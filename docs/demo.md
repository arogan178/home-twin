# Static demo

The landing page links to a read-only copy of the browser UI at
`https://arogan178.github.io/home-twin/demo/`. It runs without a server. Every
number and shape it shows came from the real server, run once on the synthetic
demo home at deploy time.

## What it shows

The model is `examples/demo/plan.yaml` compiled to a verified draft IFC, then lit
by `scripts/build_demo_model.py` through the same validated IFC transaction the
MCP tools use. The layout follows the design brief: 3000 K, CRI 90 downlights in
pools over the places people use, rather than a grid.

| Room | Lights | Switching |
| --- | --- | --- |
| Living and kitchen | Two over the north worktop, one inside the front door, two over the seating by the terrace slider | `KITCHEN` on SW02, `LIVING` on SW01 |
| Sunken snug | Two reading lights beside the window | `SNUG` on SW03 |
| Bedroom | One inside the door, one on the window side | `BEDROOM` on SW04 |
| Bathroom | None | None |
| Terrace | None; it is outdoors | None |

The bathroom stays unlit on purpose. It is 2 m square, so the 600 mm
ceiling-edge clearance leaves only the rooflight's footprint, and a downlight
does not go in a rooflight. The plan has no table, so there is no pendant.

## What works and what does not

These work from recordings:

- the room list, each room's 2D plan and 3D view, and the whole floor
- the saved layout's checks, coverage, and dark spots
- sun patches and the day's sun path for 20 March, 21 June and 21 December, at
  09:00, 12:00 and 15:00 UTC, on the floor and the task plane. The time slider
  steps only between those three times, and the date field is replaced by a
  note naming the presets. The site states no timezone, so times are UTC.
- the trace workspace, with the demo plan source and its underlay

Anything that writes or computes something new shows one message, "This is a
read-only demo. Install Home Twin to run this.", and sends nothing. That covers
Save to IFC, Propose, Align, Export, the shadow pass, replacing the IFC, and
saving, reviewing or building a trace. Removing an underlay changes only the
unsaved trace document.

You can still move, add and delete lights locally. The checks and coverage come
back only for the unedited saved layout, for example after undo. An edited
layout shows the read-only message in place of checks. It never shows the saved
layout's numbers as if they described the edit.

Method labels and disclaimers are unchanged. Coverage is still the lumen
beam-cone approximation, and sun patches are still direct-beam geometry with no
illuminance.

## How it works

`vite build --mode demo` sets `base` to `/home-twin/demo/`, turns on the banner,
and switches `ui/src/api.ts` into demo mode (`ui/src/demo.ts`):

- A GET becomes a fetch of its recorded file. `demoFile` maps the request URL,
  query string included, to a path under `api/`. Percent-decoding comes first,
  then every character outside `A-Za-z0-9/._-` becomes `~` plus its hex code.
  For example, `/api/rooms/1iK%24u5…/daylight?at=2026-06-21T09%3A00%3A00&plane=floor`
  maps to `api/rooms/1iK~24u5…/daylight/at~3d2026-06-21T09~3a00~3a00~26plane~3dfloor.json`.
- Any other method throws `DemoReadOnlyError` before `fetch` is called.
- Room analysis is a POST. In demo mode the UI compares the submitted layout
  with the saved one. If they match, it reads the recorded analysis. Otherwise
  it throws the read-only error.

`scripts/record_demo.py` builds the model in a temporary directory and runs the
FastAPI app in process with `TestClient`. It writes each response to the path
`demoFile` names, using the Python twin of that function. It rewrites two
things. Temporary project paths become project-relative, so `model_path` reads
`model/draft.ifc`. The trace's `underlay_url` points at the recorded PNG. The
sun presets live in `ui/src/demoPresets.json`, which both the recorder and the
UI read.

The recordings total about 1.1 MB across roughly 100 files. They are not
committed. The Pages workflow builds the demo UI, records into it, copies `site/`
on top, and deploys the result, so the demo always matches the code at that
commit.

## Regenerate it locally

```bash
npm --prefix ui ci
mkdir -p build/pages
npm --prefix ui run build -- --mode demo --outDir ../build/pages/demo --emptyOutDir
uv run --extra dev python scripts/record_demo.py build/pages/demo
cp -R site/. build/pages/
mkdir -p /tmp/pages && ln -sfn "$PWD/build/pages" /tmp/pages/home-twin
python3 -m http.server 8141 --directory /tmp/pages
```

Then open `http://127.0.0.1:8141/home-twin/`. The demo needs the
`/home-twin/demo/` path, because that is the base it was built for.

`tests/test_demo_recording.py` reads the server's route table. It fails if a
GET route is neither recorded nor listed as unused by the UI. It also checks
that each recorded analysis matches its room's saved design. `ui/src/demo.test.ts`
covers the URL mapping and the write guard, and both test files assert the same
mapping examples.
