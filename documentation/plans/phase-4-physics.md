# Phase 4 plan: physics, collisions and flight behaviour

Status: **draft for approval**. Phase 3.8 (hardening and docs) stays open. 3.6, 3.7
and the realism work are not committed yet; that happens later, as agreed.

## Goal

The drone you build in the workshop flies the way its parts say it should:
- moving, adding or re-weighting a part changes the mass, centre of mass (CoM) and
  inertia;
- those values, together with the motors' positions and data, decide thrust,
  torque, control headroom and stability;
- collisions between parts, and with the ground or obstacles, are detected and
  resolved.

Everything shown in the viewport comes from that physical state.

## Decisions (made with you)

| Topic | Decision |
|---|---|
| Values no source states | **Derive or ask.** Where physics allows, a value is derived from stated values with a documented formula, e.g. the torque constant from KV. Otherwise the user enters it, and the simulation refuses to start until it is set. Nothing is invented. |
| Physics and collisions | **rapier3d** (`rapier3d-f64`, Apache-2.0) in the Rust engine, with `enhanced-determinism`. It does integration and contacts; our code adds every force and torque. |
| Control | **Basic PX4-style controller now**: angle → rate cascade, allocation from geometry, altitude hold. Tuning tools stay in Phase 5. |
| Order | Plan now and commit later. 3.8 stays open. |

## Where each calculation lives (separation of concerns)

- **`src/domain/mass.ts`** (TypeScript, pure): static mass properties.
  - Covers total mass, CoM and the inertia tensor.
  - Runs in the editor on every edit, with no engine round trip, so the CoM marker
    follows a drag at 60 fps.
  - Tested against hand calculations, like `electrical.ts`.
- **`simulation-engine/engine-core`** (Rust, pure, no IO): the simulation.
  - Covers the vehicle model, motors and props, the battery, aerodynamics, the
    controller and rapier.
  - Deterministic: a fixed step, the same inputs give a bit-identical state hash.
- **`engine-host`**: protocol v2 over the existing sidecar.
  - Messages: `vehicle.load`, `sim.start/stop/input`, `sim.state` stream,
    `scenario.run` and `interference.check`.
- **Renderer**: draws engine state and never computes physics.

The engine receives the mass properties per part and builds rapier colliders with
those explicit values. A cross-check test asserts that rapier's resulting body
mass, CoM and inertia equal `mass.ts` to 1e-9, so the two never drift apart.

## Shared interface (pinned before wave 1, so 4.1 and 4.3 build to the same shape)

Body coordinates are the workshop's (ADR 0003): +X forward, +Y left, +Z up,
metres, kg, seconds. The origin is the frame centre at the bottom of the centre
plate. An inertia is given as tensor components about the stated point, in body
axes: `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]` (kg·m²), with the tensor sign convention
(Ixy = −Σ m·x·y), so the full matrix is [[Ixx,Ixy,Ixz],[Ixy,Iyy,Iyz],[Ixz,Iyz,Izz]].

```ts
// src/domain/mass.ts (4.1) produces this; engine `vehicle.load` (4.3) consumes it as JSON.
type Vec3 = [number, number, number]
type Quat = [number, number, number, number] // x, y, z, w (three.js order)
type Inertia6 = [number, number, number, number, number, number]

type CollisionShape =
  | { type: 'box'; halfExtents: Vec3 }
  | { type: 'cylinder'; radius: number; halfHeight: number } // axis = local Z
  | { type: 'hull'; points: Vec3[] }                         // local coordinates

interface PartBody {
  partId: string
  massKg: number
  com: Vec3          // part CoM in body coordinates
  inertia: Inertia6  // about the part's own CoM, body axes
  pose: { position: Vec3; quaternion: Quat } // collision shape placement in body coordinates
  shape: CollisionShape
}

interface MotorBody {
  partId: string
  position: Vec3      // thrust point (prop hub) in body coordinates
  thrustAxis: Vec3    // unit vector, body axes (includes tilt)
  spin: 'cw' | 'ccw'  // seen from above, as in the workshop
}

interface VehicleDefinition {
  version: 1
  parts: PartBody[]   // only parts with a mass; the frame is 'frame:plate' + 'frame:arm-1…n'; ids are opaque and unique
  motors: MotorBody[]
  totalMassKg: number
  com: Vec3
  inertia: Inertia6   // about `com`, body axes
  missingMass: string[] // part ids without a mass; a non-empty list blocks flight
}
```

The engine trusts nothing: `vehicle.load` validates the definition (finite
numbers, positive mass, a positive-definite inertia satisfying the triangle
inequality, unit axes) and recomputes the totals from `parts`. A mismatch with the
sent totals beyond 1e-9 relative is an error, not a silent correction.

## Physical model (all documented in the code and in a Method panel)

**Mass properties**

- Part mass comes from its linked component, or from the user's value.
- A part with no mass makes the CoM **incomplete**. The CoM is still shown, with
  "N parts without mass" listed, and flying is blocked until every part has a mass.
- **Frame mass** is a new frame parameter. The user enters it, or it is computed
  from plate and arm volume × a density. The density must come from a cited
  datasheet or be entered by the user.
- **Part inertia** about the part's own centre:
  - a uniform solid of its collision shape (box: m(b²+c²)/12 …; cylinder:
    m(3r²+h²)/12 and mr²/2);
  - this assumption is labelled, and the user can enter their own tensor and
    CoM offset.
- **Totals**:
  - CoM = Σ mᵢ rᵢ / Σ mᵢ, with rᵢ from the existing `worldMatrix`;
  - I = Σ (Rᵢ Iᵢ Rᵢᵀ + mᵢ(|dᵢ|² E − dᵢ dᵢᵀ)), with dᵢ = rᵢ − CoM (parallel axis
    theorem).

**Motor and propeller** (per motor, at its true pose: position, arm direction, tilt)

- **Thrust**: T = k_T ω².
  - k_T is fitted (least squares) to the motor's cited thrust table rows for that
    prop.
  - Otherwise it comes from cited prop performance data. The plan is to source
    APC's published performance files for the three APC props.
  - Otherwise the user must enter it.
- **Drag torque**: Q = k_Q ω².
  - k_Q is fitted from the table's current: Q = K_t (I − I₀), with
    K_t = 60 / (2π·KV) and I₀ the stated no-load current.
- **Steady speed**: from the motor's electrical model, solved together with the
  drag torque:
  - V·throttle = ω/K_v + R·I (stated KV and internal resistance);
  - K_t (I − I₀) = k_Q ω².
  - The solved RPM and thrust are compared with the cited table and the error is
    reported. That comparison is the model's validation.
- **Response**: J dω/dt = K_t (I − I₀) − k_Q ω².
  - Prop inertia is derived from mass and radius (blade-as-rod assumption,
    labelled).
  - Rotor-bell inertia is not stated anywhere, so the user must enter it, or enter
    the motor time constant directly.
- **Spin direction** comes from the mount. It sets the sign of the reaction torque
  and the gyroscopic coupling.
- **Max RPM, max thrust and power** come out of this model at the pack voltage.
  Current draw feeds the 3.7 battery model.

**Battery**

- The pack voltage sags as V = V_oc − I·R_int. R_int must be stated or entered;
  the Tattu pack states none.
- Charge used is ∫I dt (mAh). The run ends when the user-set cut-off is reached.

**Aerodynamics**

- Body drag per axis: F = ½ ρ C_d A v².
  - A is the projected area of the collision shapes, which is derived.
  - C_d is entered by the user.
  - ρ comes from the ISA standard atmosphere (ISO 2533, cited) at the altitude and
    temperature you set.
- Wind and ground effect stay in a later milestone.

**Rigid body**

- rapier integrates the motion with a fixed step of 1 ms.
- Each step, our code applies thrust and torque per motor, gravity, drag, and the
  gyroscopic torque −ω × (Iω) if rapier omits it. The 4.3 spike checks this
  against conservation of angular momentum.

**Controller** (runs inside the engine at 1 kHz)

- **Loops**: an angle loop (P) feeds a rate loop (PID with integrator limits).
  Altitude hold is a velocity/position PID.
- **Gains**: PX4's documented default parameters, cited with the PX4 version, and
  editable.
- **Allocation**: the pseudo-inverse of the effectiveness matrix, built from the
  *nominal* motor geometry about the frame centre.
- Like a real flight controller, it does not know the true CoM.
  - A CoM offset therefore has to be trimmed out by the integrator, using some of
    the motors' thrust headroom.
  - When the offset is too large, motors saturate and the drone cannot hold
    attitude. This is the behaviour the spec asks for, arising from the physics
    rather than being scripted.

**Collisions**

- **Collision shape per part**: its envelope primitive (box or cylinder), or the
  convex hull of an imported model (computed once at import and saved). The prop
  uses its swept disc.
- **Workshop interference check**: overlaps deeper than a configurable tolerance
  are errors, with both parts highlighted.
  - Parent–child contact (a motor on its pad, a prop on its motor) is allowed by
    default.
  - The user can also allow an overlap for a specific pair of parts.
- **In flight**: rapier contacts against the ground plane and box obstacles.
  - The friction and restitution of the ground and obstacles are environment
    settings the user enters.
  - Contacts are reported to the debug panel: which part touched what, and when.

## Inputs the user will have to enter (nothing in the sources states them)

Frame mass (or a cited density), battery internal resistance (Tattu), body C_d,
motor rotor inertia (or time constant), ground friction and restitution, and k_T
for any motor and prop pair without data. A "Ready to fly" checklist lists exactly
what is missing for the current build, with a link to each field.

## Milestones

Each milestone ends with `npm run test:all` green, a DEVLOG entry and screenshots.

| # | Scope |
|---|---|
| 4.1 Mass properties | Frame mass parameter (migration); `mass.ts` (mass, CoM, inertia, incomplete CoM); CoM marker in the viewport; mass panel with the CoM in X/Y/Z and its distance from the frame centre, plus the inertia tensor; live updates while dragging; CoM-offset warning (threshold is a setting) |
| 4.2 Editor additions | New part kinds: GPS, camera, sensor, landing gear (parametric legs/skids); drag a component from the library into the viewport or onto a mount; scale tool for envelope parts only (linked components keep their stated size); per-part inertia and CoM-offset override; collision-shape choice |
| 4.3 Engine foundation | rapier3d-f64 with enhanced determinism; protocol v2; `vehicle.load` from the assembly; cross-check against `mass.ts`; spikes: gyroscopic term and determinism hash; ADR 0005 (rapier) and ADR 0006 (mass properties in TS, simulation in Rust) |
| 4.4 Collisions | Interference check in the workshop (live while dragging, debounced); tolerance and allowed pairs; collision-boundary debug view; ground and obstacle contact in the engine |
| 4.5 Motor, prop and battery models | k_T and k_Q fits and the steady-state solver; validation against the cited thrust tables (error shown); APC performance data sourced into the seed; Ready-to-fly checklist |
| 4.6 Flight dynamics | Per-motor forces at their true pose, reaction torque, gravity, drag, battery sag and consumption; analytical tests |
| 4.7 Controller | Angle/rate cascade, allocation, altitude hold, PX4 default gains (cited) |
| 4.8 Flight test view and physics debug | Engine → renderer state stream; flight view with ground and obstacles; keyboard sticks; a debug panel showing every value the spec lists (mass, CoM, inertia, thrust per motor and total, torque per axis, angular and linear velocity, collisions, battery use); indicators for unbalanced mass, motor layout, collisions, T/W below the limit and instability |
| 4.9 Scenarios and acceptance | Scripted unbalanced and payload scenarios; determinism; docs; update the ROADMAP (Phase 5/6 then deepen what 4.7/4.8 start) |

## Automated tests (the spec's 10 areas)

1. **CoM**: hand-calculated builds (two parts; battery moved 30 mm → the exact CoM
   shift).
2. **Inertia**: box and cylinder formulas, parallel axis theorem, a rotated part,
   and the rapier cross-check.
3. **Attach/detach**: transforms are kept and the mass properties follow (the
   existing ops, plus new kinds).
4. **Collision detection**: overlap/no-overlap for each pair of shape types, with
   tolerance edges and allowed pairs.
5. **Collision response**: a drop onto the ground comes to rest at the right height
   and with zero velocity within a set time; the contact is reported.
6. **Motor thrust**: the fit reproduces the cited table rows within the reported
   error, and the steady-state solver is checked against a hand solution.
7. **Torque**: a single motor's roll/pitch/yaw torque from its position and spin
   equals r × F + reaction torque.
8. **Stability vs mass distribution**:
   - centred CoM: holds hover within limits;
   - 20 mm offset: holds, with the hover integrator trim and motor imbalance
     matching the hand calculation;
   - large offset: saturates and loses attitude (detected).
9. **Payload**: hover throttle rises and acceleration falls as predicted by T/W;
   above max thrust, the drone cannot climb.
10. **Consistency and determinism**:
    - the same inputs give an identical state hash over 10 s;
    - free fall matches ½gt² (within a stated tolerance);
    - a constant torque matches the analytical spin-up;
    - angular momentum is conserved without torque.

## Risks

- **rapier's integrator** is symplectic Euler. The analytical tests use 1 ms steps
  and state their tolerance; contact behaviour is not hand-verifiable (accepted
  with the choice).
- **Missing data** means that, out of the box, the built-in parts can't fly until
  the user enters the values in the list above. This is intended under "derive or
  ask", but it is the first thing you will notice.
- **Scope**: this is the largest phase so far. 4.1–4.2 are useful on their own
  (live CoM and inertia in the workshop) before any flying.
