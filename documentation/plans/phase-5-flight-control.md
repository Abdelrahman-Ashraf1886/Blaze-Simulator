# Phase 5 plan: flight control

Status: **Draft, awaiting your decisions.**

Written against `phase-1-foundation` at 4.7 (609a672). 4.8 (live flight, debug panel) and
4.9 (scripted scenarios) are in progress on other branches. File and type names taken from
those branches (`flight_session.rs`, `scenario.rs`) may change before they merge; the
milestones that depend on them are marked.

## Goal

You can tune the flight controller of the drone you built, and see what the tuning does:
- the vehicle flies in three PX4-style modes: stabilized, altitude hold, position hold;
- every gain, limit and threshold is a cited PX4 value or one you entered, edited per
  project with validation and saved;
- a scripted step (roll, pitch, yaw, rate, altitude, horizontal position) gives rise
  time, overshoot, settling time and steady-state error, so a gain change can be judged
  by numbers and not only by watching the drone.

Everything is computed by the engine from the vehicle and the controller settings. The
renderer shows it.

## What Phase 4 already delivers, and what Phase 5 adds

| Part of the controller | Phase 4 (as built or in progress) | Phase 5 |
|---|---|---|
| Attitude P with yaw weighting | 4.7: `controller.rs::attitude_rates` | Unchanged |
| Rate PID, feed-forward, K, integrator limits, saturation anti-windup | 4.7: `RateControl` | Unchanged. The D filter belongs to the sensors (D6) |
| Allocation: pseudo-inverse, PX4 normalisation, desaturation | 4.7: `Allocator`, airmode 0 only | Airmode 1 and 2 (D3) |
| Vertical position and velocity hold, thrust limits | 4.7: inside `Controller::step` | Same behaviour, now one part of a 3-axis position controller |
| **Horizontal position and velocity control** | No | **5.1** |
| **Thrust vector to attitude, tilt limit, horizontal thrust margin** | No: the attitude setpoint is given | **5.1** |
| **Thrust curve (`THR_MDL_FAC`)** | No: command = throttle, linear (4.7 header) | **5.2** |
| **Flight modes** | 4.8 keyboard sticks: attitude, yaw rate and climb rate with UI limits (30°, 90°/s, 2 m/s) that are not PX4 values | **5.3**: rates, stabilized, altitude, position, with PX4's stick mapping and limits. The 4.7 attitude API stays for scripted runs |
| Gains | `sim.run` and 4.8 sessions accept overrides by exact PX4 name; Rust checks only "finite and not negative" | **5.5**: stored per project, checked against PX4's documented ranges, editable in the UI |
| Scenarios | 4.9: summary checks (`pass/fail`, max error, mean throttle…), no time series | **5.7**: time series from a scripted step; **5.6**: the metrics |
| Estimator | None: the controller gets the true state (4.7 header) | Unchanged (D6). The boundary stays where Phase 7 can insert sensor models |
| Hover thrust | `MPC_THR_HOVER` fixed at its default 0.5; the integrator absorbs the difference | Unchanged unless you choose to port the estimator (D5) |

Not in Phase 5: auto modes (mission, takeoff, land, return), trajectory generators,
collision prevention, terrain following, wind estimation, failsafes, arming and the landed
detector. Phase 6 covers input devices, cameras and any further modes.

## Decisions (for you)

Nothing below is decided. Each row has a recommendation; the plan is written to it.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | PX4 version | (a) stay on v1.13.3, as 4.7 and the cited data; (b) move to a newer release | **(a)**. One version means one set of citations. A newer release changes the reference data, the 4.7 defaults and the 4.9 baselines together, and I have not read its differences |
| D2 | Which PX4 parts to port | (a) `PositionControl` + `ControlMath` + the three manual modes; (b) (a) plus jerk-limited trajectories and auto modes | **(a)**. Auto modes need a mission and a takeoff/land state machine, which belong with Phase 6 |
| D3 | Airmode | (a) 0 only, as now; (b) add 1 (roll/pitch) and 2 (roll/pitch/yaw) as a setting, default 0 | **(b)**. The algorithms are short (`mixAirmodeRP`, `mixAirmodeRPY`) and they change how a large CoM offset saturates, which is what 4.9 measures. PX4's own text says to disable it while tuning, so the default stays 0 and the UI says so |
| D4 | Thrust curve | (a) `THR_MDL_FAC` = 0, PX4's default; (b) derived by fitting PX4's model to our propulsion model, shown with its fit error, you can overwrite it; (c) you enter it | **(b)**. PX4's guide tells users to fit it to thrust-stand data, and the 4.5 model is that data. Derived, not invented. Applied by default only in 5.9, after the 4.9 baselines are re-run (see risks) |
| D5 | Hover thrust | (a) fixed `MPC_THR_HOVER`, editable, integrator absorbs the rest; (b) derive it from the model at the nominal mass; (c) port PX4's hover thrust estimator | **(a)** for 5.1 to 5.9. (c) is optional 5.10. (b) is not what a real controller knows, and (c) is what makes a payload change settle in PX4 |
| D6 | Estimator and sensor filtering | (a) perfect state in Phase 5, Phase 7 adds sensor models and an estimator; (b) add a simple estimator now | **(a)**. The gyro low-pass (`IMU_GYRO_CUTOFF`, 40 Hz) and the D-term differentiation (`IMU_DGYRO_CUTOFF`, 30 Hz) act on sensed signals, so they come with the sensor models. Until then tuning on exact signals looks better than a real vehicle would |
| D7 | Where flight modes live, and the split with Phase 6 | (a) mode logic in engine-core now, UI selector on the existing flight page; Phase 6 adds input devices, cameras, auto modes; (b) leave all modes to Phase 6 and test position control with scripted setpoints only | **(a)**. The stick shaping (expo, dead zone, tilt and speed limits) decides how a gain change feels and is part of the controller stack in PX4. Phase 6 then only maps devices to normalised sticks |
| D8 | Position-mode submode | (a) `MPC_POS_MODE` 4, PX4's default: sticks command acceleration with a virtual brake drag; (b) (a) plus 0: sticks command velocity directly, which PX4 describes as useful for velocity tuning; (c) all three including the jerk-optimised mode | **(b)**. Mode 3 needs the trajectory generator, which is out of scope (D2) |
| D9 | Tuning storage | (a) one set of overrides per project; (b) named tunes per project; (c) global presets | **(a)**. A project has one assembly today, so per project is per build. Only overrides are stored, so PX4 defaults stay visible. Each step-response and scenario result records the gains it used. (b) can be added later without changing the storage of (a) |
| D10 | Tuning aids beyond editing gains and step responses | (a) none; (b) linear loop analysis (gain and phase margins) from the vehicle's own inertia and motor lag; (c) auto-tune | **(a)**. PX4's guide tunes from step responses. (b) is optional 5.11: it needs the motor time constant, which is still a user input (4.5), and a linearisation whose error I would have to quantify. (c) has no PX4 source |
| D11 | Range checks on gains | (a) refuse a value outside the `@min`/`@max` PX4 documents for it; (b) warn only | **(a)**. The limits are PX4's, cited per parameter. Parameters with no documented range get no invented one; they keep the existing "finite, not negative" check and the relations (`min ≤ hover ≤ max ≤ 1`) |
| D12 | Step-response definitions | (a) 10–90 % rise time, 2 % settling band, overshoot as a percentage of the step, steady-state error as the mean over the last 10 % of the window, all editable, computed in TypeScript from the time series; (b) computed in Rust inside the scenario report | **(a)**. These are conventions, not PX4 values, so they are labelled as ours and editable; I have not yet checked them against a textbook and will cite one in 5.6. TypeScript lets the panel change a threshold without re-running the simulation (ADR 0008), and there is one implementation, so no cross-check as in ADR 0006 |
| D13 | Integration style | (a) new modules next to 4.7's `Controller`; once 4.8 and 4.9 have merged, 5.9 can make `ClosedLoop` use the new loop; (b) change `Controller`, `Setpoint` and `ControllerInput` now | **(a)**. 4.9's `scenario.rs` builds those types, so changing them now would collide with that branch. (a) leaves 4.7/4.8/4.9 results bit-identical, which a test asserts |

## Where each calculation lives (ADR 0006, ADR 0008)

| Calculation | Where | Why |
|---|---|---|
| Position/velocity control, thrust vector to attitude, tilt and thrust limits | `engine-core` (Rust): `position_control.rs` | In the 1 kHz loop, deterministic, no IO |
| Flight modes: stick mapping, setpoint generation, position lock, mode-driven loop | `engine-core`: `flight_modes.rs`, `flight_loop.rs` | Same loop; sticks arrive normalised in [−1, 1] as in PX4's `manual_control_setpoint` |
| Airmode, thrust curve applied to the commands | `engine-core`: `controller.rs` (airmode), `thrust_model.rs` | Part of allocation and output |
| Thrust-curve **fit** (the derived `THR_MDL_FAC`) | `src/domain/thrust-curve.ts` (pure TS) | Like the k_T fit in `propulsion.ts`: derived from the propulsion model in the editor, sent to the engine as a number, with its error shown. The engine only applies the formula |
| Parameter table: names, defaults, units, ranges, groups, validation | `src/domain/controller-params.ts` (pure TS), reading `database/reference/physics.v1.json` | Used by the UI, by main's zod check and by tests. The engine re-validates everything it receives (ADR 0006 rule: trust nothing) |
| Step-response metrics | `src/domain/step-response.ts` (pure TS) | Post-processing of a sampled signal; thresholds editable (D12) |
| Time-series recording, step definitions | `engine-core`: `trace.rs`, plus the scenario runner from 4.9 | The samples only exist inside the engine |
| Protocol messages, session handling | `engine-host` | No physics or control maths |
| Tuning storage, IPC | `electron/main` repositories, migration, `electron/ipc` | Like assemblies and physics inputs |
| Panels, charts, mode selector | Renderer | Draws values; never computes control. Setpoints are drawn in magenta, as DESIGN.md reserves for Phase 5 |

Frames: the engine's world is Z-up (+X forward, +Y left). PX4 is NED/FRD. The conversion
is the one 4.7 already uses (`controller.rs` header): diag(1, −1, −1) on vectors, so y and
z (and pitch/yaw rates) change sign, and yaw is negated. The position controller applies
it once at its boundary, as the vertical loop does now.

## The control model

All PX4 references are tag **v1.13.3**, the tag `physics.v1.json` cites. Read on
2026-11-23 from `raw.githubusercontent.com/PX4/PX4-Autopilot/v1.13.3/…`. Prefix of every
path below: `https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/`. "L" is the line number at
that tag. Items marked **to verify** were not read yet; 5.x reads them before coding and
fixes the citation, and the plan changes if one turns out different.

### Position and velocity control

`src/modules/mc_pos_control/PositionControl/PositionControl.cpp`

| What | Lines | Our use |
|---|---|---|
| `_positionControl`: velocity setpoint = (pos_sp − pos)·P, plus feed-forward; XY limited with priority to the position term; Z limited to [−up, down] | L124–138 | Ported for XY and Z. A NaN setpoint component means "not controlled" |
| `_velocityControl`: acc_sp = P·(v_sp − v) + integrator − D·dv/dt | L140–149 | Ported |
| Vertical anti-windup: no integration when thrust is at its minimum or maximum and the error pushes further | L151–155 | Same as 4.7's vertical rule; the test shows equal output |
| Vertical priority with a horizontal margin: z thrust ≤ √(max² − min(\|xy\|, margin)²) | L157–167 | Ported; `MPC_THR_XY_MARG` |
| Horizontal thrust cut to what is left | L169–180 | Ported |
| Horizontal tracking anti-windup, gain 2/P_vel,x | L182–186 | Ported |
| Vertical integrator limited to ±g | L193–194 | Already in 4.7; horizontal is not limited by this line |
| `_accelerationControl`: body z = normalise(−a_x, −a_y, g), tilt limit, collective = a_z·hover/g − hover, projected on body z, at least `MPC_THR_MIN` | L197–208 | Ported (4.7 uses the vertical part) |
| `setThrustLimits` (minimum at least 1e-3), `updateHoverThrust` | L61–66, L73–86 | Limits ported. `updateHoverThrust` only if D5(c) |
| Input validity (each axis needs some setpoint, x/y in pairs, estimate valid where a setpoint is used) | L210–236 | Ported as a returned error, not a panic |

`src/modules/mc_pos_control/PositionControl/ControlMath.cpp`: `thrustToAttitude` L47–51,
`limitTilt` L53–68, `bodyzToAttitude` L70–120 (yaw reference, inverted-flight rule,
quaternion from the matrix), `constrainXY` L122–… (five branches; the last solves a
quadratic. Its end line to be read in 5.1).

`src/modules/mc_pos_control/MulticopterPositionControl.cpp`:
- gains and margin wiring L164–169;
- limits per step L436–450: tilt limit `MPC_TILTMAX_AIR`, normally, but `MPC_TILTMAX_LND`
  until takeoff completes; minimum thrust is 0 before flight, `MPC_THR_MIN` in flight;
- velocity derivative L268–284, per axis, with `control::BlockDerivative`
  (`src/lib/controllib/BlockDerivative.cpp` L48–68: a first-order low-pass of the
  finite difference, first sample 0) and `BlockLowPass.cpp` L48–57 (α = b/(1+b), b = 2π·f·dt),
  cut-off `MPC_VELD_LP` (5 Hz).

Differences from 4.7 that 5.1 introduces on purpose: the vertical D term uses this filter
(4.7 differences unfiltered). At the default `MPC_Z_VEL_D_ACC` = 0 the results are equal;
the conformance test runs with D = 0 and says so.

For reference (not ported, D6): PX4's rate-loop D term uses an angular acceleration derived
from a filtered gyro (`src/modules/mc_rate_control/MulticopterRateControl.cpp` L127–137,
L242), with `IMU_GYRO_CUTOFF` 40 Hz (L118) and `IMU_DGYRO_CUTOFF` 30 Hz (L160) in
`src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`.

Our estimate for the position loop is the CoM position and velocity (as 4.7 does for z).
The controller does not know the true CoM beyond that, which is a perfect-state
simplification (D6).

### Parameters added

Defaults are the `PARAM_DEFINE` values; line numbers are in
`src/modules/mc_pos_control/mc_pos_control_params.c` unless a file is named. Units and
`@min`/`@max` are in the same doc comments and are read in 5.0.

| Group | Parameters (default, line) |
|---|---|
| Horizontal loop | `MPC_XY_P` 0.95 (L270), `MPC_XY_VEL_P_ACC` 1.8 (L282), `MPC_XY_VEL_I_ACC` 0.4 (L295), `MPC_XY_VEL_D_ACC` 0.2 (L307), `MPC_XY_VEL_MAX` 12 (L379), `MPC_VELD_LP` 5 (L529) |
| Limits | `MPC_TILTMAX_AIR` 45° (L392), `MPC_TILTMAX_LND` 12° (L405, used only if D2 gains a landed state), `MPC_THR_XY_MARG` 0.3 (L123) |
| Stabilized and altitude modes | `MPC_MAN_TILT_MAX` 35° (L462), `MC_MAN_TILT_TAU` 0 s (`mc_att_control_params.c` L160), `MPC_MAN_Y_MAX` 150°/s (L473), `MPC_MAN_Y_TAU` 0.08 s (L486), `MPC_THR_CURVE` 0 (L108), `MPC_MANTHR_MIN` 0.08 (L152), `MPC_HOLD_DZ` 0.1 (L496), `MPC_HOLD_MAX_Z` 0.6 (L518), `MPC_Z_MAN_EXPO` 0.6 (L675), `MPC_YAW_EXPO` 0.6 (L691) |
| Position mode | `MPC_POS_MODE` 4 (L781), `MPC_VEL_MANUAL` 10 (L364), `MPC_HOLD_MAX_XY` 0.8 (L507), `MPC_XY_MAN_EXPO` 0.6 (L659), `MPC_ACC_HOR` 3 (L561), `MPC_JERK_MAX` 8 (L605), `MPC_ACC_UP_MAX` 4 (L573), `MPC_ACC_DOWN_MAX` 3 (L585) |
| Mixer | `MC_AIRMODE` 0 (`src/lib/mixer_module/params.c` L18), `THR_MDL_FAC` 0 (`src/lib/mixer_module/motor_params.c` L73, range 0 to 1) |

Already stored from 4.7 and reused: `MPC_Z_P`, `MPC_Z_VEL_*_ACC`, `MPC_THR_HOVER`,
`MPC_THR_MIN`, `MPC_THR_MAX`, `MPC_Z_VEL_MAX_UP/DN`, `MPC_USE_HTE`.

`SYS_VEHICLE_RESP` (L831, default −0.4) rewrites several of these when it is ≥ 0
(`MulticopterPositionControl.cpp` L92–117). At its default it does nothing. We do not port
it; the parameter list says so, and the individual parameters are used.

### Flight modes

| Mode | PX4 source | What is ported |
|---|---|---|
| **Rates** | `MulticopterRateControl.cpp`; tuning guide | A direct rate setpoint (rad/s) into the rate loop, no stick shaping. Needed for rate step tests (PX4 tunes the rate loop in Acro or Stabilized). The stick-shaped Acro mapping (`MC_ACRO_EXPO`, `MC_ACRO_SUPEXPO`, defaults already in `physics.v1.json`) is **to verify** and not planned |
| **Stabilized** | `src/modules/mc_att_control/mc_att_control_main.cpp`: `generate_attitude_setpoint` L120–223, `throttle_curve` L103–118 | Tilt as an axis-angle from the stick, limited to `MPC_MAN_TILT_MAX`, optional low-pass `MC_MAN_TILT_TAU`; yaw setpoint integrates the stick yaw rate × `MPC_MAN_Y_MAX` (only above 5 % throttle unless airmode 2); thrust from the throttle curve (hover at stick centre for `MPC_THR_CURVE` 0). The code's own comment gives the yaw change for a diagonal tilt (L167–170), used as a test |
| **Altitude** | `src/modules/flight_mode_manager/tasks/ManualAltitude/FlightTaskManualAltitude.cpp` | Vertical velocity = stick (expo, dead zone) × `MPC_Z_VEL_MAX_UP/DN` (L95–105); yaw rate filter (L107–113); altitude lock when the stick is centred and \|vz\| < `MPC_HOLD_MAX_Z` (L115–206, the `MPC_ALT_MODE` 0 branch only); yaw lock (L296–328); horizontal acceleration setpoint = stick × tan(`MPC_MAN_TILT_MAX`) × g (L338–358). Terrain following (`MPC_ALT_MODE` 1, 2) needs a distance sensor and is not ported |
| **Position, `MPC_POS_MODE` 0** | `…/ManualPosition/FlightTaskManualPosition.cpp` | Stick (length limited to 1) × `MPC_VEL_MANUAL`, rotated into the heading frame (L73–108); position lock when the stick is centred and speed < `MPC_HOLD_MAX_XY` (L110–135) |
| **Position, `MPC_POS_MODE` 4 (default)** | `…/ManualAcceleration/FlightTaskManualAcceleration.cpp` L66–92; `…/Utility/StickAccelerationXY.cpp` L73–184; `…/Utility/Sticks.cpp` L47–107 | Stick → acceleration (scale 2·`MPC_ACC_HOR`), jerk limit `MPC_JERK_MAX` per axis, virtual drag that sets the top speed and brakes (with a brake boost when the stick is centred), tilt limit, velocity setpoint = integral of the acceleration, position lock; stick shaping `expo_deadzone` with `MPC_HOLD_DZ` and the three expo parameters |

**To verify before 5.3 starts** (not read): `FlightTaskManualAltitudeSmoothVel.cpp` and the
`VelocitySmoothing` it uses (the default position mode derives from it, for the vertical
velocity: `MPC_ACC_UP_MAX`, `MPC_ACC_DOWN_MAX`, `MPC_JERK_MAX`); `Utility/StickYaw.cpp`;
the `mathlib` helpers `expo_deadzone`, `gradual3`, `sqrt_linear`; `FlightTask.cpp` handling
of the setpoints. If the smooth-velocity part is large, the first cut of 5.3 ships mode 0
(D8) and mode 4 follows, and the DEVLOG says so.

Ground: PX4 limits the tilt to `MPC_TILTMAX_LND` until takeoff completes and has a landed
detector and takeoff ramp (`MPC_TKO_*`, `MPC_SPOOLUP_TIME`; `MulticopterPositionControl.cpp`
L425–450, `Takeoff`, `land_detector`; **to verify**). None is ported. Our stand-in is ours,
not PX4's: altitude and position modes are available only while the vehicle has no ground
contact (the engine already reports contacts, 4.4), and the flight page starts in the air
or in stabilized mode. Both are listed in risks.

### Allocation: airmode

`src/modules/control_allocator/ControlAllocation/ControlAllocationSequentialDesaturation.cpp`:
selection by `MC_AIRMODE` L52–64, `mixAirmodeRP` L122–143, `mixAirmodeRPY` L146–171,
`mixAirmodeDisabled` L174–204 (already ported), `mixYaw` L207–228. The header comment
(`….hpp` L91–110) states the three behaviours; PX4's parameter text says airmode "should
be disabled during tuning" because it helps an unstable loop diverge (`params.c` L3–18).

### Thrust curve

- Model, from the parameter text (`motor_params.c`): rel_thrust = f·x² + (1 − f)·x, with x
  the motor signal and f = `THR_MDL_FAC`, 0 to 1, default 0 (linear).
- Applied as the inverse, x = −b/(2f) + √(b²/(4f²) + u/f), b = 1 − f, on each motor
  command u: `src/lib/mixer_module/functions.hpp` L141–165 (`FunctionMotors::updateValues`),
  wired at `mixer_module.cpp` L394. The older mixer has the same formula
  (`src/lib/mixer/MultirotorMixer.cpp` L352–358). Which allocation path is PX4's default at
  v1.13.3 (`SYS_CTRL_ALLOC`) is **to verify**; 4.7 follows the control-allocator files, and
  so does this plan.
- PX4's tuning guide (https://docs.px4.io/v1.13/en/config_mc/pid_tuning_guide_multicopter.html,
  section "Thrust Curve", read 2026-11-23): tune around hover; use the factor for
  non-linearity towards full throttle; typical values 0.3 to 0.5; with thrust data "fit a
  function to the data"; the rate loop may need re-tuning after a change.
- Our fit: least squares of f over throttle in [`MPC_THR_MIN`, `MPC_THR_MAX`] against the
  steady thrust the 4.5 solver gives, normalised to thrust at full throttle, at a stated
  battery state. The 4.9 code already inverts that solver (`steady_thrust`). The pack
  state (full charge with sag, or nominal) is chosen in 5.2 by hand calculation and shown
  next to the result, because sag makes thrust-versus-throttle depend on the pack.
- The motor model's own throttle-to-duty map (4.5 bench map) is separate from this and
  stays. The curve linearises what the allocator asks for; it does not replace the map.

### Tuning procedure the tools follow

PX4 guide, same URL, read 2026-11-23: increase gains slowly (20 to 30 % per step, 5 to
10 % at the end); tune the rate loop first (P and D together, then I; D can stay 0 for
yaw), then the attitude P ("much easier to tune"), then the position loops; test "a fast
step-input when hovering": the vehicle "should immediately follow the command, and neither
oscillate, nor overshoot". The step tests in 5.7 are that procedure with a number on each
step; the panel does not decide what a good value is. A threshold such as "overshoot below
X %" is a user input, never ours.

## Data found and not found

Searched 2026-11-23 in the PX4 v1.13.3 tag and the v1.13 documentation.

**Found**
- Defaults, line numbers and the algorithms in the tables above, for the position loop,
  the thrust vector math, the three modes' stick handling (except the items to verify),
  airmode, the thrust curve and the derivative filter.
- PX4's tuning order and test procedure (documentation, quoted by section above).
- Parameter doc comments with `@min`/`@max`/`@unit` for the new parameters: present in the
  same files; read into the reference data in 5.0.

**Not found, stays "to verify" or a user input**
- The unread files listed under Flight modes and Ground.
- A textbook source for the step-response definitions (D12): I will cite one in 5.6 or the
  panel labels them as ours.
- Rotor inertia or motor time constant of the built-in motors (known gap from 4.5). Step
  responses depend on motor lag, so a built-in build still has to have this entered before
  a step test runs, as before.
- Any PX4 acceptance numbers ("a well-tuned vehicle has overshoot below …"): none found.
  PX4's guide describes tuning qualitatively.
- A comparison against a running PX4 (SITL or logs). Not available here, so conformance
  is by source reading and hand calculations, not by matching a PX4 run (risks).

## Milestones

Each milestone ends with `npm run test:all` green, a DEVLOG entry and, for UI work,
screenshots. "Files" lists what the milestone may touch; two milestones in the same wave
touch no common file except the one-line `pub mod` in `engine-core/src/lib.rs` (a trivial
merge) and, where noted, the DEVLOG.

| # | Scope | Files | Needs |
|---|---|---|---|
| 5.0 Reference data | The new parameters in the `px4` set of `physics.v1.json`, each with its `PARAM_DEFINE` line, plus `min`, `max` and `unit` where the doc comment states them. Format note in the README. The thrust-model formula and airmode behaviours are recorded as `condition` text | `database/reference/physics.v1.json`, `database/reference/README.md`, `tests/unit/reference-data.test.ts` | Nothing |
| 5.1 Position controller | `PositionControl` port (XY and Z, NaN-able setpoints, the table above), `ControlMath` (tilt limit, XY constrain, thrust vector to attitude), the velocity derivative filter, `PositionGains` with PX4 defaults and validation, name-based overrides for the new names. A test that the Rust defaults equal the reference data, as `defaults_match_reference` does for 4.7. No change to `controller.rs` | `engine-core/src/position_control.rs`, `position_control/tests.rs`, `lib.rs` | 5.0 |
| 5.2 Airmode and thrust curve | `Allocator::set_airmode` (default 0, so `allocate` keeps its signature); `thrust_model.rs` (forward and inverse, f in [0, 1]); the TS fit with its error | `engine-core/src/controller.rs`, `controller/tests.rs`, `thrust_model.rs`, `lib.rs`, `src/domain/thrust-curve.ts`, `tests/unit/thrust-curve.test.ts` | 5.0 (the fit reads `propulsion.ts`, which exists) |
| 5.3 Flight modes and loop | Rates, stabilized, altitude and position (0, then 4) as setpoint generators; `flight_loop.rs`: composes `attitude_rates`, `RateControl`, `Allocator` and 5.1's controller with `Flight`/`Simulation` the way `closed_loop.rs` does, leaving `closed_loop.rs` alone. Reads the "to verify" files first | `engine-core/src/flight_modes.rs`, `flight_modes/tests.rs`, `flight_loop.rs`, `flight_loop/tests.rs`, `lib.rs` | 5.1, 5.2 |
| 5.4 Protocol and host | `controller.mode` and its setpoint (normalised sticks, or the 4.7 attitude form), the new gain names, `airmode`, `thrustModelFactor`, per-step position-loop diagnostics, in `sim.run` and the 4.8b session. Additive fields; the protocol version stays 2 unless a field changes meaning (to confirm against how 4.8b/4.9 bumped it) | `engine-host/src/protocol.rs`, `engine.rs`, `flight_session.rs`, `electron/main/engine/protocol.ts`, `electron/main/engine/flight-session.ts`, `ARCHITECTURE.md` protocol table | 5.3, and **4.8b merged** (and 4.9, which also edits `protocol.rs`/`engine.rs`) |
| 5.5 Tuning settings | `controller-params.ts` (table, validation, grouping); migration (next free number when this starts; 0011 is the latest now); repository; IPC with zod; "reset to PX4 defaults"; the saved set is overrides only | `src/domain/controller-params.ts`, `tests/unit/controller-params.test.ts`, `database/migrations/NNNN_controller_tuning.sql`, `electron/main/db/*` (a new repository file), `electron/ipc/contract.ts`, `handlers.ts`, `schemas.ts`, `tests/unit/migrations.test.ts` and `database.test.ts` | 5.0. Independent of the engine |
| 5.6 Step-response metrics | `step-response.ts`: rise, overshoot, settling, steady-state error, peak time, "did not settle" and "no overshoot" as distinct results, from sampled time and signal; thresholds as arguments | `src/domain/step-response.ts`, `tests/unit/step-response.test.ts` | Nothing |
| 5.7 Step tests in the engine | Time-series recorder (setpoint, state, command, saturation, at a stated decimation); step definitions (attitude and rate about each axis, altitude, horizontal position) run through the 4.9 scenario runner with a trace in the report; a host message to run one and return it | `engine-core/src/trace.rs`, `trace/tests.rs`, `engine-core/src/scenario.rs` and `scenario/*` (4.9's files: small additions), `engine-host/src/*` (one new module), `electron/main/engine/*` | 5.3, 5.4, **4.9 merged** |
| 5.8 Tuning and flight UI | Tuning panel (groups from the table, units, PX4 default beside each value, range errors, reset, save per project); step-response panel (charts with the setpoint in magenta, the metrics, editable thresholds, the gains used); mode selector and PX4 stick behaviour on the flight page | `src/features/tuning/*` (new), `src/features/flight/*` (4.8's folder: small edits), `src/app/nav.ts`, `tests/e2e/tuning.spec.ts`, `tests/unit/tuning-*.test.ts` | 5.4, 5.5, 5.6, 5.7, **4.8b merged** |
| 5.9 Acceptance and defaults | Position-hold and step scenarios on the built-in builds; apply the derived `THR_MDL_FAC` by default (D4) and re-run the 4.9 scenarios, stating each changed number and why; optionally `ClosedLoop` on the new loop (D13); ROADMAP, ARCHITECTURE, DEVLOG, an ADR for the controller port and the perfect-state boundary | `engine-core/src/scenario/builtins.rs`, docs, `closed_loop.rs` if D13 | All of the above, 4.8, 4.9 |
| 5.10 (optional) Hover thrust estimator | Port of PX4's estimator, `updateHoverThrust` (`PositionControl.cpp` L73–86) and `MulticopterPositionControl.cpp` L327–332. The estimator module (`src/modules/hover_thrust_estimator`) is **not read yet** | new `engine-core` file | D5(c), 5.3 |
| 5.11 (optional) Loop margins | Linear analysis from the vehicle's inertia, allocation scale and motor lag | `src/domain/loop-analysis.ts` | D10(b), 4.5's motor time constant |

**Waves.** After 5.0 (small, data only): 5.1, 5.2, 5.5 and 5.6 run in parallel, because
their files are disjoint. Then 5.3. 5.4, 5.7, 5.8 and 5.9 wait for 4.8b and 4.9 to merge.
5.0 to 5.3, 5.5 and 5.6 do not depend on either and can start now. 5.0 to 5.3 are useful
on their own (a position-holding engine with tests) before any UI.

## Automated tests

Analytical where possible. A tolerance is stated with each test, not tuned afterwards.

1. **Horizontal loop, P only** (5.1): a point mass that accepts the thrust vector. With
   I = D = 0 the loop is p̈ = K_v(K_p(r − p) − ṗ): ω_n = √(K_v·K_p), ζ = K_v/(2ω_n). Defaults
   (K_p 0.95, K_v 1.8): ω_n = 1.308 rad/s, ζ = 0.688, overshoot exp(−πζ/√(1−ζ²)) = 5.1 %,
   peak time π/(ω_n√(1−ζ²)) = 3.31 s. The simulated step matches within the 1 ms step's
   discretisation error (tolerance set by running the same plant at 0.5 ms).
2. **Disturbance rejection** (5.1): with a constant disturbance acceleration d on that
   plant, the horizontal integrator settles at −d and the position error goes to 0. The
   characteristic polynomial with I: s³ + K_v·s² + (K_i + K_v·K_p)·s + K_i·K_p.
3. **Vertical conformance to 4.7** (5.1): identical inputs, D = 0, 10 s scripted
   altitude profile: collective thrust equal to 4.7's `Controller::step` to 1e-12.
4. **Thrust-vector rules** (5.1): hand values. The z limit is √(1 − 0.3²) = 0.9539 when
   the horizontal demand exceeds the margin; the tilt limit gives exactly `MPC_TILTMAX_AIR`
   for a huge acceleration demand; each branch of `constrainXY`; `bodyzToAttitude` for a
   known thrust vector and yaw (quaternion by hand, inverted-flight rule).
5. **Thrust model** (5.2): f = 0 is the identity, f = 1 is the square root; inverse of the
   forward model returns the input to 1e-12; the fit recovers an f used to generate
   synthetic data exactly; the fit on a built-in motor reports its error, stated, not
   asserted to be small.
6. **Airmode** (5.2): X quad, small collective, large roll demand. Airmode 0: thrust is not
   raised, the roll demand is only partly met and saturation is flagged (matches 4.7).
   Airmode 1: thrust is raised until the roll demand is met. Airmode 2: same for yaw.
7. **Stabilized mapping** (5.3): full roll stick gives a tilt of `MPC_MAN_TILT_MAX`;
   a 45° diagonal stick gives the yaw change from the formula in the PX4 comment;
   yaw setpoint integrates at `MPC_MAN_Y_MAX`; throttle curve passes through (0, min),
   (0.5, hover), (1, max).
8. **Altitude and position locks** (5.3): centred stick locks the current altitude or
   position once the speed is below the hold limit; a stick input releases it; the stick
   → velocity map equals stick × limit after the stated expo. Mode 4: constant full stick
   reaches `MPC_VEL_MANUAL` and no more (drag balance, checked by hand); centred stick
   brakes to rest.
9. **Position hold in flight** (5.3): the built-in builds hold position and altitude after a
   2 m step with the final error and time within bounds stated after the first run and
   written into the DEVLOG; not an analytical test.
10. **Step metrics** (5.6): first-order response: 10–90 % rise time τ·ln 9 and 2 %
    settling time τ·ln 50, exactly; second-order response: overshoot and peak time from the
    closed form, rise and settling times from the exact curve solved numerically, each
    within one sample period; a type-0 plant's steady-state error equals 1/(1 + K); a
    never-settling signal and a monotone signal give "did not settle" and "no overshoot",
    not zero; a step that starts after t = 0, a non-zero baseline and a downward step.
11. **Regression** (5.2, 5.3, 5.4): with airmode 0, thrust factor 0 and the attitude mode,
    the state hash of the 4.7 closed-loop tests and the 4.9 scenarios is unchanged.
12. **Determinism and chunking** (5.3, 5.4): the same run twice gives one hash; a 4.8b
    session stepped in chunks equals one `sim.run`, with the position loop in use.
13. **Tuning storage** (5.5): save and load; only overrides are stored; an unknown name, a
    non-number or a value outside PX4's documented range is refused; a project without a
    saved set flies on PX4 defaults; the migration upgrades from the previous version.
14. **Step tests on the vehicle** (5.7): the engine's roll-rate step on a built-in build is
    compared with a linear model built from the vehicle's own numbers (inertia, the
    allocator's normalisation, thrust per command, motor lag). The derivation is written
    before the test and the tolerance comes from it; if the nonlinearity is too large to
    bound, the test checks direction and ordering only and the DEVLOG says so.
15. **Reference data** (5.0): every new entry has its citation, unit and range where PX4
    states them; the Rust defaults equal the JSON (5.1), per parameter.

## Risks

- **No PX4 run to compare with.** The port is checked against the source and hand
  calculations. PX4 computes in 32-bit floats and we use 64-bit, so equal inputs give
  nearly, not exactly, equal outputs. A later check against a PX4 SITL log would need a
  PX4 build, which is not available here.
- **PX4's defaults are not tuned for your build.** PX4's guide says its default gains are
  set low for safety. A heavy or large build may be slow or oscillate on them. Phase 5
  shows this with numbers; it does not choose better ones (D10).
- **Perfect state flatters the tuning** (D6). A D gain that would amplify gyro noise on a
  real vehicle costs nothing here. The panel says so next to the results.
- **Motor lag is a user input.** The built-in motor has no stated rotor inertia or time
  constant, and the rate and attitude responses depend on it. A step test refuses to run
  without it, as flying already does.
- **Turning on the thrust curve moves the 4.9 numbers.** Hence the default switches in 5.9
  only, with the re-run and each change explained. Until then the engine default is 0 and
  results are bit-identical to 4.7.
- **Ground handling is ours.** The "airborne only" gate for altitude and position modes is
  a stand-in, not PX4's landed detector and takeoff ramp. A build that cannot lift off
  would sit in stabilized mode. Porting the real takeoff logic is a Phase 6 candidate.
- **The default position mode may be large.** If `FlightTaskManualAltitudeSmoothVel` and
  `VelocitySmoothing` prove long, mode 0 ships first (D8).
- **Parallel work.** 4.8b and 4.9 edit `protocol.rs`, `engine.rs` and the flight folder.
  Milestones 5.4, 5.7 and 5.8 start only after those merge; 5.0 to 5.3, 5.5 and 5.6 are
  built to avoid every file those branches touch (D13). The migration number is taken
  when 5.5 starts, not now.
- **Scope.** Ten milestones plus two optional. The core (5.0 to 5.3, 5.5, 5.6) has no
  dependency on 4.8 or 4.9 and gives a tested position controller, modes and metrics.
