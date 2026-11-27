# Roadmap

Each phase has its own plan and acceptance gate. A phase is "done" only when it
builds and its acceptance tests pass. Status is updated in `DEVLOG.md` entries.

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Architecture, Electron + React + TS, Rust sidecar integration, navigation, dashboard, SQLite, installer smoke test | **Done** (2026-11-20). Awaiting user review |
| 2 3D Workshop | three/R3F scene, frames (quad/hex/octo), placement, selection + transform gizmos, properties, GLTF/GLB import, exploded view, ortho/persp cameras | **Done** (2026-11-21), 2.1–2.7 ([plan](plans/phase-2-workshop.md)). Awaiting user review |
| 3 Components & Electrical | Component DB with provenance, compatibility validation, wiring editor, electrical calculations, diagnostics | **Done** (2026-11-21), 3.1–3.8 ([plan](plans/phase-3-components.md); ADRs [0007](adr/0007-component-provenance.md), [0008](adr/0008-pure-domain-modules.md)). Awaiting user review |
| 4 Physics engine | 6-DOF rigid body, inertia tensor, motor/prop/battery models, drag, wind, ground effect; analytical validation | **Done** (2026-11-23), 4.1–4.9 ([plan](plans/phase-4-physics.md)). Wind and ground effect shipped in [Phase 6](plans/phase-6-flight-environment.md). Awaiting user review |
| 5 Flight control | PID cascade (rate/angle/alt/pos), mixing/allocation, tuning tools, step-response metrics | **Done** (2026-11-24), [plan](plans/phase-5-flight-control.md), [ADR 0009](adr/0009-px4-controller-perfect-state.md) |
| 6 Flight environment | Wind, ground effect, terrain and obstacles, input devices, auto flight modes, cameras and acceptance scenarios | **Done** (2026-11-25), [plan](plans/phase-6-flight-environment.md), [ADR 0010](adr/0010-flight-environment.md). 6.0b passed (2026-11-25). 6.11 (turbulence) and 6.12 (return) are included. Awaiting user review. |
| 7 Telemetry | Sensor models (noise/bias/delay), live and historical graphs, recording/replay, CSV, reports | **Done, awaiting review** (2026-11-25). 7.0–7.9 and 7.12 built and merged. 7.10 attitude estimator and 7.11 ULog not chosen. [Plan](plans/phase-7-telemetry.md#milestones). |
| 8 Quality & distribution | Profiling, regression suite, validation report, signed installer, upgrade test, docs | Plan drafted 2026-11-26, decisions open ([plan](plans/phase-8-quality.md)) |
| 9 Aircraft identity & evidence | Physical aircraft registry, immutable configuration snapshots, measurement provenance and portability | **Planned** (2026-11-26). [Digital twin plan](plans/digital-twin.md#phase-9--aircraft-identity-and-evidence) |
| 10 Real flight data & comparison | PX4 ULog import, real-flight replay, clock/frame alignment and measured-versus-simulated reports | **Planned**. After 9; real logs required for aircraft acceptance. [Plan](plans/digital-twin.md#phase-10--real-flight-data-and-comparison) |
| 11 Calibration & independent validation | Aircraft-specific parameter fitting, held-out flight validation, prediction uncertainty and validity envelope | **Planned**. After 10; bench measurements and separate validation flights required. [Plan](plans/digital-twin.md#phase-11--calibration-and-independent-validation) |
| 12 Live synchronization & prediction | MAVLink connection, independent telemetry clock, freshness/loss handling and live endurance forecasts | **Planned**. After 11; physical aircraft/link required. [Plan](plans/digital-twin.md#phase-12--live-synchronization-and-prediction) |
| 13 Actual firmware integration | Supported PX4 firmware in SITL, sensor/estimator path, controller comparisons and conditional HITL | **Planned**. After 10–11; 12 infrastructure before HITL. [Plan](plans/digital-twin.md#phase-13--actual-firmware-integration) |
| 14 Lifecycle & health | Component/battery history, performance drift, calibration revisions and change-triggered revalidation | **Planned**. After 11–12; relevant firmware evidence from 13. [Plan](plans/digital-twin.md#phase-14--lifecycle-and-health) |
| 15 Digital twin acceptance | Physical end-to-end demonstration, evidence audit, resilience and packaged release | **Planned**. After 9–14 and applicable Phase 8 gates. [Plan](plans/digital-twin.md#phase-15--digital-twin-acceptance-and-release) |

## Digital twin delivery

[Phases 9–15](plans/digital-twin.md) extend the simulator into a digital counterpart
of one physical aircraft, initially validated for hover power and endurance within
a declared operating envelope. They add real measurements, calibration, independent
validation, live synchronization, firmware integration and lifecycle history.
Actual firmware control-fidelity and hardware-timing claims require separate evidence.

The first milestone is an **offline validated aircraft model** (9–11), followed by
a **live synchronized twin** (12), firmware and lifecycle work (13–14), and the
**accepted digital twin release** (15). Phase 8 remains the simulator quality plan;
its analytical validation alone does not satisfy real-flight validation. New data
features depend on its backup/migration work before shipping.

All new phases are planned, not implemented. Aircraft selection, exact firmware,
measurement resources and numerical acceptance limits are explicit prerequisites
in the plan; no physical validation or release date is claimed yet.

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
