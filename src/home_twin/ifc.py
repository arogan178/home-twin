"""IfcOpenShell adapter and verified durable fixture transactions."""

from __future__ import annotations

import hashlib
import math
import os
import tempfile
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.geom
import ifcopenshell.validate
import numpy as np
from ifcopenshell.util import element as element_util
from ifcopenshell.util import placement as placement_util
from ifcopenshell.util import shape as shape_util
from ifcopenshell.util import unit as unit_util
from ifcopenshell.util.shape_builder import ShapeBuilder

from home_twin.fixtures import (
    ControlGroup,
    Fixture,
    InstalledLuminaire,
    LightFixture,
    LightingLayout,
    PendantFixture,
    PendantSpec,
    PlannedPendant,
    PlannedRopeLight,
    PlannedSensor,
    PlannedSpotlight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightFixture,
    RopeLightSpec,
    RopeMounting,
    SensorDevice,
    SensorKind,
    SensorSpec,
    SpotlightSpec,
    WallSwitch,
    WallSwitchFace,
    WallSwitchKind,
    WallSwitchSpec,
)
from home_twin.geometry import (
    bounds_distance,
    convex_hull_2d,
    distance_2d,
    point_in_polygon,
    point_segment_distance,
    polygon_area,
)
from home_twin.model import (
    Bounds3D,
    Building,
    BuildingObject,
    Ceiling,
    DaylightSource,
    MutationResult,
    ObjectKind,
    Opening,
    OpeningKind,
    Point2D,
    Point3D,
    Polygon2D,
    Room,
    RoomContext,
    Site,
    Soffit,
    Stair,
    Storey,
    TriangleMesh,
    Vector3D,
    WallFace,
)
from home_twin.validation import ExternalModification, GeometryUnavailable, StaleRevision

if TYPE_CHECKING:
    from home_twin.finishes import FinishCatalogue

T = TypeVar("T")

# How far a recessed trim stands below the finished ceiling face. A downlight
# reads as flush; this is the bezel, not the housing, which sits in the void.
TRIM_PROJECTION_MM = 3.0


def _sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _optional_str(value: object) -> str | None:
    return str(value) if value not in (None, "") else None


def _optional_float(value: object) -> float | None:
    """A stated number, or None. Zero is a stated zero and not an absence."""
    return None if value is None or value == "" else float(value)


def _entity_guid(entity: ifcopenshell.entity_instance) -> str:
    guid = getattr(entity, "GlobalId", None)
    if not guid:
        raise ValueError(f"{entity.is_a()} #{entity.id()} has no GlobalId")
    return str(guid)


def _compound_angle_to_degrees(value: Any) -> float | None:
    """Convert an IFC compound plane angle measure to signed decimal degrees."""

    if value is None:
        return None
    parts = [float(part) for part in value if part is not None]
    if not parts:
        return None
    sign = -1.0 if any(part < 0 for part in parts) else 1.0
    magnitudes = [abs(part) for part in parts]
    scales = (1.0, 1 / 60, 1 / 3600, 1 / 3_600_000_000)
    return sign * sum(magnitude * scale for magnitude, scale in zip(magnitudes, scales, strict=False))


def degrees_to_compound_angle(degrees_value: float) -> tuple[int, int, int, int]:
    """Convert signed decimal degrees to the IFC (deg, min, sec, millionths) form."""

    sign = -1 if degrees_value < 0 else 1
    total_millionths = round(abs(degrees_value) * 3_600_000_000)
    degrees_part, remainder = divmod(total_millionths, 3_600_000_000)
    minutes_part, remainder = divmod(remainder, 60_000_000)
    seconds_part, millionths = divmod(remainder, 1_000_000)
    return (
        sign * int(degrees_part),
        sign * int(minutes_part),
        sign * int(seconds_part),
        sign * int(millionths),
    )


def true_north_bearing_deg(true_north_ratios: tuple[float, ...] | None) -> float:
    """Return the clockwise bearing of building ``+Y`` from an IFC ``TrueNorth``."""

    if true_north_ratios is None or len(true_north_ratios) < 2:
        return 0.0
    north_x, north_y = float(true_north_ratios[0]), float(true_north_ratios[1])
    if north_x == 0 and north_y == 0:
        return 0.0
    return float(np.degrees(np.arctan2(-north_x, north_y)) % 360.0)


def _parent_space_guid(space: ifcopenshell.entity_instance) -> str | None:
    """The space this one is a level of, when it aggregates into another space."""

    for relation in getattr(space, "Decomposes", ()) or ():
        parent = getattr(relation, "RelatingObject", None)
        if parent is not None and parent.is_a("IfcSpace"):
            return _entity_guid(parent)
    return None


def _interior_point(polygon: Polygon2D) -> Point2D:
    """A point well inside a room, which its bounding-box centre need not be.

    A concave room such as an L-shaped open plan can have its bounding-box
    centre outside itself, and a wall oriented against that centre ends up
    facing the wrong way. That is what decides which side a sun patch lands on.
    """

    ring = polygon.outer
    xs = [point.x for point in ring]
    ys = [point.y for point in ring]
    best: tuple[float, Point2D] | None = None
    for step_x in range(1, 16):
        for step_y in range(1, 16):
            candidate = Point2D(
                min(xs) + (max(xs) - min(xs)) * step_x / 16,
                min(ys) + (max(ys) - min(ys)) * step_y / 16,
            )
            if not point_in_polygon(candidate, polygon):
                continue
            clearance = min(
                point_segment_distance(candidate, ring[index], ring[(index + 1) % len(ring)])
                for index in range(len(ring))
            )
            if best is None or clearance > best[0]:
                best = (clearance, candidate)
    if best is None:
        return Point2D(sum(xs) / len(xs), sum(ys) / len(ys))
    return best[1]


def bearing_deg_to_true_north_ratios(bearing_deg: float) -> tuple[float, float]:
    """Return the IFC ``TrueNorth`` ratios for a building ``+Y`` bearing."""

    radians = np.radians(bearing_deg)
    return (float(-np.sin(radians)), float(np.cos(radians)))


# A note is why a fitting is where it is, and where it takes its power from. It
# was planning-time only and never reached the file, so a supply an owner stated
# out loud vanished on save and the model could not be asked about it.
_NOTE_SEPARATOR = " | "


def _join_notes(notes: tuple[str, ...]) -> str:
    return _NOTE_SEPARATOR.join(note.replace(_NOTE_SEPARATOR, " ") for note in notes)


def _split_notes(value: object) -> tuple[str, ...]:
    text = str(value or "").strip()
    return tuple(part.strip() for part in text.split(_NOTE_SEPARATOR) if part.strip())


class IfcRepository:
    """The sole mutable IFC boundary. Public mutations are durable transactions."""

    def __init__(self, path: Path, model: ifcopenshell.file) -> None:
        self.path = path
        self.model = model
        self.revision = _sha256(path)
        self._mesh_cache: dict[str, TriangleMesh | None] = {}
        self._bounds_cache: dict[str, Bounds3D] = {}
        self._object_cache: dict[str, BuildingObject] = {}
        self._finishes: FinishCatalogue | None = None

    @property
    def finishes(self) -> FinishCatalogue:
        """Named finishes from ``finishes.yaml`` beside the IFC, over the generic ones."""

        if self._finishes is None:
            from home_twin.finishes import load_finishes

            self._finishes = load_finishes(self.path.parent)
        return self._finishes

    @classmethod
    def open(cls, path: Path) -> IfcRepository:
        if not path.exists():
            raise FileNotFoundError(path)
        return cls(path, ifcopenshell.open(path))

    def _clear_caches(self) -> None:
        self._mesh_cache.clear()
        self._bounds_cache.clear()
        self._object_cache.clear()

    @staticmethod
    def _project_to_mm(model: ifcopenshell.file) -> float:
        return unit_util.calculate_unit_scale(model) * 1000

    @classmethod
    def _placement_point(cls, model: ifcopenshell.file, product: ifcopenshell.entity_instance) -> Point3D:
        placement = getattr(product, "ObjectPlacement", None)
        if placement is None:
            return Point3D(0, 0, 0)
        matrix = placement_util.get_local_placement(placement)
        factor = cls._project_to_mm(model)
        return Point3D(
            round(float(matrix[0, 3] * factor), 6),
            round(float(matrix[1, 3] * factor), 6),
            round(float(matrix[2, 3] * factor), 6),
        )

    @staticmethod
    def _shape_mesh(model: ifcopenshell.file, product: ifcopenshell.entity_instance) -> TriangleMesh | None:
        if getattr(product, "Representation", None) is None:
            return None
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
        except (RuntimeError, ValueError):
            return None
        vertices_array = shape_util.get_vertices(shape.geometry)
        faces_array = shape_util.get_faces(shape.geometry)
        vertices = tuple(Point3D(float(x * 1000), float(y * 1000), float(z * 1000)) for x, y, z in vertices_array)
        faces = tuple(tuple(int(index) for index in face) for face in faces_array)
        return TriangleMesh(vertices, faces)

    def get_mesh(self, object_id: str) -> TriangleMesh | None:
        if object_id not in self._mesh_cache:
            entity = self._by_guid(object_id)
            self._mesh_cache[object_id] = self._shape_mesh(self.model, entity)
        return self._mesh_cache[object_id]

    def _bounds(self, product: ifcopenshell.entity_instance) -> Bounds3D:
        guid = _entity_guid(product)
        if guid in self._bounds_cache:
            return self._bounds_cache[guid]
        mesh = self.get_mesh(guid)
        if mesh and mesh.vertices:
            bounds = Bounds3D(
                Point3D(
                    min(vertex.x for vertex in mesh.vertices),
                    min(vertex.y for vertex in mesh.vertices),
                    min(vertex.z for vertex in mesh.vertices),
                ),
                Point3D(
                    max(vertex.x for vertex in mesh.vertices),
                    max(vertex.y for vertex in mesh.vertices),
                    max(vertex.z for vertex in mesh.vertices),
                ),
            )
        else:
            point = self._placement_point(self.model, product)
            bounds = Bounds3D(point, point)
        self._bounds_cache[guid] = bounds
        return bounds

    def _by_guid(self, guid: str) -> ifcopenshell.entity_instance:
        try:
            entity = self.model.by_guid(guid)
        except RuntimeError:
            entity = None
        if entity is None:
            raise KeyError(f"IFC object {guid!r} was not found")
        return entity

    def get_building(self) -> Building:
        buildings = self.model.by_type("IfcBuilding")
        if not buildings:
            raise KeyError("The IFC has no IfcBuilding")
        building = sorted(buildings, key=_entity_guid)[0]
        return Building(
            _entity_guid(building),
            building.Name or "Unnamed building",
            self.model.schema,
            revision=self.revision,
        )

    def get_site(self) -> Site:
        """Return the geographic site, with unstated values left as ``None``."""

        sites = self.model.by_type("IfcSite")
        if not sites:
            return Site("", "Unstated site", evidence="unstated")
        site = sorted(sites, key=_entity_guid)[0]
        properties = self._flatten_properties(site)
        elevation = getattr(site, "RefElevation", None)
        contexts = [
            context
            for context in self.model.by_type("IfcGeometricRepresentationContext")
            if getattr(context, "TrueNorth", None) is not None
            and not context.is_a("IfcGeometricRepresentationSubContext")
        ]
        ratios = tuple(contexts[0].TrueNorth.DirectionRatios) if contexts else None
        timezone_value = properties.get("Pset_HomeTwinSite.Timezone")
        evidence_value = properties.get("Pset_HomeTwinSite.Evidence")
        return Site(
            _entity_guid(site),
            site.Name or "Unnamed site",
            _compound_angle_to_degrees(getattr(site, "RefLatitude", None)),
            _compound_angle_to_degrees(getattr(site, "RefLongitude", None)),
            float(elevation) * self._project_to_mm(self.model) if elevation is not None else 0.0,
            true_north_bearing_deg(ratios),
            str(timezone_value) if timezone_value else None,
            str(evidence_value) if evidence_value else "unstated",
        )

    def get_storeys(self) -> tuple[Storey, ...]:
        values = []
        for storey in self.model.by_type("IfcBuildingStorey"):
            point = self._placement_point(self.model, storey)
            elevation = point.z
            if getattr(storey, "Elevation", None) is not None:
                elevation = float(storey.Elevation * self._project_to_mm(self.model))
            values.append(Storey(_entity_guid(storey), storey.Name or "Unnamed storey", elevation))
        return tuple(sorted(values, key=lambda item: (item.elevation_mm, item.id)))

    def _storey_for(self, entity: ifcopenshell.entity_instance) -> str:
        current = entity
        visited: set[int] = set()
        while current is not None and current.id() not in visited:
            visited.add(current.id())
            if current.is_a("IfcBuildingStorey"):
                return _entity_guid(current)
            current = element_util.get_aggregate(current) or element_util.get_container(current)
        return ""

    def get_rooms(self) -> tuple[Room, ...]:
        values = []
        for space in self.model.by_type("IfcSpace"):
            properties = self._flatten_properties(space)
            if properties.get("Pset_HomeTwinDaylight.SourceKind") is not None:
                continue
            bounds = self._bounds(space)
            values.append(
                Room(
                    _entity_guid(space),
                    space.Name or "Unnamed room",
                    self._storey_for(space),
                    bounds.minimum.z,
                    bounds,
                    space.PredefinedType == "EXTERNAL",
                    _parent_space_guid(space),
                    _optional_str(properties.get("Pset_HomeTwinFinish.FloorFinish")),
                    _optional_str(properties.get("Pset_HomeTwinFinish.WallFinish")),
                    _optional_str(properties.get("Pset_HomeTwinFinish.FeatureWallId")),
                    _optional_str(properties.get("Pset_HomeTwinFinish.FeatureWallFinish")),
                    _optional_str(properties.get("Pset_HomeTwinFinish.FeatureWallColour")),
                    skirting=_optional_str(properties.get("Pset_HomeTwinFinish.SkirtingFinish")),
                    skirting_height_mm=_optional_float(properties.get("Pset_HomeTwinFinish.SkirtingHeightMm")),
                    skirting_thickness_mm=_optional_float(
                        properties.get("Pset_HomeTwinFinish.SkirtingThicknessMm")
                    ),
                    clad_wall_ids=tuple(
                        part
                        for part in (_optional_str(properties.get("Pset_HomeTwinFinish.CladWallIds")) or "").split(";")
                        if part
                    ),
                    clad_wall=_optional_str(properties.get("Pset_HomeTwinFinish.CladWallFinish")),
                )
            )
        return tuple(sorted(values, key=lambda item: (item.storey_id, item.name.casefold(), item.id)))

    def get_room(self, room_id: str) -> Room:
        for room in self.get_rooms():
            if room.id == room_id:
                return room
        raise KeyError(f"Room {room_id!r} was not found")

    @staticmethod
    def _flatten_properties(product: ifcopenshell.entity_instance) -> dict[str, str | int | float | bool | None]:
        result: dict[str, str | int | float | bool | None] = {
            "Name": getattr(product, "Name", None),
            "Tag": getattr(product, "Tag", None),
            "PredefinedType": getattr(product, "PredefinedType", None),
        }
        for pset_name, values in element_util.get_psets(product).items():
            for name, value in values.items():
                if name == "id" or not isinstance(value, (str, int, float, bool, type(None))):
                    continue
                result[f"{pset_name}.{name}"] = value
        return result

    @staticmethod
    def _classify(product: ifcopenshell.entity_instance, properties: dict[str, Any]) -> ObjectKind:
        if product.is_a("IfcWall"):
            return ObjectKind.WALL
        if product.is_a("IfcOpeningElement") or product.is_a("IfcDoor") or product.is_a("IfcWindow"):
            return ObjectKind.OPENING
        if product.is_a("IfcLightFixture"):
            return ObjectKind.LIGHT_FIXTURE
        if product.is_a("IfcSanitaryTerminal") or product.is_a("IfcValve") or product.is_a("IfcWasteTerminal"):
            return ObjectKind.SANITARY_FIXTURE
        if product.is_a("IfcFan") or product.is_a("IfcAirTerminal"):
            return ObjectKind.EXTRACTOR
        if product.is_a("IfcSensor"):
            return ObjectKind.SENSOR
        if product.is_a("IfcCovering") and str(getattr(product, "PredefinedType", "")) == "CEILING":
            return ObjectKind.CEILING
        name = (getattr(product, "Name", None) or "").casefold()
        declared = str(properties.get("Pset_HomeTwin.ObjectKind", "")).casefold()
        if "shadow_gap" in declared or "shadow gap" in name:
            return ObjectKind.SHADOW_GAP
        # A declared kind wins: a worktop is named like joinery but is a task
        # surface to light, not an obstruction to clear.
        if "cabinet" in declared or (not declared and ("cabinet" in name or "worktop" in name)):
            return ObjectKind.CABINET
        if declared in {"ac", "air_conditioner"} or name.startswith("ac ") or "air conditioner" in name:
            return ObjectKind.AC
        if product.is_a("IfcStair") or product.is_a("IfcStairFlight") or "stair" in declared:
            return ObjectKind.STAIR
        if "beam" in declared or product.is_a("IfcBeam"):
            return ObjectKind.BEAM
        if "duct" in declared or product.is_a("IfcDuctSegment"):
            return ObjectKind.DUCT
        if "pipe" in declared or product.is_a("IfcPipeSegment"):
            return ObjectKind.PIPE
        if product.is_a("IfcFurniture") or product.is_a("IfcFurnishingElement"):
            return ObjectKind.FURNITURE
        return ObjectKind.OTHER

    @staticmethod
    def _parent_space(space: ifcopenshell.entity_instance) -> ifcopenshell.entity_instance | None:
        """The space this one is a part of, when it is a part of one."""
        for relation in getattr(space, "Decomposes", ()) or ():
            parent = getattr(relation, "RelatingObject", None)
            if parent is not None and parent.is_a("IfcSpace"):
                return parent
        return None

    @staticmethod
    def _joined_spaces(product: ifcopenshell.entity_instance) -> tuple[ifcopenshell.entity_instance, ...]:
        """The rooms a door or window joins, being a hole through a shared wall.

        A wall is bounded from both sides and a door in it belongs to both
        rooms, but the boundary the tracer writes for the door itself names only
        one. The pierced wall knows the pair, so the door is read from it.

        A wall bounding more than two spaces runs past several rooms, and which
        two a door joins is then a question of where along it the door sits.
        That is not answered here: the door keeps its own boundary rather than
        being handed a room it may not open into.
        """
        for fill in getattr(product, "FillsVoids", ()) or ():
            opening = getattr(fill, "RelatingOpeningElement", None)
            if opening is None:
                continue
            for void in getattr(opening, "VoidsElements", ()) or ():
                wall = getattr(void, "RelatingBuildingElement", None)
                if wall is None:
                    continue
                spaces = [
                    space
                    for boundary in getattr(wall, "ProvidesBoundaries", ()) or ()
                    if (space := getattr(boundary, "RelatingSpace", None)) is not None
                ]
                unique = {_entity_guid(space): space for space in spaces}
                if len(unique) == 2:
                    return tuple(unique.values())
        return ()

    def _room_ids_for(self, product: ifcopenshell.entity_instance) -> tuple[str, ...]:
        spaces: list[ifcopenshell.entity_instance] = []
        container = element_util.get_container(product)
        if container is not None and container.is_a("IfcSpace"):
            spaces.append(container)
        for boundary in getattr(product, "ProvidesBoundaries", ()) or ():
            space = getattr(boundary, "RelatingSpace", None)
            if space is not None:
                spaces.append(space)
        spaces.extend(self._joined_spaces(product))

        ids: set[str] = set()
        for space in spaces:
            ids.add(_entity_guid(space))
            # A sub-space is part of its parent room, so whatever sits in the
            # entrance landing sits in the open plan it is a landing of.
            parent = self._parent_space(space)
            while parent is not None:
                ids.add(_entity_guid(parent))
                parent = self._parent_space(parent)
        room_property = self._flatten_properties(product).get("Pset_HomeTwinLighting.RoomId")
        if isinstance(room_property, str):
            ids.add(room_property)
        return tuple(sorted(ids))

    def _object_from_entity(self, product: ifcopenshell.entity_instance) -> BuildingObject:
        guid = _entity_guid(product)
        if guid not in self._object_cache:
            properties = self._flatten_properties(product)
            self._object_cache[guid] = BuildingObject(
                guid,
                product.is_a(),
                self._classify(product, properties),
                product.Name or product.is_a(),
                self._room_ids_for(product),
                self._bounds(product),
                properties,
                self._plan_footprint(guid),
            )
        obj = self._object_cache[guid]
        return replace(obj, properties=dict(obj.properties))

    def _plan_footprint(self, guid: str) -> Polygon2D | None:
        mesh = self.get_mesh(guid)
        if not mesh or not mesh.vertices:
            return None
        hull = convex_hull_2d([Point2D(vertex.x, vertex.y) for vertex in mesh.vertices])
        return Polygon2D(hull) if len(hull) >= 3 else None

    def _opening_from_entity(self, product: ifcopenshell.entity_instance) -> Opening:
        properties = self._flatten_properties(product)
        prefix = "Pset_HomeTwinDaylight."
        fills = getattr(product, "FillsVoids", ()) or ()
        opening = fills[0].RelatingOpeningElement if fills else None
        voids = (getattr(opening, "VoidsElements", ()) or ()) if opening is not None else ()
        host = voids[0].RelatingBuildingElement if voids else None
        operation = str(getattr(product, "OperationType", "") or "")
        if operation == "USERDEFINED":
            operation = f"{operation}:{getattr(product, 'UserDefinedOperationType', '') or ''}"
        if product.is_a("IfcWindow"):
            kind = OpeningKind.WINDOW
        elif "SLIDING" in operation.upper():
            kind = OpeningKind.SLIDING_DOOR
        else:
            kind = OpeningKind.DOOR
        swing_value = properties.get(f"{prefix}Swing")
        swing = swing_value if swing_value in {"inward", "outward"} else None
        return Opening(
            id=_entity_guid(product),
            name=product.Name or product.is_a(),
            kind=kind,
            room_ids=self._room_ids_for(product),
            host_wall_id=_entity_guid(host) if host is not None else "",
            start=Point2D(
                float(properties.get(f"{prefix}PlanStartX") or 0),
                float(properties.get(f"{prefix}PlanStartY") or 0),
            ),
            end=Point2D(
                float(properties.get(f"{prefix}PlanEndX") or 0),
                float(properties.get(f"{prefix}PlanEndY") or 0),
            ),
            sill_height_mm=float(properties.get(f"{prefix}SillHeight") or 0),
            head_height_mm=float(properties.get(f"{prefix}HeadHeight") or 0),
            exposure=str(properties.get(f"{prefix}Exposure") or "none"),
            evidence=str(properties.get(f"{prefix}Evidence") or "unknown"),
            swing=swing,
            glazing_fraction=float(properties.get(f"{prefix}GlazingFraction") or 0),
            overhang_depth_mm=_optional_float(properties.get(f"{prefix}OverhangDepth")),
            overhang_soffit_mm=_optional_float(properties.get(f"{prefix}OverhangSoffit")),
        )

    def _stair_from_entity(self, product: ifcopenshell.entity_instance) -> Stair:
        properties = self._flatten_properties(product)
        prefix = "Pset_HomeTwinStair."
        bounds = self._bounds(product)
        mesh = self.get_mesh(_entity_guid(product))
        footprint: Polygon2D | None = None
        if mesh is not None:
            corners = [(round(v.x, 1), round(v.y, 1)) for v in mesh.vertices]
            hull = _convex_hull(corners)
            if len(hull) >= 3:
                footprint = Polygon2D(tuple(Point2D(x, y) for x, y in hull))
        if footprint is None:
            footprint = Polygon2D(
                (
                    Point2D(bounds.minimum.x, bounds.minimum.y),
                    Point2D(bounds.maximum.x, bounds.minimum.y),
                    Point2D(bounds.maximum.x, bounds.maximum.y),
                    Point2D(bounds.minimum.x, bounds.maximum.y),
                )
            )
        tread_count = int(float(properties.get("Pset_StairFlightCommon.NumberOfTreads") or 0) or 0)
        riser_count = int(
            float(
                properties.get("Pset_StairFlightCommon.NumberOfRiser")
                or getattr(product, "NumberOfRisers", 0)
                or 0
            )
            or 0
        )
        return Stair(
            id=_entity_guid(product),
            name=product.Name or product.is_a(),
            kind=str(properties.get(f"{prefix}FlightKind") or getattr(product, "PredefinedType", "") or "NOTDEFINED"),
            footprint=footprint,
            bounds=bounds,
            base_elevation_mm=float(properties.get(f"{prefix}BaseElevation") or bounds.minimum.z),
            rise_mm=float(properties.get(f"{prefix}Rise") or (bounds.maximum.z - bounds.minimum.z)),
            tread_depth_mm=float(properties.get("Pset_StairFlightCommon.TreadLength") or 0.0),
            riser_height_mm=float(properties.get("Pset_StairFlightCommon.RiserHeight") or 0.0),
            tread_count=max(tread_count, 1),
            riser_count=max(riser_count, 1),
            up_bearing_deg=float(properties.get(f"{prefix}UpBearingDeg") or 0.0),
            room_ids=self._room_ids_for(product),
            evidence=str(properties.get(f"{prefix}Evidence") or "unknown"),
            finish=_optional_str(properties.get(f"{prefix}Finish")),
            skirting=_optional_str(properties.get(f"{prefix}SkirtingFinish")),
            skirting_height_mm=_optional_float(properties.get(f"{prefix}SkirtingHeightMm")),
            skirting_thickness_mm=_optional_float(properties.get(f"{prefix}SkirtingThicknessMm")),
        )

    def get_stairs(self, room_id: str) -> tuple[Stair, ...]:
        """Return stair flights that serve or adjoin a room.

        A common stair core often sits outside every ``IfcSpace``, so flights
        within 1.5 m of the room bounds are included; the lighting model treats
        them as obstructions and the viewer draws their treads.
        """

        room = self.get_room(room_id)
        values = []
        for product in self.model.by_type("IfcStairFlight"):
            stair = self._stair_from_entity(product)
            if room_id in stair.room_ids or bounds_distance(stair.bounds, room.bounds) <= 1500:
                values.append(stair)
        return tuple(sorted(values, key=lambda item: (item.name.casefold(), item.id)))

    def _unfilled_from_entity(self, product: ifcopenshell.entity_instance) -> Opening:
        """A cased opening: a void in a wall with nothing filling it.

        Its plan facts live on the opening element rather than on a filling, and
        its rooms come from the host wall's space boundaries, because there is no
        filling to associate with a space.
        """

        properties = self._flatten_properties(product)
        prefix = "Pset_HomeTwinDaylight."
        voids = getattr(product, "VoidsElements", ()) or ()
        host = voids[0].RelatingBuildingElement if voids else None
        rooms: set[str] = set()
        if host is not None:
            for boundary in getattr(host, "ProvidesBoundaries", ()) or ():
                space = getattr(boundary, "RelatingSpace", None)
                if space is not None:
                    rooms.add(_entity_guid(space))
        return Opening(
            id=_entity_guid(product),
            name=product.Name or "Cased opening",
            kind=OpeningKind.UNFILLED,
            room_ids=tuple(sorted(rooms)),
            host_wall_id=_entity_guid(host) if host is not None else "",
            start=Point2D(
                float(properties.get(f"{prefix}PlanStartX") or 0),
                float(properties.get(f"{prefix}PlanStartY") or 0),
            ),
            end=Point2D(
                float(properties.get(f"{prefix}PlanEndX") or 0),
                float(properties.get(f"{prefix}PlanEndY") or 0),
            ),
            sill_height_mm=float(properties.get(f"{prefix}SillHeight") or 0),
            head_height_mm=float(properties.get(f"{prefix}HeadHeight") or 0),
            exposure=str(properties.get(f"{prefix}Exposure") or "none"),
            evidence=str(properties.get(f"{prefix}Evidence") or "unknown"),
            swing=None,
        )

    def get_openings(self, room_id: str) -> tuple[Opening, ...]:
        values = [
            self._opening_from_entity(product)
            for ifc_class in ("IfcDoor", "IfcWindow")
            for product in self.model.by_type(ifc_class)
            if room_id in self._room_ids_for(product)
        ]
        for product in self.model.by_type("IfcOpeningElement"):
            if getattr(product, "HasFillings", ()) or ():
                continue
            if self._flatten_properties(product).get("Pset_HomeTwinDaylight.Unfilled") is None:
                continue
            opening = self._unfilled_from_entity(product)
            if room_id in opening.room_ids:
                values.append(opening)
        return tuple(sorted(values, key=lambda item: (item.kind.value, item.name.casefold(), item.id)))

    def get_soffits(self, room_id: str) -> tuple[Soffit, ...]:
        values: list[Soffit] = []
        for covering in self.model.by_type("IfcCovering"):
            properties = self._flatten_properties(covering)
            kind = properties.get("Pset_HomeTwinSoffit.Kind")
            if not isinstance(kind, str):
                continue
            if room_id not in self._room_ids_for(covering):
                continue
            mesh = self.get_mesh(_entity_guid(covering))
            top = self._top_polygon(mesh) if mesh else None
            if top is None:
                continue
            polygon, elevation = top
            height = properties.get("Pset_HomeTwinSoffit.HeightAboveFloor")
            evidence = properties.get("Pset_HomeTwinSoffit.Evidence")
            values.append(
                Soffit(
                    _entity_guid(covering),
                    covering.Name or "Soffit",
                    kind,
                    room_id,
                    polygon,
                    elevation,
                    float(height) if isinstance(height, (int, float)) else elevation,
                    str(evidence) if evidence is not None else "unstated",
                )
            )
        return tuple(sorted(values, key=lambda item: item.id))

    def get_daylight_sources(self, room_id: str) -> tuple[DaylightSource, ...]:
        room = self.get_room(room_id)
        values: list[DaylightSource] = []
        for space in self.model.by_type("IfcSpace"):
            properties = self._flatten_properties(space)
            source_kind = properties.get("Pset_HomeTwinDaylight.SourceKind")
            if not isinstance(source_kind, str):
                continue
            bounds = self._bounds(space)
            horizontal_gap = max(
                bounds.minimum.x - room.bounds.maximum.x,
                room.bounds.minimum.x - bounds.maximum.x,
                bounds.minimum.y - room.bounds.maximum.y,
                room.bounds.minimum.y - bounds.maximum.y,
                0,
            )
            if horizontal_gap > 750:
                continue
            mesh = self.get_mesh(_entity_guid(space))
            top = self._top_polygon(mesh) if mesh else None
            if top is None:
                continue
            values.append(
                DaylightSource(
                    id=_entity_guid(space),
                    name=space.Name or "Unnamed daylight source",
                    kind=source_kind,
                    footprint=top[0],
                    bounds=bounds,
                    daylight_role=str(properties.get("Pset_HomeTwinDaylight.Role") or "possible"),
                    evidence=str(properties.get("Pset_HomeTwinDaylight.Evidence") or "unknown"),
                )
            )
        return tuple(sorted(values, key=lambda item: (item.kind, item.name.casefold(), item.id)))

    def get_objects(
        self,
        room_id: str | None = None,
        kind: ObjectKind | None = None,
        ifc_class: str | None = None,
    ) -> tuple[BuildingObject, ...]:
        values: list[BuildingObject] = []
        wall_ids: set[str] | None = None
        for product in self.model.by_type("IfcElement"):
            if not getattr(product, "GlobalId", None):
                continue
            obj = self._object_from_entity(product)
            if kind is not None and obj.kind != kind:
                continue
            if ifc_class and not product.is_a(ifc_class):
                continue
            if room_id and room_id not in obj.room_ids:
                if obj.kind != ObjectKind.WALL:
                    continue
                if wall_ids is None:
                    wall_ids = {wall.wall_id for wall in self.get_room_context(room_id).walls}
                if obj.id not in wall_ids:
                    continue
            values.append(obj)
        return tuple(sorted(values, key=lambda item: (item.kind.value, item.name.casefold(), item.id)))

    def get_object(self, object_id: str) -> BuildingObject:
        return self._object_from_entity(self._by_guid(object_id))

    @staticmethod
    def _top_polygon(mesh: TriangleMesh, *, tolerance_mm: float = 0.5) -> tuple[Polygon2D, float] | None:
        if not mesh.vertices or not mesh.faces:
            return None
        top_z = max(vertex.z for vertex in mesh.vertices)
        top_faces = [
            face for face in mesh.faces if all(abs(mesh.vertices[index].z - top_z) <= tolerance_mm for index in face)
        ]
        if not top_faces:
            return None
        counts: Counter[tuple[int, int]] = Counter()
        for a, b, c in top_faces:
            for edge in ((a, b), (b, c), (c, a)):
                counts[tuple(sorted(edge))] += 1
        boundary = {edge for edge, count in counts.items() if count == 1}
        if len(boundary) < 3:
            return None
        adjacency: dict[int, set[int]] = defaultdict(set)
        for a, b in boundary:
            adjacency[a].add(b)
            adjacency[b].add(a)
        loops: list[tuple[Point2D, ...]] = []
        unused = set(boundary)
        while unused:
            first_edge = min(unused)
            start, current = first_edge
            loop = [start, current]
            unused.remove(first_edge)
            previous = start
            while current != start:
                choices = sorted(
                    neighbor
                    for neighbor in adjacency[current]
                    if tuple(sorted((current, neighbor))) in unused and neighbor != previous
                )
                if not choices:
                    if start in adjacency[current] and tuple(sorted((current, start))) in unused:
                        next_vertex = start
                    else:
                        break
                else:
                    next_vertex = choices[0]
                unused.discard(tuple(sorted((current, next_vertex))))
                previous, current = current, next_vertex
                if current != start:
                    loop.append(current)
            if current == start and len(loop) >= 3:
                loops.append(tuple(Point2D(mesh.vertices[index].x, mesh.vertices[index].y) for index in loop))
        if not loops:
            return None
        polygons = [Polygon2D(loop) for loop in loops]
        outer = max(polygons, key=polygon_area)
        holes = tuple(polygon.outer for polygon in polygons if polygon is not outer)
        return Polygon2D(outer.outer, holes), top_z

    @staticmethod
    def _wall_face_from_bounds(wall: BuildingObject, inside: Point2D) -> WallFace:
        bounds = wall.bounds
        center = inside
        dx = bounds.maximum.x - bounds.minimum.x
        dy = bounds.maximum.y - bounds.minimum.y
        if dx >= dy:
            y = (
                bounds.maximum.y
                if abs(center.y - bounds.maximum.y) < abs(center.y - bounds.minimum.y)
                else bounds.minimum.y
            )
            normal_y = 1.0 if center.y >= y else -1.0
            return WallFace(
                wall.id,
                Point2D(bounds.minimum.x, y),
                Point2D(bounds.maximum.x, y),
                Vector3D(0, normal_y, 0),
                dy,
                bounds.minimum.z,
                bounds.maximum.z,
            )
        x = (
            bounds.maximum.x
            if abs(center.x - bounds.maximum.x) < abs(center.x - bounds.minimum.x)
            else bounds.minimum.x
        )
        normal_x = 1.0 if center.x >= x else -1.0
        return WallFace(
            wall.id,
            Point2D(x, bounds.minimum.y),
            Point2D(x, bounds.maximum.y),
            Vector3D(normal_x, 0, 0),
            dx,
            bounds.minimum.z,
            bounds.maximum.z,
        )

    @staticmethod
    def _room_lies_towards(room: Polygon2D, midpoint: Point2D, normal_x: float, normal_y: float) -> bool:
        """Whether stepping off the wall in this direction lands in the room."""

        for step in (150.0, 400.0, 900.0):
            probe = Point2D(midpoint.x + normal_x * step, midpoint.y + normal_y * step)
            if point_in_polygon(probe, room):
                return True
        return False

    def _wall_face(self, wall: BuildingObject, room: Polygon2D, inside: Point2D) -> WallFace:
        mesh = self.get_mesh(wall.id)
        footprint = self._top_polygon(mesh) if mesh else None
        if footprint is None:
            return self._wall_face_from_bounds(wall, inside)
        polygon, _elevation = footprint
        edges = tuple(
            (polygon.outer[index], polygon.outer[(index + 1) % len(polygon.outer)])
            for index in range(len(polygon.outer))
        )
        lengths = tuple(distance_2d(start, end) for start, end in edges)
        if not lengths or max(lengths) <= 1e-6:
            return self._wall_face_from_bounds(wall, inside)
        longest = max(lengths)
        long_faces = tuple(edge for edge, length in zip(edges, lengths, strict=True) if length >= longest * 0.95)

        # The face this room sees is the one lying on its own outline; the far
        # face of a shared wall belongs to the room on the other side.
        def off_outline(edge: tuple[Point2D, Point2D]) -> float:
            midpoint = Point2D((edge[0].x + edge[1].x) / 2, (edge[0].y + edge[1].y) / 2)
            ring = room.outer
            return min(
                point_segment_distance(midpoint, ring[index], ring[(index + 1) % len(ring)])
                for index in range(len(ring))
            )

        start, end = min(
            long_faces,
            key=lambda edge: (round(off_outline(edge)), point_segment_distance(inside, edge[0], edge[1])),
        )
        dx = end.x - start.x
        dy = end.y - start.y
        length = distance_2d(start, end)
        normal_x = -dy / length
        normal_y = dx / length
        # Which side the room is on is answered next to the wall, not from the
        # room's middle: a long room's far end can sit across a short wall's
        # own line and flip the normal the wrong way.
        midpoint = Point2D((start.x + end.x) / 2, (start.y + end.y) / 2)
        outward_lands_inside = self._room_lies_towards(room, midpoint, -normal_x, -normal_y)
        if not self._room_lies_towards(room, midpoint, normal_x, normal_y) and (
            outward_lands_inside
            or (normal_x * (inside.x - midpoint.x) + normal_y * (inside.y - midpoint.y)) < 0
        ):
            normal_x = -normal_x
            normal_y = -normal_y
        # The footprint's depth perpendicular to the face, which does not depend
        # on which of a wall's two long faces this room sees.
        offsets = [(point.x - start.x) * normal_x + (point.y - start.y) * normal_y for point in polygon.outer]
        thickness = max(offsets) - min(offsets)
        return WallFace(
            wall.id,
            start,
            end,
            Vector3D(normal_x, normal_y, 0),
            max(thickness, 1.0),
            wall.bounds.minimum.z,
            wall.bounds.maximum.z,
        )

    def get_room_context(self, room_id: str) -> RoomContext:
        room = self.get_room(room_id)
        space = self._by_guid(room_id)
        mesh = self.get_mesh(room_id)
        top = self._top_polygon(mesh) if mesh else None
        source = "ifc_space"
        if top is None:
            coverings = [
                obj
                for obj in self.get_objects(room_id=room_id, kind=ObjectKind.CEILING)
                if (covering_mesh := self.get_mesh(obj.id)) is not None and self._top_polygon(covering_mesh) is not None
            ]
            if not coverings:
                raise GeometryUnavailable(f"Room {room_id!r} has no usable ceiling polygon")
            covering_mesh = self.get_mesh(coverings[0].id)
            assert covering_mesh is not None
            top = self._top_polygon(covering_mesh)
            source = "ceiling_covering"
        assert top is not None
        polygon, ceiling_z = top

        # A cased opening records a virtual boundary against the wall it pierces.
        # That is a hole in someone's wall, not a wall of this room.
        explicit_walls = {
            _entity_guid(boundary.RelatedBuildingElement)
            for boundary in getattr(space, "BoundedBy", ()) or ()
            if getattr(boundary, "RelatedBuildingElement", None) is not None
            and boundary.RelatedBuildingElement.is_a("IfcWall")
            and getattr(boundary, "PhysicalOrVirtualBoundary", "PHYSICAL") != "VIRTUAL"
        }
        wall_objects = self.get_objects(kind=ObjectKind.WALL)
        if explicit_walls:
            room_walls = tuple(wall for wall in wall_objects if wall.id in explicit_walls)
        else:
            room_walls = tuple(wall for wall in wall_objects if bounds_distance(wall.bounds, room.bounds) <= 250)
        inside = _interior_point(polygon)
        walls = tuple(
            sorted(
                (self._wall_face(wall, polygon, inside) for wall in room_walls),
                key=lambda item: item.wall_id,
            )
        )
        from home_twin.finishes import finish_reflectance, lrv

        # Clad faces stand on their own: a room can carry joinery against its
        # walls without painting any one of them differently, and nesting this
        # under the feature wall meant a room's cladding never reached the
        # interreflection term.
        clad = finish_reflectance(room.clad_wall, self.finishes)
        if clad is not None and room.clad_wall_ids:
            walls = tuple(
                replace(face, reflectance=clad) if face.wall_id in room.clad_wall_ids else face
                for face in walls
            )
        if room.feature_wall_colour is not None:
            # A named finish may carry the manufacturer's LRV; the colour is
            # only the fallback for one that does not.
            feature = finish_reflectance(room.feature_wall, self.finishes) or lrv(room.feature_wall_colour)
            walls = tuple(
                replace(face, reflectance=feature) if face.wall_id == room.feature_wall_id else face for face in walls
            )

        room_objects = tuple(obj for obj in self.get_objects() if room_id in obj.room_ids)
        openings = self.get_openings(room_id)
        daylight_sources = self.get_daylight_sources(room_id)
        # What the room contains, as opposed to what a fixture has to keep clear
        # of. A sensor belongs here and not in `obstruction_kinds`: it has to be
        # queryable and drawable, but a 70 mm PIR is not something a downlight
        # needs to move for.
        furniture = tuple(
            obj
            for obj in room_objects
            if obj.kind
            in {
                ObjectKind.FURNITURE,
                ObjectKind.CABINET,
                ObjectKind.SANITARY_FIXTURE,
                ObjectKind.EXTRACTOR,
            }
        )
        obstruction_kinds = {
            ObjectKind.CABINET,
            ObjectKind.SHADOW_GAP,
            ObjectKind.AC,
            ObjectKind.BEAM,
            ObjectKind.DUCT,
            ObjectKind.PIPE,
        }
        obstructions = tuple(obj for obj in room_objects if obj.kind in obstruction_kinds)
        stairs = self.get_stairs(room_id)
        soffits = self.get_soffits(room_id)
        room_properties = self._flatten_properties(space)
        structural = room_properties.get("Pset_HomeTwinRoom.StructuralCeilingElevation")
        board = room_properties.get("Pset_HomeTwinRoom.CeilingBoardThicknessMm")
        return RoomContext(
            room,
            Ceiling(
                room_id,
                polygon,
                ceiling_z,
                source,
                float(structural) if isinstance(structural, (int, float)) else None,
                float(board) if isinstance(board, (int, float)) else None,
            ),
            walls,
            openings,
            daylight_sources,
            furniture,
            obstructions,
            stairs,
            soffits,
        )

    @staticmethod
    def _fixture_from_model(model: ifcopenshell.file, fixture: ifcopenshell.entity_instance) -> LightFixture:
        properties = IfcRepository._flatten_properties(fixture)
        pset = "Pset_HomeTwinLighting."
        tag = fixture.Tag or fixture.Name or _entity_guid(fixture)
        room_id = str(properties.get(f"{pset}RoomId") or "")
        container = element_util.get_container(fixture)
        if container is not None and container.is_a("IfcSpace"):
            room_id = _entity_guid(container)
        point = IfcRepository._placement_point(model, fixture)
        direction = Vector3D(
            float(properties.get(f"{pset}DirectionX") or 0),
            float(properties.get(f"{pset}DirectionY") or 0),
            float(properties.get(f"{pset}DirectionZ") or -1),
        )
        model_name = properties.get(f"{pset}Model")
        ies_path = properties.get(f"{pset}IESPath")
        spec = SpotlightSpec(
            model=str(model_name) if model_name else None,
            lumens=float(properties[f"{pset}Lumens"]) if properties.get(f"{pset}Lumens") is not None else None,
            beam_angle_deg=float(properties.get(f"{pset}BeamAngleDegrees") or 36),
            cct_kelvin=int(properties[f"{pset}CCTKelvin"]) if properties.get(f"{pset}CCTKelvin") is not None else None,
            cri=float(properties[f"{pset}CRI"]) if properties.get(f"{pset}CRI") is not None else None,
            dimmable=bool(properties.get(f"{pset}Dimmable", True)),
            diameter_mm=float(properties.get(f"{pset}DiameterMm") or 82),
            cutout_diameter_mm=float(properties.get(f"{pset}CutOutDiameterMm") or 68),
            mounting_depth_mm=float(properties.get(f"{pset}MountingDepthMm") or 60),
            ies_path=str(ies_path) if ies_path else None,
            peak_candela=float(properties[f"{pset}PeakCandela"])
            if properties.get(f"{pset}PeakCandela")
            else None,
            ip_rating=_optional_str(properties.get(f"{pset}IPRating")),
        )
        return LightFixture(
            _entity_guid(fixture),
            str(tag),
            room_id,
            point,
            spec,
            str(properties.get(f"{pset}SwitchingGroup") or "MAIN"),
            direction,
            _split_notes(properties.get(f"{pset}Notes")),
        )

    def get_light_fixtures(self, room_id: str) -> tuple[LightFixture, ...]:
        fixtures = []
        for fixture in self.model.by_type("IfcLightFixture"):
            properties = self._flatten_properties(fixture)
            if properties.get("Pset_HomeTwinLighting.FixtureKind") != "recessed_spotlight":
                continue
            parsed = self._fixture_from_model(self.model, fixture)
            if parsed.room_id == room_id:
                fixtures.append(parsed)
        return tuple(sorted(fixtures, key=lambda item: (item.tag, item.id)))

    @staticmethod
    def _pendant_from_model(
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
    ) -> PendantFixture:
        properties = IfcRepository._flatten_properties(fixture)
        pset = "Pset_HomeTwinLighting."
        container = element_util.get_container(fixture)
        room_id = _entity_guid(container) if container is not None and container.is_a("IfcSpace") else str(
            properties.get(f"{pset}RoomId") or ""
        )
        spec = PendantSpec(
            model=str(properties.get(f"{pset}Model") or "") or None,
            lumens=float(properties[f"{pset}Lumens"]) if properties.get(f"{pset}Lumens") is not None else None,
            cct_kelvin=int(properties[f"{pset}CCTKelvin"])
            if properties.get(f"{pset}CCTKelvin") is not None
            else None,
            cri=float(properties[f"{pset}CRI"]) if properties.get(f"{pset}CRI") is not None else None,
            dimmable=bool(properties.get(f"{pset}Dimmable", True)),
            drop_mm=float(properties.get(f"{pset}DropMm") or 600),
            canopy_diameter_mm=float(properties.get(f"{pset}CanopyDiameterMm") or 100),
            canopy_depth_mm=float(properties.get(f"{pset}CanopyDepthMm") or 30),
            bulb_diameter_mm=float(properties.get(f"{pset}BulbDiameterMm") or 120),
            lamp_count=int(properties.get(f"{pset}LampCount") or 1),
            ies_path=str(properties.get(f"{pset}IESPath") or "") or None,
        )
        return PendantFixture(
            _entity_guid(fixture),
            str(fixture.Tag or fixture.Name or _entity_guid(fixture)),
            room_id,
            IfcRepository._placement_point(model, fixture),
            spec,
            str(properties.get(f"{pset}SwitchingGroup") or "MAIN"),
            _split_notes(properties.get(f"{pset}Notes")),
        )

    @staticmethod
    def _serialise_path(path: tuple[Point3D, ...]) -> str:
        return ";".join(f"{point.x:.6f},{point.y:.6f},{point.z:.6f}" for point in path)

    @staticmethod
    def _parse_path(value: object) -> tuple[Point3D, ...]:
        if not isinstance(value, str):
            raise ValueError("Rope-light path is missing")
        try:
            return tuple(Point3D(*(float(axis) for axis in item.split(","))) for item in value.split(";"))
        except (TypeError, ValueError) as error:
            raise ValueError("Rope-light path is invalid") from error

    @staticmethod
    def _rope_from_model(
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
    ) -> RopeLightFixture:
        properties = IfcRepository._flatten_properties(fixture)
        pset = "Pset_HomeTwinLighting."
        container = element_util.get_container(fixture)
        room_id = _entity_guid(container) if container is not None and container.is_a("IfcSpace") else str(
            properties.get(f"{pset}RoomId") or ""
        )
        spec = RopeLightSpec(
            model=str(properties.get(f"{pset}Model") or "") or None,
            lumens_per_m=float(properties[f"{pset}LumensPerMetre"])
            if properties.get(f"{pset}LumensPerMetre") is not None
            else None,
            cct_kelvin=int(properties[f"{pset}CCTKelvin"])
            if properties.get(f"{pset}CCTKelvin") is not None
            else None,
            cri=float(properties[f"{pset}CRI"]) if properties.get(f"{pset}CRI") is not None else None,
            dimmable=bool(properties.get(f"{pset}Dimmable", True)),
            diameter_mm=float(properties.get(f"{pset}DiameterMm") or 16),
            minimum_bend_radius_mm=float(properties.get(f"{pset}MinimumBendRadiusMm") or 60),
            mounting=RopeMounting(str(properties.get(f"{pset}Mounting") or "ceiling")),
            ip_rating=_optional_str(properties.get(f"{pset}IPRating")),
        )
        return RopeLightFixture(
            _entity_guid(fixture),
            str(fixture.Tag or fixture.Name or _entity_guid(fixture)),
            room_id,
            IfcRepository._parse_path(properties.get(f"{pset}PathPointsMm")),
            spec,
            str(properties.get(f"{pset}SwitchingGroup") or "MAIN"),
            _split_notes(properties.get(f"{pset}Notes")),
        )

    @classmethod
    def _luminaire_from_model(
        cls,
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
    ) -> InstalledLuminaire:
        kind = cls._flatten_properties(fixture).get("Pset_HomeTwinLighting.FixtureKind")
        if kind == "recessed_spotlight":
            return cls._fixture_from_model(model, fixture)
        if kind == "pendant_bulb":
            return cls._pendant_from_model(model, fixture)
        if kind == "rope_light":
            return cls._rope_from_model(model, fixture)
        raise ValueError(f"Unsupported Home Twin fixture kind {kind!r}")

    def get_luminaires(self, room_id: str) -> tuple[InstalledLuminaire, ...]:
        luminaires: list[InstalledLuminaire] = []
        for fixture in self.model.by_type("IfcLightFixture"):
            kind = self._flatten_properties(fixture).get("Pset_HomeTwinLighting.FixtureKind")
            if kind not in {"recessed_spotlight", "pendant_bulb", "rope_light"}:
                continue
            parsed = self._luminaire_from_model(self.model, fixture)
            if parsed.room_id == room_id:
                luminaires.append(parsed)
        return tuple(sorted(luminaires, key=lambda item: (item.tag, item.id)))

    def _find_fixture_entity(
        self,
        model: ifcopenshell.file,
        fixture_id: str,
        room_id: str | None = None,
    ) -> ifcopenshell.entity_instance:
        try:
            by_guid = model.by_guid(fixture_id)
        except RuntimeError:
            by_guid = None
        if by_guid is not None and by_guid.is_a("IfcLightFixture"):
            container = element_util.get_container(by_guid)
            if room_id is None or (
                container is not None
                and container.is_a("IfcSpace")
                and _entity_guid(container) == room_id
            ):
                return by_guid
            raise KeyError(f"Fixture {fixture_id!r} is not in room {room_id!r}")
        matches = [
            fixture
            for fixture in model.by_type("IfcLightFixture")
            if fixture.Tag == fixture_id
            and (
                room_id is None
                or (
                    (container := element_util.get_container(fixture)) is not None
                    and container.is_a("IfcSpace")
                    and _entity_guid(container) == room_id
                )
            )
        ]
        if not matches:
            raise KeyError(f"Fixture {fixture_id!r} was not found")
        return sorted(matches, key=_entity_guid)[0]

    @staticmethod
    def _find_switch_entity(
        model: ifcopenshell.file,
        switch_id: str,
        room_id: str | None = None,
    ) -> ifcopenshell.entity_instance:
        try:
            by_guid = model.by_guid(switch_id)
        except RuntimeError:
            by_guid = None
        if by_guid is not None and by_guid.is_a("IfcSwitchingDevice"):
            container = element_util.get_container(by_guid)
            if room_id is None or (
                container is not None
                and container.is_a("IfcSpace")
                and _entity_guid(container) == room_id
            ):
                return by_guid
            raise KeyError(f"Wall switch {switch_id!r} is not in room {room_id!r}")
        matches = [
            device
            for device in model.by_type("IfcSwitchingDevice")
            if device.Tag == switch_id
            and (
                room_id is None
                or (
                    (container := element_util.get_container(device)) is not None
                    and container.is_a("IfcSpace")
                    and _entity_guid(container) == room_id
                )
            )
        ]
        if not matches:
            raise KeyError(f"Wall switch {switch_id!r} was not found")
        return sorted(matches, key=_entity_guid)[0]

    def get_light_fixture(self, fixture_id: str) -> LightFixture:
        return self._fixture_from_model(self.model, self._find_fixture_entity(self.model, fixture_id))

    @staticmethod
    def _body_context(model: ifcopenshell.file) -> ifcopenshell.entity_instance:
        contexts = [
            context
            for context in model.by_type("IfcGeometricRepresentationSubContext")
            if context.ContextIdentifier == "Body"
        ]
        if not contexts:
            parent = ifcopenshell.api.run("context.add_context", model, context_type="Model")
            return ifcopenshell.api.run(
                "context.add_context",
                model,
                context_type="Model",
                context_identifier="Body",
                target_view="MODEL_VIEW",
                parent=parent,
            )
        return contexts[0]

    @staticmethod
    def _lighting_properties(model: ifcopenshell.file, planned: PlannedSpotlight) -> dict[str, Any]:
        spec = planned.spec
        properties: dict[str, Any] = {
            "FixtureKind": "recessed_spotlight",
            "Model": spec.model or "",
            "Lumens": spec.lumens,
            "BeamAngleDegrees": spec.beam_angle_deg,
            "CCTKelvin": spec.cct_kelvin,
            "CRI": spec.cri,
            "Dimmable": spec.dimmable,
            "SwitchingGroup": planned.switching_group,
            "DiameterMm": spec.diameter_mm,
            "CutOutDiameterMm": spec.cutout_diameter_mm,
            "MountingDepthMm": spec.mounting_depth_mm,
            "RoomId": planned.room_id,
            # Typed explicitly: a straight-down (0, 0, -1) aim would otherwise be saved
            # as IfcInteger, and editing keeps that type, truncating any later tilt.
            "DirectionX": model.createIfcReal(float(planned.direction.x)),
            "DirectionY": model.createIfcReal(float(planned.direction.y)),
            "DirectionZ": model.createIfcReal(float(planned.direction.z)),
            "IESPath": spec.ies_path or "",
            "PeakCandela": spec.peak_candela,
            "IPRating": spec.ip_rating or "",
            "Notes": _join_notes(planned.notes),
        }
        return properties

    @staticmethod
    def _pendant_properties(planned: PlannedPendant) -> dict[str, Any]:
        spec = planned.spec
        return {
            "FixtureKind": "pendant_bulb",
            "Model": spec.model or "",
            "Lumens": spec.lumens,
            "CCTKelvin": spec.cct_kelvin,
            "CRI": spec.cri,
            "Dimmable": spec.dimmable,
            "SwitchingGroup": planned.switching_group,
            "DropMm": spec.drop_mm,
            "CanopyDiameterMm": spec.canopy_diameter_mm,
            "CanopyDepthMm": spec.canopy_depth_mm,
            "BulbDiameterMm": spec.bulb_diameter_mm,
            "LampCount": spec.lamp_count,
            "RoomId": planned.room_id,
            "IESPath": spec.ies_path or "",
            "Notes": _join_notes(planned.notes),
        }

    @classmethod
    def _rope_properties(cls, planned: PlannedRopeLight) -> dict[str, Any]:
        spec = planned.spec
        return {
            "FixtureKind": "rope_light",
            "Model": spec.model or "",
            "LumensPerMetre": spec.lumens_per_m,
            "CCTKelvin": spec.cct_kelvin,
            "CRI": spec.cri,
            "Dimmable": spec.dimmable,
            "SwitchingGroup": planned.switching_group,
            "DiameterMm": spec.diameter_mm,
            "MinimumBendRadiusMm": spec.minimum_bend_radius_mm,
            "Mounting": spec.mounting.value,
            "IPRating": spec.ip_rating or "",
            "PathPointsMm": cls._serialise_path(planned.path),
            "RoomId": planned.room_id,
            "Notes": _join_notes(planned.notes),
        }

    @classmethod
    def _fixture_representation(
        cls,
        model: ifcopenshell.file,
        spec: SpotlightSpec,
    ) -> ifcopenshell.entity_instance:
        """A recessed downlight: the can in the void, the trim proud of the ceiling.

        ``mounting_depth_mm`` is the depth *above* the finished ceiling face, so
        it extrudes up. Only ``TRIM_PROJECTION_MM`` of bezel stands below, which
        is what a flush-fitted downlight looks like from the room.
        """

        factor = unit_util.calculate_unit_scale(model) * 1000
        builder = ShapeBuilder(model)
        projection = TRIM_PROJECTION_MM / factor
        trim = builder.extrude(
            builder.circle(center=(0, 0), radius=spec.diameter_mm / 2 / factor),
            magnitude=projection,
            position=(0, 0, -projection),
        )
        can = builder.extrude(
            builder.circle(center=(0, 0), radius=spec.cutout_diameter_mm / 2 / factor),
            magnitude=spec.mounting_depth_mm / factor,
            position=(0, 0, 0),
        )
        return builder.get_representation(cls._body_context(model), [trim, can])

    @classmethod
    def _pendant_representation(
        cls,
        model: ifcopenshell.file,
        spec: PendantSpec,
    ) -> ifcopenshell.entity_instance:
        factor = unit_util.calculate_unit_scale(model) * 1000
        builder = ShapeBuilder(model)
        canopy_radius = spec.canopy_diameter_mm / 2 / factor
        canopy_depth = spec.canopy_depth_mm / factor
        drop = spec.drop_mm / factor
        canopy = builder.extrude(
            builder.circle(center=(0, 0), radius=canopy_radius),
            magnitude=canopy_depth,
            position=(0, 0, -canopy_depth),
        )
        cord_radius = max(1.5 / factor, spec.bulb_diameter_mm / 2 / factor * 0.025)
        items = [canopy]

        if spec.lamp_count == 1:
            bulb_radius = spec.bulb_diameter_mm / 2 / factor
            cord_end = min(-canopy_depth, -drop + bulb_radius)
            items.append(
                builder.create_swept_disk_solid(
                    builder.polyline(((0, 0, -canopy_depth), (0, 0, cord_end))), cord_radius
                )
            )
            items.append(builder.sphere(radius=bulb_radius, center=(0, 0, -drop)))
            return builder.get_representation(cls._body_context(model), items)

        # A cluster: the stated diameter is the spread, the shades sit on a ring
        # inside it, and their drops stagger so it reads as a cluster and not as
        # a ring of identical pendants.
        shade_radius = spec.bulb_diameter_mm * 0.15 / factor
        ring_radius = spec.bulb_diameter_mm / 2 / factor - shade_radius
        for index in range(spec.lamp_count):
            angle = 2 * math.pi * index / spec.lamp_count
            x, y = ring_radius * math.cos(angle), ring_radius * math.sin(angle)
            stagger = (spec.bulb_diameter_mm * 0.13 / factor) * (index % 3 - 1)
            centre = -drop + stagger
            items.append(
                builder.create_swept_disk_solid(
                    builder.polyline(
                        ((0, 0, -canopy_depth), (x, y, min(-canopy_depth, centre + shade_radius)))
                    ),
                    cord_radius,
                )
            )
            items.append(builder.sphere(radius=shade_radius, center=(x, y, centre)))
        return builder.get_representation(cls._body_context(model), items)

    @classmethod
    def _rope_representation(
        cls,
        model: ifcopenshell.file,
        path: tuple[Point3D, ...],
        spec: RopeLightSpec,
    ) -> ifcopenshell.entity_instance:
        factor = unit_util.calculate_unit_scale(model) * 1000
        origin = path[0]
        coordinates = tuple(
            (
                (point.x - origin.x) / factor,
                (point.y - origin.y) / factor,
                (point.z - origin.z) / factor,
            )
            for point in path
        )
        builder = ShapeBuilder(model)
        curve = builder.polyline(coordinates)
        solid = builder.create_swept_disk_solid(curve, spec.diameter_mm / 2 / factor)
        return builder.get_representation(cls._body_context(model), solid)

    @staticmethod
    def _placement_matrix(point: Point3D, direction: Vector3D) -> np.ndarray:
        target = np.array([direction.x, direction.y, direction.z], dtype=float)
        target /= np.linalg.norm(target)
        local_z = -target
        reference = np.array([0.0, 1.0, 0.0]) if abs(local_z[1]) < 0.99 else np.array([1.0, 0.0, 0.0])
        local_x = np.cross(reference, local_z)
        local_x /= np.linalg.norm(local_x)
        local_y = np.cross(local_z, local_x)
        matrix = np.eye(4)
        matrix[:3, :3] = np.column_stack((local_x, local_y, local_z))
        matrix[:3, 3] = [point.x / 1000, point.y / 1000, point.z / 1000]
        return matrix

    @staticmethod
    def _lighting_pset(fixture: ifcopenshell.entity_instance) -> ifcopenshell.entity_instance | None:
        for relationship in getattr(fixture, "IsDefinedBy", ()) or ():
            definition = getattr(relationship, "RelatingPropertyDefinition", None)
            if (
                definition is not None
                and definition.is_a("IfcPropertySet")
                and definition.Name == "Pset_HomeTwinLighting"
            ):
                return definition
        return None

    @classmethod
    def _create_fixture(cls, model: ifcopenshell.file, planned: PlannedSpotlight) -> ifcopenshell.entity_instance:
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        fixture = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcLightFixture",
            predefined_type="LIGHTEMITTINGDIODE",
            name=planned.tag,
        )
        fixture.Tag = planned.tag
        representation = cls._fixture_representation(model, planned.spec)
        ifcopenshell.api.run("geometry.assign_representation", model, product=fixture, representation=representation)
        matrix = cls._placement_matrix(planned.point, planned.direction)
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=fixture, matrix=matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[fixture], relating_structure=room)
        pset = ifcopenshell.api.run("pset.add_pset", model, product=fixture, name="Pset_HomeTwinLighting")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=cls._lighting_properties(model, planned))
        return fixture

    @classmethod
    def _update_fixture_entity(
        cls,
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
        planned: PlannedSpotlight,
    ) -> None:
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        fixture.Name = planned.tag
        fixture.Tag = planned.tag
        old_representations = tuple(getattr(getattr(fixture, "Representation", None), "Representations", ()) or ())
        for representation in old_representations:
            ifcopenshell.api.run(
                "geometry.unassign_representation",
                model,
                product=fixture,
                representation=representation,
            )
            ifcopenshell.api.run("geometry.remove_representation", model, representation=representation)
        representation = cls._fixture_representation(model, planned.spec)
        ifcopenshell.api.run("geometry.assign_representation", model, product=fixture, representation=representation)
        matrix = cls._placement_matrix(planned.point, planned.direction)
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=fixture, matrix=matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[fixture], relating_structure=room)
        pset = cls._lighting_pset(fixture)
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=fixture, name="Pset_HomeTwinLighting")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=cls._lighting_properties(model, planned))

    @staticmethod
    def _replace_representation(
        model: ifcopenshell.file,
        product: ifcopenshell.entity_instance,
        representation: ifcopenshell.entity_instance,
    ) -> None:
        old_representations = tuple(
            getattr(getattr(product, "Representation", None), "Representations", ()) or ()
        )
        for old in old_representations:
            ifcopenshell.api.run(
                "geometry.unassign_representation",
                model,
                product=product,
                representation=old,
            )
            ifcopenshell.api.run("geometry.remove_representation", model, representation=old)
        ifcopenshell.api.run(
            "geometry.assign_representation",
            model,
            product=product,
            representation=representation,
        )

    @classmethod
    def _create_luminaire(
        cls,
        model: ifcopenshell.file,
        planned: PlannedSpotlight | PlannedPendant | PlannedRopeLight,
    ) -> ifcopenshell.entity_instance:
        if isinstance(planned, PlannedSpotlight):
            return cls._create_fixture(model, planned)
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        fixture = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcLightFixture",
            predefined_type="LIGHTEMITTINGDIODE",
            name=planned.tag,
        )
        fixture.Tag = planned.tag
        if isinstance(planned, PlannedPendant):
            representation = cls._pendant_representation(model, planned.spec)
            point = planned.point
            properties = cls._pendant_properties(planned)
        else:
            representation = cls._rope_representation(model, planned.path, planned.spec)
            point = planned.path[0]
            properties = cls._rope_properties(planned)
        ifcopenshell.api.run(
            "geometry.assign_representation",
            model,
            product=fixture,
            representation=representation,
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=fixture,
            matrix=cls._placement_matrix(point, Vector3D(0, 0, -1)),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[fixture], relating_structure=room)
        pset = ifcopenshell.api.run("pset.add_pset", model, product=fixture, name="Pset_HomeTwinLighting")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        return fixture

    @classmethod
    def _update_luminaire_entity(
        cls,
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
        planned: PlannedSpotlight | PlannedPendant | PlannedRopeLight,
    ) -> None:
        if isinstance(planned, PlannedSpotlight):
            cls._update_fixture_entity(model, fixture, planned)
            return
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        fixture.Name = planned.tag
        fixture.Tag = planned.tag
        if isinstance(planned, PlannedPendant):
            representation = cls._pendant_representation(model, planned.spec)
            point = planned.point
            properties = cls._pendant_properties(planned)
        else:
            representation = cls._rope_representation(model, planned.path, planned.spec)
            point = planned.path[0]
            properties = cls._rope_properties(planned)
        cls._replace_representation(model, fixture, representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=fixture,
            matrix=cls._placement_matrix(point, Vector3D(0, 0, -1)),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[fixture], relating_structure=room)
        pset = cls._lighting_pset(fixture)
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=fixture, name="Pset_HomeTwinLighting")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)

    @staticmethod
    def _switch_pset(device: ifcopenshell.entity_instance) -> ifcopenshell.entity_instance | None:
        for relationship in getattr(device, "IsDefinedBy", ()) or ():
            definition = getattr(relationship, "RelatingPropertyDefinition", None)
            if (
                definition is not None
                and definition.is_a("IfcPropertySet")
                and definition.Name == "Pset_HomeTwinSwitch"
            ):
                return definition
        return None

    @staticmethod
    def _switch_properties(planned: PlannedWallSwitch) -> dict[str, Any]:
        return {
            "DeviceKind": planned.spec.kind.value,
            "HostWallId": planned.host_wall_id,
            "OffsetMm": planned.offset_mm,
            "MountingHeightMm": planned.mounting_height_mm,
            "SwitchingGroup": planned.switching_group,
            "WidthMm": planned.spec.width_mm,
            "HeightMm": planned.spec.height_mm,
            "DepthMm": planned.spec.depth_mm,
            "MountingFace": planned.mounting_face.value,
            "RoomId": planned.room_id,
        }

    @classmethod
    def _switch_representation(
        cls,
        model: ifcopenshell.file,
        spec: WallSwitchSpec,
    ) -> ifcopenshell.entity_instance:
        factor = unit_util.calculate_unit_scale(model) * 1000
        builder = ShapeBuilder(model)
        solid = builder.block(
            position=(-spec.width_mm / 2 / factor, -spec.depth_mm / 2 / factor, -spec.height_mm / 2 / factor),
            x_length=spec.width_mm / factor,
            y_length=spec.depth_mm / factor,
            z_length=spec.height_mm / factor,
        )
        return builder.get_representation(cls._body_context(model), solid)

    @staticmethod
    def _switch_placement_matrix(point: Point3D, wall: WallFace) -> np.ndarray:
        length = distance_2d(wall.start, wall.end)
        if length <= 0:
            raise ValueError(f"Host wall {wall.wall_id!r} has no length")
        local_x = np.array(
            [(wall.end.x - wall.start.x) / length, (wall.end.y - wall.start.y) / length, 0.0]
        )
        local_y = np.array([wall.inward_normal.x, wall.inward_normal.y, 0.0])
        local_y /= np.linalg.norm(local_y)
        matrix = np.eye(4)
        matrix[:3, :3] = np.column_stack((local_x, local_y, np.array([0.0, 0.0, 1.0])))
        matrix[:3, 3] = [point.x / 1000, point.y / 1000, point.z / 1000]
        return matrix

    @classmethod
    def _create_wall_switch(
        cls,
        model: ifcopenshell.file,
        planned: PlannedWallSwitch,
        wall: WallFace,
        floor_elevation_mm: float,
    ) -> ifcopenshell.entity_instance:
        from home_twin.lighting import wall_switch_point

        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        predefined = {
            WallSwitchKind.TOGGLE: "TOGGLESWITCH",
            WallSwitchKind.DIMMER: "DIMMERSWITCH",
            WallSwitchKind.MOMENTARY: "MOMENTARYSWITCH",
        }[planned.spec.kind]
        device = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcSwitchingDevice",
            predefined_type=predefined,
            name=planned.tag,
        )
        device.Tag = planned.tag
        representation = cls._switch_representation(model, planned.spec)
        ifcopenshell.api.run(
            "geometry.assign_representation",
            model,
            product=device,
            representation=representation,
        )
        point = wall_switch_point(planned, wall, floor_elevation_mm)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=device,
            matrix=cls._switch_placement_matrix(point, wall),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[device], relating_structure=room)
        pset = ifcopenshell.api.run("pset.add_pset", model, product=device, name="Pset_HomeTwinSwitch")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=cls._switch_properties(planned))
        return device

    @classmethod
    def _update_wall_switch_entity(
        cls,
        model: ifcopenshell.file,
        device: ifcopenshell.entity_instance,
        planned: PlannedWallSwitch,
        wall: WallFace,
        floor_elevation_mm: float,
    ) -> None:
        from home_twin.lighting import wall_switch_point

        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        device.Name = planned.tag
        device.Tag = planned.tag
        cls._replace_representation(model, device, cls._switch_representation(model, planned.spec))
        point = wall_switch_point(planned, wall, floor_elevation_mm)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=device,
            matrix=cls._switch_placement_matrix(point, wall),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[device], relating_structure=room)
        pset = cls._switch_pset(device)
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=device, name="Pset_HomeTwinSwitch")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=cls._switch_properties(planned))

    @staticmethod
    def _wall_switch_from_model(
        model: ifcopenshell.file,
        device: ifcopenshell.entity_instance,
    ) -> WallSwitch:
        properties = IfcRepository._flatten_properties(device)
        pset = "Pset_HomeTwinSwitch."
        container = element_util.get_container(device)
        room_id = _entity_guid(container) if container is not None and container.is_a("IfcSpace") else str(
            properties.get(f"{pset}RoomId") or ""
        )
        spec = WallSwitchSpec(
            kind=WallSwitchKind(str(properties.get(f"{pset}DeviceKind") or "toggle")),
            width_mm=float(properties.get(f"{pset}WidthMm") or 86),
            height_mm=float(properties.get(f"{pset}HeightMm") or 86),
            depth_mm=float(properties.get(f"{pset}DepthMm") or 10),
        )
        return WallSwitch(
            _entity_guid(device),
            str(device.Tag or device.Name or _entity_guid(device)),
            room_id,
            str(properties.get(f"{pset}HostWallId") or ""),
            float(properties.get(f"{pset}OffsetMm") or 0),
            float(properties.get(f"{pset}MountingHeightMm") or 0),
            str(properties.get(f"{pset}SwitchingGroup") or "MAIN"),
            IfcRepository._placement_point(model, device),
            spec,
            mounting_face=WallSwitchFace(str(properties.get(f"{pset}MountingFace") or "room")),
        )

    @staticmethod
    def _sensor_pset(device: ifcopenshell.entity_instance) -> ifcopenshell.entity_instance | None:
        for relationship in getattr(device, "IsDefinedBy", ()) or ():
            definition = getattr(relationship, "RelatingPropertyDefinition", None)
            if (
                definition is not None
                and definition.is_a("IfcPropertySet")
                and definition.Name == "Pset_HomeTwinSensor"
            ):
                return definition
        return None

    @staticmethod
    def _sensor_properties(planned: PlannedSensor) -> dict[str, Any]:
        return {
            "SensorKind": planned.spec.kind.value,
            "ControlsTag": planned.controls_tag,
            "SwitchingGroup": planned.switching_group,
            "RunOnMinutes": planned.run_on_minutes,
            "DiameterMm": planned.spec.diameter_mm,
            "CutoutDiameterMm": planned.spec.cutout_diameter_mm,
            "MountingDepthMm": planned.spec.mounting_depth_mm,
            "DetectionDiameterMm": planned.spec.detection_diameter_mm,
            "RoomId": planned.room_id,
        }

    @classmethod
    def _sensor_representation(
        cls,
        model: ifcopenshell.file,
        spec: SensorSpec,
    ) -> ifcopenshell.entity_instance:
        factor = unit_util.calculate_unit_scale(model) * 1000
        builder = ShapeBuilder(model)
        circle = builder.circle(center=(0, 0), radius=spec.diameter_mm / 2 / factor)
        depth = spec.mounting_depth_mm / factor
        solid = builder.extrude(circle, magnitude=depth, position=(0, 0, -depth))
        return builder.get_representation(cls._body_context(model), solid)

    @classmethod
    def _create_sensor(
        cls,
        model: ifcopenshell.file,
        planned: PlannedSensor,
    ) -> ifcopenshell.entity_instance:
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        device = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcSensor",
            predefined_type="MOVEMENTSENSOR",
            name=planned.tag,
        )
        device.Tag = planned.tag
        cls._update_sensor_entity(model, device, planned)
        return device

    @classmethod
    def _update_sensor_entity(
        cls,
        model: ifcopenshell.file,
        device: ifcopenshell.entity_instance,
        planned: PlannedSensor,
    ) -> None:
        room = model.by_guid(planned.room_id)
        if room is None or not room.is_a("IfcSpace"):
            raise ValueError(f"Room {planned.room_id!r} is not an IfcSpace")
        device.Name = planned.tag
        device.Tag = planned.tag
        cls._replace_representation(model, device, cls._sensor_representation(model, planned.spec))
        matrix = np.eye(4)
        matrix[:3, 3] = [planned.point.x / 1000, planned.point.y / 1000, planned.point.z / 1000]
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=device, matrix=matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[device], relating_structure=room)
        pset = cls._sensor_pset(device)
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=device, name="Pset_HomeTwinSensor")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=cls._sensor_properties(planned))
        # A sensor authored here is not a wet-room fixture. PIR01 and PIR02 were
        # authored by that layer first, and an entity left carrying both psets
        # reads as two different things at once.
        for relationship in tuple(getattr(device, "IsDefinedBy", ()) or ()):
            definition = getattr(relationship, "RelatingPropertyDefinition", None)
            if definition is not None and definition.Name == "Pset_HomeTwinWetRoom":
                ifcopenshell.api.run("pset.remove_pset", model, product=device, pset=definition)

    @staticmethod
    def _sensor_from_model(
        model: ifcopenshell.file,
        device: ifcopenshell.entity_instance,
    ) -> SensorDevice:
        properties = IfcRepository._flatten_properties(device)
        pset = "Pset_HomeTwinSensor."
        container = element_util.get_container(device)
        room_id = _entity_guid(container) if container is not None and container.is_a("IfcSpace") else str(
            properties.get(f"{pset}RoomId") or ""
        )
        detection = properties.get(f"{pset}DetectionDiameterMm")
        spec = SensorSpec(
            kind=SensorKind(str(properties.get(f"{pset}SensorKind") or "movement")),
            diameter_mm=float(properties.get(f"{pset}DiameterMm") or 70),
            cutout_diameter_mm=float(properties.get(f"{pset}CutoutDiameterMm") or 60),
            mounting_depth_mm=float(properties.get(f"{pset}MountingDepthMm") or 25),
            detection_diameter_mm=None if detection is None else float(detection),
        )
        group = properties.get(f"{pset}SwitchingGroup")
        controls = properties.get(f"{pset}ControlsTag")
        return SensorDevice(
            _entity_guid(device),
            str(device.Tag or device.Name or _entity_guid(device)),
            room_id,
            IfcRepository._placement_point(model, device),
            float(properties.get(f"{pset}RunOnMinutes") or 0),
            str(group) if group else None,
            str(controls) if controls else None,
            spec,
        )

    def get_sensors(self, room_id: str) -> tuple[SensorDevice, ...]:
        sensors = []
        for device in self.model.by_type("IfcSensor"):
            if "Pset_HomeTwinSensor.SensorKind" not in self._flatten_properties(device):
                continue
            parsed = self._sensor_from_model(self.model, device)
            if parsed.room_id == room_id:
                sensors.append(parsed)
        return tuple(sorted(sensors, key=lambda item: (item.tag, item.id)))

    def get_wall_switches(self, room_id: str) -> tuple[WallSwitch, ...]:
        switches = []
        for device in self.model.by_type("IfcSwitchingDevice"):
            properties = self._flatten_properties(device)
            if "Pset_HomeTwinSwitch.HostWallId" not in properties:
                continue
            parsed = self._wall_switch_from_model(self.model, device)
            if parsed.room_id == room_id:
                switches.append(parsed)
        return tuple(sorted(switches, key=lambda item: (item.tag, item.id)))

    @staticmethod
    def _group_pset(group: ifcopenshell.entity_instance) -> ifcopenshell.entity_instance | None:
        for relationship in getattr(group, "IsDefinedBy", ()) or ():
            definition = getattr(relationship, "RelatingPropertyDefinition", None)
            if (
                definition is not None
                and definition.is_a("IfcPropertySet")
                and definition.Name == "Pset_HomeTwinControl"
            ):
                return definition
        return None

    @classmethod
    def _control_group_label(cls, group: ifcopenshell.entity_instance) -> str | None:
        value = cls._flatten_properties(group).get("Pset_HomeTwinControl.Label")
        return str(value) if value else None

    @classmethod
    def _ensure_control_group(
        cls,
        model: ifcopenshell.file,
        label: str,
    ) -> ifcopenshell.entity_instance:
        for group in model.by_type("IfcGroup"):
            if cls._control_group_label(group) == label:
                return group
        group = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcGroup",
            name=f"Lighting control: {label}",
        )
        pset = ifcopenshell.api.run("pset.add_pset", model, product=group, name="Pset_HomeTwinControl")
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={"Label": label})
        return group

    @classmethod
    def _sync_control_groups(cls, model: ifcopenshell.file) -> tuple[str, ...]:
        members: defaultdict[str, list[ifcopenshell.entity_instance]] = defaultdict(list)
        for fixture in model.by_type("IfcLightFixture"):
            properties = cls._flatten_properties(fixture)
            if properties.get("Pset_HomeTwinLighting.FixtureKind") not in {
                "recessed_spotlight",
                "pendant_bulb",
                "rope_light",
            }:
                continue
            label = str(properties.get("Pset_HomeTwinLighting.SwitchingGroup") or "MAIN")
            members[label].append(fixture)
        for device in model.by_type("IfcSwitchingDevice"):
            properties = cls._flatten_properties(device)
            if "Pset_HomeTwinSwitch.HostWallId" not in properties:
                continue
            label = str(properties.get("Pset_HomeTwinSwitch.SwitchingGroup") or "MAIN")
            members[label].append(device)
        # A sensor switching lights is that group's switch, so it joins the group.
        for device in model.by_type("IfcSensor"):
            label = cls._flatten_properties(device).get("Pset_HomeTwinSensor.SwitchingGroup")
            if label:
                members[str(label)].append(device)

        changed: list[str] = []
        existing_groups = {
            label: group
            for group in model.by_type("IfcGroup")
            if (label := cls._control_group_label(group)) is not None
        }
        for label in sorted(set(members) | set(existing_groups)):
            products = members.get(label, [])
            group = existing_groups.get(label)
            if group is None:
                group = cls._ensure_control_group(model, label)
            existing = {
                _entity_guid(product): product
                for relationship in getattr(group, "IsGroupedBy", ()) or ()
                for product in relationship.RelatedObjects
                if getattr(product, "GlobalId", None)
            }
            expected = {_entity_guid(product): product for product in products}
            remove = [product for guid, product in existing.items() if guid not in expected]
            add = [product for guid, product in expected.items() if guid not in existing]
            if remove:
                ifcopenshell.api.run("group.unassign_group", model, products=remove, group=group)
            if add:
                ifcopenshell.api.run("group.assign_group", model, products=add, group=group)
            if remove or add:
                changed.append(_entity_guid(group))
            if not products:
                guid = _entity_guid(group)
                ifcopenshell.api.run("root.remove_product", model, product=group)
                changed.append(guid)
        return tuple(changed)

    def get_control_groups(self) -> tuple[ControlGroup, ...]:
        values: list[ControlGroup] = []
        for group in self.model.by_type("IfcGroup"):
            label = self._control_group_label(group)
            if label is None:
                continue
            related = [
                product
                for relationship in getattr(group, "IsGroupedBy", ()) or ()
                for product in relationship.RelatedObjects
            ]
            values.append(
                ControlGroup(
                    _entity_guid(group),
                    label,
                    tuple(sorted(_entity_guid(item) for item in related if item.is_a("IfcSwitchingDevice"))),
                    tuple(sorted(_entity_guid(item) for item in related if item.is_a("IfcLightFixture"))),
                    tuple(sorted(_entity_guid(item) for item in related if item.is_a("IfcSensor"))),
                )
            )
        return tuple(sorted(values, key=lambda item: (item.label, item.id)))

    @staticmethod
    def _as_planned_luminaire(
        item: InstalledLuminaire | PlannedSpotlight | PlannedPendant | PlannedRopeLight,
    ) -> PlannedSpotlight | PlannedPendant | PlannedRopeLight:
        if isinstance(item, (PlannedSpotlight, PlannedPendant, PlannedRopeLight)):
            return item
        if isinstance(item, LightFixture):
            return PlannedSpotlight(
                item.tag,
                item.room_id,
                item.point,
                item.spec,
                item.switching_group,
                item.direction,
                item.notes,
            )
        if isinstance(item, PendantFixture):
            return PlannedPendant(item.tag, item.room_id, item.point, item.spec, item.switching_group, item.notes)
        return PlannedRopeLight(item.tag, item.room_id, item.path, item.spec, item.switching_group, item.notes)

    @staticmethod
    def _as_planned_switch(item: PlannedWallSwitch | WallSwitch) -> PlannedWallSwitch:
        if isinstance(item, PlannedWallSwitch):
            return item
        return PlannedWallSwitch(
            item.tag,
            item.room_id,
            item.host_wall_id,
            item.offset_mm,
            item.mounting_height_mm,
            item.switching_group,
            item.spec,
            item.notes,
            item.mounting_face,
        )

    @classmethod
    def _verify_luminaire(
        cls,
        parsed: InstalledLuminaire,
        planned: PlannedSpotlight | PlannedPendant | PlannedRopeLight,
    ) -> None:
        if isinstance(planned, PlannedSpotlight):
            if not isinstance(parsed, LightFixture):
                raise ValueError("Saved luminaire kind does not match the request")
            cls._verify_fixture(parsed, planned)
            return
        if isinstance(planned, PlannedPendant):
            if not isinstance(parsed, PendantFixture):
                raise ValueError("Saved luminaire kind does not match the request")
            if distance_mm(parsed.point, planned.point) > 0.01 or parsed.spec != planned.spec:
                raise ValueError("Saved pendant geometry or properties do not match the request")
        else:
            if not isinstance(parsed, RopeLightFixture):
                raise ValueError("Saved luminaire kind does not match the request")
            if len(parsed.path) != len(planned.path) or any(
                distance_mm(actual, expected) > 0.01
                for actual, expected in zip(parsed.path, planned.path, strict=True)
            ):
                raise ValueError("Saved rope-light path does not match the request")
            if parsed.spec != planned.spec:
                raise ValueError("Saved rope-light properties do not match the request")
        if (
            parsed.tag != planned.tag
            or parsed.room_id != planned.room_id
            or parsed.switching_group != planned.switching_group
        ):
            raise ValueError("Saved luminaire identity, containment, or control group does not match the request")

    @staticmethod
    def _as_planned_sensor(item: PlannedSensor | SensorDevice) -> PlannedSensor:
        if isinstance(item, PlannedSensor):
            return item
        return PlannedSensor(
            item.tag,
            item.room_id,
            item.point,
            item.run_on_minutes,
            item.switching_group,
            item.controls_tag,
            item.spec,
            item.notes,
        )

    @staticmethod
    def _find_sensor_entity(
        model: ifcopenshell.file,
        sensor_id: str,
        room_id: str,
    ) -> ifcopenshell.entity_instance:
        try:
            by_guid = model.by_guid(sensor_id)
        except RuntimeError:
            by_guid = None
        candidates = [by_guid] if by_guid is not None and by_guid.is_a("IfcSensor") else []
        candidates.extend(device for device in model.by_type("IfcSensor") if device.Tag == sensor_id)
        for device in candidates:
            container = element_util.get_container(device)
            if container is not None and container.is_a("IfcSpace") and _entity_guid(container) == room_id:
                return device
        raise KeyError(f"Sensor {sensor_id!r} is not in room {room_id!r}")

    @staticmethod
    def _verify_sensor(parsed: SensorDevice, planned: PlannedSensor) -> None:
        if (
            parsed.tag != planned.tag
            or parsed.room_id != planned.room_id
            or parsed.controls_tag != planned.controls_tag
            or parsed.switching_group != planned.switching_group
            or abs(parsed.run_on_minutes - planned.run_on_minutes) > 0.01
            or parsed.spec != planned.spec
            or distance_mm(parsed.point, planned.point) > 0.01
        ):
            raise ValueError("Saved sensor semantics do not match the request")

    @classmethod
    def _verify_wall_switch(cls, parsed: WallSwitch, planned: PlannedWallSwitch, expected_point: Point3D) -> None:
        if (
            parsed.tag != planned.tag
            or parsed.room_id != planned.room_id
            or parsed.host_wall_id != planned.host_wall_id
            or abs(parsed.offset_mm - planned.offset_mm) > 0.01
            or abs(parsed.mounting_height_mm - planned.mounting_height_mm) > 0.01
            or parsed.switching_group != planned.switching_group
            or parsed.spec != planned.spec
            or parsed.mounting_face != planned.mounting_face
            or distance_mm(parsed.point, expected_point) > 0.01
        ):
            raise ValueError("Saved wall-switch semantics do not match the request")

    @staticmethod
    def _as_planned(item: Fixture) -> PlannedSpotlight:
        return PlannedSpotlight(
            item.tag,
            item.room_id,
            item.point,
            item.spec,
            item.switching_group,
            item.direction,
            item.notes,
        )

    @staticmethod
    def _verify_fixture(parsed: LightFixture, planned: PlannedSpotlight) -> None:
        if distance_mm(parsed.point, planned.point) > 0.01 or parsed.room_id != planned.room_id:
            raise ValueError("Saved fixture placement or containment does not match the request")
        if parsed.tag != planned.tag or parsed.switching_group != planned.switching_group:
            raise ValueError("Saved fixture identity or switching group does not match the request")
        if parsed.spec != planned.spec or parsed.direction != planned.direction:
            raise ValueError("Saved fixture properties do not match the request")

    @classmethod
    def _move_fixture_entity(
        cls,
        model: ifcopenshell.file,
        fixture: ifcopenshell.entity_instance,
        point: Point3D,
    ) -> None:
        placement = (
            placement_util.get_local_placement(fixture.ObjectPlacement) if fixture.ObjectPlacement else np.eye(4)
        )
        placement[:3, 3] = [point.x / 1000, point.y / 1000, point.z / 1000]
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=fixture, matrix=placement, is_si=True)

    @staticmethod
    def _schema_issue_count(model: ifcopenshell.file) -> int:
        logger = ifcopenshell.validate.json_logger()
        ifcopenshell.validate.validate(model, logger)
        return len(logger.statements)

    def _check_revision(self, expected_revision: str) -> None:
        disk_revision = _sha256(self.path)
        if disk_revision != self.revision:
            raise ExternalModification(
                f"{self.path} changed outside Home Twin: loaded {self.revision}, disk {disk_revision}"
            )
        if expected_revision != self.revision:
            raise StaleRevision(f"Expected {expected_revision}, current revision is {self.revision}")

    def _transaction(
        self,
        expected_revision: str,
        operation: Callable[[ifcopenshell.file], T],
        verify: Callable[[ifcopenshell.file, T], None],
    ) -> tuple[T, str]:
        self._check_revision(expected_revision)
        clone = ifcopenshell.file.from_string(self.model.to_string())
        baseline_issues = self._schema_issue_count(clone)
        result = operation(clone)
        if self._schema_issue_count(clone) > baseline_issues:
            raise ValueError("The mutation introduced an IFC schema validation issue")

        descriptor, temp_name = tempfile.mkstemp(prefix=f".{self.path.stem}-", suffix=".ifc", dir=self.path.parent)
        os.close(descriptor)
        temp_path = Path(temp_name)
        try:
            clone.write(temp_path)
            with temp_path.open("rb") as handle:
                os.fsync(handle.fileno())
            reopened = ifcopenshell.open(temp_path)
            verify(reopened, result)
            os.replace(temp_path, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except (AttributeError, OSError):
                pass
            self.model = reopened
            self.revision = _sha256(self.path)
            self._clear_caches()
            return result, self.revision
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def add_spotlight(self, planned: PlannedSpotlight, expected_revision: str) -> LightFixture:
        def operation(model: ifcopenshell.file) -> str:
            if any(fixture.Tag == planned.tag for fixture in model.by_type("IfcLightFixture")):
                raise ValueError(f"Fixture tag {planned.tag!r} already exists")
            return _entity_guid(self._create_fixture(model, planned))

        def verify(model: ifcopenshell.file, guid: str) -> None:
            fixture = model.by_guid(guid)
            if fixture is None:
                raise ValueError("Saved IFC does not contain the new fixture")
            parsed = self._fixture_from_model(model, fixture)
            self._verify_fixture(parsed, planned)

        guid, _ = self._transaction(expected_revision, operation, verify)
        return self.get_light_fixture(guid)

    def move_fixture(self, fixture_id: str, point: Point3D, expected_revision: str) -> LightFixture:
        def operation(model: ifcopenshell.file) -> str:
            fixture = self._find_fixture_entity(model, fixture_id)
            self._move_fixture_entity(model, fixture, point)
            return _entity_guid(fixture)

        def verify(model: ifcopenshell.file, guid: str) -> None:
            fixture = model.by_guid(guid)
            if fixture is None or distance_mm(self._fixture_from_model(model, fixture).point, point) > 0.01:
                raise ValueError("Saved fixture placement does not match the request")

        guid, _ = self._transaction(expected_revision, operation, verify)
        return self.get_light_fixture(guid)

    def delete_fixture(self, fixture_id: str, expected_revision: str) -> MutationResult:
        def operation(model: ifcopenshell.file) -> str:
            fixture = self._find_fixture_entity(model, fixture_id)
            guid = _entity_guid(fixture)
            ifcopenshell.api.run("root.remove_product", model, product=fixture)
            return guid

        def verify(model: ifcopenshell.file, guid: str) -> None:
            # by_guid raises for an absent instance rather than returning None,
            # so the successful case is the exception, not a falsy result.
            try:
                model.by_guid(guid)
            except RuntimeError:
                return
            raise ValueError("Saved IFC still contains the deleted fixture")

        guid, revision = self._transaction(expected_revision, operation, verify)
        return MutationResult(revision, (guid,))

    def apply_lighting_layout(self, layout: LightingLayout, expected_revision: str) -> MutationResult:
        expected: dict[str, PlannedSpotlight] = {}

        def operation(model: ifcopenshell.file) -> tuple[str, ...]:
            changed: list[str] = []
            retained: set[str] = set()
            for item in sorted(layout.fixtures, key=lambda fixture: fixture.tag):
                planned = self._as_planned(item)
                try:
                    existing = self._find_fixture_entity(
                        model,
                        getattr(item, "id", item.tag),
                        planned.room_id,
                    )
                except KeyError:
                    existing = self._create_fixture(model, planned)
                else:
                    self._update_fixture_entity(model, existing, planned)
                guid = _entity_guid(existing)
                changed.append(guid)
                retained.add(guid)
                expected[guid] = planned
            for fixture in tuple(model.by_type("IfcLightFixture")):
                properties = self._flatten_properties(fixture)
                if properties.get("Pset_HomeTwinLighting.FixtureKind") != "recessed_spotlight":
                    continue
                parsed = self._fixture_from_model(model, fixture)
                guid = _entity_guid(fixture)
                if parsed.room_id == layout.room_id and guid not in retained:
                    ifcopenshell.api.run("root.remove_product", model, product=fixture)
                    changed.append(guid)
            return tuple(changed)

        def verify(model: ifcopenshell.file, guids: tuple[str, ...]) -> None:
            for guid, planned in expected.items():
                fixture = model.by_guid(guid)
                if fixture is None:
                    raise ValueError(f"Saved layout fixture {guid} is missing")
                self._verify_fixture(self._fixture_from_model(model, fixture), planned)
            actual_tags = {
                self._fixture_from_model(model, fixture).tag
                for fixture in model.by_type("IfcLightFixture")
                if self._fixture_from_model(model, fixture).room_id == layout.room_id
                and self._flatten_properties(fixture).get("Pset_HomeTwinLighting.FixtureKind") == "recessed_spotlight"
            }
            if actual_tags != {item.tag for item in layout.fixtures}:
                raise ValueError("Saved room fixture set does not match the requested layout")

        changed, revision = self._transaction(expected_revision, operation, verify)
        return MutationResult(revision, changed)

    def apply_room_lighting_design(
        self,
        design: RoomLightingDesign,
        expected_revision: str,
    ) -> MutationResult:
        """Persist all known luminaires and wall switches in one verified room transaction."""

        context = self.get_room_context(design.room_id)
        wall_lookup = {wall.wall_id: wall for wall in context.walls}
        planned_luminaires: dict[str, PlannedSpotlight | PlannedPendant | PlannedRopeLight] = {}
        planned_switches: dict[str, tuple[PlannedWallSwitch, Point3D]] = {}
        planned_sensors: dict[str, PlannedSensor] = {}

        def operation(model: ifcopenshell.file) -> tuple[str, ...]:
            from home_twin.lighting import wall_switch_point

            changed: list[str] = []
            retained_lights: set[str] = set()
            retained_switches: set[str] = set()
            retained_sensors: set[str] = set()
            for item in sorted(design.luminaires, key=lambda candidate: candidate.tag):
                planned = self._as_planned_luminaire(item)
                try:
                    existing = self._find_fixture_entity(model, getattr(item, "id", item.tag))
                except KeyError:
                    existing = self._create_luminaire(model, planned)
                else:
                    self._update_luminaire_entity(model, existing, planned)
                guid = _entity_guid(existing)
                planned_luminaires[guid] = planned
                retained_lights.add(guid)
                changed.append(guid)

            for item in sorted(design.switches, key=lambda candidate: candidate.tag):
                planned = self._as_planned_switch(item)
                wall = wall_lookup.get(planned.host_wall_id)
                if wall is None:
                    raise ValueError(f"Switch host wall {planned.host_wall_id!r} is not in the room")
                try:
                    existing = self._find_switch_entity(
                        model,
                        getattr(item, "id", item.tag),
                        planned.room_id,
                    )
                except KeyError:
                    existing = self._create_wall_switch(
                        model,
                        planned,
                        wall,
                        context.room.elevation_mm,
                    )
                else:
                    self._update_wall_switch_entity(
                        model,
                        existing,
                        planned,
                        wall,
                        context.room.elevation_mm,
                    )
                guid = _entity_guid(existing)
                expected_point = wall_switch_point(planned, wall, context.room.elevation_mm)
                planned_switches[guid] = (planned, expected_point)
                retained_switches.add(guid)
                changed.append(guid)

            for item in sorted(design.sensors, key=lambda candidate: candidate.tag):
                planned = self._as_planned_sensor(item)
                # A Tag is the installation label an electrician works to, so it
                # has to be unique across the model, not just within the room.
                # The browser can only see one room's tags at a time.
                elsewhere = [
                    device
                    for device in model.by_type("IfcSensor")
                    if device.Tag == planned.tag
                    and self._sensor_from_model(model, device).room_id != planned.room_id
                ]
                if elsewhere:
                    raise ValueError(f"Sensor tag {planned.tag!r} is already used in another room")
                try:
                    existing = self._find_sensor_entity(model, getattr(item, "id", item.tag), planned.room_id)
                except KeyError:
                    existing = self._create_sensor(model, planned)
                else:
                    self._update_sensor_entity(model, existing, planned)
                guid = _entity_guid(existing)
                planned_sensors[guid] = planned
                retained_sensors.add(guid)
                changed.append(guid)

            for device in tuple(model.by_type("IfcSensor")):
                if "Pset_HomeTwinSensor.SensorKind" not in self._flatten_properties(device):
                    continue
                guid = _entity_guid(device)
                if (
                    self._sensor_from_model(model, device).room_id == design.room_id
                    and guid not in retained_sensors
                ):
                    ifcopenshell.api.run("root.remove_product", model, product=device)
                    changed.append(guid)

            for fixture in tuple(model.by_type("IfcLightFixture")):
                properties = self._flatten_properties(fixture)
                if properties.get("Pset_HomeTwinLighting.FixtureKind") not in {
                    "recessed_spotlight",
                    "pendant_bulb",
                    "rope_light",
                }:
                    continue
                parsed = self._luminaire_from_model(model, fixture)
                guid = _entity_guid(fixture)
                if parsed.room_id == design.room_id and guid not in retained_lights:
                    ifcopenshell.api.run("root.remove_product", model, product=fixture)
                    changed.append(guid)

            for device in tuple(model.by_type("IfcSwitchingDevice")):
                properties = self._flatten_properties(device)
                if "Pset_HomeTwinSwitch.HostWallId" not in properties:
                    continue
                parsed = self._wall_switch_from_model(model, device)
                guid = _entity_guid(device)
                if parsed.room_id == design.room_id and guid not in retained_switches:
                    ifcopenshell.api.run("root.remove_product", model, product=device)
                    changed.append(guid)

            changed.extend(self._sync_control_groups(model))
            return tuple(dict.fromkeys(changed))

        def verify(model: ifcopenshell.file, _changed: tuple[str, ...]) -> None:
            for guid, planned in planned_luminaires.items():
                entity = model.by_guid(guid)
                if entity is None:
                    raise ValueError(f"Saved luminaire {guid} is missing")
                self._verify_luminaire(self._luminaire_from_model(model, entity), planned)
            for guid, (planned, point) in planned_switches.items():
                entity = model.by_guid(guid)
                if entity is None:
                    raise ValueError(f"Saved wall switch {guid} is missing")
                self._verify_wall_switch(self._wall_switch_from_model(model, entity), planned, point)
            for guid, planned in planned_sensors.items():
                entity = model.by_guid(guid)
                if entity is None:
                    raise ValueError(f"Saved sensor {guid} is missing")
                self._verify_sensor(self._sensor_from_model(model, entity), planned)
            actual_sensors = {
                self._sensor_from_model(model, device).tag
                for device in model.by_type("IfcSensor")
                if "Pset_HomeTwinSensor.SensorKind" in self._flatten_properties(device)
                and self._sensor_from_model(model, device).room_id == design.room_id
            }
            if actual_sensors != {planned.tag for planned in planned_sensors.values()}:
                raise ValueError("Saved room sensor set does not match the requested design")

            actual_lights = {
                (self._luminaire_from_model(model, fixture).tag, type(self._luminaire_from_model(model, fixture)))
                for fixture in model.by_type("IfcLightFixture")
                if self._flatten_properties(fixture).get("Pset_HomeTwinLighting.FixtureKind")
                in {"recessed_spotlight", "pendant_bulb", "rope_light"}
                and self._luminaire_from_model(model, fixture).room_id == design.room_id
            }
            persisted_types = {
                PlannedSpotlight: LightFixture,
                PlannedPendant: PendantFixture,
                PlannedRopeLight: RopeLightFixture,
            }
            expected_lights = {
                (planned.tag, persisted_types[type(planned)]) for planned in planned_luminaires.values()
            }
            if actual_lights != expected_lights:
                raise ValueError("Saved room luminaire set does not match the requested design")
            actual_switches = {
                self._wall_switch_from_model(model, device).tag
                for device in model.by_type("IfcSwitchingDevice")
                if "Pset_HomeTwinSwitch.HostWallId" in self._flatten_properties(device)
                and self._wall_switch_from_model(model, device).room_id == design.room_id
            }
            if actual_switches != {planned.tag for planned, _ in planned_switches.values()}:
                raise ValueError("Saved room switch set does not match the requested design")

            for label in {
                *(planned.switching_group for planned in planned_luminaires.values()),
                *(planned.switching_group for planned, _ in planned_switches.values()),
                *(
                    planned.switching_group
                    for planned in planned_sensors.values()
                    if planned.switching_group is not None
                ),
            }:
                groups = [group for group in model.by_type("IfcGroup") if self._control_group_label(group) == label]
                if len(groups) != 1:
                    raise ValueError(f"Control group {label!r} was not saved exactly once")
                related = {
                    _entity_guid(product)
                    for relationship in getattr(groups[0], "IsGroupedBy", ()) or ()
                    for product in relationship.RelatedObjects
                    if getattr(product, "GlobalId", None)
                }
                expected_related = {
                    guid
                    for guid, planned in planned_luminaires.items()
                    if planned.switching_group == label
                } | {
                    guid
                    for guid, (planned, _) in planned_switches.items()
                    if planned.switching_group == label
                } | {
                    guid
                    for guid, planned in planned_sensors.items()
                    if planned.switching_group == label
                }
                if not expected_related <= related:
                    raise ValueError(f"Control group {label!r} membership does not match the requested design")

        changed, revision = self._transaction(expected_revision, operation, verify)
        return MutationResult(revision, changed)


def _convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew's monotone chain hull, used to recover a stair plan outline."""

    unique = sorted(set(points))
    if len(unique) < 3:
        return unique

    def half(seq: list[tuple[float, float]]) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for point in seq:
            while len(out) >= 2:
                (ax, ay), (bx, by) = out[-2], out[-1]
                if (bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax) > 0:
                    break
                out.pop()
            out.append(point)
        return out

    lower = half(unique)
    upper = half(unique[::-1])
    return lower[:-1] + upper[:-1]


def distance_mm(a: Point3D, b: Point3D) -> float:
    return float(np.linalg.norm(np.array([a.x - b.x, a.y - b.y, a.z - b.z])))
