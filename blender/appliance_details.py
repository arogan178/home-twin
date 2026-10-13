"""Illustrative appliance construction from the IFC envelope and declared front.

Small controls, mixer profile and upholstery details are visual allowances,
not manufacturer CAD or installation dimensions.
"""

import math

import bpy
from detail_geometry import DetailFrame, box
from mathutils import Vector


def kitchen_frame(record, minimum, maximum, palette):
    facing = record['declared'].get('Facing', 'south')
    angle = {'north': 0, 'east': -math.pi/2, 'south': math.pi, 'west': math.pi/2}[facing]
    span = maximum-minimum
    w, d = (span.x, span.y) if facing in {'north', 'south'} else (span.y, span.x)
    frame = DetailFrame(palette, ((minimum.x+maximum.x)/2, (minimum.y+maximum.y)/2, minimum.z), angle)
    return frame, w, d, span.z


def appliance_detail(record, minimum, maximum, palette):
    declared = record.get('declared') or {}
    appliance = declared.get('Appliance')
    open_shelf = declared.get('Role') == 'wall' and declared.get('Front') == 'open'
    if appliance not in {'coffee_machine', 'grinder', 'cooktop', 'sink'} and not open_shelf:
        return False
    f, w, d, h = kitchen_frame(record, minimum, maximum, palette)
    if open_shelf:
        for side in (-1, 1):
            f.box('Niche side', 'walnut', (side*(w/2-0.009), 0, h/2), (0.018, d, h))
        f.box('Niche back', 'walnut', (0, -d/2+0.009, h/2), (w-0.036, 0.018, h))
        for z in (0.011, h/2, h-0.011):
            f.box('Cup shelf', 'walnut', (0, 0.009, z), (w-0.036, d-0.018, 0.022))
    elif appliance == 'coffee_machine':
        front = d/2
        f.box('Machine base', 'gunmetal', (0, 0, 0.030), (w, d, 0.034), 0.010)
        f.box('Machine rear housing', 'gunmetal', (0, -d*0.27, h/2), (w, d*0.46, h-0.025), 0.018)
        f.box('Machine boiler head', 'gunmetal', (0, 0.015, h*0.77), (w, d*0.86, h*0.43), 0.018)
        f.box('Machine control fascia', 'appliance', (0, front-0.020, h*0.78), (w-0.035, 0.009, h*0.25), 0.004)
        f.box('Machine display', 'display', (0, front-0.014, h*0.80), (w*0.26, 0.003, 0.035), 0.002)
        for x in (-w*0.32, w*0.32):
            f.rod('Machine dial', 'nickel', (x, front-0.015, h*0.78), (x, front-0.004, h*0.78), 0.015)
        group_y = front-0.085
        f.rod('Group head', 'nickel', (0, group_y, h*0.48), (0, group_y, h*0.60), 0.034)
        f.rod('Portafilter grip', 'appliance', (0, group_y, h*0.50), (0, front-0.002, h*0.47), 0.013)
        for x in (-0.013, 0.013):
            f.rod('Coffee spout', 'nickel', (x, group_y, h*0.48), (x, group_y, h*0.43), 0.006)
        f.tube('Steam wand', 'nickel', [(w*0.34, front-0.07, h*0.65),
               (w*0.39, front-0.045, h*0.40), (w*0.34, front-0.065, h*0.24)], 0.005)
        f.box('Drip tray inset', 'appliance', (0, d*0.23, 0.052), (w-0.035, d*0.42, 0.009), 0.004)
        for i in range(12):
            x = (i/11-0.5)*(w-0.055)
            f.box('Drip tray bar', 'nickel', (x, d*0.23, 0.059), (0.005, d*0.39, 0.005), 0.001)
        f.tube('Cup warming rail', 'nickel', [(-w/2+0.02, d*0.30, h-0.005),
               (-w/2+0.02, -d*0.40, h-0.005), (w/2-0.02, -d*0.40, h-0.005),
               (w/2-0.02, d*0.30, h-0.005)], 0.004)
    elif appliance == 'grinder':
        f.box('Grinder foot', 'appliance', (0, 0, 0.016), (w, d*0.88, 0.032), 0.012)
        f.box('Grinder motor housing', 'gunmetal', (0, -d*0.12, h*0.33), (w*0.84, d*0.54, h*0.57), 0.025)
        f.rod('Grinder adjustment collar', 'gola', (0, -d*0.12, h*0.60), (0, -d*0.12, h*0.66), w*0.47)
        f.rod('Tapered bean hopper', 'glass', (0, -d*0.12, h*0.66), (0, -d*0.12, h*0.96), w*0.28, w*0.47)
        f.rod('Coffee beans', 'coffee', (0, -d*0.12, h*0.67), (0, -d*0.12, h*0.83), w*0.27, w*0.38)
        f.rod('Hopper lid', 'gola', (0, -d*0.12, h*0.96), (0, -d*0.12, h*0.99), w*0.48)
        f.box('Dosing chute', 'nickel', (0, d*0.22, h*0.43), (w*0.28, d*0.23, 0.045), 0.005)
        for x in (-w*0.18, w*0.18):
            f.rod('Portafilter fork', 'nickel', (x, d*0.08, h*0.23), (x, d*0.36, h*0.23), 0.004)
    elif appliance == 'cooktop':
        f.box('Induction glass', 'appliance', (0, 0, h-0.003), (w, d, 0.006), radius=0.018)
        long_axis = 0 if w >= d else 1
        for u in (-0.27, 0.27):
            for v in (-0.24, 0.24):
                x, y = (u*w, v*d) if long_axis == 0 else (v*w, u*d)
                radius = min(w, d)*0.16
                f.tube('Induction zone marking', 'zone',
                       [(x+radius*math.cos(i*math.tau/64), y+radius*math.sin(i*math.tau/64), h+0.0003)
                        for i in range(65)], 0.00055)
        grille_w, grille_d = (w*0.09, d*0.65) if long_axis == 0 else (w*0.65, d*0.09)
        f.box('Downdraft well', 'gola', (0, 0, h+0.0005), (grille_w, grille_d, 0.002), radius=0.008)
        for i in range(15):
            if long_axis == 0:
                centre, size = (0, (i/14-0.5)*grille_d*0.92, h+0.002), (grille_w*0.9, 0.003, 0.003)
            else:
                centre, size = ((i/14-0.5)*grille_w*0.92, 0, h+0.002), (0.003, grille_d*0.9, 0.003)
            f.box('Extractor grille fin', 'gunmetal', centre, size, 0.001)
    else:
        # The aperture is cut through both the worktop and design-envelope carcass.
        wall = 0.007
        # Bowl and mixer are one purchase in one finish, so both follow what the
        # unit declares rather than a hardcoded brushed nickel.
        metal = 'gunmetal' if declared.get('Finish') == 'gunmetal' else 'nickel'
        f.box('Sink bowl bottom', metal, (0, 0, 0.010), (w-0.014, d-0.014, 0.012), radius=0.025)
        for side in (-1, 1):
            f.box('Sink side', metal, (side*(w/2-wall/2), 0, h/2), (wall, d, h), 0.003)
            f.box('Sink end', metal, (0, side*(d/2-wall/2), h/2), (w-wall*2, wall, h), 0.003)
        f.rod('Sink drain recess', 'gola', (0, 0, 0.016), (0, 0, 0.018), 0.044)
        f.rod('Sink strainer', metal, (0, 0, 0.018), (0, 0, 0.020), 0.032)
        # Centre the mixer on the sink. +Y faces the user, so its base is behind the bowl.
        back = -d/2-0.026
        f.rod('Mixer base', metal, (0, back, h), (0, back, h+0.018), 0.027)
        f.rod('Mixer body', metal, (0, back, h+0.018), (0, back, h+0.18), 0.022)
        points = [(0, back, h+0.14), (0, back, h+0.26)]
        points += [(0, back+0.10-0.10*math.cos(i*math.pi/24), h+0.26+0.10*math.sin(i*math.pi/24))
                   for i in range(25)]
        points += [(0, back+0.20, h+0.23)]
        f.tube('Arched mixer spout', metal, points, 0.012)
        f.rod('Mixer lever', metal, (0.020, back, h+0.105), (0.060, back+0.014, h+0.16), 0.006)
    return True


def cut_sink_apertures(items, identity, palette):
    """Cut only derived meshes intersecting the sink, never write these voids to IFC."""
    sinks = [entry for entry in identity.values() if entry.get('declared', {}).get('Appliance') == 'sink']
    for entry in sinks:
        lo, hi = entry['bounds_mm']['minimum'], entry['bounds_mm']['maximum']
        a = [lo[k]/1000 for k in ('x', 'y', 'z')]
        b = [hi[k]/1000 for k in ('x', 'y', 'z')]
        cutter = None
        for item in items:
            guid = item.name.partition('__')[2].split('.')[0]
            record = identity.get(guid, {})
            if record.get('declared', {}).get('Role') not in {'worktop', 'base'}:
                continue
            corners = [item.matrix_world @ Vector(v) for v in item.bound_box]
            low = [min(v[i] for v in corners) for i in range(3)]
            high = [max(v[i] for v in corners) for i in range(3)]
            if not all(low[i] < b[i] and high[i] > a[i] for i in range(3)):
                continue
            if cutter is None:
                cutter = box('Sink aperture cutter', palette['nickel'],
                             ((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2+0.003),
                             (b[0]-a[0]+0.002, b[1]-a[1]+0.002, b[2]-a[2]+0.010), 0)
            modifier = item.modifiers.new('Authored sink aperture', 'BOOLEAN')
            modifier.operation = 'DIFFERENCE'
            modifier.solver = 'EXACT'
            modifier.object = cutter
            bpy.context.view_layer.objects.active = item
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        if cutter is not None:
            bpy.data.objects.remove(cutter, do_unlink=True)
