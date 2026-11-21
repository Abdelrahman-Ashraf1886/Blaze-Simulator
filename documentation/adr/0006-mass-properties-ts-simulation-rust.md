# ADR 0006: Mass properties are computed in TypeScript, the simulation runs in Rust, and the engine cross-checks them

**Status:** accepted (2026-11-21)

## Context
The workshop must show the CoM and inertia live while a part is dragged (60 fps),
without an engine round trip. The simulation (rapier, ADR 0005) needs the same
values. Two implementations of the same physics can drift apart silently.

## Decision
- **`src/domain/mass.ts`** (pure TypeScript, milestone 4.1) computes the static
  mass properties per part and in total, and produces the `VehicleDefinition`
  pinned in `documentation/plans/phase-4-physics.md` ("Shared interface").
- **`engine-core/src/vehicle.rs`** (Rust) trusts nothing it receives:
  - main checks the shape with zod first (`electron/main/engine/protocol.ts`);
  - the engine checks every number is finite, masses are positive, every inertia
    is positive definite and its principal moments satisfy the triangle
    inequality, quaternions and thrust axes are unit length (1e-9), part ids are
    unique (they are opaque strings; the frame arrives as several parts), and a
    part cannot both have a mass and be listed in `missingMass`;
  - it **recomputes** the totals from the parts:
    m = Σ mᵢ, c = Σ mᵢ rᵢ / m, I = Σ (Iᵢ + mᵢ(|dᵢ|² E − dᵢ dᵢᵀ)), dᵢ = rᵢ − c;
  - it compares them with the sent totals: |Δm| ≤ 1e-9·m, |Δc| ≤ 1e-9·L (L the
    vehicle's extent, since a CoM can be zero), ‖ΔI‖_F ≤ 1e-9·‖I‖_F. A larger
    difference is an error listed back to the app, never a silent correction;
  - it builds the rapier body from per-part colliders with explicit mass
    properties and checks that rapier's body mass, CoM and inertia equal the
    recomputation to 1e-9 (refusing the vehicle otherwise; see ADR 0005).
- Totals are compared only once the structure is valid, so the first errors a
  user sees are the root causes.
- Parts listed in `missingMass` do not stop `vehicle.load` (the app needs the
  totals to show an incomplete CoM) but `sim.run` refuses with
  `VEHICLE_INCOMPLETE`.

## Consequences
- \+ The editor stays fast, and the simulation cannot run on numbers the editor
  did not show: any disagreement surfaces as a load error.
- \+ Each side is tested on its own against hand calculations, and the engine
  side is also tested against rapier.
- − The formulas exist twice (TypeScript and Rust). The 1e-9 comparison makes a
  divergence visible on the first load instead of hiding it.
- − The interface is pinned: a field added on one side is refused by the other
  (`deny_unknown_fields` in Rust, `strictObject` in zod) until both change.
