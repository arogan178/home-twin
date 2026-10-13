"""Small mesh builders for disposable IFC-derived finish geometry, in metres."""

import math

import bpy
from mathutils import Vector


def finish(item, material, bevel=0.0):
    item.data.materials.append(material)
    if bevel:
        modifier = item.modifiers.new("Soft edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 4
    for face in item.data.polygons:
        face.use_smooth = True
    modifier = item.modifiers.new("Face normals", "WEIGHTED_NORMAL")
    modifier.keep_sharp = True
    return item


def box(name, material, centre, size, bevel=0.002):
    bpy.ops.mesh.primitive_cube_add(size=1, location=centre)
    item = bpy.context.object
    item.name = name
    item.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(item, material, min(bevel, min(size) * 0.45))


def outline(width, depth, radius, steps=12):
    """Rounded plan rectangle; a half-width radius gives a stadium top."""
    radius = min(radius, width / 2, depth / 2)
    points = []
    for x, y, start in ((width / 2-radius, depth / 2-radius, 0),
                        (-width / 2+radius, depth / 2-radius, 90),
                        (-width / 2+radius, -depth / 2+radius, 180),
                        (width / 2-radius, -depth / 2+radius, 270)):
        for i in range(steps + 1):
            angle = math.radians(start + 90 * i / steps)
            point = (x + radius * math.cos(angle), y + radius * math.sin(angle))
            if not points or math.dist(points[-1], point) > 1e-8:
                points.append(point)
    if math.dist(points[0], points[-1]) < 1e-8:
        points.pop()
    return points


def slab(name, material, centre, size, radius, bevel=0.002):
    ring = outline(size[0], size[1], radius)
    count = len(ring)
    vertices = [(x, y, z) for z in (-size[2]/2, size[2]/2) for x, y in ring]
    faces = [tuple(reversed(range(count))), tuple(range(count, 2*count))]
    faces += [(i, (i+1) % count, (i+1) % count+count, i+count) for i in range(count)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    item = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(item)
    item.location = centre
    return finish(item, material, min(bevel, size[2]*0.3))


def rod(name, material, start, end, radius, tip=None):
    a, b = Vector(start), Vector(end)
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=radius, radius2=radius if tip is None else tip,
                                    depth=(b-a).length, location=(a+b)/2)
    item = bpy.context.object
    item.name = name
    item.rotation_euler = (b-a).to_track_quat("Z", "Y").to_euler()
    return finish(item, material, min(radius*0.18, 0.002))


def tube(name, material, points, radius):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 4
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(points)-1)
    for point, co in zip(spline.points, points, strict=True):
        point.co = (*co, 1)
    item = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(item)
    item.data.materials.append(material)
    return item


class DetailFrame:
    """Local X across, +Y toward the front, Z up; rotation about building Z."""

    def __init__(self, palette, centre, angle=0):
        self.palette, self.centre, self.angle = palette, Vector(centre), angle
        self.items = []

    def point(self, point):
        x, y, z = point
        c, s = math.cos(self.angle), math.sin(self.angle)
        return self.centre + Vector((x*c-y*s, x*s+y*c, z))

    def box(self, name, key, centre, size, bevel=0.002, radius=None):
        if radius is None:
            item = box(name, self.palette[key], self.point(centre), size, bevel)
        else:
            item = slab(name, self.palette[key], self.point(centre), size, radius, bevel)
        item.rotation_euler.z = self.angle
        self.items.append(item)
        return item

    def rod(self, name, key, start, end, radius, tip=None):
        item = rod(name, self.palette[key], self.point(start), self.point(end), radius, tip)
        self.items.append(item)
        return item

    def tube(self, name, key, points, radius):
        item = tube(name, self.palette[key], [self.point(p) for p in points], radius)
        self.items.append(item)
        return item
