# Roadmap

Each phase has its own plan and acceptance gate. A phase is "done" only when it
builds and its acceptance tests pass. Status is updated in `DEVLOG.md` entries.

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Architecture, Electron + React + TS, Rust sidecar integration, navigation, dashboard, SQLite, installer smoke test | **Done** (2026-11-20). Awaiting user review |
| 2 3D Workshop | three/R3F scene, frames (quad/hex/octo), placement, selection + transform gizmos, properties, GLTF/GLB import, exploded view, ortho/persp cameras | **Done** (2026-11-21), 2.1–2.7 ([plan](plans/phase-2-workshop.md)). Awaiting user review |
| 3 Components & Electrical | Component DB with provenance, compatibility validation, wiring editor, electrical calculations, diagnostics | **Done** (2026-11-21), 3.1–3.8 ([plan](plans/phase-3-components.md); ADRs [0007](adr/0007-component-provenance.md), [0008](adr/0008-pure-domain-modules.md)). Awaiting user review |
| 4 Physics engine | 6-DOF rigid body, inertia tensor, motor/prop/battery models, drag, wind, ground effect; analytical validation | **Done** (2026-11-23), 4.1–4.9 ([plan](plans/phase-4-physics.md)). Wind and ground effect were deferred, not built (Phase 6 recommended, undecided). Awaiting user review |
| 5 Flight control | PID cascade (rate/angle/alt/pos), mixing/allocation, tuning tools, step-response metrics | **In progress** ([plan](plans/phase-5-flight-control.md), approved 2026-11-23). Merged: 5.0 reference data, 5.1 position controller, 5.2 airmode and thrust model, 5.5 tuning storage and IPC, 5.6 step-response metrics. In progress: 5.3 flight modes and loop, 5.10a hover thrust estimator. Not started: 5.4, 5.7–5.9, 5.11 |
| 6 Flight environment | Real-time engine ↔ renderer stream, terrain/obstacles, input devices, flight modes, cameras | Not started |
| 7 Telemetry | Sensor models (noise/bias/delay), live and historical graphs, recording/replay, CSV, reports | Not started |
| 8 Quality & distribution | Profiling, regression suite, validation report, signed installer, upgrade test, docs | Not started |

## Phase 2 acceptance criteria (carried in from the Phase 1 design review)

Responsive 3D viewports are a hard requirement:
- The canvas fills its layout cell and follows window **and** panel resizes (no fixed pixel sizes).
- `dpr={[1, 2]}` with adaptive DPR under load; `frameloop="demand"` in the workshop.
- Camera framing is preserved on resize (perspective FOV constant; orthographic zoom from bounds and aspect).
- Resizable, collapsible panels with a minimum viewport size; layout persisted.
- Screen-space-constant labels and connection markers.
- Playwright resizes to 1100×700, 1920×1080 and 3840×2160, asserting canvas size = container size and the model stays in frame. Frame time is logged at 4K.
- Route-level code splitting so non-3D pages do not load three.js.

## Dashboard items deferred to later phases (by design, not placeholders)
- Recently simulated drones and saved configurations → Phase 4/6 (needs runs and configurations).
- Quick access to engineering tools → appears as each tool ships.
