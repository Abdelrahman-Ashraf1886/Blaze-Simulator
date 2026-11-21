# Phase 2 plan: 3D Drone Workshop

Status: **approved 2026-11-20** with the proposed defaults (mm/°, user-defined
parts, PX4 motor numbering). Progress: 2.1 ✅ · 2.2 ✅ (undo uses document snapshots
instead of command objects; see DEVLOG) · 2.3 ✅ (PX4 numbering verified against
v1.13.3 geometry files) · 2.4 ✅ · 2.5 ✅ (units and up axis stored per part, not per
asset; see DEVLOG) · 2.6 ✅ · 2.7 ✅. Scope revised with the user on 2026-11-21:
added drag onto a mount, copy to all motor mounts, image export and a measure
tool. All acceptance criteria below are met; measurements are in the DEVLOG. Supersedes the one-line Phase 2 entry in
`ROADMAP.md`. Phase 1 must stay green throughout: every milestone below ends with
`npm run test:all` passing.

## Goal
An interactive 3D assembly environment in which a user builds a quad, hex or octo
airframe from a parametric frame, places and orients parts on real mounting points,
imports GLB/glTF models, and inspects the result from any angle. All of it is saved
to the project and survives restarts.

## The one constraint that shapes this phase
The component library with sourced specifications arrives in **Phase 3**, and specs
must never be invented. So in Phase 2:
- Parts are **user-defined**: a kind (motor, propeller, battery, flight controller,
  ESC, payload, custom), a shape (box, cylinder or imported model), dimensions, and
  an optional mass. Every physical value is stored with `source: "user"`.
- Mass is optional and shown as "not set" when absent. Mass totals, centre of
  gravity and inertia are **not** shown in Phase 2. They belong to Engineering
  Analysis (Phase 4), which will use these stored values.
- In Phase 3 a part can be linked to a library component, which replaces the user
  values with sourced ones.

## Scope
**In scope**
1. Workshop route: library (left), viewport (centre), properties (right),
   assembly status (bottom). Panels are resizable and collapsible, and the layout
   is remembered.
2. Viewport: perspective/orthographic toggle; orbit, pan and zoom; view presets
   (top, front, side, iso); fit-to-selection; ground grid with scale; axis gizmo.
3. Parametric frame for quad X, hex X and octo X with user-set motor-to-motor
   diagonal, arm width/thickness and centre-plate size. Mounting points are
   generated at arm tips, plus top and bottom plate points.
4. Motor mounts carry orientation: spin direction (CW/CCW) and tilt. The default
   motor numbering and spin pattern follow the PX4 airframe reference; this is
   checked against the PX4 docs during implementation, not assumed.
5. Parts: add from the library, select by click, move and rotate with a gizmo,
   snapping (grid in mm, 15° steps), snap onto a mounting point (the part becomes
   attached and moves with its parent), edit transforms numerically (mm and °),
   delete, duplicate.
6. Properties panel: name, kind, shape and dimensions, transform, attachment,
   mass with source, and bounding-box dimensions readout.
7. GLB / self-contained glTF import with unit choice (m, mm, in) and up-axis
   conversion. Files are copied into the app's asset store.
8. Exploded view (visual only, never saved), dimension overlay for the selection,
   connection-point markers.
9. Undo/redo for every assembly edit.
10. Assembly status strip: part count, unattached parts, parts without mass,
    import warnings.

**Out of scope (later phases)**: component catalogue and compatibility (3),
wiring (3), clearance and prop-strike checks (3), mass properties and thrust
analysis (4), anything that flies (4–6).

## Architecture decisions
| Topic | Decision | Reason |
|---|---|---|
| 3D stack | three 0.187, @react-three/fiber 9, @react-three/drei 10 | As specified; versions verified compatible with React 19.3 |
| World axes | Renderer uses the engine's **Z-up, metres** frame (`Object3D.DEFAULT_UP = +Z`) | One coordinate frame end to end; no conversions between engine and view. glTF (Y-up) is rotated +90° about X on import |
| Display units | mm and degrees in the UI, metres and quaternions in storage | Builders think in mm; physics wants SI |
| Persistence | New tables via migration `0002_assembly.sql`: `assembly_parts` (transform, parent + mount id, kind, shape JSON, mass + source), `assets` (sha256, filename, bytes, format, units, up axis) | Relational data the analysis phases can query; same zod-validated IPC pattern as Phase 1 |
| Saving | Editor state in a Zustand store with a command-based undo stack. Debounced save (500 ms) through `assembly:save` with a revision number, so a stale save is rejected rather than overwriting | No lost edits and no silent overwrites |
| Asset loading | Imported files live in `<userData>/assets/<sha256>.glb`, served to the renderer through a privileged `blaze-asset://` protocol that serves only that folder | Keeps the strict CSP (`'self'` only); the renderer still never touches the disk |
| Import safety | Accept `.glb` and `.gltf` with embedded (data URI) buffers only; reject external URIs; 50 MB limit; magic-byte check; parsed in the renderer, never executed | glTF can reference arbitrary paths/URLs; this closes that door |
| Rendering cost | `frameloop="demand"`, `dpr={[1, 2]}` with adaptive DPR, no post-processing in the workshop | Editor redraws only on change; stays cool on laptops |
| Bundle | Workshop route lazy-loaded (`React.lazy`) | Dashboard and Projects never load three.js |
| Panels | `react-resizable-panels` | Small, accessible, persists layout |

New code is laid out per the master prompt: `src/three/` (scene primitives,
cameras, frame mesh builder), `src/features/workshop/` (page, panels, store,
commands), `electron/main/assets/` (import, protocol), and pure geometry in
`src/features/workshop/geometry/` so it can be unit tested without WebGL.

## Milestones
Each milestone ends green and is demonstrable.

| # | Milestone | Done when |
|---|---|---|
| 2.1 | **Viewport shell**: lazy route, resizable panels, canvas, cameras, grid, view presets, fit, responsive behaviour | Workshop opens from the sidebar; canvas tracks window and panel resizes; responsive e2e passes |
| 2.2 | **Assembly model**: migration 0002, repositories, IPC, store, undo/redo, debounced save | Edits persist across restart; stale-revision save rejected (unit + e2e) |
| 2.3 | **Parametric frame + mount points**: generator for quad/hex/octo X, motor orientation, mount markers | Mount positions match the analytical geometry within 0.01 mm (unit); frame follows the project's layout |
| 2.4 | **Parts and editing**: library, add, select, gizmo, snapping, attach to mount, numeric transform, delete, duplicate, properties panel | Full keyboard and mouse flow covered by e2e |
| 2.5 | **Model import**: file dialog, validation, asset store, protocol, unit/up-axis options | Valid fixture imports at the right size and orientation; malicious fixtures (external URI, oversize, wrong magic) are rejected with clear messages |
| 2.6 | **Inspection**: exploded view, dimension overlay, connection markers, status strip | Visual checks pass at all target sizes; exploded view leaves saved transforms unchanged |
| 2.7 | **Hardening and docs**: performance pass, ADRs (Z-up renderer, asset protocol), DEVLOG and ROADMAP updated | Acceptance list below is green |

## Acceptance criteria
- Responsive 3D (carried over from Phase 1): the canvas equals its container at
  1100×700, 1920×1080 and 3840×2160, and with 150 %/200 % zoom; the model stays in
  frame after every resize and panel collapse; perspective FOV is constant;
  orthographic zoom is derived from bounds and aspect.
- Labels and connection markers stay a constant size on screen.
- Performance: 50-part assembly holds 60 fps while orbiting at 1080p on this
  machine. Frame time is logged at 4K. Idle viewport renders 0 frames per second
  (demand mode).
- Create a hex X, attach 6 motors and 6 propellers to its mount points, set spin
  directions, import a GLB payload, restart the app: everything is exactly where
  it was (e2e).
- Undo/redo restores every edit kind, including attach/detach and import.
- Unit tests: frame geometry, axis conversion, snapping, undo stack, schema
  validation, asset validation. IPC tests for save/load and import rejection.
- No values shown without a source; mass reads "not set" until the user enters it.
- Zero console errors across the e2e suite; typecheck and lint clean.

## Risks
| Risk | Mitigation |
|---|---|
| WebGL unavailable or software-rendered in CI/VMs | Detect and show a clear message; e2e asserts canvas sizing (works under SwiftShader) rather than pixel output |
| Gizmo and orbit controls fighting for the mouse | drei `TransformControls` disables orbit while dragging; covered by e2e drag test |
| Imported models with absurd scale or huge triangle counts | Unit selection with a live size preview; warn above 500 k triangles |
| Scope creep into analysis | Mass properties explicitly deferred to Phase 4; plan reviewed at each milestone |

## Decisions needed from you
1. **Units:** mm and degrees in the UI (proposed), or metric/imperial switchable now?
2. **Parts before Phase 3:** user-defined parts with optional mass, as above
   (proposed), or wait for the Phase 3 library before allowing anything except the
   frame?
3. **Default motor numbering:** PX4 convention (proposed) or Betaflight?
