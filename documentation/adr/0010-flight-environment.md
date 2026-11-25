# ADR 0010 — Flight environment models

Date: 2026-11-24. Status: Accepted.

## Context

Phase 6 adds wind, near-ground thrust and collidable surfaces to the perfect-state flight engine from [ADR 0009](0009-px4-controller-perfect-state.md). Wind and ground-effect inputs are saved per project. The Scenarios page exercises the models on a build. [Phase 6 decisions](../plans/phase-6-flight-environment.md#decisions-made-with-you)

## Decision

- Compute quadratic per-axis body drag with the vehicle’s velocity relative to local air. Constant wind and logarithmic shear supply mean velocity. MIL-F-8785C §3.7.3.2 gives the shear form and roughness categories. The 3–1000 ft evaluation range comes from the secondary reference. The engine holds the lower value below 3 ft and clamps and flags above 1000 ft. MIL-F-8785C §3.7.1.3 gives the discrete cosine ramp. The engine integrates air distance relative to the mean after the saved start time, and the increment persists at full amplitude. [Wind sources](../plans/phase-6-flight-environment.md#mean-wind-with-height-and-a-discrete-gust) · [Runtime sampling](../../simulation-engine/engine-core/src/flight.rs#L195-L211) · [Discrete gust](../../simulation-engine/engine-core/src/wind.rs#L225-L261)
- Enable ground effect by explicit project choice. Apply Cheeseman–Bennett equation 4 to each rotor with its own hub height over the plane or terrain and in-plane airspeed. Clamp the evaluation below `Z/R = 0.5` and expose that condition. The model adds thrust at unchanged rotor torque and shaft power. Obstacles count as colliders and do not supply ground-effect height. [Model derivation](../../simulation-engine/engine-core/src/ground_effect.rs#L1-L48) · [Per-rotor loads](../../simulation-engine/engine-core/src/flight.rs#L465-L509)
- Use a ground plane or triangulated terrain and place the collision shapes using engine start clearance. Aircraft state is exact. Start arms the vehicle, and the PX4 takeoff ramp and landed detector drive the auto sequence. The auto modes smooth the vertical trajectory and hold fixed XY and yaw. [Start placement](../../simulation-engine/engine-core/src/sim.rs#L123-L171) · [Auto modes](../../simulation-engine/engine-core/src/auto_modes.rs#L1-L6)

## Consequences

Body drag is the only direct wind force. Rotor inflow, rotor drag and rotor-to-rotor ground-effect interaction are outside these models. The single-rotor thrust correction has unknown error on a multirotor. Except on that leg, auto modes omit XY smoothing, and all omit multi-waypoint smoothing, time stretching and axis synchronization. Hold entered at speed pulls back toward the captured position. Low-altitude Dryden turbulence (6.11, `engine-core/src/turbulence.rs`) is a frozen field that needs a mean wind and is not applicable to hovering flight. Return (6.12) flies one straight leg to the run start. [D6 and D7](../plans/phase-6-flight-environment.md#decisions-made-with-you) · [Hold target](../../simulation-engine/engine-core/src/auto_modes.rs#L55-L97)
