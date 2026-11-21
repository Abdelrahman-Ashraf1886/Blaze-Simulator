# Reference analysis: Blaze-Simulator

Source: <https://github.com/Abdelrahman-Ashraf1886/Blaze-Simulator> (inspected 2026-11-20).

## Licensing

The repository has **no LICENSE file**, so by default all rights are reserved by
its author. Until 2026-11-21 this project used it **only as functional inspiration**.

**Update 2026-11-21:** the user, who has write access to the repository (this
project's branch `phase-1-foundation` is pushed there), said its `main` branch may
be used. Applied as follows:
- **Used:** the visual design of its procedural part models (outrunner motor with
  base, windings, bell, accent band, vents and shaft; bladed propellers with a hub;
  Pixhawk-style case with lip, screws, LEDs and port sockets). These were rebuilt
  from scratch in `src/three/part-models.tsx` for this Z-up, metre renderer. No
  source lines were copied. `main` contains no model files (no glTF/STL/OBJ/STEP),
  only geometry built in code.
- **Not used:** its component catalogue (`dist/model.mjs`, `dist/component-data.mjs`).
  Its values (e.g. motor masses and thrust factors) carry no sources, and this
  project's rule is that every specification cites its source. All component data
  still comes from cited manufacturer documents, user input, or clearly labelled
  estimates.
- If the repository owner is someone other than the user, the owner's permission
  should be confirmed before any further reuse.

## What it is

A static browser app (`dist/`: vanilla ES modules, bundled three.js, pdf.js, no
build step). State is kept in `localStorage`; builds can be exported to files.

## Features observed (README + module names)

| Area | Blaze behaviour | Our take |
|---|---|---|
| Frames | Quad X and Hex X; STL frame import (binary/ASCII ≤25 MB, unit + up-axis + measured mass) | Quad/Hex/Octo + more layouts; GLTF/GLB import (Phase 2) |
| Placement | Click-to-mount parts on frame surfaces, rotate 90°, view presets | Full transform gizmos, mounting points, exploded view (Phase 2) |
| Weights | Placeable point masses that affect balance | Generalised: every part contributes mass + inertia tensor (Phase 3/4) |
| Clearance | Bounding-box overlap + swept prop disks | Keep the swept-disk idea; add mesh-level checks later |
| Wiring | Pin-to-pin leads, auto-wire reference harness, wire colours, rating checks | Graph-based electrical model with validation report (Phase 3) |
| Power | Series packs (voltages add, lowest capacity/current limit) | Same physics, plus SoC-dependent OCV and internal resistance (Phase 4) |
| Peripherals | Pixhawk 6C / 2.4.8 sockets, port-conflict preflight | Flight-controller port model (Phase 3), PX4 bridge later |
| Hover test | Arm, throttle, hold 1 m; telemetry of thrust, pitch/roll, drift | Full 6-DOF rigid body + controllers (Phases 4–6) |
| Compare/export | Side-by-side build comparison, JSON export | SQLite projects + comparisons (Phases 1, 4) |

## Limits stated by Blaze itself

Representative specs and *estimated* motor curves; no firmware, switching
transients, thermal dynamics or lateral flight; endurance assumes 80 % usable
capacity. It is an estimator, not a dynamics engine. Our engine is designed to be
a time-stepped 6-DOF simulation whose models are documented and tested, and
that labels every estimate as such.

## Architectural lessons

- Keeping everything client-side and local is good (privacy, offline). We keep
  local-first but move storage to SQLite and computation to a native engine.
- Mixing physics, UI and rendering in one JS bundle (`app.mjs` ≈ 49 KB) makes
  models hard to test; we separate them into processes/crates.
