# Validating the lux figures

Fidelity and validation are different axes. [The lighting design model](lighting-design.md)
describes a ladder of fidelity: geometry, then a lumen approximation, then
occlusion, then room interreflection, then measured IES photometry, then
simulation. Climbing it adds physics. None of it says the arithmetic is right.

Validation means comparing an output against an answer established somewhere
else. A high-fidelity unvalidated model and a low-fidelity validated one are
both possible, and the second is worth more to an electrician.

This document records which parts of Home Twin have been held against an
outside answer, which have not, and what the remaining steps cost.

## What a reported figure now means

Two changes make a lux number a quantity rather than an artifact.

**Illuminance is maintained, not initial.** `maintenance_factor` in
`config/constraints.yaml` depreciates both the direct and the interreflected
component. The default 0.8 is the usual product of an LED's lamp lumen
maintenance, luminaire dirt depreciation, and room surface depreciation in a
clean domestic interior. It is a stated allowance, not a measurement of any
particular luminaire. Reporting initial illuminance while a designer reads it as
maintained overstates the installation by roughly the same 20 percent for its
whole life, so the factor is applied and named rather than left out.

The factor is applied once, to the sum of the components. `optimise_spotlights`
divides by it when choosing a fixture count, so the optimiser aims at the same
maintained target the grid reports; without that it proposes a layout that
misses its own target.

**Statistics are quoted over a task area.** A whole-room average includes the
samples hard against the wall, where a downlight grid never puts light, so it
falls as the room grows and cannot be compared with another tool or a meter.
`task_area_border_mm` excludes a perimeter band, and `TaskArea` reports the
mean, minimum, and the `Emin/Eavg` uniformity over what is left. A space
narrower than twice the border has no task area and reports none, which is
honest in a 1,020 mm corridor where a task-area average would be meaningless.

Uniformity is reported because it is the number a designer argues about once the
average is agreed. An average of 200 lx at 0.2 uniformity and one at 0.7 are
different rooms.

## What is validated

`tests/test_photometric_reference.py` holds cases whose answers are derived by
hand from the defining physics, independently of this code. They assert absolute
values, so they fail on arithmetic that is wrong by a constant factor. Every
other lighting test asserts a relation, which catches regressions but would pass
a consistently wrong formula.

| Case | Reference answer |
| --- | --- |
| Off-axis point illuminance | `E = I·cos³θ/h²`, derived from the mounting height rather than the slant distance |
| Lambertian flux | `∫I₀cosθ dΩ = πI₀` over the hemisphere; the zonal sum telescopes, so this is an equality at any angle set |
| Isotropic flux | `2π·I` over a hemisphere (`tests/test_photometry.py`) |
| Room interreflection | `(F/A)·ρ̄/(1-ρ̄)` against an explicit sum of `Σ(F/A)ρ̄ⁿ` |
| Area-weighted reflectance | Hand-computed for a 4 m room: 16 m² floor, 16 m² ceiling, 41.6 m² wall |
| The composite grid | Intensity over squared drop, written out rather than fetched from the photometry module |
| Maintenance factor | Exactly linear across every sample and the bounce, so it cannot be applied twice or to one component only |
| Task area | 3x3 interior of a 4 m room on a 1 m grid at a 500 mm border |

`rated_flux_agreement` compares a parsed file's integrated distribution against
the flux it declares. A well-formed file reconciles near 1.0; a ratio far from
it means the candela block was read wrongly or the file is mislabelled, and the
lux built on it is wrong by that factor. This is a field check that works on any
real manufacturer file, not only on synthetic ones.

## What is not validated

**CIE 171:2006, "Test Cases to Assess the Accuracy of Lighting Computer
Programs," has not been run.** It is the recognised instrument for this and its
analytical cases cover exactly the direct and simple-interreflection situations
Home Twin computes. The report is paywalled, so running its scenarios needs the
purchased standard. The reference cases above are independent derivations, not a
subset of it, and no conformance is claimed.

**No cross-engine comparison has been run.** Radiance is the preferred engine
and is not installed in this checkout. No adapter is written, deliberately: an
unrun exporter would be a claim without evidence, which is the failure mode this
document exists to prevent. When it is written, the discipline is that agreement
with Radiance is corroboration rather than proof, because Radiance's answer
depends on the reflectances, the luminaire data, and the ambient parameters it is
given. Run both on the synthetic reference scenes first, publish the delta, and
treat a large one as a bug hunt.

**Nothing has been measured.** No figure in this repository has been held
against a meter, so the accuracy of any room-level number is unknown.

## The error budget

The solver is not the bottleneck. In rough order of contribution to a room lux
figure:

1. **Surface reflectances.** `ceiling_reflectance`, `wall_reflectance`, and
   `floor_reflectance` are typical decorated finishes, not measurements. They
   drive the interreflected term directly, and one dark feature wall moves the
   room average more than the difference between this split-flux term and full
   radiosity. A `WallFace` may now carry its own `reflectance`, so a dark slatted
   feature wall is representable rather than averaged into the painted ones, but
   a declared value is still a guess until it is measured. `surface_materials`
   stays in the exclusions because reflectance is not the whole of a material:
   the bounce remains uniform and Lambertian, so a specular finish is still
   outside the model.
2. **Lamp output against its rating.** Rated lumens, driver losses, the dimming
   curve, and thermal derating of a downlight in insulation. LM-79 data closes
   this where a manufacturer publishes it.
3. **The uniform bounce assumption.** The interreflected term is uniform by
   construction, so it cannot say one corner is better lit than another.
4. **Geometry simplification.** Occluders reduce to axis-aligned boxes and
   vertical panels.

Measuring the finishes is worth more than a better solver. A Radiance run fed
guessed reflectances is wrong by roughly the same margin as the current
arithmetic, and far more expensively.

## Measuring the real installation

This is the only step that says anything about a specific building. The protocol
matters more than the meter, because a careless measurement produces a residual
that looks like a model error.

1. **Measure after dark**, with blinds closed and every other room's light off.
   Daylight is not in the model at all, so any of it in the reading lands in the
   residual. See [the daylight boundary](daylight.md).
2. **Let the lamps stabilise.** LED output drifts for several minutes from cold,
   and more if the luminaire is enclosed.
3. **Record what is actually installed**: the lamp or luminaire model, its rated
   lumens, the dimmer position, and the supply voltage. A layout designed around
   650 lm fixtures and built with 500 lm ones is a data disagreement, not a
   calculation error.
4. **Use the plane the model uses.** `task_plane_height_mm` defaults to 800 mm.
   Hold the meter horizontal and face up, and keep your own shadow off it.
5. **Use documented points.** Coordinates in the building frame, in
   millimetres, the same frame `lighting-layout.csv` exports, so a reading can
   be taken back to the same spot.

Record the readings as CSV with `x_mm,y_mm,z_mm,measured_lux` and an optional
`note`, then compare:

```bash
uv run home-twin --model model/house.ifc compare-measurements \
  --room ROOM_ID --readings measurements/open-plan-night.csv
```

The comparison predicts at each measured point rather than at the nearest grid
sample, so the residual reports the model instead of the bake's step. It gives a
signed `mean_bias_lux` alongside `mean_absolute_error_lux` on purpose: a model
that is 40 lx high everywhere has a calibration problem, while one that is 40 lx
out in both directions has a geometry or reflectance problem, and an unsigned
average cannot tell them apart.

The residual is the honest accuracy claim. Expect it to be dominated by
reflectances and lamp tolerance rather than by the arithmetic, which is itself
the finding.

## Order of remaining work

1. Measure the finishes in the real home and state per-room reflectances. The
   current values are project-wide and typical; a per-room table and extraction
   from `IfcMaterial` are both still open.
2. Take night readings in the real home and record the residual.
3. Buy CIE 171:2006 and run its analytical cases against the direct and
   interreflected components.
4. Write the Radiance adapter, cross-validate on the synthetic scenes, and
   document its ambient parameters as part of every result.

Until at least the first two are done, every room-level lux figure in Home Twin
is an estimate with a stated method, and the method label is the point.

## Measuring a surface reflectance

This is the cheapest measurement in the list and it addresses the largest term
in the error budget, so it comes before any better solver.

A reflectance is a ratio of two readings taken at the same spot with the same
meter, so it needs no calibration against an absolute standard.

1. **Hold the meter against the surface, sensor facing it**, close enough to
   fill its view but not touching, and read the reflected light. Keep your body
   and the meter's own shadow out of the light path.
2. **Turn the meter around at the same spot**, sensor facing away from the
   surface, and read the incident light.
3. **Divide.** `ρ ≈ E_reflected / E_incident`.
4. **Repeat at three spots per surface** and take the mean. Timber and stone
   vary across a sheet, and a slatted wall varies most of all.

Measure the slatted wall as built, slats and gaps together, rather than a
sample of the timber. The gaps and the dark void behind them are part of what
the room sees, and a reading off a single slat overstates the wall by more than
the difference between any two interreflection methods.

Record the reading, the meter, and the date next to the value. A reflectance
that does not say where it came from is the typical figure it replaced.
