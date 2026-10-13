"""Local browser API for IFC intake and residential lighting design."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import tempfile
import threading
import uuid
import webbrowser
from dataclasses import asdict, is_dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import ifcopenshell
import ifcopenshell.validate
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import Scope

from home_twin.fixtures import (
    LightingLayout,
    PendantSpec,
    PlannedPendant,
    PlannedRopeLight,
    PlannedSensor,
    PlannedSpotlight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightSpec,
    RopeMounting,
    SensorKind,
    SensorSpec,
    SpotlightSpec,
    WallSwitchFace,
    WallSwitchKind,
    WallSwitchSpec,
)
from home_twin.http_security import DEV_ORIGINS, LOOPBACK_HOSTS, WILDCARD_HOSTS, BodyLimits, BrowserRequests
from home_twin.model import HomeTwin, Point3D, Vector3D
from home_twin.plan_draft import (
    DraftPlanError,
    DraftReplacementRequired,
    DraftWouldDiscardFixtures,
    PlanDocument,
    build_draft,
    draft_path,
    load_plan,
    plan_path,
    review_plan,
    save_plan,
    underlay_stem,
)
from home_twin.validation import ExternalModification, HomeTwinError, LayoutRejected, StaleRevision

MAX_IFC_BYTES = 250 * 1024 * 1024
MAX_UNDERLAY_BYTES = 40 * 1024 * 1024
# Room for the multipart boundaries, part headers, and small form fields around the file.
MULTIPART_OVERHEAD_BYTES = 64 * 1024
IFC_TOO_LARGE = "IFC files must be 250 MB or smaller"
UNDERLAY_TOO_LARGE = "Reference images must be 40 MB or smaller"
UNDERLAY_SUFFIXES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
MAX_UNDERLAY_PIXELS = 40_000


class BuiltAssets(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Any:
        response = await super().get_response(path, scope)
        if response.status_code == 200 and re.search(r"-[A-Za-z0-9_-]{8,}\.[^./]+$", path):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _default_ui_dir() -> Path:
    repository_build = Path(__file__).resolve().parents[2] / "ui" / "dist"
    packaged_build = Path(__file__).resolve().parent / "ui_dist"
    return repository_build if repository_build.exists() else packaged_build


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PointInput(StrictModel):
    x: float
    y: float
    z: float


class VectorInput(StrictModel):
    x: float
    y: float
    z: float


class SpotlightInput(StrictModel):
    model: str | None = None
    lumens: Annotated[float | None, Field(gt=0)] = 650
    beam_angle_deg: Annotated[float, Field(gt=0, lt=180)] = 36
    cct_kelvin: Annotated[int | None, Field(gt=0)] = 3000
    cri: Annotated[float | None, Field(ge=0, le=100)] = 90
    dimmable: bool = True
    diameter_mm: Annotated[float, Field(gt=0)] = 90
    cutout_diameter_mm: Annotated[float, Field(gt=0)] = 80
    mounting_depth_mm: Annotated[float, Field(gt=0)] = 60
    ies_path: str | None = None
    peak_candela: Annotated[float | None, Field(gt=0)] = None
    ip_rating: str | None = None


class DraftFixtureInput(StrictModel):
    kind: Literal["recessed_spotlight"] = "recessed_spotlight"
    tag: Annotated[str, Field(min_length=1, max_length=80)]
    point: PointInput
    spec: SpotlightInput
    switching_group: Annotated[str, Field(min_length=1, max_length=120)]
    direction: VectorInput = Field(
        default_factory=lambda: VectorInput(x=0, y=0, z=-1)
    )
    notes: list[str] = Field(default_factory=list)


class PendantSpecInput(StrictModel):
    model: str | None = None
    lumens: Annotated[float | None, Field(gt=0)] = 800
    cct_kelvin: Annotated[int | None, Field(gt=0)] = 2700
    cri: Annotated[float | None, Field(ge=0, le=100)] = 90
    dimmable: bool = True
    drop_mm: Annotated[float, Field(gt=0)] = 600
    canopy_diameter_mm: Annotated[float, Field(gt=0)] = 100
    canopy_depth_mm: Annotated[float, Field(gt=0)] = 30
    bulb_diameter_mm: Annotated[float, Field(gt=0)] = 120
    ies_path: str | None = None


class DraftPendantInput(StrictModel):
    kind: Literal["pendant_bulb"]
    tag: Annotated[str, Field(min_length=1, max_length=80)]
    point: PointInput
    spec: PendantSpecInput
    switching_group: Annotated[str, Field(min_length=1, max_length=120)]
    notes: list[str] = Field(default_factory=list)


class RopeLightSpecInput(StrictModel):
    model: str | None = None
    lumens_per_m: Annotated[float | None, Field(gt=0)] = 900
    cct_kelvin: Annotated[int | None, Field(gt=0)] = 3000
    cri: Annotated[float | None, Field(ge=0, le=100)] = 90
    dimmable: bool = True
    diameter_mm: Annotated[float, Field(gt=0)] = 16
    minimum_bend_radius_mm: Annotated[float, Field(gt=0)] = 60
    mounting: Literal["ceiling", "wall", "concealed", "joinery"] = "ceiling"
    ip_rating: str | None = None


class DraftRopeLightInput(StrictModel):
    kind: Literal["rope_light"]
    tag: Annotated[str, Field(min_length=1, max_length=80)]
    path: Annotated[list[PointInput], Field(min_length=2)]
    spec: RopeLightSpecInput
    switching_group: Annotated[str, Field(min_length=1, max_length=120)]
    notes: list[str] = Field(default_factory=list)


class WallSwitchSpecInput(StrictModel):
    kind: Literal["toggle", "dimmer", "momentary"] = "toggle"
    width_mm: Annotated[float, Field(gt=0)] = 86
    height_mm: Annotated[float, Field(gt=0)] = 86
    depth_mm: Annotated[float, Field(gt=0)] = 10


class DraftWallSwitchInput(StrictModel):
    tag: Annotated[str, Field(min_length=1, max_length=80)]
    host_wall_id: Annotated[str, Field(min_length=1)]
    offset_mm: Annotated[float, Field(ge=0)]
    mounting_height_mm: Annotated[float, Field(gt=0)]
    switching_group: Annotated[str, Field(min_length=1, max_length=120)]
    spec: WallSwitchSpecInput = Field(default_factory=WallSwitchSpecInput)
    mounting_face: Literal["room", "opposite"] = "room"
    notes: list[str] = Field(default_factory=list)


class SensorSpecInput(StrictModel):
    kind: Literal["movement"] = "movement"
    diameter_mm: Annotated[float, Field(gt=0)] = 70
    cutout_diameter_mm: Annotated[float, Field(gt=0)] = 60
    mounting_depth_mm: Annotated[float, Field(gt=0)] = 25
    detection_diameter_mm: Annotated[float | None, Field(gt=0)] = None


class DraftSensorInput(StrictModel):
    tag: Annotated[str, Field(min_length=1, max_length=80)]
    point: PointInput
    run_on_minutes: Annotated[float, Field(gt=0)]
    switching_group: Annotated[str | None, Field(min_length=1, max_length=120)] = None
    controls_tag: Annotated[str | None, Field(min_length=1, max_length=80)] = None
    spec: SensorSpecInput = Field(default_factory=SensorSpecInput)
    notes: list[str] = Field(default_factory=list)


class LayoutInput(StrictModel):
    fixtures: list[DraftFixtureInput | DraftPendantInput | DraftRopeLightInput]
    switches: list[DraftWallSwitchInput] = Field(default_factory=list)
    sensors: list[DraftSensorInput] = Field(default_factory=list)


class CommitLayoutInput(LayoutInput):
    expected_revision: str


class OptimiseInput(StrictModel):
    fixture: SpotlightInput


class BakeInput(LayoutInput):
    step_mm: Annotated[float, Field(ge=50, le=1000)] = 150
    plane: str = "task"


class AdoptImportInput(StrictModel):
    expected_revision: str


class TraceReviewInput(StrictModel):
    document: PlanDocument


class TraceSaveInput(StrictModel):
    document: PlanDocument
    expected_revision: str


class TraceBuildInput(StrictModel):
    expected_draft_revision: str | None = None
    discard_fixtures: bool = False


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _point(value: PointInput) -> Point3D:
    return Point3D(value.x, value.y, value.z)


def _vector(value: VectorInput) -> Vector3D:
    return Vector3D(value.x, value.y, value.z)


def _spec(value: SpotlightInput) -> SpotlightSpec:
    return SpotlightSpec(**value.model_dump())


def _room_lighting_design(room_id: str, value: LayoutInput) -> RoomLightingDesign:
    luminaires = []
    for fixture in value.fixtures:
        if isinstance(fixture, DraftFixtureInput):
            luminaires.append(
                PlannedSpotlight(
                    tag=fixture.tag,
                    room_id=room_id,
                    point=_point(fixture.point),
                    spec=_spec(fixture.spec),
                    switching_group=fixture.switching_group,
                    direction=_vector(fixture.direction),
                    notes=tuple(fixture.notes),
                )
            )
        elif isinstance(fixture, DraftPendantInput):
            luminaires.append(
                PlannedPendant(
                    tag=fixture.tag,
                    room_id=room_id,
                    point=_point(fixture.point),
                    spec=PendantSpec(**fixture.spec.model_dump()),
                    switching_group=fixture.switching_group,
                    notes=tuple(fixture.notes),
                )
            )
        else:
            spec_values = fixture.spec.model_dump()
            spec_values["mounting"] = RopeMounting(spec_values["mounting"])
            luminaires.append(
                PlannedRopeLight(
                    tag=fixture.tag,
                    room_id=room_id,
                    path=tuple(_point(point) for point in fixture.path),
                    spec=RopeLightSpec(**spec_values),
                    switching_group=fixture.switching_group,
                    notes=tuple(fixture.notes),
                )
            )
    switches = tuple(
        PlannedWallSwitch(
            tag=device.tag,
            room_id=room_id,
            host_wall_id=device.host_wall_id,
            offset_mm=device.offset_mm,
            mounting_height_mm=device.mounting_height_mm,
            switching_group=device.switching_group,
            spec=WallSwitchSpec(
                kind=WallSwitchKind(device.spec.kind),
                width_mm=device.spec.width_mm,
                height_mm=device.spec.height_mm,
                depth_mm=device.spec.depth_mm,
            ),
            mounting_face=WallSwitchFace(device.mounting_face),
            notes=tuple(device.notes),
        )
        for device in value.switches
    )
    sensors = tuple(
        PlannedSensor(
            tag=sensor.tag,
            room_id=room_id,
            point=_point(sensor.point),
            run_on_minutes=sensor.run_on_minutes,
            switching_group=sensor.switching_group,
            controls_tag=sensor.controls_tag,
            spec=SensorSpec(
                kind=SensorKind(sensor.spec.kind),
                diameter_mm=sensor.spec.diameter_mm,
                cutout_diameter_mm=sensor.spec.cutout_diameter_mm,
                mounting_depth_mm=sensor.spec.mounting_depth_mm,
                detection_diameter_mm=sensor.spec.detection_diameter_mm,
            ),
            notes=tuple(sensor.notes),
        )
        for sensor in value.sensors
    )
    return RoomLightingDesign(room_id, tuple(luminaires), switches, sensors=sensors)


def _layout(room_id: str, value: LayoutInput) -> LightingLayout:
    return _room_lighting_design(room_id, value).spotlight_layout


def _sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _plan_validation_detail(error: ValidationError) -> str:
    """Explain a plan-source rejection, naming the likely cause.

    A source that carries fields this process has never heard of almost always
    means the server is older than the file, which happens whenever the plan
    schema gains a field while a server is left running. Saying so beats a raw
    validator dump, because the fix is a restart rather than an edit.
    """

    problems = error.errors()
    unknown = sorted(
        {str(item["loc"][-1]) for item in problems if item.get("type") == "extra_forbidden"}
    )
    if unknown and len(unknown) == len({str(item["loc"][-1]) for item in problems}):
        fields = ", ".join(unknown)
        return (
            f"This server does not know the plan fields {fields}. That usually means it is running older "
            f"code than the plan source; restart it and reload. If the fields really are wrong, remove them "
            f"from the source."
        )
    summary = "; ".join(f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in problems[:6])
    more = "" if len(problems) <= 6 else f" (and {len(problems) - 6} more)"
    return f"The plan trace source is invalid: {summary}{more}"


def _resolve_instant(value: str | None, timezone_name: str | None) -> datetime:
    """Read an ISO 8601 instant, defaulting a naive value to the site timezone."""

    zone: ZoneInfo | None = None
    if timezone_name:
        try:
            zone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise HTTPException(
                status_code=422,
                detail=f"The model states an unknown site timezone {timezone_name!r}",
            ) from error
    if value is None:
        return datetime.now(tz=zone or UTC)
    try:
        moment = datetime.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=f"{value!r} is not an ISO 8601 instant") from error
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=zone or UTC)


class UiState:
    def __init__(
        self, model_path: Path, config_dir: Path | None, export_dir: Path | None, plan: Path | None = None
    ) -> None:
        self.model_path = model_path.resolve()
        self.plan = plan
        self.config_dir = config_dir.resolve() if config_dir else None
        self.export_dir = export_dir.resolve() if export_dir else None
        self.project_root = (
            self.model_path.parent.parent if self.model_path.parent.name == "model" else self.model_path.parent
        )
        self.lock = threading.RLock()
        self.imports: dict[str, Path] = {}
        self._designs: dict[str, dict[str, Any]] = {}
        self._plan: dict[str, Any] | None = None
        self._remove_abandoned_imports()
        self.twin = self._open()
        self._read_revision = self.twin.revision

    def _remove_abandoned_imports(self) -> None:
        """Delete inspection temporaries left by an earlier interrupted run."""

        for stale in self.model_path.parent.glob(".incoming-*.ifc"):
            stale.unlink(missing_ok=True)

    @property
    def plan_path(self) -> Path:
        return plan_path(self.project_root, self.plan)

    @property
    def draft_path(self) -> Path:
        return draft_path(self.project_root, self.plan)

    @property
    def underlay_stem(self) -> str:
        return underlay_stem(self.plan_path)

    def underlay_path(self, file_name: str) -> Path:
        root = self.plan_path.parent.resolve()
        candidate = (root / Path(file_name).name).resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(status_code=400, detail="The underlay name must stay beside the plan source")
        return candidate

    def trace(self) -> dict[str, Any]:
        try:
            document, review, revision = load_plan(self.project_root, self.plan)
        except FileNotFoundError as error:
            raise HTTPException(
                status_code=404,
                detail=f"No plan trace source was found at {self.plan_path}",
            ) from error
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=_plan_validation_detail(error)) from error
        except Exception as error:
            raise HTTPException(status_code=422, detail=f"The plan trace source is invalid: {error}") from error
        draft = self.draft_path
        return {
            "document": document.model_dump(mode="json", by_alias=True, exclude_none=True),
            "review": _jsonable(review),
            "revision": revision,
            "source_path": str(self.plan_path),
            "underlay_url": "/api/trace/underlay/file" if document.underlay is not None else None,
            "draft": {
                "path": str(draft),
                "exists": draft.exists(),
                "revision": _sha256(draft) if draft.exists() else None,
                "is_open_model": draft.exists() and draft == self.model_path,
            },
        }

    def _open(self) -> HomeTwin:
        twin = HomeTwin.open(self.model_path, config_dir=self.config_dir)
        if self.export_dir:
            twin.export_dir = self.export_dir
        return twin

    def reload(self) -> HomeTwin:
        self.twin = self._open()
        self._designs.clear()
        self._plan = None
        return self.twin

    def _ensure_fresh(self) -> None:
        if self.model_path.exists() and _sha256(self.model_path) != self.twin.revision:
            self.reload()
        if self._read_revision != self.twin.revision:
            self._designs.clear()
            self._plan = None
            self._read_revision = self.twin.revision

    def discard_import(self, import_id: str) -> None:
        path = self.imports.pop(import_id, None)
        if path is not None:
            path.unlink(missing_ok=True)

    def design(self, room_id: str) -> dict[str, Any]:
        with self.lock:
            self._ensure_fresh()
            if room_id in self._designs:
                return self._designs[room_id]
            design = self._build_design(room_id)
            # Measured photometry can change independently of the IFC revision.
            if not any(fixture["spec"].get("ies_path") for fixture in design["fixtures"]):
                self._designs[room_id] = design
            return design

    def _build_design(self, room_id: str) -> dict[str, Any]:
        context = self.twin.get_room_context(room_id)
        lighting = self.twin.get_room_lighting_design(room_id)
        analysis = self.twin.analyse_room_lighting_design(lighting)
        return {
            "revision": self.twin.revision,
            "room": _jsonable(context.room),
            "ceiling": _jsonable(context.ceiling),
            "walls": _jsonable(context.walls),
            "openings": _jsonable(context.openings),
            "daylight_sources": _jsonable(context.daylight_sources),
            "stairs": _jsonable(context.stairs),
            "soffits": _jsonable(context.soffits),
            "furniture": _jsonable(context.furniture),
            "obstructions": _jsonable(context.obstructions),
            "fixtures": _jsonable(lighting.luminaires),
            "switches": _jsonable(lighting.switches),
            "sensors": _jsonable(lighting.sensors),
            "control_groups": _jsonable(lighting.control_groups),
            "analysis": _jsonable(analysis),
            "constraints": _jsonable(self.twin.constraints),
        }

    def whole_plan(self) -> dict[str, Any]:
        with self.lock:
            self._ensure_fresh()
            if self._plan is None:
                rooms: list[dict[str, Any]] = []
                for room in self.twin.get_rooms():
                    try:
                        context = self.twin.get_room_context(room.id)
                    except Exception:
                        continue
                    lighting = self.twin.get_room_lighting_design(room.id)
                    rooms.append(
                        {
                            "room": _jsonable(context.room),
                            "ceiling": _jsonable(context.ceiling),
                            "walls": _jsonable(context.walls),
                            "openings": _jsonable(context.openings),
                            "daylight_sources": _jsonable(context.daylight_sources),
                            "stairs": _jsonable(context.stairs),
                            "soffits": _jsonable(context.soffits),
                            "furniture": _jsonable(context.furniture),
                            "obstructions": _jsonable(context.obstructions),
                            "fixtures": _jsonable(lighting.luminaires),
                            "switches": _jsonable(lighting.switches),
                            "sensors": _jsonable(lighting.sensors),
                        }
                    )
                self._plan = {
                    "revision": self.twin.revision,
                    "site": _jsonable(self.twin.get_site()),
                    "constraints": _jsonable(self.twin.constraints),
                    "control_groups": _jsonable(self.twin.get_control_groups()),
                    "rooms": rooms,
                }
            return self._plan

    def inspect_import(self, path: Path, original_name: str) -> dict[str, Any]:
        blockers: list[str] = []
        warnings: list[str] = []
        try:
            candidate = HomeTwin.open(path, config_dir=self.config_dir)
            building = candidate.get_building()
            rooms = candidate.get_rooms()
        except Exception as error:
            raise HTTPException(status_code=422, detail=f"IfcOpenShell could not open this IFC: {error}") from error
        if not rooms:
            blockers.append("The IFC has no IfcSpace rooms.")
        ready_rooms = 0
        for room in rooms:
            try:
                context = candidate.get_room_context(room.id)
            except Exception as error:
                blockers.append(f"{room.name}: {error}")
                continue
            ready_rooms += 1
            if not context.walls:
                warnings.append(f"{room.name}: no bounding walls were resolved.")

        model = ifcopenshell.open(path)
        logger = ifcopenshell.validate.json_logger()
        ifcopenshell.validate.validate(model, logger)
        if logger.statements:
            warnings.append(f"IFC schema validation reported {len(logger.statements)} issue(s).")

        import_id = uuid.uuid4().hex
        self.imports[import_id] = path
        return {
            "import_id": import_id,
            "file_name": original_name,
            "size_bytes": path.stat().st_size,
            "building": _jsonable(building),
            "room_count": len(rooms),
            "ready_room_count": ready_rooms,
            "blockers": blockers,
            "warnings": warnings,
            "can_adopt": not blockers,
        }

    def adopt_import(self, import_id: str, expected_revision: str) -> dict[str, Any]:
        with self.lock:
            candidate_path = self.imports.get(import_id)
            if candidate_path is None or not candidate_path.exists():
                raise HTTPException(status_code=404, detail="This inspected IFC is no longer available.")
            disk_revision = _sha256(self.model_path)
            if disk_revision != self.twin.revision:
                raise ExternalModification(
                    f"{self.model_path} changed outside Home Twin: loaded {self.twin.revision}, disk {disk_revision}"
                )
            if expected_revision != self.twin.revision:
                raise StaleRevision(f"Expected {expected_revision}, current revision is {self.twin.revision}")

            summary = self.inspect_import(candidate_path, candidate_path.name)
            validation_import_id = str(summary["import_id"])
            self.imports.pop(validation_import_id, None)
            if not summary["can_adopt"]:
                raise HTTPException(status_code=422, detail={"code": "import_blocked", **summary})

            candidate = HomeTwin.open(candidate_path, config_dir=self.config_dir)
            expected_building = candidate.get_building()
            expected_rooms = {room.id for room in candidate.get_rooms()}
            backup_dir = self.model_path.parent / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_path = backup_dir / f"{self.model_path.stem}-{self.twin.revision.removeprefix('sha256:')[:12]}.ifc"
            shutil.copy2(self.model_path, backup_path)
            with backup_path.open("rb") as handle:
                os.fsync(handle.fileno())

            try:
                os.replace(candidate_path, self.model_path)
                reopened = self.reload()
                if reopened.get_building().id != expected_building.id:
                    raise RuntimeError("The adopted IFC building identity changed during replacement")
                if {room.id for room in reopened.get_rooms()} != expected_rooms:
                    raise RuntimeError("The adopted IFC room set changed during replacement")
            except Exception:
                descriptor, recovery_name = tempfile.mkstemp(
                    prefix=f".{self.model_path.stem}-recovery-",
                    suffix=".ifc",
                    dir=self.model_path.parent,
                )
                os.close(descriptor)
                recovery_path = Path(recovery_name)
                try:
                    shutil.copy2(backup_path, recovery_path)
                    os.replace(recovery_path, self.model_path)
                    self.reload()
                finally:
                    recovery_path.unlink(missing_ok=True)
                raise
            self.imports.pop(import_id, None)
            return {
                "revision": reopened.revision,
                "backup_path": str(backup_path),
                "building": _jsonable(reopened.get_building()),
                "rooms": _jsonable(reopened.get_rooms()),
            }


def _source_fingerprint() -> str:
    """A digest of the server's own Python sources, as they are on disk now.

    Python is loaded once. A fix edited after the process started is not in
    it, and the browser cannot tell: the answers just do not change. Comparing
    this against the value read at startup is what lets the page say so.
    """

    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    try:
        for path in sorted(root.rglob("*.py")):
            digest.update(path.name.encode())
            digest.update(str(path.stat().st_mtime_ns).encode())
    except OSError:
        return ""
    return digest.hexdigest()


def build_app(
    model_path: Path | str = Path("model/house.ifc"),
    *,
    config_dir: Path | str | None = None,
    export_dir: Path | str | None = None,
    ui_dir: Path | str | None = None,
    allowed_hosts: tuple[str, ...] = LOOPBACK_HOSTS,
    plan: Path | str | None = None,
) -> FastAPI:
    state = UiState(
        Path(model_path),
        Path(config_dir) if config_dir else None,
        Path(export_dir) if export_dir else None,
        Path(plan) if plan else None,
    )
    app = FastAPI(title="Home Twin", version="0.1.0")
    app.state.home_twin = state
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=4)
    app.add_middleware(
        BodyLimits,
        limits={
            "/api/imports": (MAX_IFC_BYTES + MULTIPART_OVERHEAD_BYTES, IFC_TOO_LARGE),
            "/api/trace/underlay": (MAX_UNDERLAY_BYTES + MULTIPART_OVERHEAD_BYTES, UNDERLAY_TOO_LARGE),
        },
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(DEV_ORIGINS),
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )
    app.add_middleware(BrowserRequests, allowed_hosts=allowed_hosts)

    @app.exception_handler(LayoutRejected)
    async def layout_rejected_handler(_request: Any, error: LayoutRejected) -> Any:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=422,
            content={"detail": {"code": error.code, "message": str(error), "report": _jsonable(error.report)}},
        )

    @app.exception_handler(HomeTwinError)
    async def home_twin_error_handler(_request: Any, error: HomeTwinError) -> Any:
        from fastapi.responses import JSONResponse

        status = 409 if isinstance(error, (StaleRevision, ExternalModification)) else 422
        return JSONResponse(status_code=status, content={"detail": {"code": error.code, "message": str(error)}})

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "revision": state.twin.revision}

    loaded_source = _source_fingerprint()

    @app.get("/api/project")
    def get_project() -> dict[str, Any]:
        with state.lock:
            state._ensure_fresh()
            return {
                "building": _jsonable(state.twin.get_building()),
                "storeys": _jsonable(state.twin.get_storeys()),
                "rooms": _jsonable(state.twin.get_rooms()),
                "model_path": str(state.model_path),
                "server_stale": _source_fingerprint() != loaded_source,
            }

    @app.get("/api/model.ifc")
    def get_ifc() -> FileResponse:
        return FileResponse(state.model_path, media_type="application/x-step", filename=state.model_path.name)

    @app.get("/api/plan")
    def get_whole_plan() -> dict[str, Any]:
        """Every room's geometry in one payload, for the whole-plan view.

        Fixtures and their saved analysis come along, but the on-demand shadow
        pass does not: one room at a time is the unit of design work, and baking
        the whole flat at once would be a long request nobody asked for.
        """

        return state.whole_plan()

    @app.get("/api/rooms/{room_id}/design")
    def get_room_design(room_id: str) -> dict[str, Any]:
        try:
            return state.design(room_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/rooms/{room_id}/validate")
    def validate_layout(room_id: str, body: LayoutInput) -> dict[str, Any]:
        lighting = _room_lighting_design(room_id, body)
        return {"report": _jsonable(state.twin.validate_room_lighting_design(lighting))}

    @app.post("/api/rooms/{room_id}/analysis")
    def analyse_layout(room_id: str, body: LayoutInput) -> dict[str, Any]:
        lighting = _room_lighting_design(room_id, body)
        return {"analysis": _jsonable(state.twin.analyse_room_lighting_design(lighting))}

    @app.post("/api/rooms/{room_id}/bake")
    def bake_lighting(room_id: str, body: BakeInput) -> dict[str, Any]:
        """Return an occlusion-aware surface for the submitted candidate layout.

        This is the deliberate, on-demand pass. It costs a few hundred
        milliseconds on a large room, so the browser asks for it rather than
        running it on every drag.
        """

        if body.plane not in {"floor", "task"}:
            raise HTTPException(status_code=422, detail="plane must be 'floor' or 'task'")
        layout = _layout(room_id, LayoutInput(fixtures=body.fixtures))
        return {
            "baked": _jsonable(
                state.twin.bake_lighting(layout, step_mm=body.step_mm, plane=body.plane)
            )
        }

    @app.post("/api/rooms/{room_id}/align")
    def align_layout_route(room_id: str, body: LayoutInput) -> dict[str, Any]:
        """Pull spotlights that nearly share an axis onto it, and report back."""

        from home_twin.lighting import align_layout

        aligned = align_layout(_layout(room_id, body), state.twin.constraints)
        return {
            "fixtures": _jsonable(aligned.fixtures),
            "report": _jsonable(state.twin.validate_lighting_layout(aligned)),
        }

    @app.post("/api/rooms/{room_id}/optimise")
    def optimise_layout(room_id: str, body: OptimiseInput) -> dict[str, Any]:
        return _jsonable(state.twin.optimise_spotlight_layout(room_id, _spec(body.fixture)))

    @app.post("/api/rooms/{room_id}/commit")
    def commit_layout(room_id: str, body: CommitLayoutInput) -> dict[str, Any]:
        with state.lock:
            result = state.twin.apply_room_lighting_design(
                _room_lighting_design(room_id, body),
                expected_revision=body.expected_revision,
            )
            return {"result": _jsonable(result), "design": state.design(room_id)}

    @app.get("/api/site")
    def get_site() -> dict[str, Any]:
        return {"site": _jsonable(state.twin.get_site())}

    @app.get("/api/rooms/{room_id}/daylight")
    def get_room_daylight(
        room_id: str,
        at: str | None = None,
        plane: str = "floor",
        step_minutes: int = 20,
    ) -> dict[str, Any]:
        """Return direct-sun geometry for one instant plus that day's sun path.

        ``at`` is an ISO 8601 instant. A naive value is read in the site
        timezone when the model states one, otherwise in UTC.
        """

        if plane not in {"floor", "task"}:
            raise HTTPException(status_code=422, detail="plane must be 'floor' or 'task'")
        try:
            context = state.twin.get_room_context(room_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        site = state.twin.get_site()
        moment = _resolve_instant(at, site.timezone)
        elevation = (
            context.room.elevation_mm + state.twin.constraints.task_plane_height_mm
            if plane == "task"
            else context.room.elevation_mm
        )
        daylight = state.twin.analyse_direct_sun(room_id, moment, plane_elevation_mm=elevation)
        path = state.twin.sun_path(moment, step_minutes=step_minutes)
        return {
            "daylight": _jsonable(daylight),
            "sun_path": _jsonable(path),
            "resolved_at": moment.isoformat(),
            "plane": plane,
        }

    @app.get("/api/trace")
    def get_trace() -> dict[str, Any]:
        return state.trace()

    @app.post("/api/trace/review")
    def review_trace(body: TraceReviewInput) -> dict[str, Any]:
        try:
            return {"review": _jsonable(review_plan(body.document))}
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/trace/save")
    def save_trace(body: TraceSaveInput) -> dict[str, Any]:
        with state.lock:
            try:
                revision, review = save_plan(
                    body.document,
                    state.project_root,
                    expected_revision=body.expected_revision,
                    plan=state.plan,
                )
            except DraftPlanError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            return {"revision": revision, "review": _jsonable(review), "trace": state.trace()}

    @app.post("/api/trace/build")
    def build_trace(body: TraceBuildInput) -> dict[str, Any]:
        with state.lock:
            try:
                report = build_draft(
                    state.project_root,
                    plan=state.plan,
                    replace_revision=body.expected_draft_revision,
                    discard_fixtures=body.discard_fixtures,
                )
            except DraftPlanError as error:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "plan_not_publishable", "message": str(error)},
                ) from error
            except DraftReplacementRequired as error:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "draft_replacement_required", "message": str(error)},
                ) from error
            except DraftWouldDiscardFixtures as error:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "draft_would_discard_fixtures", "message": str(error)},
                ) from error
            reloaded = report.path == state.model_path
            if reloaded:
                state.reload()
            return {
                "report": _jsonable(report),
                "model_reloaded": reloaded,
                "revision": state.twin.revision,
                "trace": state.trace(),
            }

    @app.post("/api/trace/underlay")
    async def upload_underlay(
        file: Annotated[UploadFile, File()],
        width_px: Annotated[int, Form(gt=0)],
        height_px: Annotated[int, Form(gt=0)],
    ) -> dict[str, Any]:
        """Store a calibration reference image beside the reviewed plan source.

        The browser reports the decoded pixel size, because the underlay is only
        a drawing to trace over and never building geometry.
        """

        suffix = Path(file.filename or "underlay.png").suffix.casefold()
        if suffix not in UNDERLAY_SUFFIXES:
            raise HTTPException(
                status_code=415,
                detail=f"Choose a {', '.join(sorted(UNDERLAY_SUFFIXES))} reference image",
            )
        if not 0 < width_px <= MAX_UNDERLAY_PIXELS or not 0 < height_px <= MAX_UNDERLAY_PIXELS:
            raise HTTPException(status_code=422, detail="The underlay pixel size is out of range")
        target = state.underlay_path(f"{state.underlay_stem}{suffix}")
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(prefix=".underlay-", suffix=suffix, dir=target.parent)
        os.close(descriptor)
        temp_path = Path(temp_name)
        total = 0
        try:
            with temp_path.open("wb") as handle:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_UNDERLAY_BYTES:
                        raise HTTPException(status_code=413, detail=UNDERLAY_TOO_LARGE)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            with state.lock:
                for existing in state.plan_path.parent.glob(f"{state.underlay_stem}.*"):
                    if existing != target:
                        existing.unlink(missing_ok=True)
                os.replace(temp_path, target)
            return {
                "file_name": target.name,
                "sha256": _sha256(target),
                "width_px": width_px,
                "height_px": height_px,
                "size_bytes": total,
            }
        finally:
            temp_path.unlink(missing_ok=True)

    @app.get("/api/trace/underlay/file")
    def download_underlay() -> FileResponse:
        document = load_plan(state.project_root, state.plan)[0]
        if document.underlay is None:
            raise HTTPException(status_code=404, detail="This plan trace has no underlay")
        path = state.underlay_path(document.underlay.file_name)
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"The underlay file {path.name} is missing")
        media_type = UNDERLAY_SUFFIXES.get(path.suffix.casefold(), "application/octet-stream")
        return FileResponse(path, media_type=media_type, filename=path.name)

    @app.delete("/api/trace/underlay", status_code=204)
    def delete_underlay() -> None:
        with state.lock:
            for existing in state.plan_path.parent.glob(f"{state.underlay_stem}.*"):
                existing.unlink(missing_ok=True)

    @app.post("/api/exports")
    def create_exports(room_id: str | None = None) -> dict[str, Any]:
        with state.lock:
            paths = state.twin.export_lighting(room_id=room_id)
        return {
            "revision": state.twin.revision,
            "files": [{"name": path.name, "url": f"/api/exports/{path.name}"} for path in paths],
        }

    @app.get("/api/exports/{file_name}")
    def download_export(file_name: str) -> FileResponse:
        allowed = {"lighting-layout.csv", "lighting-layout.json", "lighting-layout.svg"}
        if file_name not in allowed:
            raise HTTPException(status_code=404, detail="Export file not found")
        path = state.twin.export_dir / file_name
        if not path.exists():
            raise HTTPException(status_code=404, detail="Create exports before downloading this file")
        return FileResponse(path, filename=path.name)

    @app.post("/api/imports")
    async def inspect_ifc(file: Annotated[UploadFile, File()]) -> dict[str, Any]:
        original_name = Path(file.filename or "uploaded.ifc").name
        if Path(original_name).suffix.casefold() != ".ifc":
            raise HTTPException(
                status_code=415,
                detail=(
                    "Choose an IFC file. To bring in a drawing, trace it in the plan workspace "
                    "and build the draft instead."
                ),
            )
        descriptor, temp_name = tempfile.mkstemp(
            prefix=".incoming-",
            suffix=".ifc",
            dir=state.model_path.parent,
        )
        os.close(descriptor)
        temp_path = Path(temp_name)
        total = 0
        try:
            with temp_path.open("wb") as handle:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_IFC_BYTES:
                        raise HTTPException(status_code=413, detail=IFC_TOO_LARGE)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            return state.inspect_import(temp_path, original_name)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    @app.post("/api/imports/{import_id}/adopt")
    def adopt_ifc(import_id: str, body: AdoptImportInput) -> dict[str, Any]:
        return state.adopt_import(import_id, body.expected_revision)

    @app.delete("/api/imports/{import_id}", status_code=204)
    def discard_ifc(import_id: str) -> None:
        state.discard_import(import_id)

    resolved_ui = Path(ui_dir).resolve() if ui_dir else _default_ui_dir()
    if resolved_ui.exists():
        assets = resolved_ui / "assets"
        if assets.exists():
            app.mount("/assets", BuiltAssets(directory=assets), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            if path == "api" or path.startswith("api/"):
                raise HTTPException(status_code=404, detail=f"No API route matches /{path}")
            candidate = (resolved_ui / path).resolve()
            if path and candidate.is_relative_to(resolved_ui) and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(resolved_ui / "index.html", headers={"Cache-Control": "no-cache"})

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Home Twin browser UI")
    parser.add_argument("--model", type=Path, default=Path("model/house.ifc"))
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--exports", type=Path, default=None)
    parser.add_argument(
        "--plan",
        type=Path,
        default=None,
        help="Plan source to trace; defaults to model/references/plan.yaml, or m1-plan.yaml when only that exists",
    )
    parser.add_argument("--ui", type=Path, default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--allowed-host", action="append", default=[], help="Additional HTTP hostname or IP to serve")
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    wildcard = args.host in WILDCARD_HOSTS
    if wildcard and not args.allowed_host:
        parser.error(f"--host {args.host} serves every interface; name each client hostname or IP with --allowed-host")
    ui_path = args.ui.resolve() if args.ui else _default_ui_dir()
    if not ui_path.exists():
        raise SystemExit("UI build not found. Run `npm --prefix ui ci` and `npm --prefix ui run build` first.")
    if not args.no_open:
        browser_host = "127.0.0.1" if wildcard else f"[{args.host}]" if ":" in args.host else args.host
        threading.Timer(0.7, lambda: webbrowser.open(f"http://{browser_host}:{args.port}")).start()
    uvicorn.run(
        build_app(
            args.model,
            config_dir=args.config,
            export_dir=args.exports,
            ui_dir=ui_path,
            allowed_hosts=(*LOOPBACK_HOSTS, *(() if wildcard else (args.host,)), *args.allowed_host),
            plan=args.plan,
        ),
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()
