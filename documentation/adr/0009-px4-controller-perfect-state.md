# ADR 0009 — PX4 controller port and perfect-state boundary

**Accepted 2026-11-24**

## Context

Phase 5 needs tuning measurements and flight control on the same deterministic
plant. The phase plan approved the PX4 v1.13.3 controller port, the derived motor
curve (D4), the perfect-state boundary (D6) and a single vertical controller
(D13). [Phase 5 decisions](../plans/phase-5-flight-control.md#decisions)

## Decision

- Port the PX4 v1.13.3 multicopter attitude, rate, position and manual-mode
  logic, with its allocation and hover-thrust estimation. `controller.rs`,
  `position_control.rs`, `flight_modes.rs` and `hover_thrust.rs` cite the source.
  `PositionControl` owns vertical control for both direct setpoints and manual
  modes. The plant uses body FLU and world Z-up. The position equations convert
  to NED/FRD at their boundary.
- Pass exact simulated state across the estimator boundary. Hover-thrust
  estimation uses the simulated change in vertical velocity and the normalized
  thrust setpoint. The distance input measures height above the ground below,
  and free space counts as airborne. The controller remains independent of the
  plant's modified mass and CoM during scenarios.
- Apply PX4's inverse motor curve between allocation and propulsion.
  Saturation and anti-windup use the allocator's output. The engine uses zero
  when the factor is omitted. The app derives a build-specific value at nominal
  pack voltage with sag. Saved `THR_MDL_FAC` takes precedence.

## Consequences

- Tuning and step responses use exact signals and can look better than flight
  on a real vehicle. D6 assigns the sensor models, estimator, gyro low-pass and
  gyro differentiation filter to Phase 7. They can supply the same controller
  input boundary.
- The airborne/manual-mode gate uses simulation ground contact. It approximates
  PX4's landed detection and takeoff logic.
- The curve changes the effective propulsion response and can change scenario
  measurements. The 5.9 DEVLOG records both factor settings with the same
  4.9 criteria.
