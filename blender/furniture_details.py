"""Finish furniture within its authored IFC footprint and bearing."""

import math

from detail_geometry import DetailFrame


def furniture_detail(record, minimum, maximum, palette):
    declared = record.get("declared") or {}
    role = declared.get("Role")
    if role not in {"chair", "stool", "table", "shoe_bench"}:
        return False
    w = float(declared.get("WidthMm", 0)) / 1000
    d = float(declared.get("DepthMm", 0)) / 1000
    if min(w, d) <= 0:
        return False
    h = maximum.z - minimum.z
    bearing = declared.get("BearingDeg")
    if bearing is None:
        bearing = {"east": 0, "north": 90, "west": 180, "south": 270}.get(declared.get("Facing"), 90)
    frame = DetailFrame(palette, ((minimum.x+maximum.x)/2, (minimum.y+maximum.y)/2, minimum.z),
                        math.radians(float(bearing)-90))
    if role == "table":
        shape = declared.get("Shape")
        radius = min(w, d)/2 if shape in {"oval", "round"} else min(w, d)*0.18
        frame.box("Dining top", "walnut", (0, 0, h-0.0175), (w, d, 0.035), radius=radius, bevel=0.005)
        if shape in {"oval", "round"}:
            for y in sorted({-(d-w)/2, (d-w)/2}):
                frame.rod("Dining pedestal foot", "walnut", (0, y, 0.008), (0, y, 0.04), w*0.225)
                frame.rod("Dining pedestal", "walnut", (0, y, 0.04), (0, y, h-0.035), w*0.09)
        else:
            for x in (-w*0.27, w*0.27):
                for y in (-d*0.27, d*0.27):
                    frame.rod("Table leg", "walnut", (x, y, 0), (x, y, h-0.035), 0.024, 0.030)
        return True
    if role == "shoe_bench":
        frame.box("Bench cushion", "upholstery", (0, 0, h-0.025), (w, d, 0.05), 0.018)
        for x in (-w/2+0.035, w/2-0.035):
            frame.box("Bench support", "walnut", (x, 0, (h-0.05)/2), (0.04, d*0.85, h-0.05))
        frame.box("Bench shelf", "walnut", (0, 0, 0.13), (w-0.05, d*0.8, 0.02))
        return True
    seat = h*(0.60 if role == "stool" else 0.525)
    frame.box("Seat frame", "walnut", (0, 0, seat-0.012), (w-0.025, d-0.025, 0.035), radius=0.06)
    frame.box("Upholstered seat", "upholstery", (0, 0.003, seat+0.0225), (w-0.006, d-0.006, 0.045),
              radius=0.07, bevel=0.012)
    for x in (-1, 1):
        for y in (-1, 1):
            frame.rod("Tapered chair leg", "walnut", (x*(w/2-0.04), y*(d/2-0.04), 0.008),
                      (x*(w/2-0.068), y*(d/2-0.065), seat-0.025), 0.012, 0.020)
    if role == "stool":
        frame.rod("Stool footrest", "gunmetal", (-w/2+0.052, d/2-0.052, 0.22),
                  (w/2-0.052, d/2-0.052, 0.22), 0.011)
        for x in (-1, 1):
            frame.rod("Stool side rail", "walnut", (x*(w/2-0.052), -d/2+0.052, 0.22),
                      (x*(w/2-0.052), d/2-0.052, 0.22), 0.010)
    # The IFC seat faces local +Y, so its back must occupy the -Y edge.
    back_height = (h-seat-0.045)*0.62
    for x in (-1, 1):
        frame.rod("Back support", "walnut", (x*(w/2-0.055), -d/2+0.065, seat),
                  (x*(w/2-0.055), -d/2+0.018, h-back_height+0.020), 0.016, 0.010)
    points = []
    for i in range(25):
        x = (i/24-0.5)*(w-0.05)
        y = -d/2+0.020+0.020*(2*x/(w-0.05))**2
        points.append((x, y, h-back_height/2-0.006))
    # A curved upholstered rest is an extruded ribbon with rounded edges.
    import bpy
    vertices = [(x, y+offset, z+level) for level in (-back_height/2, back_height/2)
                for offset in (-0.012, 0.012) for x, y, z in points]
    n = len(points)
    faces = []
    for i in range(n-1):
        faces += [(i, i+1, 2*n+i+1, 2*n+i), (n+i, 3*n+i, 3*n+i+1, n+i+1),
                  (i, n+i, n+i+1, i+1), (2*n+i, 2*n+i+1, 3*n+i+1, 3*n+i)]
    faces += [(0, 2*n, 3*n, n), (n-1, 2*n-1, 4*n-1, 3*n-1)]
    mesh = bpy.data.meshes.new("Curved backrest")
    mesh.from_pydata([frame.point(p) for p in vertices], [], faces)
    mesh.update()
    item = bpy.data.objects.new("Curved upholstered backrest", mesh)
    bpy.context.collection.objects.link(item)
    from detail_geometry import finish
    finish(item, palette["upholstery"], 0.008)
    return True


def lounge_detail(name, minimum, maximum, palette):
    name = name.lower()
    w, d, h = maximum-minimum
    frame = DetailFrame(palette, ((minimum.x+maximum.x)/2, (minimum.y+maximum.y)/2, minimum.z))
    if "sofa" in name:
        frame.box("Sofa recessed foot", "walnut", (0, 0, 0.075), (w-0.18, d-0.16, 0.15), 0.018)
        frame.box("Sofa upholstered base", "sofa", (0, 0, 0.235), (w, d, 0.25), 0.07)
        frame.box("Sofa back shell", "sofa", (0, -d/2+0.115, 0.48), (w, 0.23, h-0.23), 0.075)
        for side in (-1, 1):
            frame.box("Sofa rounded arm", "sofa", (side*(w/2-0.10), 0.025, 0.39),
                      (0.20, d-0.09, 0.48), 0.085)
        seat_width = (w-0.43)/3
        for i in range(3):
            x = (i-1)*(seat_width+0.008)
            frame.box("Sofa seat cushion", "sofa", (x, 0.105, 0.43),
                      (seat_width, d-0.28, 0.17), 0.07)
            frame.box("Sofa back cushion", "sofa", (x, -d/2+0.235, 0.61),
                      (seat_width, 0.18, h-0.49), 0.075)
        return True
    if "coffee table" in name:
        frame.box("Coffee table rounded top", "walnut", (0, 0, h-0.02), (w, d, 0.04),
                  radius=min(w, d)*0.35, bevel=0.006)
        for x in (-w*0.29, w*0.29):
            frame.box("Coffee table trestle", "walnut", (x, 0, (h-0.04)/2), (0.065, d*0.65, h-0.04), 0.014)
        return True
    if "area rug" in name:
        frame.box("Woven area rug", "rug", (0, 0, h/2), (w, d, h), radius=0.065)
        return True
    return False
