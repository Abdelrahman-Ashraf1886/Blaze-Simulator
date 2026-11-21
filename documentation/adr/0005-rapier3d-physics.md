# ADR 0005: rapier3d integrates the rigid body and resolves contacts; our code adds every force

**Status:** accepted (2026-11-21)

## Context
Phase 4 needs a rigid-body integrator for the vehicle and, from 4.4, contacts with
the ground and obstacles. Writing a contact solver ourselves is a large, risky
project. The simulation must be deterministic (same inputs, bit-identical state)
and every physical value must come from the vehicle data or a cited source.

## Decision
- **`rapier3d-f64` 0.36.1** (Apache-2.0, dimforge), pinned exactly (`=0.36.1`) with
  the `enhanced-determinism` feature (libm math in simba/parry, no platform
  intrinsics). A version bump can change results bit for bit, so it is a
  reviewed change.
- rapier does **integration and contacts only**. Gravity (g = 9.80665 m/s²,
  3rd CGPM 1901 / ISO 80000-3) is set as world gravity; every other force and
  torque is applied by our code each step (`engine-core/src/sim.rs`), in body
  axes, held constant over the step.
- One dynamic body per vehicle, one collider per part. Colliders carry the
  part's explicit mass properties, never a density (ADR 0006).
- Fixed step: 1 ms by default. The body never sleeps.
- State hash: FNV-1a 64 over the step count and the exact bit patterns of
  position, attitude, linear and angular velocity.

## Findings (4.3 spikes, rapier 0.36.1)
- **Gyroscopic term.** rapier applies −ω×(Iω) itself, enabled by default
  (`gyroscopic_forces_enabled`): an explicit term per substep, then the
  body-frame momentum is rescaled to its previous magnitude. Torque-free
  tumbling of an asymmetric body for 10 s at 1 ms: world angular momentum
  drifts at most 4.5e-4 relative, energy 2.1e-3. With the term switched off,
  L drifts 54 %. **We do not add the term ourselves** (it would be counted twice).
- **Determinism.** The same inputs give the same state hash over 10 s, within one
  process and across two engine processes. A 1e-12 N change at one step changes
  the hash.
- **Substeps.** rapier splits each step into `num_solver_iterations` = 4
  substeps, so the symplectic-Euler step is h = dt/4 = 0.25 ms. Free fall
  follows the discrete solution exactly: error ½·g·t·h (1.23 mm after 1 s).
- **Eigen solver defect (glamx 0.3.1).** `MassProperties::with_inertia_matrix`,
  which rapier also uses when it sums collider mass properties, diagonalizes
  with glamx's closed-form solver. It returns a wrong principal frame when the
  smallest principal moment is repeated (13 % reconstruction error for a tilted
  round motor, at any scale), and for any small tensor (an absolute 1e-20
  threshold; 29 % error at 1e-6 kg·m², the size of a motor). Mitigations:
  - we diagonalize every part tensor ourselves (cyclic Jacobi,
    `vehicle::principal_axes`) and give rapier the principal frame directly;
  - colliders are summed heaviest first, so partial sums are large;
  - `vehicle.load` builds the body and refuses a vehicle whose rapier mass,
    CoM or inertia differs from our recomputation by more than 1e-9, with a
    message saying why. A zero-mass-collider fallback does not work: zero-mass
    colliders still pass through the same sum.

## Limits (accepted with the choice)
- **Integrator.** Symplectic (semi-implicit) Euler, first order. The
  analytical tests use 1 ms steps and state their error bounds.
- **Contacts are not hand-verifiable.** rapier's soft-constraint contact solver
  can be tested for outcomes (comes to rest at the right height, contact
  reported), not checked against a closed form.
- **Velocity cap.** rapier clamps linear speed at
  `normalized_max_linear_velocity × length_unit` = 400 m/s (defaults). That is far
  above any multirotor, but it is a limit.
- **Rotation update** is accurate to about 2e-8 rad over 1 s of constant spin
  at 1 ms (4000 substeps), not exact.

## Consequences
- \+ Contacts, CCD and joints are available without writing a solver.
- \+ All forces are ours, so each one is documented and testable.
- − The repeated-smallest-moment refusal can block an unusual build until a
  part is moved slightly. Follow-up: report the glamx defect upstream
  (dimforge/glamx) and drop the refusal once a fixed version is pinned.
