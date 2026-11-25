# Development log

## 2026-11-25 — Phase 7 telemetry, recordings and gyro feedback

- **7.0–7.2.** Added sourced sensor specs and PX4 parameters. Unavailable inputs stay explicit in the sensor form. Added optional engine sampling for flights and scenarios. Stored runs in append-only, CRC-checked files with a SQLite metadata row. Startup recovers the intact prefix of an interrupted recording and closes its run row. [Catalogue](../database/seed/components.v1.json#L12-L44) · [Parameters](../database/reference/physics.v1.json#L1538) · [Sampler](../simulation-engine/engine-host/src/telemetry.rs#L63-L109) · [Recovery](../electron/main/telemetry/store.ts#L115-L144)
- **7.3–7.4.** Connected the recorder to live flights, scenarios and step tests. The dashboard shows recent runs. Recording shutdown moved to the window's `closed` event so cancelling a close leaves the flight recording active. Added uPlot graphs and a rolling live panel. [Recorder](../electron/main/telemetry/session-recorder.ts#L228-L274) · [Dashboard](../src/features/dashboard/DashboardPage.tsx#L110-L123) · [Close handling](../electron/main/index.ts#L399-L417) · [Live plots](../src/features/telemetry/LiveGraphs.tsx#L6-L25)
- **7.5.** Added run history, 3D replay, a shared graph cursor, a second-run overlay and Verify in a separate engine. Range reads on a 100 MB file took 1446 ms for a one-second query before the chunk index cache. With the cache they took 710 ms cold and 3–4 ms repeated. Main now reuses the validated offsets and reads the requested window. [Run graphs](../src/features/telemetry/RunGraphs.tsx#L140-L249) · [Verify](../electron/main/telemetry/verify.ts#L80-L166) · [Index](../electron/main/telemetry/reader.ts#L221-L280)
- **7.6–7.7.** Added CSV export by channel and time range, and reports for flights, scenarios and step tests. Grouped propulsion rows by motor group and kept tables together in print. A 3 s report prints on six A4 pages. [CSV](../electron/main/telemetry/csv.ts#L40-L102) · [Report build](../src/features/telemetry/report/ReportBuild.tsx) · [Print layout](../src/features/telemetry/report/report.css#L51-L90) · [PDF footer](../electron/main/telemetry/report-pdf.ts#L17-L47)
- **7.8–7.9.** Added seeded gyro, accelerometer, barometer and GPS signals, with saved project settings shared by flights, scenarios and step tests. Missing seeds appear first in the input list. Modelled gyro feedback adds the PX4 filters and a D term on filtered acceleration. The same step test compares gyro feedback with perfect state. Response metrics use true motion. Recordings declare the raw and filtered channels. [Settings inputs](../src/domain/sensors.ts#L174-L229) · [Models](../simulation-engine/engine-core/src/sensors.rs#L179-L257) · [Recorded channels](../electron/main/telemetry/session-recorder.ts#L18-L26) · [Comparison](../tests/unit/scenario-protocol.test.ts#L794-L820) · [Tuning readout](../src/features/tuning/StepTestPanel.tsx#L137-L142)
- **7.12 in progress.** Added acceptance test 12 for a flight, replay, verification, CSV and PDF, then reopening and verifying after restart and deleting the run and file. The test has not been run. [Test 12](../tests/e2e/phase7-acceptance.spec.ts#L27) · [ADR 0011](adr/0011-telemetry-recording-and-sensor-models.md)

### Catalogue acceptance and performance

| Feedback for a 10 deg/s roll-rate step | Rise time | Overshoot |
| --- | --- | --- |
| Modelled gyro | 0.060 s | 13.2 % |
| Perfect state | 0.069 s | 11.8 % |

Both exceeded the 10 % overshoot limit set before the first run. On 2026-11-25 the user chose to report overshoot without judging it. With 2.8 mdps/√Hz gyro density in hover, tilt RMS was 1.5e-5 rad and body-rate RMS was 2.4e-4 rad/s. [Catalogue test](../tests/unit/scenario-protocol.test.ts#L719-L820)

- **D20 sensor cost.** Compared with sensors off, flying on the gyro cost 1.27× per 1 ms step without samples and 1.35× when sampling every fourth step. Three runs each; without samples only one run is usable, because the other two timed the sensors-off case at about 31 µs per step instead of 12, slower than with sensors on (unexplained, probably request round trips). Both ratios are below the 2× limit. [D20](plans/phase-7-telemetry.md#decisions-made-with-you)
- **Disk use.** A recording at 250 Hz takes about 15 MB per minute. The plan estimated 9.6 MB per minute. [Saved cadence](../electron/main/telemetry/session-recorder.ts#L9-L26)
- **D18 frame time with recording and live graphs.** PERF-GATE: to be measured. [Gate configuration](../tests/e2e/flight-performance.spec.ts#L270-L272)

### PX4 v1.13.3 source lines

- `src/modules/sensors/vehicle_angular_velocity/VehicleAngularVelocity.cpp:160–190,735–763` supplies the static notch ordering, two-pole rate low-pass and filtered rate difference. Lines 493–526 give PX4's reset inputs and line 916 applies bias after filtering. This implementation primes from the first delivered gyro sample and treats the entered bias as residual. It runs at 1 kHz, without raw FIFO processing, publication throttling or dynamic notches. [Rust cascade](../simulation-engine/engine-core/src/gyro_filters.rs#L1-L195)
- `src/lib/mathlib/math/filter/NotchFilter.hpp:78–87,133–147,173–187,217–229,267–285`, `LowPassFilter2p.hpp:61–107,128–144` and `AlphaFilter.hpp:67–88,102–119` supply the single-precision equations. `src/modules/mc_rate_control/RateControl/RateControl.cpp:57–68` supplies the rate error and acceleration D-term convention. [Filter port](../simulation-engine/engine-core/src/gyro_filters.rs#L33-L195) · [Rate loop](../simulation-engine/engine-core/src/controller.rs#L347)
- `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c:51,66,85,100,118,160,173` supplies the notch, cutoff and dynamic-notch parameter references. `src/modules/ekf2/ekf2_params.c:89` supplies the labelled GPS delay suggestion. [Reference values](../database/reference/physics.v1.json#L1538) · [Delay input](../src/domain/sensors.ts#L198-L229)

## 2026-11-25 — Phase 6, milestone 6.0b: live-flight measurement; engine pipe crash

**Verdict: the 4.8 lockstep stays (D2(a)).** Three runs of `npm run test:flight-perf`, all valid, all judged cases pass. i7-9750H, 60 Hz primary display, mains power, nothing else running, window 1388 × 785. The app drew on the Intel UHD 630 (ANGLE/D3D11), not on the GTX 1650. 20 s per case, 60 stick changes per case, none unmatched, no recorder overflow.

| Case | Frame median, ms | Frame p95, ms | Frames over two periods (longest, ms) | Request p95, ms | Stick to draw p95, ms | Simulated / wall time |
| --- | --- | --- | --- | --- | --- | --- |
| Limit | 17.5 | 35.0 | – | – | 67 | – |
| On the ground | 16.6 / 16.6 / 16.6 | 19.5 / 19.4 / 19.3 | 3 (271) / 4 (137) / 2 (426) | 6.4 / 6.4 / 6.7 | 50.5 / 51.4 / 50.6 | 0.986 / 0.991 / 0.980 |
| Free hover | 16.6 / 16.6 / 16.6 | 19.3 / 18.4 / 18.5 | 5 (95) / 4 (124) / 5 (90) | 4.5 / 4.4 / 4.2 | 50.4 / 50.8 / 48.7 | 0.995 / 0.990 / 0.995 |
| Hover over 512 × 512 terrain, wind, gust, turbulence, ground effect (reported) | 16.6 / 16.6 / 16.7 | 19.3 / 19.5 / 19.2 | 4 (125) / 5 (100) / 4 (128) | 5.8 / 5.7 / 5.7 | 49.4 / 50.5 / 51.7 | 0.986 / 0.991 / 0.989 |

- Frame limits carry the 5 % timer tolerance of D2. The stick limit covers input sampling, IPC, engine and renderer submission; controller transport, GPU completion, compositor and monitor are outside it. The animation frame after the draw came 60.0–61.6 ms (p95) after the stick change.
- Each 20 s run had two to five hitches above two periods, the longest 426 ms; they also give the largest single stick delays (up to 182 ms) and the 1–2 % of simulated time lost. They are within the p95 limits. Their cause was not traced.
- The stick changes landed 5 to 17 ms into the frame, so the first 5 ms after a frame start, while the main thread draws, were not sampled.
- Earlier runs the same night were discarded: three with bugs in the script (a readout parsed with its unit, the window checked before it was shown), three before the fix below or with lost window focus. Their judged values, where valid, also passed.

**Crash fixed.** A request written to an engine that had just exited raised an unhandled `error` event on its stdin, and Electron ended in a "JavaScript error in the main process" dialog (`write EPIPE`). `EngineSupervisor` now handles that event (the request still fails on its own and the exit handler restarts the engine) and refuses requests while it stops. The regression test kills the engine under load and fails with the same error without the fix. The fault was older than Phase 6; it was seen when a measurement run closed the app during a flight.

## 2026-11-24 — Phase 6 flight environment

- **6.0a–6.5.** Recorded the PX4 v1.13.3 references and MIL-F-8785C shear and gust sources. Wind pushes through body drag only. Shear clamps and sets the above-range flag above 1000 ft. The discrete gust ramps with mean-air-relative distance and stays at its final amplitude. Optional Cheeseman–Bennett ground effect is a single-rotor thrust correction without rotor interaction. Terrain and fixed obstacles enter the collision world, and start clearance resolves against the build’s collision shapes. The host and storage carry the environment data, and sessions retain accepted inputs for deterministic in-memory replay. The 6.5 host step costs were 1.3 ms / 4.2 ms per 100 steps (milestone measurements supplied for this entry). 6.0b stream measurement remains pending the user’s pass limits. [ADR 0010](adr/0010-flight-environment.md)
- **6.6–6.9.** Added calibrated Gamepad API inputs, takeoff/hold/land controls, chase/orbit/fixed/FPV cameras and the environment editor and readouts. The PX4 controller receives perfect state. Auto modes smooth vertical motion and omit XY and multi-waypoint smoothing, time stretching and axis synchronization. Hold at speed pulls back toward the captured position. Turbulence and return remain open. [Auto modes](../simulation-engine/engine-core/src/auto_modes.rs#L1-L6) · [Auto state and setpoints](../simulation-engine/engine-core/src/auto_modes.rs#L55-L129)
- **6.10.** Added four FlightLoop scripts to Scenarios. Wind hold uses the saved mean wind. Gust loads the saved gust after the 10 s pre-hold and honours its start offset from that point. The land sequences reproduce the 6.7 takeoff/hold/land windows, including PX4 spool-up and ramp. The Flight idle preview seats the build at the sampled terrain height minus the lowest collision point. The engine resolves the actual start. [Scenario implementation](../simulation-engine/engine-core/src/scenario/flight_script.rs) · [Preview](../src/features/flight/FlightPage.tsx#L117-L129)

### Catalogue acceptance

The 4.9 Quad X used sea-level ISA, a 12 V battery cutoff and its derived thrust-model factor. The example project used **5 m/s** constant wind from 90° and an **8 m/s** gust ramp over **4 m** with saved offset **0 s**. The 5 m/s setting was chosen for this test only. Both landing sequences received the saved wind. The landing scenarios use the project's own ground; this fixture's plane has friction 0.5 and restitution 0, as in 6.7. The terrain used the existing 45° fixture, friction 0.4, restitution 0.2 and zero start clearance. Ground effect was off. [Build and inputs](../tests/unit/scenario-protocol.test.ts#L62-L113) · [Acceptance fixture](../tests/unit/scenario-protocol.test.ts#L444-L472)

Horizontal radial error and absolute vertical error each had to be below 0.01 m, from the 6.7 hold test. Wind tilt had to be within 0.1°, the centred-attitude tolerance, of the equilibrium obtained by solving for thrust direction against weight and the engine’s per-axis drag at rest. Gust had to return to the same position band before the run ended and stay there. The landing limit was PX4 `MPC_LAND_SPEED` at 0.7 m/s, measured from the last pre-contact vertical velocity. State order and a final ready-and-landed state were also required. Heights are relative to the start. [6.7 tolerances](../simulation-engine/engine-core/src/flight_loop/tests.rs#L98-L119) · [6.7 sequence](../simulation-engine/engine-core/src/flight_loop/tests.rs#L302-L350) · [Landing-speed source](../database/reference/physics.v1.json#L1050-L1057)

| Scenario | Verdict | Measured |
| --- | --- | --- |
| `wind_hold` | Pass | At 20 s, horizontal/vertical error 0.001306 / +0.00007138 m. Tilt 0.685681°, force-balance tilt 0.685959°. |
| `gust` | Pass | 0.332565 m peak displacement. Recovery 17.748 s after full strength in the 60 s run. |
| `takeoff_hold_land` | Pass | Hold height 2.500021 m. Horizontal/vertical error 0.007781 / +0.00002146 m. Touchdown 0.595345 m/s. Spool, ramp, flight, hold, land, ground detected, maybe landed, landed and ready at 0.001, 1.001, 4.001, 5.872, 24.001, 28.490, 28.840, 29.180 and 29.181 s. |
| `terrain` | Fail | Hold height 2.500301 m. Horizontal/vertical error 0.026027 / +0.00030140 m. Touchdown 0.636171 m/s. Spool, ramp, flight, hold and land at 0.001, 1.001, 4.001, 7.280 and 24.001 s. The detector did not reach ground contact, maybe landed, landed or ready by 34 s. |

Friction 0.4 is below tan 45°, so nothing can rest on the steep slope; its failure was not traced further. On a 5° grid with the same friction the sequence passes: horizontal/vertical hold error 0.007855 / +0.0000192 m, touchdown 0.541750 m/s, landed at 29.070 s.

All ten complete ClosedLoop reports from the 4.9 catalogue matched the pre-change engine build byte for byte with the thrust curve off and on. Their state hashes also matched the recorded 5.9 baselines. The PX4 snapshot lacked `src/modules/navigator/mission_params.c`. The 2.5 m takeoff target comes from the existing reference record and 6.7 fixture. [Recorded parameter](../database/reference/physics.v1.json#L1332-L1340)

- **6.11.** Added optional low-altitude Dryden turbulence with a user-entered seed and a positive mean wind reference speed. Exact spatial filter transitions use stationary initial states and deterministic noise. Live loads include the turbulent velocity and height holds, and the session log retains the seed for replay. The flight form explains the hover limitation and the frozen-field behavior at zero mean-relative airspeed. [Model and sources](../simulation-engine/engine-core/src/turbulence.rs#L1) · [Verification](../simulation-engine/engine-core/src/turbulence/tests.rs)
- **6.12.** Added a FlightLoop Return command with first-step home position and heading, multicopter cone altitude, straight-track jerk-limited motion, timed or indefinite loiter, and the existing landing controller. The Flight page exposes Return beside Land and maps PlayStation L1 to the same action. PX4 source ranges are `rtl.cpp:270–309,334–488,545–590,605–675,683–717`, `mission_block.cpp:74–80,202–231,271–280,336–397`, `FlightTaskAuto.cpp:289–315,354–369,809–819`, `PositionSmoothing.cpp:107–126,235–251,286–325`, `TrajectoryConstraints.hpp:70–98`, and `TrajMath.hpp:61–70`. The simulator uses local XY distance, slews to home heading inside `RTL_MIN_DIST`, and uses the 6.7 vertical smoother. It omits turn planning, trajectory time stretching, axis synchronization, yaw-rate feedforward, and mission, rally and VTOL destinations. [Return logic](../simulation-engine/engine-core/src/auto_modes.rs)

PX4 v1.13.3 multicopter startup uses a 2 m horizontal acceptance radius, 30 m return altitude and 10 m loiter altitude (`ROMFS/px4fmu_common/init.d/rc.mc_defaults:18,20–21`). Session gains also accept `NAV_MC_ALT_RAD` (0.8 m, `navigator_params.c:112`), `MIS_YAW_ERR` (12°, `mission_params.c:158`) and `MPC_XY_CRUISE` (5 m/s, `mc_pos_control_params.c:321`). The simulator omits position-controller-status widening from `navigator_main.cpp:995–1014`. Saved tuning checks its own parameter catalogue when editing, saving through IPC and writing to the database. Return gains go through the Flight Start IPC schema when present in the session input. [Reference data](../database/reference/physics.v1.json) · [Flight Start](../electron/main/engine/flight-session.ts)

The 4.9 catalogue quad returned from 30 m out in 5 m/s wind through climb, return, land and landed. The final horizontal and vertical errors were 0.003810 m and 0.00000641 m, within the 6.7 limits of 0.01 m and 0.00012 m. Return from low altitude at home rose by less than 0.01 m and landed. The session log replayed to identical hashes with 100-step and 7-step chunks, and the takeoff, hold and land hashes matched the pre-6.12 baselines. [Wind landing](../tests/unit/scenario-protocol.test.ts) · [Session checks](../tests/unit/flight-live.test.ts)

## 2026-11-24 — Phase 5, milestone 5.9

- **A.** `PositionControl` now owns vertical control in both loops. With `MPC_USE_HTE = 0`, the five scenario hashes match the 4.7 controller. With the estimator enabled, it uses height above the ground beneath the vehicle and treats free space as airborne. The Part A scenario altitude errors changed by less than 1e-5 m. [Hash regression](../simulation-engine/engine-core/src/scenario/tests.rs#L120-L136) · [Estimator sample](../simulation-engine/engine-core/src/flight_loop.rs#L86-L107)
- **B.** Both loops pass each allocated motor command through the same PX4 inverse before propulsion. Saturation reporting and anti-windup use the allocator output. Zero passes the original commands through bit for bit. The sidecar accepts `thrustModelFactor` and `THR_MDL_FAC` from the controller or run configuration, rejects conflicting values and defaults to zero. The step-test trim converts the solved physical throttle into thrust space so the initialized rotor speed still matches the hold command. [Motor output](../simulation-engine/engine-core/src/thrust_model.rs#L8-L49) · [Host validation](../simulation-engine/engine-host/src/engine.rs#L606-L620) · [Step initialization](../simulation-engine/engine-core/src/step_test.rs#L253-L264)
- The app fits equal-command build thrust at nominal pack voltage with shared sag and sea-level ISA density. It uses the 5.2 sampling grid, PX4's throttle bounds and the 4.9 pack-voltage solve. Scenario requests send the build factor. Tuning shows the build factor or saved override, its relative-thrust fit errors, pack state and origin. The resolver uses zero when a fit is unavailable. Live flights, step tests and scenarios send the derived factor, or the saved override when there is one, and the flight and tuning pages show which. [Fit](../src/domain/thrust-curve.ts#L115-L176)
- The local PX4 snapshot did not contain `src/lib/mixer_module/functions.hpp` or `motor_params.c`. This change uses the existing inverse and its source citations. [Prior port](../simulation-engine/engine-core/src/thrust_model.rs#L1-L13)

### 4.9 catalogue Quad X baselines

The headless test reconstructed the 4.9 Quad X from its seeded components and recorded fixture entries. The fit used four MN3110 KV470s with P13×4.4 props, a nominal 14.8 V Tattu 4S pack with 12 mΩ shared resistance, a 550 mm diagonal and a 300 g frame. The 4.9 runs used sea-level ISA air, free space and a 12 V cutoff, with 200 g added mass and 5 mm offset where those scenarios request an entry. The fit was **0.4909184903334239**, with 5.3382% RMS and 10.2200% maximum relative-thrust error. [4.9 inputs](../tests/e2e/scenarios.spec.ts#L33-L65) · [Headless comparison](../tests/unit/scenario-protocol.test.ts#L265-L313)

All five passed at both factors using the 4.9 criteria. The overweight and beyond-authority checks passed by observing the predicted failures. Values below are rounded. Motor values are in vehicle order with one value shown where all four agree.

| Scenario and measured quantities | Factor 0 | Factor 0.49091849 | Cause |
| --- | --- | --- | --- |
| Balanced hover, final / last-second max altitude error (m) | −1.11770e−5 / 1.78762e−5 | +7.13730e−5 / 1.13268e−4 | The first command rises from 0.500000 to 0.616111, increasing early lift. The controller settles from a different transient. |
| Balanced hover, mean / peak / last-second mean throttle and charge (mAh) | 0.530980 / 0.628162 / 0.52975963 and 34.3077 | 0.530994 / 0.701168 / 0.52976039 and 34.5828 | The transient uses more battery charge and reaches a higher peak. The plant's required steady hover throttle is about 0.529760. |
| Payload, final / last-second max altitude error (m) | −4.42496e−5 / 7.07883e−5 | +3.24408e−5 / 5.14727e−5 | The same first-command increase reduces the payload's initial shortfall in lift and shifts its settling response. |
| Payload, mean / peak / last-second mean throttle and charge (mAh) | 0.586270 / 0.654745 / 0.58498217 and 42.6324 | 0.586291 / 0.714425 / 0.58498296 and 42.8991 | The changed transient accounts for most of the throttle and charge difference. The heavier quad needs about 0.584983 to hover. |
| Overweight, final altitude error (m) / maximum climb velocity at full throttle (m/s) | −556.591 / −5.66965 | −555.960 / −5.58084 | The higher initial duty reduces the fall during spool-up. Both reach full throttle and keep descending because the load exceeds thrust. |
| Overweight, mean / peak throttle and charge (mAh) | 0.996713 / 1 and 123.904 | 0.997502 / 1 and 124.270 | The inverse raises intermediate commands during spool-up and maps full thrust to full throttle. |
| CoM offset, final / last-second max altitude error (m), peak attitude error (deg) | −1.11434e−5 / 1.78224e−5 and 0.633388 | +7.13860e−5 / 1.13288e−4 and 0.714209 | The inverse raises the initial lift and changes the differential thrust response while the rate integral trims the offset. |
| CoM offset, pitch integral, thrust-balance measurement (N), charge (mAh) | −0.0121541 / 0.29888294 / 34.3155 | −0.0125087 / 0.29888363 / 34.5907 | A different differential command produces nearly the same physical thrust split dictated by the offset. The transient draws more charge. |
| CoM offset, throttle mean / peak, alternating motor pairs | [0.539533, 0.522328] / [0.640734, 0.615673] | [0.539534, 0.522354] / [0.711500, 0.691368] | The offset still biases the same pair upward. The initial inverse raises both pairs' peaks. |
| Beyond authority, peak attitude error (deg), final altitude error (m), saturated fraction | 179.95469 / −89.39154 / 0.9570 | 179.99987 / −88.46186 / 0.9572 | The first-command lift increase reduces the drop. Different intermediate commands change the tumbling trajectory and hence when the allocator clips. The shifted CoM remains beyond trim authority. |
| Beyond authority, mean throttles and charge (mAh) | [0.794807, 0.223481, 0.783078, 0.194144] and 30.8284 | [0.779731, 0.214663, 0.797737, 0.235690] and 30.6397 | The altered tumble redistributes the motor duty and net current. All four reach 1 in both runs. |

First throttle is 0.500000 / 0.616111 on all five scenarios. The roll trim in CoM offset
is −4.92e−18 / −8.78e−18, at numerical roundoff. The hashes follow the different
flight and propulsion states.

| Scenario | Factor 0 hash | Derived factor hash |
| --- | --- | --- |
| `balanced_hover` | `b4d5732073603b5b` | `d84d378ce0b70e99` |
| `payload` | `39ad58438e739b44` | `fefe22d4f8ed12b8` |
| `overweight_payload` | `07f31b231caec2b9` | `fa14918d4c4faee6` |
| `com_offset` | `a1a0af78cfe05825` | `314d7fc1c5f70dea` |
| `com_offset_beyond_authority` | `01059c09483c7c6b` | `649b32eb9bf9b2db` |

### Position hold and step tests

The same quad flew 2 m horizontal and altitude steps and a 10°/s roll-rate step.
Both factors settled within the measured 2% band in each run. The rise and settling
times below are measured from the step, with 10 ms trace samples. Signed final
error is target minus the last measurement. [Test inputs](../tests/unit/scenario-protocol.test.ts#L286-L313) · [Metric definitions](../src/domain/step-response.ts#L30-L46)

| Step | Factor 0, rise / settle (s), final error, overshoot | Derived factor, rise / settle (s), final error, overshoot |
| --- | --- | --- |
| Horizontal position | 1.286 / 6.725, +0.01116 m, 13.19% | 1.282 / 6.710, +0.01088 m, 13.29% |
| Altitude | 1.780 / 3.847, +0.00179 m, none | 1.594 / 3.699, +0.00207 m, none |
| Roll rate | 0.06794 / 0.94582, −3.51e−8 rad/s, 11.73% | 0.06896 / 0.95893, −3.53e−8 rad/s, 11.76% |

## 2026-11-23 — Phase 4 closes: Engineering Analysis page, spinning propellers, render-test fix

Phase 4 (physics, collisions, flight behaviour) is complete: 4.1–4.9 are merged and `CURRENT_PHASE` is 5. These are the last changes made to it.

**Built**
- **Engineering Analysis page** (`src/features/analysis/`, route `/analysis`, no longer locked):
  - one view of a saved build's analyses: mass properties (total mass, weight, CoM, horizontal offset, the inertia tensor with its principal moments and axes), hover balance, propulsion, electrical, the Ready-to-fly list and the scenarios;
  - `analysis.ts` only wires functions the workshop, the electrical designer and the flight page already use, so the page and its sources cannot disagree. Each value's tooltip names the function or formula it comes from; a value that cannot be computed shows "not available" with the reason;
  - per-motor maximum thrust and current, and the T/W number, were added after the first version.
- **Principal moments and axes in TypeScript** (`principalAxes` in `src/domain/mass.ts`): cyclic Jacobi, the same method and conventions as the engine's `principal_axes` (`vehicle.rs`). Moments are sorted ascending; the axes are right-handed.
- **Propellers spin in the flight view** (`rotor-spin.ts`, `FlightViewport.tsx`):
  - each propeller turns at the simulated rotor speed, CCW positive and CW negative seen from above;
  - at a speed where the blades would alias at the display rate (Nyquist for the blade count) a disc is drawn instead of blades. The 900 rpm limit for a two-blade propeller at 60 frames/s is a display convention, not a physics parameter (stated in the code).
- **Render-test fix**: the SSR render tests (`flight-view-render`, `rotor-spin`) no longer start Vite's file watcher. The main checkout's root contains `.claude/worktrees`, and watching it made `rotor-spin` time out.

**Verified**
- New tests: `analysis-page.test.ts`, `principal-axes.test.ts`, `rotor-spin.test.ts` and e2e `analysis.spec.ts`; `app.spec.ts` was updated for the unlocked page.
- Both merges were reviewed. No full-suite count was recorded with these commits, so none is given here.

**Still open**
- Wind and ground effect (listed under Phase 4 in the ROADMAP) were deferred by the Phase 4 plan and are not built. The Phase 5 plan recommends Phase 6 for them; that is not decided.
- The propeller angle in the flight view is integrated from the displayed rotor speed. It is a rendering, not a blade model.

## 2026-11-23 — Phase 4, milestone 4.9: scripted scenarios

Scripted acceptance runs on the mainline flight engine, a protocol command, and a page.

**Built**
- **Part A, engine core** (`engine-core/src/scenario.rs`, `scenario/builtins.rs`):
  - the plant is `ClosedLoop` (the PX4 controller flying the 4.6 motors, battery and drag) built on the modified vehicle. The controller is built from the nominal vehicle's motor geometry and its estimate is the true state, so it never sees the true CoM or the payload;
  - a `Scenario` is a name, a duration, modifications (a payload; a part shift, which moves the part's mass, shape and true thrust pose but not the controller's nominal pose), a script (attitude or Euler angles, yaw rate, altitude and climb rate per segment) and checks: altitude, attitude, no sustained saturation, saturation observed, attitude lost, cannot climb, hover throttle, rate trim, thrust balance. The report holds each check's measured value and verdict, summary metrics and the state hash;
  - five built-ins: `balanced_hover`, `payload`, `overweight_payload`, `com_offset`, `com_offset_beyond_authority`. The base scenario runs 20 s from the vehicle's CoM height; its checks look at the last second: altitude within 2 cm, attitude within 0.01 rad, at most 10 consecutive saturated 1 ms steps. The predictions (hover command with a payload, the thrust split for an offset) are computed from the same propulsion data, scaled to the flight's air density, with the shared pack sag;
  - the tolerances are acceptance policy, not sourced physical parameters (stated in the code). Air density, its reference density and the gains are always given; none is defaulted.
- **Part B, `scenario.run`** (`engine-host/src/scenario_run.rs`, `electron/main/engine/scenario-run.ts`):
  - a built-in by name and parameters, or a full `Scenario`; the config gives the air density, the battery cut-off, optional gain overrides, and optionally a ground and a start position;
  - refusals carry the engine's own message under `NO_PROPULSION`, `REFERENCE_DENSITY_REQUIRED`, `CUTOFF_REQUIRED`, `INVALID_SCENARIO` or `INVALID_PARAMS`;
  - a scenario is limited to 60 s of simulated time, 10 s with a ground, so the single-threaded engine keeps answering the supervisor's health ping. The code records a 60 s scenario of the 4.7 test quad taking 0.41 s in a release build on the development machine, and a 10 s one on a box ground taking 0.25 s.
- **Scenarios page** (`src/features/scenarios/`): the built-ins, the one entry each needs (a payload mass, a CoM offset; no defaults), the run, and the report as rows: what is measured, the value, the limit, the verdict. A check whose window was never reached shows no value. A scenario that passes by showing the failure it predicts (`overweight_payload`, `com_offset_beyond_authority`) is marked, so a pass is not read as a flight that holds.

**Verified**
- engine-core `scenario/tests.rs`, including: the built-ins match their predictions; the controller never sees the payload or the CoM; modifications recompute the totals and leave the nominal vehicle unchanged; a 10 s run is deterministic and its JSON round-trips; invalid inputs are errors, not panics; a cut-off ends the run and fails acceptance; the air density scales the prediction and the flight; only the ratio to a motor's reference density matters.
- Sidecar `tests/scenario_run.rs`; vitest `scenario-protocol` and `scenario-report`; e2e `scenarios.spec.ts`.
- Both merges were reviewed.

**Still open**
- The error code of a `scenario.run` refusal is chosen by matching the message text (`e.contains("reference density")` in `scenario_run.rs`), so rewording a message changes the code. A typed error is being added on another branch.
- The checks and tolerances are ours. They show that the build behaves as the model predicts, not that a real drone would.
- The controller's estimate is the true state: no sensor noise, delay or estimator.
- Wind and ground effect are not simulated (see the entry above).
- Phase 5 work in progress: 5.3 (flight modes and loop) and 5.10a (hover thrust estimator).

## 2026-11-23 — Phase 4, milestone 4.8: live flight and the flight view

The renderer flies the PX4-controlled vehicle in the real engine and shows what acts on it.

**Built**
- **Part A, flight view and debug panel** (`src/features/flight/`), first on demo data:
  - a Z-up view of the assembly posed from the frame, with the ground, obstacles, a follow camera and the CoM marker;
  - keyboard sticks with heading hold (the stick limits are UI limits, not controller tuning);
  - a debug panel with every value the plan lists, and indicators: hover balance (the existing tolerance setting; no invented CoM limit), motor layout, active contacts, maximum T/W from the 4.5 steady-state solver with the shared pack sag (floor 1.0), and sustained allocator saturation.
- **Part B, the engine session** (`engine-host/src/flight_session.rs`, `electron/main/engine/flight-session.ts`):
  - `flight.session.start` builds what a controller `sim.run` builds, plus the user's battery cut-off (voltage or charge; no default); `flight.session.step` advances up to 100 fixed 1 ms steps with one setpoint held; `flight.session.end` drops the session;
  - the engine never runs on its own clock, so a session is deterministic: any chunking of the same setpoint ends in the same state hash as one controller `sim.run` of the same duration;
  - new error codes `CUTOFF_REQUIRED` and `NO_SESSION`; the protocol version stays 2;
  - `EngineFlightSource` feeds the page from the session. The page lists what is missing and does not start until the Ready-to-fly list and the flight conditions are complete.
- **Loads by source** (`flight.rs`, for the debug panel): the thrust force, body drag, arm torque, the held rotor drag torque, the spin-up reaction and the gyroscopic torque of the last step. Their torques sum to the torque applied.
- **Battery cut-off** (`Cutoff`): the run ends when the pack voltage under load falls to the value, or the charge drawn reaches it. It overshoots by at most one step, and an ended flight does not step again.
- **Air-density scaling of k_T and k_Q** (`Flight::scale_to_air_density`): each motor's coefficients scale by ρ/ρ_ref, where ρ_ref is the density its propeller data was taken at, stated by that data's source or entered by the user, per motor. It scales from the coefficients as loaded, so calling it again replaces the scaling instead of compounding it. `sim.run` scales like the session, and the T/W indicator uses the scaled coefficients.
- **Flight conditions saved per project** (migration `0012_flight_conditions.sql`, `assemblies.flight_json`): ambient altitude (sets the ISA air density), temperature (null = standard) and the cut-off type and value. Null means not entered, and the flight test lists it as missing.
- The estimate's attitude is normalised before the controller's unit-quaternion assert, and a long yawing run flies on (tests `the_estimate_is_normalised_before_the_controllers_unit_assert`, `a_long_yawing_run_flies_on`).

**Verified**
- Sidecar `tests/flight_session.rs`; engine-core flight and closed-loop tests (loads by source and drag, the cut-off, the coefficient scaling); vitest `flight-view`, `flight-live` and `flight-conditions`; the SSR render test; e2e `flight-live.spec.ts`.
- The part B commit messages state that the full `test:all` passed after the review fixes.

**Still open**
- Not simulated: wind, ground effect, inflow, blade flapping, thermal limits.
- The estimate is the true state: no sensors, noise or delay.
- A motor whose propeller data has no reference density stops the run; no value is assumed.
- A bouncing flat box still rebounds about half the expected height (rapier; see 4.4). The flight view's ground contact is subject to it.
- Phase 5 flight modes (5.3) are in progress.

## 2026-11-23 — Phase 4 follow-ups: propeller placement, legacy projects, hull worker threads, clippy

**Built**
- **A propeller added onto its motor** (`placement.ts`, `assembly-ops.ts`): a propeller aimed at a motor mount rests on the motor on that mount, not on the arm. When no spot is free the message says why: which parts collide and their sizes and, only after the existing search failed, the motor spacing (in the test, at 135 mm spacing a 254 mm disc on a bare mount intersects the next motor). The clearance rules are unchanged. One undo removes only the new propeller, and dropping it on the mount uses the same rule.
- **Legacy projects upgraded** (`seatPropsOnMotors` in `assembly-ops.ts`, run from `WorkshopPage.tsx` once the component library is loaded): a propeller resting directly on a motor mount is moved onto the motor on it. The first in document order gets the motor; one already attached takes precedence; extras stay where they are and are reported by the interference findings, not stacked. The twist about the motor shaft is kept. It is an undoable, saved edit, and a no-op when nothing needs moving.
- **Hull computation on worker threads** (`electron/main/assets/hull-async.ts`, `hull-worker.ts`): `modelHull` runs on a lazy pool of up to 2 worker threads, started on first use and ended after 30 s without work, never keeping the process alive. The model's bytes are transferred, not copied; a worker that throws or exits rejects its jobs and is replaced on the next call. Import and the start-up hull back-fill use it (`importAssetFileAsync`, `backfillHullsAsync`), and main ends the workers on `will-quit`.
- **Clippy**: the existing warnings in `vehicle.rs` are fixed; behaviour is unchanged.

**Verified**
- `placement.test.ts`, `assembly-ops.test.ts` and e2e `prop-on-mount.spec.ts` (add onto the selected motor, one undo, drop on the mount, a taller neighbour that clears the normal propeller but obstructs an oversized one).
- `hull-worker.test.ts`: the same hull and the same errors as the synchronous `modelHull`, several calls at once, and a worker that dies. The worker is built the way electron-vite builds it and started from a temporary folder.
- The merges were reviewed.

**Still open**
- Hull computation no longer blocks main's event loop (4.4's open item). The 4.4 figure of about 1 s for 200 000 vertices was not re-measured on a worker.
- A part's placement uses its placeholder size until a component is linked, so a large placeholder can be refused (4.4's open item).

## 2026-11-22 — Phase 4, milestone 4.7: the controller flies the vehicle

The PX4 v1.13.3 controller (`controller.rs`, merged earlier) now flies the 4.5/4.6 plant:
the real motors, battery and drag, not the linear test actuator of its own tests.

**Built**
- **`engine-core/src/closed_loop.rs`**: each step,
  - estimate = the true state, with no estimator, noise or delay (stated);
  - the controller's commands are the motors' throttles. This is linear: PX4's
    thrust-curve compensation is not modelled, and the vertical integrator absorbs it,
    as it absorbs MPC_THR_HOVER not being this vehicle's.
- **As the plan asks**:
  - the allocation uses the nominal motor geometry about the frame origin and the mean
    fitted k_Q/k_T; the controller never sees the true CoM or inertia;
  - a CoM offset is trimmed by the rate integrators;
  - too large an offset saturates the motors and loses attitude, an outcome of the
    physics rather than a script.
- **Gains**: the PX4 v1.13.3 defaults (checked against the cited reference file by
  `defaults_match_reference`), editable by exact PX4 parameter name. An unknown or
  lower-case name is refused.
- **Protocol** (additive):
  - `sim.run` takes `controller: {altitudeM?, climbRateMps?, attitude?, yawRateRadps?,
    gains?}` instead of `throttle`;
  - it returns `controller: {saturatedSteps, rateIntegral, collectiveThrust}`;
  - refused: a non-unit attitude, unknown gains, and throttle together with controller.
- `Propulsion::yaw_ratio()` (mean k_Q/k_T).

**Tests** (plan areas 8, 9, 10, against the test motor)
- Hover from rest to 1 m: the CoM within 1 cm and the tilt within 0.1° after 10 s, a
  quarter of the weight per motor within 0.5 %.
- CoM 20 mm off-centre: level within 0.1°. The thrusts match the moment balance
  T₊ = W(A + d)/4A and T₋ = W(A − d)/4A within 0.5 %, held by the roll integrator.
- CoM beyond the motors: saturation, attitude lost (> 10°).
- Payload: the settled hover throttle equals the plant's predicted one (bisection)
  within 0.5 % at 1.0 and 1.4 kg, and rises with the mass. At 1.2 × the maximum
  thrust's weight it cannot climb, with the collective at its limit.
- Determinism; gain overrides.
- Protocol: a 0.5 m hover through the sidecar, and the refusals.
- Supervisor: the mass.ts quad that pitched up at fixed throttle in the 4.6 test is held
  level at 1 m, with its pitch integrator holding the trim.

**Note**
- `sim_run_at_the_step_limit` (4.4's 2 s compute budget) is near its limit on this
  machine under load: 120 000 free-flight steps took 0.99–2.0 s, for the 4.6 and 4.7
  builds alike, against 0.88 s measured earlier. A wall-clock test on a busy machine is
  fragile; left as it is.

## 2026-11-22 — Phase 4, milestone 4.6: flight dynamics

The 4.5 motor, battery and drag models now fly the rigid body. The throttles drive
everything; the controller that sets them is 4.7.

**Built**
- **`engine-core/src/flight.rs`**: one fixed step, with the throttles held over it:
  1. Rotor loads from each rotor's speed at the start of the step:
     - thrust k_T ω² along the motor's true thrust axis, at its true position, giving
       force plus r × F about the CoM;
     - the drag-torque reaction −s·k_Q ω² (s = +1 CCW, −1 CW);
     - the rotors' gyroscopic coupling −ω_body × Σ s·J·ω·a.
  2. Rotors and battery advance (4.5's RK4: pack sag, charge used). The spin-up
     reaction −s·J·Δω/dt is added exactly over the step.
  3. Body drag −½ ρ C_d A v|v| per body axis, through the CoM. ρ is the caller's;
     there is no default.
  4. rapier steps the body, gravity included.
  - Not modelled, and stated in the module: inflow, ground effect, blade flapping,
    prop drag in forward flight, thermal limits, a battery cut-off.
- **Protocol** (additive; PROTOCOL_VERSION stays 2):
  - `sim.run` takes `throttle` (per motor, vehicle order, held over the run; absent =
    motors off), `rotorSpeedsRadps` (start speeds) and `airDensityKgM3` (required with
    body drag);
  - it returns per-motor `motors` (throttle, rpm, thrust, drag torque) and `battery`
    (voltage, current, charge used, state of charge);
  - with propulsion, `stateHash` also covers the rotor speeds and the charge used;
  - refused: throttle without propulsion, drag without the density, body loads with
    propulsion, a throttle outside [0, 1] or of the wrong count.
- **`src/domain/atmosphere.ts`**: ISA (USSA 1976, −5 km′ to 11 km′) density for the
  drag.
  - It takes its constants from the cited `database/reference/physics.v1.json`
    (nothing retyped): T = T0 + L·H, P from eq. 33a, ρ = P·M0/(R*·T).
  - A non-standard day uses the air temperature at the standard pressure of H.
  - Altitude is geopotential (within 0.2 % of geometric below 11 km; stated).
  - The user's altitude and temperature fields come with the flight view (4.8).

**Tests**
- engine-core `flight/tests.rs` (9 tests):
  - rotor loads: thrust, r × F, the drag reaction for both spins and the gyroscopic
    coupling against a hand calculation;
  - hover trim: altitude and attitude held, a quarter of the weight per motor;
  - full-throttle climb: v = a·t, and z = ½·a·t² + ½·a·t·h with h = dt/4, rapier's
    substep;
  - body + rotor angular momentum: conserved up to the prop's drag impulse, to 1e-12;
  - fall with drag: against v_t·tanh(g·t/v_t), with first-order convergence measured
    (error halves with dt);
  - battery: V = V_oc − R_int·I and charge = I·t at steady hover;
  - unequal thrust: roll, pitch and yaw follow r × F;
  - the same inputs give the same hash, rotors included;
  - refusals.
- sidecar: a flight run through the protocol, including its readings, determinism and
  every refusal.
- vitest:
  - `atmosphere.test.ts`: the cited ρ0 at 0 m; the hydrostatic equation dP/dH = −ρ g0
    at 5 altitudes; a hot day; range checks;
  - the supervisor flies a mass.ts quad with propulsion, drag and ISA density in the
    real engine. Its GPS sits 40 mm aft, so equal thrust pitches it nose-up, as
    r × F says. Holding it level is 4.7's job.

## 2026-11-22 — Phase 4, milestone 4.7 (controller module): the PX4 controller in engine-core

The controller as its own pure module, merged before it flew the vehicle (the entry above). It was written by Codex and reviewed; it was not wired into the engine host or the protocol until 4.4 and 4.5 had merged.

**Built** (`engine-core/src/controller.rs`)
- **Gains**: all 38 PX4 v1.13.3 defaults, each with its source line; `defaults_match_reference` asserts they equal `database/reference/physics.v1.json`. `Gains::validate` checks a set before use.
- **Angle loop**: PX4's reduced attitude control with the yaw weight, and a vertical position/velocity hold.
- **Rate loop** (`RateControl`): P, I, D, feed-forward and K, integrator limits, and directional anti-windup. D uses a finite difference of the caller's filtered estimate.
- **Allocation** (`Allocator`): from the nominal motor geometry about the frame centre, a pseudo-inverse with PX4's mix normalisation, and PX4's sequential desaturation with airmode disabled: thrust is only reduced, roll then pitch, yaw gets 15 % headroom. Ported from PX4's `ControlAllocationPseudoInverse.cpp` and `ControlAllocationSequentialDesaturation.cpp` (the BSD-3 notice is kept). Rank-deficient or invalid geometry is refused.
- **Frames**: PX4's FRD/NED is mapped to the engine's FLU/Z-up (documented in the module header). The collective is positive up, the negative of PX4's NED thrust-z.
- **Deviations** (stated in the module): the caller supplies filtered estimates; no arming, landed detection, sensor filtering or horizontal control; no hover thrust estimator (`MPC_THR_HOVER` stays fixed although `MPC_USE_HTE` defaults on).
- The controller never receives the true CoM or inertia.

**Verified** (17 tests at the merge, in `controller/tests.rs`)
- Hand-calculated allocation for an X quad, a rectangular quad, a hexa and a tilted motor; the desaturation order and the 15 % yaw headroom; rate-loop limits, freeze and unwind; the vertical equation, limits and reset.
- Closed loops in `sim::Simulation` against a test actuator: hover, a 10° roll step, CoM trims of 2 cm and 6 cm, loss of attitude at a 25 cm offset, and the determinism hash.
- The first review round replaced a row-sum normalisation and a thrust-preserving desaturation that differed from PX4.

**Still open**
- No horizontal control and no hover thrust estimator in this module. Horizontal position control has since merged as Phase 5.1; the hover thrust estimator is Phase 5.10, its core (5.10a) in progress.

## 2026-11-22 — Phase 4, milestone 4.4 follow-ups: placement, hulls, environment, live drag, contact limits

The 4.4 entry below left five issues open, and three e2e tests had hidden one of them with a 50 mm overlap tolerance. This entry fixes them; the workarounds are gone.

**Placement keeps physical constraints** (`src/features/workshop/placement.ts`, `place-actions.ts`)
- A new part rests on what it is attached to: a motor mount (that pose only), a plate face or the top of the frame (centre within the plate), or its parent's top face (centre within it). It keeps its attachment and is never stacked onto another part.
- Search: a 5 mm grid on that face, nearest first, then by angle and coordinates. Deterministic.
- The first spot with no interference error is taken. If none exists, the part is not added: no undo step, and the reason appears under "Add part" and in the inspector, e.g. "No free spot on the frame for Battery 4 (140 × 45 × 35 mm): …".
- Applies to adding from the library, dropping on the viewport, model import, duplicate, copy to motor mounts and attaching (the field or a gizmo release onto a mount). Each is one undo step.
- Linking a component or resizing keeps the part, and what rests on it, on its support. This was the cause of the 1.2 mm flight-controller-into-frame overlap: a linked part kept its placeholder's resting height. If the new size overlaps, the part moves to the nearest free spot on its support; if there is none, it stays and the error shows.
- The e2e builds were fixed rather than tolerated:
  - `buildHex` gives its parts real positions;
  - the hex acceptance build hangs the battery under the frame. On top, the 140 mm battery plus six ESCs and three payloads did not fit a 150 mm plate, which the check now says.

**Conservative hulls for imported models** (`electron/main/assets/hull.ts`)
- At import, every vertex of the default scene is read from its POSITION accessor, with node transforms. Handled: byteOffset, byteStride, sparse substitution and normalized integers (KHR_mesh_quantization).
- The full convex hull is kept (three.js `ConvexHull`); nothing is simplified.
- Every source vertex is checked against every hull face (1e-9 × size), and every hull point against the stored bounds.
- Flat models, unreadable data, a failed check, or more than 4096 hull vertices: no hull, with the reason stored; the part collides as its bounding box, which contains it.
- Stored in `assets.hull_json`, and back-filled at startup for models imported earlier.
- The production main bundle contains the hull code (`out/main/index.js`, 628 kB). An e2e test imports `pod.glb` through the built app and sees a hull.
- Measured:
  - the fixture `pod.glb`: 216 vertices give a 40-point hull in 11 ms;
  - 200 000 random vertices give a 130-point hull, fully verified, in 1.17 s (main thread, at import).
- Mass and inertia are unchanged: a model is still a uniform solid box of its bounds (`inertiaShape` in `mass.ts`). The hull bounds the surface; it says nothing about the mass distribution. Tests check that the inertia is identical with and without the hull, and that a hull loads in the real engine with totals equal to `mass.ts`.

**Environment per project** (`src/domain/environment.ts`, `EnvironmentPanel.tsx`)
- Ground friction and restitution and box obstacles (name, centre, size, yaw, friction, restitution), saved with the project (`assemblies.environment_json`).
- Not set means null. Each missing value is listed with where to enter it, and nothing is assumed (zero is a value).
- Validated in main: μ ≥ 0, 0 ≤ e ≤ 1, positive sizes, unique ids, finite numbers.
- **Drop test** (IPC `engine:dropTest`): the vehicle from `mass.ts` and the environment from `simEnvironment` go through the protocol schemas to the real engine. The release height is taken from the lowest point of the collision shapes plus a visible "Release height" field. The button stays disabled while a value or a mass is missing.

**Live drag tested, with test hooks only in tests**
- `window.__blazeTest` exists only in a development build or when main is started with `BLAZE_UAV_TEST_HOOKS=1` (the e2e launcher). A launch without it has none; an e2e test checks that.
- The preview follows a drag pose after the 80 ms pause, while the saved revision, the undo list and `save-state` stay unchanged.
- A real pointer drag of the gizmo (top view, orthographic) sets the drag pose, updates the outline, saves nothing until release, then adds one undo step. Dragging the gizmo's free-move handle can also move the part a little in Z (the view plane is not exactly horizontal).

**rapier flat-impact spin, measured** (`environment/spin_study.rs`, run on demand)
- A flat 100 × 100 × 40 mm box dropped from 0.5 m:

  | Setting | Corner impulse ratio | Peak spin, e = 0 | Rebound, e = 0.5 (should be 120 mm) | Rest, e = 0 |
  |---|---|---|---|---|
  | rapier default | 1.30 | 12.8 rad/s | 65.7 mm | 1.18 s |
  | stabilization 4 | 1.01 | 1.2 rad/s | 64.7 mm | 1.32 s |
  | stabilization 8 | 1.01 | 1.2 rad/s | 64.7 mm | 0.39 s |

  Contact clustering off, warm-start 0, more PGS iterations and more substeps were also tried. None fixed the rebound. The one-point pyramid control rebounds 119.1 mm in every case.
- Not applied: stabilization fixes the dead landing but not the bounce, and makes a contact step 1.6× to 2.9× slower. A 120 000-step resting run took 2.7 s (×4) and 4.8 s (×8), against 1.7 s. Documented in `environment.rs`; the existing test that the box lands back flat stays.

**Engine time budget (new finding)**
- With ground contact a step costs far more than in free flight: a 20-box vehicle resting on the ground took ≈25 s for 120 000 steps (≈0.2 ms per step).
- The supervisor kills an engine that misses its 3 s health ping. So `sim.run` now stops itself after 2 s of computing with `RUN_TOO_LONG` (no partial state, so completed runs stay deterministic). A sidecar test runs the 20-box case and checks that the engine keeps answering.
- Long simulations with contact need a step budget per message (streaming, 4.6/4.8).

**Migration 0010**
- 0010 is renamed `0010_collisions.sql` and adds `interference_json`, `environment_json` and `assets.hull_json`. It was extended before shipping.
- Development databases that ran the first 0010 get the missing columns from `repairUnshippedMigrations` (database.ts), with the same constraints.
- A test checks that migration files are numbered without gaps and that `MIGRATIONS` runs them in file order, so the merge with 4.5 keeps 0010 → 0011.

**Verified**
- Rust: debug and release workspaces green. 53 tests: engine-core 41, protocol 5, sidecar 8; plus 3 ignored studies.
- vitest: 285 tests, 31 files, all green, against the real engine binary. Typecheck and lint clean.
- Playwright: the full 43-test suite ran to the end in one go (5.9 min). 42 passed; phase3-acceptance timed out on its first click, straight after the performance test, with 4.5 GB of virtual memory free. Rerun alone and after the performance test, it passed. An earlier `test:all` (Rust, typecheck, lint and vitest green) lost the live-drag test the same way and then died; that test then passed 20 of 20 in repeated runs of its file. Both failures were timeouts under memory pressure, not wrong results.
- Performance, 50 parts: 1080p 59.5 rendered fps, median frame 16.6 ms, p95 16.8 ms; 4K 40.8 fps, median 17.0 ms, p95 33.4 ms.

Screenshots: `documentation/screenshots/4.4-interference-highlight.png`, `4.4-collision-debug-view.png`, `4.4-model-hull-debug-view.png`, `4.4-environment-drop-test.png`.

**Still open**
- A fully green `npm run test:all` in a single run: on this machine the e2e suite only passes when memory is not short (above).
- A bouncing flat box rebounds about half the expected height (rapier; above).
- Long simulations with ground contact stop at the 2 s compute budget.
- Hull computation runs on main's thread: about 1 s for a 200 000-vertex model.
- Placement uses a new part's placeholder size until a component is linked. A large placeholder can be refused where the linked part would fit; add it elsewhere, or link it on a support with room.
- Obstacles are not drawn in 3D yet (flight view, 4.8).

## 2026-11-22 — Phase 4, milestone 4.4: collisions

**Built**
- **Workshop interference check** (`src/domain/collisions.ts`, pure):
  - finds overlaps between the parts' collision shapes (box, cylinder, convex
    hull; a propeller is its swept disc) at their workshop poses, the same shapes
    and poses `mass.ts` gives the engine;
  - depth = penetration depth (the shortest move that separates the two), by
    GJK + EPA on the shapes' support functions: exact for boxes and hulls, to
    1e-9 m on a cylinder's round side;
  - deeper than the tolerance is an error naming both parts (new rule
    `interference` in Checks); a part may always touch what it is mounted on
    (motor on its pad, prop on its motor, a part on a plate mount); the user can
    allow a pair ("Allow" on the finding; undo restores it);
  - the frame is checked as its plate and arms; two props are left to
    `prop-clearance`, which already reports overlapping discs;
  - runs live while dragging, after an 80 ms pause, through the existing checks
    pipeline (`findings.ts` now also takes the asset bounds, so imported models
    have their size; without it they are "cannot check").
- **Settings saved per project**: tolerance (starting value 0.5 mm, a check
  margin, not a physical value) and allowed pairs, in `assemblies.interference_json`
  (migration 0010, now `0010_collisions.sql`, schema v10), validated in main (unknown
  parts, unsorted or repeated pairs, tolerance 0–50 mm). Deleting a part drops
  its pairs.
- **Viewport**: overlapping parts are outlined red (both parts, or the exact
  plate or arm); **collision-shape debug view** (View panel or **B**) draws every
  shape the check and the engine use. The highlight is an outline, not a fill:
  with the 50-part performance build (many overlaps) fills cost 6 rendered fps
  at 1080p (44 against 50 without the overlay), outlines 2.
- **Engine** (`engine-core/src/environment.rs`):
  - ground plane z = 0 and fixed box obstacles;
  - friction and restitution of the ground and of each obstacle are required in
    `sim.run`'s `environment`; nothing has a default, and the error names each
    missing value (`ENVIRONMENT_INCOMPLETE`). `"ground": null` is free space;
  - the entered values are the contact's coefficients: vehicle colliders carry
    0 and environment colliders the value with rapier's `Max` combine rule;
  - `sim.run` takes `startPositionM` and refuses a start inside the ground or an
    obstacle, naming the part and the depth;
  - contacts are reported: which part touched what, from when to when (`endS`
    null = still touching), at most 10 000 per run.

**Findings**
- rapier marks a contact "active" from its 20 mm prediction distance, which
  would report a landing ~5 ms early; and with contact recycling (on by default)
  contact distances can be up to 50 mm stale. The contact log therefore uses
  the contact points' distances (touching = within the solver's 0.1 mm), with
  recycling off.
- rapier's default allowed penetration is 5 mm; the engine uses 0.1 mm. A
  resting brick settles 0.106 mm into the ground.
- A perfectly flat box landing gets a brief spin (up to ~13 rad/s for a few
  steps): rapier solves the four corner contacts one after another. It still
  lands back flat, but with restitution > 0 the spin takes energy from the
  bounce. More solver iterations do not remove it. With a single contact point
  restitution is accurate (rebound speed 0.28 % low, height 0.66–0.88 % low for
  e = 0.25 to 0.8).
- parry 0.31.1's `contact` query mis-places a half-space given as the second
  shape; the start check passes it first.
- EPA needs faces that are coplanar with the new point treated as visible, or
  box faces (the usual workshop case) fold the polytope inside out. 300 random
  box pairs, also given as hulls, now match the exact separating-axis depth to
  1e-8 m.

**Tests**
- `collisions.test.ts` (plan test 4): overlap depth against hand values and
  apart/touching for box–box, rotated box–box, box–cylinder, cylinder–cylinder
  (side and stacked), hull–box, hull–cylinder and hull–hull; 300 random box
  pairs against SAT; tolerance edges, attached and allowed pairs, one finding
  per owner pair.
- `interference-input.test.ts`: a quad with motors and props has no finding; a
  sunk motor is mounted contact; a battery pushed 2 mm into the plate is an
  error naming the frame; allow, tolerance edge, delete; unknown model size;
  migration 0010 on a v9 database and the save schema.
- Rust `environment/tests.rs` (plan test 5): a brick dropped from 0.5 m lands
  within 1 ms after √(2h/g), rests flat at 20 mm − [0, 0.12] mm with
  |v|, |ω| < 1e-6 at every step from 1.5 s to 2.5 s, and the contact is
  reported; rebound speed and height for e = 0.25/0.5/0.8; friction μ = 0.5
  holds a 4 N push and lets 6 N accelerate at (6 − μmg)/m within 1 %; landing
  on an obstacle; start inside the ground refused; deterministic with contacts.
- Sidecar and supervisor tests for the protocol; `collisions.spec.ts` (e2e):
  two batteries 5 mm into each other give the error and the highlight, allow
  and undo, tolerance 5.01 / 4.99 mm, debug view with 7 shapes, settings survive
  a restart.

Screenshots: `documentation/screenshots/4.4-interference-highlight.png`,
`documentation/screenshots/4.4-collision-debug-view.png`.

- **The check finds overlaps the earlier builds had all along**: parts added
  with nothing selected, or onto the same plate mount, start at the same spot,
  so they sit inside each other. Three e2e tests about other rules
  (`checks.spec.ts` 6S battery, `electrical.spec.ts` port conflict,
  `phase3-acceptance.spec.ts`) built such stacks and counted every error; they
  now set a 50 mm overlap tolerance, with a comment saying why.

**Open**
- Imported models still collide as their bounding box; computing and saving
  their convex hull at import is not done.
- No UI yet sets the ground and obstacle values; the flight view (4.8) and the
  Ready-to-fly checklist (4.5) need to ask for them.
- New parts are still placed at a shared spot, so a typical build starts with
  interference errors until the parts are arranged. Placing each new part
  clear of the others would fix that; not done here.
- The live-drag debounce is not exercised by an e2e test (Playwright cannot
  hold a gizmo drag easily); the drag path uses the same functions as a release.

**Verified** (`npm run test:all`, exit 0)
- Rust: 53 tests (41 engine-core, 7 of them new; 5 protocol; 7 sidecar, 1 new).
  Typecheck and lint clean.
- vitest: 258 tests (33 new in `collisions.test.ts` and `interference-input.test.ts`,
  1 new supervisor test against the real engine).
- Playwright: 39 tests, 1 new (`collisions.spec.ts`). Performance with 50 parts
  in this full run: 39.6 rendered fps (median frame 17.2 ms) at 1080p and 25.6 at
  4K; this machine measured lower than in 4.2 (59.0) on this day even without the
  overlay (50 fps in the A/B above), so the numbers are noisy run to run.
## 2026-11-22 — Phase 4.5 follow-up: throttle map, held-out validation, gap-fills and overrides, per-axis drag

Fixes from the 4.5 review, with your corrections. Three commits: c9e8923, 71c38fc,
6ffa3b6.

The model is now **coherent and bounded**, not "validated":
- every assumption is labelled;
- every fit has a stated domain;
- the errors below are measured on rows the throttle map did not see.

What is still unknown is listed at the end.

**Built**
- **Throttle map (an empirical effective control ratio)**:
  - Each T-Motor row implies the duty the motor actually saw:
    d_eff = [E + √(E² + 4·V·R·I)]/(2V), from d·V = E + R·I/d and E = ω/K_v.
  - The map takes, at each throttle step, the median of d_eff/throttle over the
    table's rows.
  - Rules:
    - the effective duty is made non-decreasing (pool-adjacent-violators,
      flagged when it changes anything) and bounded to (0, 1];
    - it is interpolated linearly between steps;
    - outside the steps the ratio is held, flagged "extrapolated".
  - It is labelled as the manufacturer bench's ratio (their ESC, supply and
    wiring together), not an ESC efficiency. The voltage deficit is not claimed
    as ESC loss.
  - The ideal lossless converter (I_supply = d_eff·I_motor) stays an explicit
    assumption.
- **k_Q** uses each row's own d_eff: Q = K_t (I/d_eff − I₀).
- **Validation is leave-one-prop-out**: each propeller's rows are predicted
  with a map built from the other propellers' rows of the same table.
  - k_T and k_Q are fitted on those same rows, so they are reported as in-sample
    fit errors, separately from the validation.
  - The ideal-ESC prediction is kept as "before".
- **Per row**:
  - the table's power column against V × I: equal to its printed rounding
    (< 0.1 %) on every T-Motor row;
  - model power;
  - the energy balance V_m·I_m = Qω + K_t·I₀·ω + R·I_m² (tested);
  - I₀'s share of the current, and whether I₀ is used away from its stated
    10 V.
- **Fit domains**:
  - each fit states the speed range of its rows;
  - APC fits keep only rows up to the motor's no-load speed at the pack
    voltage (plus the first row above it);
  - outside the domain a result is an estimate.
- **APC provenance corrected**: APC's FAQ
  (https://www.apcprop.com/faq/, read 2026-11-22) states the data uses the
  sea-level Standard Atmosphere, 1.225 kg/m³. It is now cited in the seed
  condition (seed v4).
- **T-Motor propeller masses unchanged**: the conditions now record that
  "Weight (Single Blade)" is ambiguous and is taken as the whole propeller.
  Unverified.
- **Same propeller in other motor tables**: shown for comparison, not pooled.
  P13*4.4: k_T is 5.2 % higher in the KV700 table.
- **Per-axis body drag**:
  - C_d per x, y and z; the first value entered fills the empty axes.
  - Projected areas A_x, A_y, A_z are derived: the union of the non-propeller
    collision shapes projected on each body plane, on a 0.5 mm grid, with the
    error estimated as |A(h) − A(2h)|. Propeller discs are excluded.
  - Engine `aero.rs`: v_b = Rᵀv, F_b,i = −½ρ C_d,i A_i v_b,i|v_b,i|, F = R·F_b.
- **One resolver for every value** (`src/domain/spec-resolution.ts`), in this
  order:
  1. part override;
  2. library gap-fill;
  3. the record's own value;
  4. missing.
  - Every layer is kept with its provenance.
  - It is memoized on the component and override objects, both of which are
    replaced on change.
  - `linkedComponent` goes through it, so mass, inertia, shapes, checks,
    wiring/electrical, propulsion and the 3D model all read the same value.
- **Library gap-fills**:
  - an empty single-value field of a built-in record can be filled in place
    (source measured or user, never manufacturer);
  - stored in `component_fills`, apart from the seed;
  - seed updates never touch them, and a later stated value is shown as
    "Manufacturer now states X" (the fill still wins);
  - duplicate and export carry fills.
- **Per-part overrides**:
  - in the inspector's Specifications list, each value shows its layer;
  - Override and Clear are undoable assembly edits (`overrides_json`),
    validated per field in main.
- **Checklist**:
  - a missing component value offers both the library fill and "override on one
    part" (it lists the parts);
  - the wording now says 4.6 will refuse to start, not that flight is blocked.
- **Engine**: optional per-motor `throttleMap` and an optional `aero` on
  `vehicle.load`, both additive and validated. `loadVehicle(vehicle,
  { propulsion?, aero? })`.

**Before / after** (built-in data; "after" = leave-one-prop-out map)

| Pair | Full throttle speed, before → after | Full throttle thrust, before → after | Max error over all rows, after (speed / thrust / current) | k_Q max / rms, before → after |
|---|---|---|---|---|
| KV470 + P13*4.4 (5 rows, 14.8 V) | +16.6 % → −2.9 % | +35.3 % → −6.3 % | 3.4 / 10.0 / 18.4 % | 19.1 / 11.5 → 10.7 / 6.9 % |
| KV470 + P15*5 (5 rows, 14.8 V) | +23.7 % → +4.7 % | +57.3 % → +12.7 % | 11.3 / 15.0 / 21.8 % | 14.6 / 9.7 → 11.1 / 5.6 % |
| KV700 + P13*4.4 (5 rows, 11.1 V) | +14.0 % → −0.2 % | +28.9 % → −1.3 % | 3.6 / 11.1 / 3.3 % | 17.8 / 9.7 → 12.8 / 6.2 % |

In-sample k_T fits are unchanged: 2.2945e-5, 4.8676e-5 and 2.4138e-5 N·s²
(max 3.6 %, 7.2 %, 13.9 %).

Bench maps over all rows (effective duty at 50/65/75/85/100 %):
- KV470: 49.3 / 61.4 / 70.6 / 78.7 / 83.9 %.
- The simulation uses this full map; validation uses the held-out one.

APC fit domains on a 14.8 V pack:

| Motor | Rows used | Speed range | k_T 10x4.5MR | k_T fit max, before → after |
|---|---|---|---|---|
| KV470 | 7 of 22 | ≤ 7,000 rpm | 1.3873e-5 | 9.3 % → 1.4 % |
| KV700 | 11 of 22 | ≤ 11,000 rpm | 1.4032e-5 | 9.3 % → 2.6 % |
| KV780 | 12 of 22 | ≤ 12,000 rpm | 1.4082e-5 | 9.3 % → 3.0 % |

- APC k_Q still scatters 14–26 %: Cp rises at low speed (the 1,000 rpm rows).
- 11x4.5MR and 12x4.5MR behave the same (1.3–3.7 %).

**Tests**
- **Unit, propulsion** (`propulsion.test.ts`):
  - throttle map: d_eff hand case; PAV; interpolation and extrapolation flags;
    bounds; monotone seed maps; a falling table made monotone;
  - the held-out map excludes the validated prop;
  - per row: model equations, ideal-converter current/power, energy balance,
    the table's power vs V·I, I₀ share and domain flag;
  - the before/after numbers above pinned as regressions;
  - k_Q scatter lower on every pair;
  - APC domain capping and `outsideDomain`;
  - cross-table k_T.
- **Unit, drag** (`aero.test.ts`): box, union, cylinder, a yawed box,
  propeller exclusion, resolution error, drag hand cases.
- **Unit, layers** (`spec-resolution.test.ts`):
  - precedence, every layer kept, a fill over a later stated value;
  - cache invalidation for component, fills and overrides;
  - shared keys have the same dimension;
  - propagation into mass, inertia, shape, checks, wiring and propulsion, and
    back when cleared.
- **Unit, storage** (`component-fills.test.ts`):
  - the fill rules: refused for a manufacturer source, a stated field, a table
    field, a user record, a wrong unit;
  - duplicate and export carry fills;
  - a seed update under a fill;
  - overrides persist on save and reload, and round-trip without the field when
    absent;
  - the override schema.
- **Unit, assembly**: per-axis C_d persistence.
- **TypeScript/Rust consistency**: `tests/fixtures/propulsion-cases.json` (42
  cases) and `aero-cases.json` (20) are produced by the TS model. Both
  `propulsion.test.ts`/`aero.test.ts` and engine-core reproduce them to 1e-12.
- **Rust**: 50 engine-core tests (map interpolation and validation, steady
  sag through a map, drag hand cases and energy) and 8 sidecar tests (`aero` on
  `vehicle.load`).
- **e2e** `propulsion.spec.ts`:
  - held-out table, map, other tables;
  - per-axis C_d fill and clear;
  - a battery R_int override with undo and redo;
  - the rotor inertia filled in the library from the checklist;
  - the checklist down to the two 4.4 items.
- **Migration order with 4.4**: applying 0001–0009, 4.4's 0010 and this 0011 in
  sequence gives every column of both, with no clash. See the hand-over for the
  merge steps.

**Screenshots** (reviewed): `documentation/screenshots/4.5-fit.png`,
`4.5-checklist.png`, `4.5-library-field.png`, `4.5-override.png`,
`4.5-checklist-after.png`.
- Fixed after review: a missing space in the I₀ line.

**Remaining uncertainty**
- **The map is the manufacturer's bench, not your ESC.**
  - With another ESC or supply the effective duty differs.
  - Nothing here measures it; a bench test of your own setup would replace it.
- **Held-out errors are still up to 15 % (thrust) and 22 % (current)** at
  some rows (P15*5, 50 % throttle). The model stays an ideal BLDC with constant
  I₀ and no temperature effects.
- **k_T and k_Q are in-sample.** Only one table per prop exists for most
  props, except P13*4.4, where the two tables differ by 5 %.
- **I₀ is a single point at 10 V**, used unvalidated elsewhere (flagged per
  row).
- **APC data is computed, not measured**, at sea-level ISA. k_Q from it
  scatters 14–26 %.
- **Propeller mass reading** ("Single Blade") is unverified; it affects
  J_prop ×2 if wrong.
- **Projected areas use collision shapes**, not real surfaces.
- **C_d, the rotor inertia, the Tattu R_int and the ground coefficients** stay
  user inputs.

## 2026-11-22 — Phase 4, milestone 4.5: motor, propeller and battery models

**Built**
- **`src/domain/propulsion.ts`** (pure; every formula is in its header):
  - k_T and k_Q are least-squares fits through the origin in ω²:
    k = Σ y ω² / Σ ω⁴.
  - Data sources, in order:
    1. the motor's cited test-table rows for that propeller;
    2. the propeller's performance table (APC: the condition "computed, not
       measured" is carried with the fit and shown);
    3. otherwise k_T is a user input.
  - A table row matches a propeller of the same manufacturer whose stated
    diameter × pitch equals the D × P in the row's name. So "T-MOTO13*4.4CF"
    and "T-MOTOR13*4.4CF" both match T-Motor's P13*4.4.
  - k_Q from the motor table: Q = K_t (I/d − I₀), with K_t = 60/(2π·KV). The
    table's current is the supply current (its power column is V × I).
    Labelled assumption: an ideal averaging ESC gives I_motor = I_supply / d.
  - Steady state in closed form: ω = 2c / (b + √(b² + 4ac)), with
    a = R k_Q K_v, b = 1/K_v and c = d·V − R·I₀. A battery R_int adds d²·R_int
    to R.
  - The solver is compared with every cited row (speed, thrust, current).
  - Propeller inertia: blades as thin rods, J = m R²/3 (the same model as
    mass.ts).
  - Rotor inertia: entered, or J = τ_m K_t²/R from an entered mechanical time
    constant.
  - Battery: V = V_oc − I·R_int. V_oc is the stated nominal voltage, held
    constant, because no discharge curve is stated.
- **Motor fields** (with the usual provenance): `rotorInertia` (g·cm²) and
  `mechanicalTimeConstant` (ms). New units: kg·m², g·cm², s, ms.
- **Body drag coefficient C_d**:
  - new frame field; migration **0011** (0010 belongs to 4.4);
  - `AssemblyDocument.bodyDrag`;
  - saved by its own `UPDATE` statement, apart from the assembly upsert.
- **Workshop**:
  - **Ready to fly** lists exactly what the build still needs: frame mass, part
    masses, motor/propeller/battery links, missing motor or battery values,
    rotor inertia, k_T/k_Q for a pair without data, body C_d, and ground
    friction and restitution.
  - A value shared by four motors is one item.
  - Each item goes to its field: the frame inputs are focused; parts are
    selected; library values open `#/components?id=…&field=…` with that field
    marked. A built-in record also gets the note "duplicate it, enter the value,
    link the copy".
  - Ground friction and restitution have no link yet: their fields come with
    4.4.
- **Propulsion** section: one block per motor + propeller pair, showing:
  - the data source and its condition;
  - k_T and k_Q with their fit errors;
  - K_t, J propeller and J rotor;
  - the solver-vs-table error for each cited row (hover a cell for both values).
- **Engine** (`engine-core/src/propulsion.rs`):
  - motor response J dω/dt = K_t (I − I₀) − k_Q ω²;
  - battery sag solved exactly for any number of motors on one pack;
  - charge used = ∫I dt;
  - RK4 integration.
  - I₀ can stop the rotor but never reverses it.
  - `vehicle.load` takes an optional `propulsion` structure, separate from the
    pinned VehicleDefinition. It is validated against the vehicle's motors, and
    the result then carries `propulsion.motorCount`.
  - Forces are not applied yet (4.6).

**Fitted coefficients (built-in data)**

| Motor + propeller | Data | k_T (N·s²) | fit max / rms | k_Q (N·m·s²) | fit max | Solver max error: speed / thrust / current |
|---|---|---|---|---|---|---|
| MN3110 KV470 + P13*4.4 | T-Motor table, 5 rows, 14.8 V | 2.2945e-5 | 3.6 % / 2.0 % | 3.7162e-7 | 19.1 % | 16.6 % / 35.3 % / 47.4 % |
| MN3110 KV470 + P15*5 | T-Motor table, 5 rows, 14.8 V | 4.8676e-5 | 7.2 % / 3.8 % | 8.2781e-7 | 14.6 % | 23.7 % / 57.3 % / 69.0 % |
| MN3110 KV700 + P13*4.4 | T-Motor table, 5 rows, 11.1 V | 2.4138e-5 | 13.9 % / 6.6 % | 3.7561e-7 | 17.8 % | 14.0 % / 28.9 % / 41.5 % |
| any MN3110 + APC 10x4.5MR | APC, computed, 22 static rows | 1.4945e-5 | 9.3 % / 5.9 % | 2.1840e-7 | 20.2 % | no bench data |
| any MN3110 + APC 11x4.5MR | APC, computed, 20 static rows | 1.9846e-5 | 9.4 % / 6.2 % | 3.0058e-7 | 17.6 % | no bench data |
| any MN3110 + APC 12x4.5MR | APC, computed, 19 static rows | 2.6449e-5 | 10.3 % / 6.9 % | 4.2577e-7 | 10.6 % | no bench data |
| KV700 + P15*5, KV780 + P13*4.4 or P15*5 | none | user input | | | | |

**Findings**
- The solver over-predicts at full throttle: speed +14 to +24 %, thrust
  +29 to +57 %. At 50 % throttle it is within 2 % in speed (KV470 + P13*4.4:
  +0.6 %).
  - The 100 % rows sit well below KV × V: 5500 rpm against 6956 rpm no-load at
    14.8 V.
  - So "V·throttle at the motor" with the stated KV and R does not hold at full
    throttle on T-Motor's bench (ESC or supply drop, or the KV under load).
  - This is reported, not corrected; nothing is tuned to fit.
- k_Q from the current scatters 11–20 % around ω²: the current-derived torque
  does not follow a square law closely in these tables.
- The two T-Motor tables disagree on the same P13*4.4: k_T is 5 % higher in the
  KV700 table, although k_T is a propeller property.
- The APC k_T fit errors (9–10 %) come from Ct rising from 0.106 to 0.119 over
  1,000–22,000 rpm. The fit uses all rows.

**Tests**
- `propulsion.test.ts` (22 tests, plan test 6):
  - the fit equals an independent least squares on the raw cited rows, and
    every row lies within the reported maximum error;
  - the steady state matches a hand solution (ω = 911.852502 rad/s), and both
    model equations hold at every validation row;
  - battery sag; prop matching by maker and size; the APC fallback; rotor
    inertia from τ_m;
  - the checklist: the exact item list for the built-in quad, dedupe, links,
    and an empty list once everything is entered.
- `propulsion-engine.test.ts`:
  - a seed quad's propulsion loads in the real engine (`motorCount` 4);
  - the result without propulsion is unchanged from 4.3;
  - a wrong `partId` is refused with paths;
  - the TS and zod types are assignable both ways.
- Rust: 7 `propulsion` tests against analytical solutions:
  - Riccati spin-up, to 1e-8 of ω₁;
  - the first-order case with τ = J·R/K_t², to 1e-9;
  - steady sag with 1 and 4 motors equals R + n·d²·R_int;
  - charge = I·t;
  - the rotor stays at rest below I₀;
  - validation paths.
- A sidecar test covers `vehicle.load` with `propulsion`.
- e2e `propulsion.spec.ts`: builds the quad, checks k_T, the five validation
  rows and the five checklist items, follows the C_d and rotor-inertia links,
  and takes the screenshots below.

**Screenshots** (reviewed): `documentation/screenshots/4.5-fit.png`,
`4.5-checklist.png`, `4.5-library-field.png`.
- Fixed after review: the narrow left panel cut off the k values and the
  four-column table. Labels are shorter now, and the table shows the errors
  with both values in a tooltip.

**Left open**
- MN3110 rotor inertia, the Tattu R_int and the ground coefficients stay user
  inputs. The ground fields arrive with 4.4.
- Built-in records are read-only, so entering a value means duplicating the
  component and relinking. A per-build override would be shorter.
- The app does not send `propulsion` yet: 4.6 wires `propulsionDefinition()` and
  the forces into the flight step.

## 2026-11-21 — Phase 4 data sources: APC performance, reference data, gaps

Data only, plus the units and the propeller field needed to hold it. No simulation
code yet.

**Built**
- **APC performance tables**:
  - new propeller field `performanceTable` ("Manufacturer performance data");
  - the seed now holds the static rows of APC's `PER3_*x45MR.dat` files for the
    three APC props (22, 20 and 19 RPM rows), with all 15 source columns in the
    file's units;
  - the condition records that APC computes this data and does not measure it;
  - the component library shows the table like the motor test tables, and
    dimensionless columns show no unit;
  - seed version 3.
- **Units** (`src/domain/units.ts`), all with exact definitions:
  - imperial: lbf, hp (mechanical), in·lbf, mph;
  - SI: N·m, m/s, m/s², Pa, K, kg/m³, g/cm³, K/km, kg/kmol, N·m/(kmol·K),
    J/(kg·K);
  - also deg/s, g/W, and "1" for dimensionless numbers.
- **`database/reference/physics.v1.json`** (format in
  `database/reference/README.md`), with cited sets:
  - ISA (U.S. Standard Atmosphere 1976);
  - carbon-fibre plate density (two datasheets);
  - PX4 v1.13.3 multicopter controller defaults (38 parameters, each pointing at
    its `PARAM_DEFINE` line).
- The plan has a new section, "Data sources found / not found". No source states
  the MN3110 rotor inertia, the Tattu pack's internal resistance, or Ct/Cp for the
  T-Motor props; these stay user inputs.

**Tests**
- `reference-data.test.ts` checks that:
  - every entry is complete (source, locator, date, condition, known unit);
  - the derived R equals R*/M0;
  - the cited ρ0 matches P0·M0/(R*·T0) to the standard's 5 figures;
  - the PX4 keys are the exact parameter names on their cited lines.
- `seed.test.ts` checks the APC tables: the imperial and SI columns agree within
  the printed rounding, and P = T·n·D·Cp/Ct holds within 1 % (this check does not
  depend on the unstated density).
- `units.test.ts` covers the new definitions.

**Notes**
- apcprop.com blocks scripted downloads (Cloudflare), so the files were read in a
  browser.
- The NTRS scan of USSA 1976 has no usable text layer, so its pages were read as
  images. Its Table 2 prints R* as "8.31432 × 10⁻³"; the body text (p. 3) gives
  10³, which is the value used.

## 2026-11-21 — Phase 4, milestone 4.3: engine foundation

**Built**
- **rapier3d-f64 0.36.1** (Apache-2.0), pinned exactly, with
  `enhanced-determinism` (ADR 0005). rapier integrates and (from 4.4) resolves
  contacts; our code applies every force and torque.
- **`engine-core/src/vehicle.rs`**: reads the pinned `VehicleDefinition` and trusts
  nothing:
  - finite numbers, positive masses, unit quaternions and thrust axes (1e-9),
    unique non-empty part ids (opaque: the frame arrives as several parts),
    real shape volumes, version 1;
  - every inertia positive definite, with principal moments satisfying the
    triangle inequality;
  - totals recomputed from the parts (Σm, Σmr/m, parallel axis theorem) and
    compared with the sent ones to 1e-9 relative; a mismatch is listed back,
    never corrected;
  - one rapier body, one collider per part carrying the part's explicit mass
    properties; the load checks rapier's body mass, CoM and inertia against the
    recomputation to 1e-9.
- **`engine-core/src/sim.rs`**: fixed step (1 ms default), body-frame force and
  torque per step, gravity 9.80665 m/s² (CGPM 1901 / ISO 80000-3), FNV-1a 64
  state hash.
- **Protocol v2** (`engine-host`): `vehicle.load` (totals or a list of errors) and
  batch `sim.run` (duration, dt, constant body-frame force and torque → final
  state and hash; at most 120 000 steps). hello/ping/shutdown unchanged.
- **Electron main**: `EngineSupervisor.loadVehicle` and `runSim`, with zod
  schemas for the definition, the parameters and both results
  (`electron/main/engine/protocol.ts`).
- ADR 0005 (rapier and its limits) and ADR 0006 (mass properties in TypeScript,
  simulation in Rust, cross-checked). ARCHITECTURE protocol table updated.

**Findings**
- **Gyroscopic term**: rapier includes −ω×(Iω) (default on). Torque-free tumble of
  an asymmetric body, 10 s at 1 ms: |ΔL|/|L| ≤ 4.5e-4, |ΔE|/E ≤ 2.1e-3. With
  rapier's term switched off, L drifts 54 %. We do not add it again.
- **Determinism**: identical inputs give the identical hash over 10 s, in one
  process and across two engine processes; a 1e-12 N change at one step changes it.
- **Substeps**: rapier runs 4 substeps per step, so free fall matches the
  discrete symplectic-Euler solution with h = 0.25 ms exactly; the error against
  ½gt² is ½·g·t·h = 1.23 mm after 1 s. Spin-up under constant torque: ω = αt to
  1e-12, θ within ½·α·t·h.
- **glamx 0.3.1 eigen solver** (used by rapier to diagonalize inertia, also when
  it sums colliders) returns a wrong frame for a repeated smallest moment (13 %
  error) and for tensors around 1e-6 kg·m² (29 % error). Found by the 1e-9
  cross-check on a tilted motor. The engine now diagonalizes each part tensor
  itself (cyclic Jacobi), sums heaviest first, and refuses the rare vehicle whose
  rapier sum still disagrees, saying why. Follow-up: report upstream.
- One 120 s `sim.run` (120 000 steps) takes 0.88 s in release, inside the
  supervisor's 3 s request timeout.

**Verified**
- Cross-check with 4.1 (`src/domain/mass.ts` at 5e2f015, run in a temporary test,
  not committed here because mass.ts is not on this branch): its
  `VehicleDefinition` type and the engine's zod type are assignable both ways,
  and five quad builds from `massProperties` (tilted motors, rod-model
  propellers, offset battery, hull GPS, frame as plate plus arms) load in the real
  engine; totals agree to ~1e-18 kg·m². The hardest part, a tilted propeller, is
  now a Rust test.
- `npm run test:all` green: 45 Rust tests (34 engine-core, 5 protocol, 6 sidecar),
  189 unit tests (4 new against the real engine binary) and 34 e2e tests; typecheck
  and lint clean.

## 2026-11-21 — Phase 4, milestone 4.2: editor additions

**Built**
- **Part kinds**: GPS, camera, sensor and landing gear (migration
  `0009_part_kinds_inertia.sql`, schema v9).
  - SQLite cannot change a CHECK in place, so the part table is rebuilt with every
    column, constraint and index, and the rows are copied.
  - GPS, camera and sensor link to peripheral components. Landing gear has no
    library category, so its size and mass are the user's.
  - New detailed models: a camera (housing, lens barrel, glass) and landing gear
    (skids, angled struts, cross tubes) that fill their envelopes.
  - Landing gear added with nothing selected goes under the bottom plate.
- **Drag from the library**:
  - each part button can be dragged onto the viewport;
  - mount markers show during the drag, and the nearest one within 28 px lights up;
  - dropping attaches there (anywhere else: free);
  - one undo step.
- **Resize (R)**: a scale gizmo for parts not linked to a library component (box
  or cylinder envelopes).
  - The scale is written back as the envelope's size, rounded to 0.1 mm and kept
    within the saved limits.
  - Cylinders stay round.
  - Linked parts keep their stated size, and the gizmo falls back to move.
- **Per-part inertia** (Inertia in the part inspector):
  - shows the derived Ixx/Iyy/Izz;
  - "Enter measured values" starts from them, then takes the user's full tensor and
    a CoM offset from the shape centre;
  - "Use values from size" goes back to the derived values.
  - `electron/ipc/inertia.ts` refuses impossible tensors, both in the field and in
    IPC validation: non-positive moments, the triangle inequality broken, or a
    tensor that is not positive definite.
  - `mass.ts` uses the override, rotating the CoM offset and the tensor with the
    part.

**Known**
- Landing gear hangs below the workshop grid, because the workshop's ground is
  still the underside of the frame. Standing the drone on its gear comes with
  ground contact (4.4).

**Verified** (`npm run test:all`, exit 0)
- Rust: 11 tests. Typecheck and lint clean.
- vitest: 212 tests, 7 new:
  - tensor validity (including the flat-plate limit and products too large);
  - the save schema;
  - the override's rotated CoM offset and tensor;
  - resize rounding and clamping;
  - which parts can be resized;
  - migration 0009 on a v8 database (parts kept, then the new kinds and an override
    round-trip).
- Playwright: 36 tests, 1 new:
  - landing gear goes under the bottom plate;
  - a GPS dragged onto the motor 2 marker attaches there;
  - the camera's derived Ixx matches the hand value (0.009 g·m²);
  - an impossible Izz is refused with the reason;
  - a CoM offset is entered, cleared and restored with undo;
  - R selects resize;
  - everything survives a restart.
  - Performance: 59.0 fps at 1080p and 38.4 fps at 4K, with 50 parts.

## 2026-11-21 — Phase 4, milestone 4.1: mass properties

**Built**
- **Frame mass**: a new frame field (migration `0008_frame_mass.sql`, schema v8),
  entered by the user with its source recorded like a part's mass. Not set = the
  CoM is incomplete. It is spread over a uniform-density model of the frame (plate,
  plus each arm outside the plate), so the frame has its own CoM and inertia.
- **`src/domain/mass.ts`** (pure, documented at the top of the file):
  - CoM = Σ mᵢ rᵢ / Σ mᵢ, positions taken through the attachment chain;
  - part inertia: uniform box or cylinder, propellers as thin blades averaged over
    a turn (mR²/3 about the shaft), imported models by their bounding box;
  - totals about the CoM by the parallel axis theorem, rotated into body axes;
  - products of inertia with the tensor sign convention;
  - parts without a mass are left out and listed;
  - `vehicleDefinition()` builds the engine's input (the shared interface in
    `plans/phase-4-physics.md`); the frame goes in as `frame:plate` and
    `frame:arm-n`.
- **Hover balance**: the least-squares thrust split that carries m·g with no roll or
  pitch moment about the CoM. If a motor would need negative thrust, the drone
  cannot hover level (error); a share above your margin (default +10 %, editable)
  is a warning. Both appear in Checks under the new `hover-balance` rule. Yaw is
  left out until each prop's drag torque is modelled (4.5).
- **Workshop**:
  - **Mass section**: total mass and weight; CoM X/Y/Z, horizontal offset and
    distance from the frame reference; the inertia tensor in g·m²; hover thrust and
    share per motor; a Method block.
  - **Viewport**: a constant-size CoM marker with a drop line to the ground. It
    can be toggled in the view panel or with C, and is dimmed while incomplete.
  - **Live dragging**: everything follows a gizmo drag before release.
- The ESLint config now ignores `.claude/**`. The parallel sessions' worktrees live
  there and broke `eslint .`.

**Verified** (`npm run test:all`, exit 0)
- Rust: 11 tests. Typecheck and lint clean.
- vitest: 205 tests, 20 of them new, against hand calculations written out in the
  tests:
  - box, cylinder and propeller inertia;
  - a rotated part, including the 45° product of inertia;
  - a battery moved 30 mm (exact CoM shift, ΔIzz and Ixz);
  - a mass change;
  - missing masses;
  - quad hover shares 1 ± d/a and the infeasible case;
  - the frame mass split;
  - thrust points (with a prop and with a tilted mount);
  - detaching leaves the mass properties unchanged.
- Playwright: 35 tests, 1 new. With a 300 g frame and a 500 g battery, moving the
  battery 40 mm forward puts the CoM at 25.0 mm and gives hover shares of
  1 ± 25/a. A warning appears and clears with the margin, undo restores the CoM,
  C toggles the marker, and the frame mass survives a restart. No console errors.
  Performance: 59.3 fps at 1080p and 38.1 fps at 4K, with 50 parts.
## 2026-11-21 — Phase 3, milestone 3.8: hardening and docs (Phase 3 done)

**Performance** (`tests/e2e/phase3-performance.spec.ts`)
- **Set-up**:
  - a library of 200 components (the built-ins plus test-only user entries);
  - an Octo X with 85 parts: battery, PM02 V3, Pixhawk 6C, 40 Tekko32 45A ESCs,
    40 MN3110 KV700 (8 on the mounts), GPS and radio;
  - auto-wire gives 100 wires. This is not a sensible drone: it is sized to load
    the wiring, checks and calculations.
- **Method**: each action is dispatched inside the page and timed to the first
  animation frame that shows its result. Pan and zoom are real mouse input,
  measured as frame intervals. 1920×1080, background throttling off.
- **Limits**:
  - 250 ms per interaction;
  - 3 s to open a page;
  - 33 ms median frame while panning or zooming;
  - 500 ms to select a part in the workshop (see the follow-up below).
- **Measured** (two runs after the fixes):

  | | Before 3.8 | After |
  |---|---|---|
  | Components: open with 200 rows | 100–185 ms | 107–134 ms |
  | Search / category filter / show all | 6–85 ms | 5–69 ms |
  | Select a component (detail) | 25–48 ms | 25–26 ms |
  | Electrical Designer: open (85 boxes) | 192–297 ms | 149–185 ms |
  | Auto-wire (100 wires) | 150–271 ms | 140–171 ms |
  | Select a wire (list / schematic) | **110–190 ms** | 20–30 ms |
  | Select a box | **110–193 ms** | 37–46 ms |
  | Open the Calculations drawer | 77–166 ms | 69–80 ms |
  | Recalculate at 60 °C | 9–17 ms | 9–14 ms |
  | Move a cable → port conflict shown | 49–115 ms | 50–63 ms |
  | Undo → conflict cleared | 125–174 ms | 95–108 ms |
  | Pan / zoom, median frame | 16.6 / 16.7 ms | 16.6 / 16.7 ms (p95 16.9 / 33–50 ms) |
  | Workshop: checks listed (25 findings) | 231–248 ms | 202–255 ms |
  | Workshop: click a finding (selects Battery 1) | 221–290 ms | 201–265 ms |
  | Workshop: same part from the tree, for comparison | 197 ms | 94–123 ms |

**Bottlenecks fixed**
- **Selection in the Electrical Designer re-rendered the whole schematic.**
  - Cause: boxes and cables were rebuilt whenever the selection changed, so
    React Flow re-rendered all 85 boxes (about 400 port handles) and 100 cables.
    A CPU profile showed the time in React's commit, `HandleComponent` and
    `NodeWrapper`.
  - Fix: boxes and cables are now built from the document only. A selection
    replaces just the selected item, and the box component is memoised.
  - Also: ports are looked up from one index per parts list, not rebuilt per wire
    and per label. The Calculations drawer and the checks list are memoised, with
    stable callbacks.
- **Super-linear work in the domain modules** (`src/domain/wiring.ts`,
  `electrical.ts`), measured at the schema maximum of 2000 wires:
  - the wiring checks and the ESC pairing scanned every wire for every port. They
    now use `wireIndex`, built in one pass. At 100 wires the checks took 1.3 ms
    before the fix;
  - `calculate` copied the adjacency list once per cable (a power module feeding n
    ESCs is O(n²)), dequeued with `shift()`, built the ports once per wire end, and
    searched the ESC results once per motor. It took 105 ms at 2000 wires before
    and takes 36–50 ms after, run alone. The checks take 18–24 ms and the ESC
    pairing 4–7 ms;
  - unit tests: the index lists the same wires as a full scan at every port of the
    100-wire assembly, including a wire that loops on one port. A 2000-wire guard
    (300 ms bound) catches a return to quadratic work.
- **The checks ran twice per edit in the workshop** (once for the panel, once for
  the status strip). One result is now kept per document and shared, the designer
  included. Unit test: same document, same array; an edit or a different library,
  a new one.

**Follow-up (not fixed here; workshop code is being changed for Phase 4.1)**:
selecting the battery in the workshop takes about 0.1–0.2 s from the assembly tree.
That is the inspector and 3D view, not the checks. The first 3D canvas once took
5.6 s to appear (GPU process start); every other run took 37–84 ms.

**Acceptance list, item by item**

| Criterion | Proved by |
|---|---|
| No value stored or shown without a source; calculated values labelled with their formula | `seed.test.ts` (every built-in value cited, allowed hosts); `components.test.ts` (manufacturer value without source or date refused); `components.spec.ts` (source and link shown per value); `checks.test.ts` battery-current ("calculated: 20 C × 1000 mAh"); calculation tooltips carry the formula |
| Every check has passing and failing inputs, and says "cannot check" when data is missing | `checks.test.ts`: a new coverage table, one row per rule with pass, fail and cannot-check inputs (it fails if a rule is added without a row); `wiring.test.ts` for the four wiring rules. **Gap found and fixed**: prop-bore and prop-hand were silent for unlinked parts, and prop-hand for a propeller that states no hand (the APC 10x4.5MR). Both now report "cannot check" with the reason. |
| e2e across a restart: hex from library parts, auto-wire, zero errors, out-of-rating battery → error, fix → zero errors | **Was split** across `electrical.spec.ts` (auto-wire, restart) and `checks.spec.ts` (a quad, no restart). **New** `phase3-acceptance.spec.ts`: 23 parts linked in the workshop UI, 22 wires from auto-wire, no errors in either view; an 8S test pack gives two battery-cells errors (ESCs and motors, 6S max) that survive a restart; the 4S Tattu clears them, and that survives another restart |
| Electrical results match hand calculations within 0.1 % | `electrical.test.ts` (hand calculations written in the file) |
| JSON packs round-trip exactly; bad packs refused with reasons | `component-library.test.ts`: **new** byte-identical export → import → export of every built-in record; refusals for bad JSON, format, version, size (10 MB), entry count (5000), each bad entry named (first five listed); `components.spec.ts` through the UI |
| Undo/redo covers linking, wiring and component edits in a project | `links.spec.ts` (link, unlink, undo); `electrical.spec.ts` (moving a cable, undo); `acceptance.spec.ts` (every workshop edit kind, back to empty and forward) |
| Phase 1–2 suites pass; no console errors; typecheck and lint clean | `npm run test:all`; every Phase 3 e2e asserts no console errors |

**Docs**
- [ADR 0007](adr/0007-component-provenance.md): values are stored as stated, with
  their source, and converted only where they are used.
- [ADR 0008](adr/0008-pure-domain-modules.md): the domain-module boundary, now
  enforced by ESLint. `src/domain/**` may import other domain modules and IPC
  types only.
- 0005 and 0006 are left to Phase 4.
- `ARCHITECTURE.md`: the provenance sources were listed wrongly ("estimated";
  it is "measured").
- ROADMAP: Phase 3 done and awaiting review; Phase 4 in progress.

**Verified** (`npm run test:all`, exit 0)
- `cargo test`: 11 passed. Typecheck and lint are clean, including the new
  domain-boundary rule.
- `vitest`: 193 passed, 8 new:
  - the rule coverage table;
  - cannot-check for prop-bore and prop-hand;
  - a passing prop-frame case;
  - the shared findings cache;
  - the wire index against a full scan;
  - the 2000-wire guard;
  - the byte-exact pack round-trip;
  - the pack size and entry-count refusals.
- `playwright`: 36 passed, 2 new (the Phase 3 acceptance hex, the Phase 3
  performance test). In that run: designer selection 38–62 ms, undo 149 ms, pan and
  zoom 16.7 ms median, workshop checks listed in 201 ms. Phase 2 orbit: 59.3 fps at
  1080p and 40.7 fps at 4K.
## 2026-11-21 — Workshop realism: frame, parts, materials, lighting

Display only. Sizes, masses and every check still use the part envelopes and the
frame's stated parameters, so no engineering value changed.

**Built**
- **Lighting**: image-based lighting from three.js `RoomEnvironment` (generated in
  the renderer, nothing downloaded, so the CSP is unchanged), plus a key light, a
  fill light and a hemisphere light.
- **Materials** (`src/three/materials.ts`), shared by every model so the scene
  still compiles only a handful of shaders:
  - carbon fibre: a 2×2 twill weave drawn on a canvas, repeating every 12 mm,
    non-metallic with a satin clearcoat;
  - aluminium, anodized black and accent, steel, copper, plastics, PCB, gold, LEDs.
- **Frame** (`src/three/frame-shapes.ts`, `FrameModel.tsx`):
  - carbon plates and arms are extruded outlines with a 0.2 mm bevel:
    - plate: chamfered, with strap slots, lightening holes and the 30.5 mm FC
      pattern;
    - arms: tapered, with lightening slots, ending in a round motor pad with a
      shaft hole and bolt holes;
  - socket-head screws clamp the arms; four bolts on each motor pad;
  - the "Simple" display mode keeps the old boxes.
- **Parts** (`src/three/part-models.tsx`):
  - motor: base, stator with copper windings, a lathed bell with vents and band,
    shaft and prop nut;
  - propeller: twisted aerofoil blades whose pitch angle follows the stated pitch,
    θ = atan(P / 2πr), mirrored for CW, with a carbon or plastic finish taken from
    the component's material;
  - battery with label, leads, XT60 and balance plug; ESC board; flight controller
    case with ports and LEDs; GPS puck; telemetry radio; power module.

**Fixed while reviewing screenshots**
- Carbon looked white at grazing angles: metalness 0.25 and a strong clearcoat
  reflected the room lights. Carbon is now dielectric (metalness 0), with a weaker
  clearcoat, a darker weave and a lower environment intensity.
- Prop plastic was near-white and is now dark grey. The swept disc keeps a lighter
  colour so it still shows on the dark grid.
- Switching to "Simple" threw `Cannot read properties of undefined (reading
  'count')`. React reused the detailed frame's mesh for the simple box, and drei
  `<Edges>` read its geometry before the box was attached. The two branches are
  now keyed separately.

**Verified**
- `npm run test:all`: 11 Rust, 185 unit and 34 e2e tests pass; typecheck and lint
  are clean. Two e2e tests (a gizmo drag, and a dialog click with "element is not
  stable") and the 4K perf figure (1.0 fps) failed in one full run while the
  window was throttled. Re-running those four specs passed all 16 tests, with
  59.3 fps at 1080p and 42.6 fps at 4K (50 parts).
- Screenshots reviewed: overview, motor close-up, body close-up, top view.

## 2026-11-21 — Phase 3, milestone 3.7: electrical calculations

**Built**
- `src/domain/electrical.ts` (pure, steady state). The model is documented at the
  top of the file and in the designer's "Method" block:
  - **Load case**: every motor at its stated maximum current (with the stated
    condition, e.g. 180 s), or one current the user enters. Battery at nominal
    voltage or full charge. Conductor temperature 20/40/60/80 °C.
  - **Currents**: the power wiring is walked as a tree from the battery; a power
    module passes current through. Each cable carries the sum of the loads
    downstream. A loop, or two batteries in one network, is refused with a reason
    instead of an assumed split.
  - **Cables**: R = ρ(T)·2L/A (both conductors of the lead), copper ρ₂₀ = 1/58
    Ω·mm²/m and α₂₀ = 0.00393 K⁻¹ (IEC 60028, annealed copper), A from AWG
    (ASTM B258). ΔV = I·R, P = I²·R.
  - **Battery**: V = V_oc − I·R_int with the pack's stated internal resistance;
    without it the terminal voltage is shown as not specified.
  - **Voltage at each ESC** (and so each motor) = terminal voltage − the drops on
    its path.
  - **Ratings for the load case**: battery continuous discharge (C × capacity),
    power-module continuous current, ESC continuous current per output.
  - Every missing value is a dash with the reason as a tooltip, and the reasons
    are listed under "Not calculated". Nothing is guessed.
- **Calculations drawer** in the Electrical Designer (toolbar button): load-case
  controls, battery, ratings (over-rated items in red; click selects the part),
  supply per ESC, power cables (click opens the wire to set gauge and length),
  method.
- The battery's internal-resistance field now says it is the whole pack's.
- The Markdown report no longer says wiring checks are missing (they have been
  included since 3.6).

**Found with the built-in hex**: six MN3110s at their stated 21 A (180 s) draw
126 A through the PM02 V3, whose PCB is rated 60 A continuous. The drawer shows it
in red; at 8 A per motor (48 A) it is within rating. The Tattu pack states no
internal resistance and no full-charge cell voltage, so sag and "full charge" are
shown as not specified.

**Deferred**
- Wire ampacity and connector ratings: the plan wants a cited ampacity table with
  its conditions, and none has been sourced yet. Until then cables show current,
  drop and loss but no rating.
- Motor-phase cables: their current depends on commutation (Phase 4 motor model).
- The load case is a view setting and is not saved with the project.

**Verified** (`npm run test:all`, exit 0)
- `cargo test`: 11 passed. Typecheck and lint clean.
- `vitest`: 185 passed, 8 new, each against a hand calculation written out in the test
  file and matched to 0.1 %: IEC resistivity at 20 and 60 °C; 12 AWG 150 mm =
  1.56324 mΩ; a two-motor network (42 A, sag 16.8 → 15.96 V, ESC voltages 15.85954
  and 15.82475 V, total loss 40.2299 W); temperature and an entered current;
  missing values with their reasons; loops, two batteries and no battery; ratings;
  the auto-wired hex overloading the PM02.
- `playwright`: 34 passed, 1 new (auto-wired hex: 126 A, 14.80 V, PM02 over its rating;
  12 AWG 150 mm main lead → 197.0 mV, 227.9 mV at 60 °C; 8 A per motor → 48 A
  within rating; no console errors).

## 2026-11-21 — Phase 3, milestone 3.6: Electrical Designer

**Built**
- **Wiring model**
  - Migration `0007_wiring.sql` (schema v7): `assemblies.wiring_json` holds the
    wires and the schematic positions. It is saved with the assembly in the same
    transaction, so undo/redo and the stale-revision check cover wiring like any
    edit.
  - Validation: unique wire ids, both ends on existing parts, no wire from a port
    to itself, schematic entries only for existing parts, up to 2000 wires.
  - Deleting a part removes its wires and its schematic position.
  - A wire is one cable: a power lead, the three motor phases, an ESC signal, or a
    peripheral cable. It can carry a gauge (AWG), a length (mm) and a colour; all
    three stay "not set" until the user enters them.
- **Ports** (`src/domain/wiring.ts`, pure), from the part's kind and linked
  component:
  - battery: power out;
  - power module: power in and out, plus sense (analog → ADC, digital → CAN);
  - ESC: power in, plus a signal and a motor output per channel (4-in-1 = 4);
  - motor: phases;
  - flight controller: its component's listed ports by name (Pixhawk 6C: Telem1–3,
    GPS1–2, I2C, CAN1–2, DSM RC, PPM/SBUS RC, USB, Power1–2) plus "PWM 1…n" (16
    stated outputs); a generic set when unlinked;
  - peripheral: one connector of its required type.

  Only ports of the same kind connect. Power, CAN and I²C are shared buses; every
  other port takes one cable.
- **Auto-wire** (PX4 convention):
  - battery → power module → every ESC;
  - power-module sense → "Power1";
  - ESC output n → motor n, by motor-mount number, so a missing motor leaves a gap;
  - PWM n → that ESC's signal;
  - GPS → "GPS1", telemetry radio → "Telem1", RC receiver → an RC input, others →
    the first free port of their type.

  It reports what it could not wire (e.g. two batteries: series or parallel is the
  user's choice). It is one undo step, and replacing existing wiring asks first.
- **Wiring checks**, added to the Checks panel in both the workshop and the
  designer:
  - wire-port: a wire on a port the part no longer has;
  - wire-kind: a wire joining different kinds;
  - port-conflict: two cables on a point-to-point port, naming the devices;
  - unwired: once wiring has started, a battery, power-module input/output, ESC
    power, motor, used ESC output without a signal, peripheral, or flight
    controller power left unconnected.
- With wiring, the **ESC-current check pairs different ESCs with their motors**
  one by one (before, it said "cannot check").
- **Electrical Designer page** (enabled in the sidebar; lazy-loaded with
  `@xyflow/react` 12.12.1, MIT):
  - one box per electrical part, with its ports on the sides, coloured by kind;
  - drag between ports to connect (only valid pairs are accepted); Delete removes
    a cable; moving a box is saved as an undoable step;
  - the side panel has:
    - the wire inspector: either end can be moved to another port of the same
      kind, and gauge, length and colour can be set;
    - a part's ports and what is on each;
    - the checks;
    - a wire list, which keyboard users can use without the canvas;
  - Undo/redo (Ctrl+Z/Y), a save indicator, and a link to the workshop.

**Bugs found and fixed**
- The assembly store saved and loaded only frame, motors and parts, so wiring was
  silently dropped on restart (caught by the e2e restart check). It now saves the
  whole document, and loads the optional fields when present.
- Deleting the battery's cable raised no warning: "unwired" now covers batteries
  and power modules.
- Peripheral connectors were drawn on the wrong side, so cables looped backwards.
  They are now on the right side.
- The performance test measured 1 fps once. Chromium throttles a hidden or covered
  window to 1 fps, and the screen was evidently not visible during that run. The
  test now disables background throttling for its window and logs visibility.
  Measured again: 59.3 fps at 1080p, 46.6 fps at 4K, unchanged from before.

**Deviation from the plan**: wiring lives in one JSON column of the assembly rather
than separate `wires`/`wire_ends` tables, so it shares the assembly's atomic save,
revision check and undo history. Calculations in 3.7 read it from there.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 177 passed, 8 new:
  - ports per part (the Pixhawk 6C's 13 named ports plus 16 PWM, 4-in-1 channels,
    analog and CAN sense, GPS UART, none for props or unlinked payloads);
  - connection rules;
  - auto-wire on a hex (22 cables, exact pairs, passes its own checks);
  - PX4 numbering with a missing motor, and the notes;
  - port conflict naming GPS and Radio;
  - missing ports, wrong kinds, and unwired warnings only once wiring has started;
  - motor-by-motor ESC pairing through the wiring;
  - wiring edits and deletion clean-up.
- `playwright`: 33 passed, 2 new:
  - a 17-part hex: auto-wire gives 22 wires and no errors or warnings; moving the
    GPS cable to Telem1 gives the exact port-conflict error; clicking it shows the
    flight controller's ports; undo clears it; a gauge of 12 AWG and a length of
    150 mm survive a restart along with all 22 wires;
  - deleting a wire raises a warning; a second auto-wire asks before replacing 21
    wires and restores 22.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.5: compatibility checks and diagnostics

**Built**
- `src/domain/checks.ts` (pure; documented in the file). Nine rules, each with a
  one-sentence reason shown in the report:
  - **motor-count**: empty motor mounts (warning), two motors on one mount (error);
  - **battery-cells**: the battery's S against every motor's and ESC's cell range;
  - **esc-outputs**: ESC outputs (4-in-1 = 4, single = 1) against the motor count;
  - **esc-current**: ESC continuous current per motor against motor maximum current;
  - **battery-current**: C rating × capacity, labelled "calculated", against the
    sum of motor maximum currents;
  - **prop-bore**: bore against motor shaft. Smaller is an error, larger a warning
    ("adapter needed").
  - **prop-hand**: a CW/CCW propeller against its motor mount's spin ("pair" passes);
  - **prop-clearance**: swept discs at about the same height that overlap (error) or
    are less than 10 mm apart (warning). Tilted discs are compared approximately,
    and the message says so.
  - **prop-frame**: a disc reaching below the top of the frame.
- Behaviour common to all rules:
  - Only stated values are compared, in SI. Messages quote values as stated, with
    their conditions, e.g. "rated 20 A per motor, below MN3110 KV700's maximum
    21 A (Max continuous current (180 s))", or "a 0.25 in bore on the 4 mm shaft".
  - Missing data gives **cannot-check** with the reason, never a guess. Examples:
    an unlinked part; two batteries, where series or parallel is decided by the
    wiring; differing ESCs, where pairing is decided by the wiring.
  - Identical parts are grouped, so four identical motors give one message
    ("4 × 10x4.5MR … 4 × MN3110 KV700").
- `check-input.ts` builds the check input from the stored assembly (linked
  components, sizes as drawn, world positions and axes, the motor mount each part
  sits on). The exploded view is never used.
- **Checks panel** (left panel):
  - findings by severity with icons;
  - clicking a finding selects the parts involved;
  - "Copy report" copies a Markdown report with counts, findings by severity, and
    every rule with its reason.
- **Status strip**: "N errors · M warnings"; a click selects the first finding's
  parts.

**Found by the checks themselves**: 13-inch props on the default 450 mm quad
overlap by 12 mm (adjacent motors are 318 mm apart; two discs need 330 mm). My
first "clean build" test had exactly that mistake; the test now uses a 550 mm
frame for the clean case and keeps the 450 mm case as a failing one.

**Moved to later milestones (as planned)**: flight-controller port conflicts and
wire/connector ratings need the wiring graph (3.6, 3.7). The report is copied as
Markdown; there is no file export.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 169 passed, 12 new. Every rule has passing and failing cases, plus
  cannot-check cases; the report format is covered too.
- `playwright`: 31 passed, 2 new:
  - a 6S test battery with a 4S test ESC gives the exact error naming both; "1
    error" in the status strip; clicking it selects the battery; the report is on
    the clipboard; swapping in the Tattu 4S clears all errors;
  - 13" T-Motor props on a 450 mm quad give four "overlap by 12 mm" errors;
    switching to APC 10" props clears them, and the bore warning remains.
- Performance with 50 parts is unchanged (59.6 fps at 1080p). Typecheck and lint
  clean.

## 2026-11-21 — Detailed part models

Asked by the user ("where are the models of the components", then "you can use
from repo main").

**Found**: the Blaze-Simulator repository's `main` has no model files. Its parts
are built in code (`dist/scene.mjs`, `dist/pixhawk-3d.mjs`) from three.js
primitives. Its catalogue values have no sources, so they were not taken. The
permission and how it was applied are recorded in `reference-analysis.md`.

**Built**
- `src/three/part-models.tsx`: detailed procedural models after that design,
  written for this renderer (Z-up, metres):
  - motor: base flange, copper windings in the gap, bell with an accent band, vented
    cap, shaft;
  - propeller: extruded blades with coloured tips, the blade count from a linked
    component (default 2), mirrored for CW/CCW from the motor mount the prop
    sits on, a prop-adapter hub and a faint swept disc;
  - battery: pack with wrap label and end caps;
  - ESC: PCB, MOSFETs, solder pads;
  - flight controller: Pixhawk-style case with lip, forward arrow, screws, LEDs,
    and one port socket per port of a linked component;
  - payload: an electronics module.

  Custom parts and imported models are unchanged.
- **Every model fills its part's envelope exactly**: the motor's sections add up
  to its height, the blades stay inside the disc, the boxes stay inside L × W × H.
  A linked MN3110 is still exactly Φ37.7 × 28.5 mm. Sizes, bounds, snapping and
  the size readout still use the envelope.
- An invisible envelope takes the clicks (thin blades are hard to hit) and shows
  the selection outline. The measure tool skips it and measures the visible
  surfaces.
- View panel "Parts: Detailed | Simple" (remembered); Simple draws the plain
  envelope shapes as before.

**Found in screenshots and fixed**:
- one blade colour vanished against the dark background (both blades are now one
  light colour with orange tips);
- the hub was as wide as the motor top (now about a prop-adapter size);
- the motor band z-fought with the bell (now 0.6 % proud of it).

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 157 passed.
- `playwright`: 29 passed, 1 new: Detailed by default, Simple on request,
  dimensions unchanged in both, remembered after a restart.
- Performance with 50 parts is unchanged: 59.2 fps at 1080p, 46.0 fps at 4K.
- Typecheck and lint clean; no console errors in the screenshot runs.

## 2026-11-21 — Phase 3, milestone 3.4: linking parts to components

**Built**
- A part can be linked to a library component (`componentId`; migration
  `0006_part_components.sql`, schema v6).
  - The link is stored, not the values. The part keeps its own shape and mass, and
    `links.ts` (pure) works out what to show:
    - motor: body diameter × body length → cylinder;
    - propeller: diameter → swept disc, keeping the part's disc thickness;
    - battery, ESC, flight controller, power module, peripheral: length × width ×
      height → box along the part's X, Y, Z;
    - the stated mass, converted to kg (e.g. 0.53 oz → 15.0 g);
    - imported models keep their mesh and take only the mass.
  - When a component does not state enough, the part's own value is used and the
    UI says so.
  - Unlinking or undo therefore restores the part's own values exactly, and a
    corrected built-in record shows up in every project that uses it.
- **Inspector**: a "Component" row offers only fitting categories:
  - motor → motors;
  - payload → peripherals and power modules;
  - custom → everything.

  While linked:
  - size and mass are read-only and show their condition, source and citation
    link;
  - the part's own mass is shown as "kept for when you unlink";
  - changing the part kind to one the link does not fit removes the link in the
    same undo step.
- Linked sizes are used everywhere a size matters: drawing, the size readout,
  dimensions, bounds and fit, resting a part on a linked part (a prop on a linked
  MN3110 sits on its stated 28.5 mm), mount snapping, and "without mass" in the
  tree and status strip.
- **Storage rules**:
  - a save that links to a component that no longer exists is refused;
  - a component in use cannot be deleted. The message names the projects, e.g.
    'Used by 1 part in "In-use quad". Unlink it in the workshop first.' (also an
    SQLite `ON DELETE RESTRICT`).
- **Built-in data**: new size fields (motor body diameter/length; length/width/
  height for ESCs, flight controllers, power modules and peripherals). 30 cited
  sizes were added to 10 built-ins from the pages already read, for example
  Pixhawk 6C "84.8 * 44 * 12.4 mm" and MN3110 "Φ37.7×28.5mm".
  - They were checked against the live pages: every stated dimension string
    matched.
  - The seed is now version 2 (177 values). Existing installs pick the new values
    up through the in-place update from 3.3.
- Refused deletes close the confirmation dialog so the reason is visible.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 157 passed, 6 new:
  - sizes by category (MN3110 → Φ37.7 × 28.5 mm, APC 10" → 127 mm radius, Tattu →
    133 × 45 × 33.5 mm, Pixhawk → box);
  - GPS (no size) and imported models keep their own shape;
  - mass conversion and fallbacks;
  - display-only resolution (the stored document is unchanged);
  - a prop resting on a linked motor;
  - category filtering;
  - a save with a missing link refused;
  - deleting an in-use component refused, with the exact message.
- `playwright`: 28 passed, 2 new:
  - link a motor: 37.7 × 37.7 × 28.5 mm and 99 g with "Manufacturer" and T-Motor's
    URL; "without mass" disappears; a prop added on it sits at 18.3 mm; unlink
    restores 28 × 28 × 30 mm and an empty mass; Ctrl+Z re-links; still linked
    after a restart;
  - deleting a linked copy is refused with its reason, and the dialog closes.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.3: built-in components with sources

**Built**
- `database/seed/components.v1.json`: 20 built-in components (147 values) in the
  pack format, with fixed ids (UUID v5).
  - Every value is `source: manufacturer`, with the page URL, the section, the
    date read (2026-11-21) and, where the page qualifies the value, a condition
    (e.g. "Max continuous current (180 s)", "±20 g", "aluminium case").
  - Values were read in the browser on the manufacturer's own pages during this
    milestone, not recalled.
- `electron/main/components/seed.ts` loads them at each start:
  - it adds missing ones as read-only built-ins;
  - it updates a built-in in place when the seed is corrected (new
    `replaceBuiltIn`, revision bumped);
  - it never touches user records (including a user record that holds a seed id);
  - it never deletes built-ins dropped from the seed;
  - the seed goes through the same validation as any import.
- New fields, so values could be stored exactly as stated instead of converted:
  - power modules: cell range (pages state "2~12S", not volts);
  - peripherals: supply voltage min/max/single and supply current;
  - batteries: nominal pack voltage;
  - motor test tables: an RPM column (new `rpm` unit).

**Sources**

| Part(s) | Page |
|---|---|
| Holybro Pixhawk 6C (processor, max input 6 V, 16 PWM outputs, 59.3 g aluminium case, 13 ports with names and types) | docs.holybro.com technical specification and ports pages |
| Holybro PM02 V3, PM06 V2, PM08-CAN (cells, continuous/burst current, sensing, 5.2 V/3 A output, mass) | docs.holybro.com power module comparison |
| Holybro M10 and M9N GPS (4.7–5.2 V, < 200 mA at 5 V, 36.8 g V2) | docs.holybro.com standard M10/M9N/M8N overview |
| Holybro SiK Telemetry Radio V3 100 mW and 1 W | docs.holybro.com SiK radio V3 |
| T-Motor MN3110 KV470 / KV700 / KV780 (Kv, 3–6S, 180 s max current and power, internal resistance, idle current at 10 V, mass, stator, shaft, and 25–30 test rows each) | store.tmotor.com MN3110, Specifications tab |
| Holybro Tekko32 F4 4in1 50A and Tekko32 F4 45A ESCs | holybro.com product pages |
| T-Motor P13×4.4 and P15×5 CF propellers | store.tmotor.com product pages, Specifications tab |
| APC 10×4.5MR, 11×4.5MR, 12×4.5MR | apcprop.com product pages |
| Tattu G-Tech 5200 mAh 4S 35C, Gens ace Adventure 3600 mAh 4S 60C | genstattu.com (Tattu and Gens ace's official store) |

**Verification of the data**
- T-Motor's test tables were extracted from the page's HTML, not retyped. The
  stored rows were re-extracted from the live page, and the SHA-256 of both
  matched (`4ade8287…`).
- An automated spot check fetched every cited page and searched for every cited
  number. 124 numbers were checked:
  - 121 appear verbatim;
  - 3 are APC's "1/4 in." bores, stored as 0.25 in with the original wording in
    the condition.

  Each MN3110 value was checked inside its own Kv table.
- Text values (processor, port names, protocols, mounting) were read by hand.
- Unit test: in every test row, power = voltage × current (±0.011 W). This holds
  for all 80 rows, which catches transposed digits.

**Honest gaps**
- Ambiguous values are stored with the page's own words, not reinterpreted:
  - Tekko32 45A: the page only says "45A designed";
  - Gens ace 3600: "60C" is only in the product title;
  - T-Motor prop mass is labelled "Weight (Single Blade)".
- Left out because the manufacturer page has no figures:
  - Holybro's X500 V2 kit motor (2216 KV920) and its 20 A ESC;
  - T-Motor's AIR 20A ESC: its rating is only in the product name, with no
    continuous/burst figure.
- No wire or connector records yet. Wire resistance comes from the AWG standard
  in 3.7; connector ratings still need a manufacturer datasheet that can be read.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 151 passed, 6 new:
  - loads once, idempotent on restart;
  - 15–25 parts across all main categories;
  - every value cited from an https manufacturer page (allow-listed hosts) with a
    date;
  - test-table consistency;
  - unique fixed ids;
  - corrections update in place without touching user copies or user records.
- `playwright`: 26 passed. The library e2e test now starts with the 20 built-ins:
  - Pixhawk 6C is read-only, shows 16 PWM outputs linked to Holybro's page, and
    lists Telem1 (UART);
  - the user-component flow works alongside the built-ins.
- Typecheck and lint clean.

## 2026-11-21 — Phase 3, milestone 3.2: component library page

**Built**
- **Components page** (enabled in the sidebar; Electrical Designer stays disabled
  until 3.6). Sections of the phase in progress are now enabled one by one with a
  `ready` flag. The disabled-section e2e check moved to Engineering Analysis.
- **List**:
  - search (name, manufacturer, category, notes) and category filters with counts;
  - columns for category, values ("6 · 4 cited") and origin;
  - empty states that say what to do.
- **Detail**: every field of the category, in order.
  - A set value shows its value and unit, any condition, its source (Manufacturer /
    Measured / Entered by you) and the citation (host · page · date read), linked
    to the source URL (opens in the system browser).
  - Unset fields read "not specified".
  - Manufacturer test tables are shown as a table with their units.
  - Edit and Delete are disabled for built-in records, with the reason.
- **Editor** (dialog, built from the field definitions):
  - name, manufacturer and notes, plus each field with value, unit (only units of
    that dimension), source and, when cited, source URL or document title,
    page/section, date read (today by default) and condition;
  - port lists and table rows can be added and removed;
  - a value without a chosen source is refused in the form;
  - main's messages (which name the field) are listed when a save is refused.
- **Packs** (`electron/main/components/pack.ts`): JSON format
  `blaze-uav.components` v1.
  - Export all, the filtered list, or one component, through a Save dialog.
  - Import through an Open dialog, all or nothing: every entry is validated with
    the same schema as an edit, so the citation rules apply to imports. Problems
    are listed per entry and field (first five shown).
  - Entries whose id already exists are skipped, so re-importing adds nothing.
  - Limits: 10 MB, 5000 entries.
- Editor form logic (`editor-model.ts`) and display helpers (`spec-format.ts`) are
  pure and unit tested.

**Found and fixed during the screenshot check**: the editor scrolled sideways. A
`<fieldset>` cannot shrink below its content's width by default, and the
thrust-table editor is wide. With `min-w-0` the table scrolls inside its own box.
Field hints now show under the field name instead of as the "Condition"
placeholder.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 145 passed, 12 new:
  - export → delete → import identical (ids, values, sources), with re-import
    skipping everything;
  - entries without ids;
  - refusals: not JSON, wrong format, newer version, duplicate ids, and a mixed
    pack (an uncited manufacturer value, a wrong unit, a non-object), with
    nothing imported;
  - editor round trip of a stored component;
  - the "choose a source" and number errors;
  - references, ports and tables;
  - strict number parsing;
  - display formatting.
- `playwright`: 26 passed, 1 new:
  - create a motor through the editor, refused first for a value without a
    source and then for a manufacturer value without a URL;
  - the detail view shows the sources and the link;
  - edit, duplicate, search, filter;
  - export (2), delete both;
  - a malformed pack and a non-JSON file are refused with their messages;
  - import: the values and sources match the originals exactly;
  - persists after a restart.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.1: component model and storage

**Built**
- `src/domain/units.ts`: a pure units module shared by main and the renderer. It
  covers 13 dimensions and conversion to and from SI. The exact definitions are
  documented in the file:
  - inch, ounce;
  - Ah, mAh;
  - Kv (rpm/V → rad/(s·V));
  - C rating (current = rate × charge);
  - gram-force (standard gravity);
  - °C;
  - AWG via ASTM B258, d = 0.127 mm × 92^((36 − n)/39).
- `electron/ipc/component-fields.ts`: nine categories and their fields, as plain
  data:
  - motor, propeller, battery, ESC, flight controller, power module, peripheral,
    wire, connector;
  - field kinds: quantity with unit, whole number, text, choice, port list, and a
    table with one unit per column (for manufacturer thrust tests);
  - every field is optional.

  The renderer will build forms from this, and main builds validation from it.
- Provenance on every value: `source` (manufacturer / measured / user), a
  `reference` (URL or document, locator, retrieval date) and an optional
  `condition`.
- `electron/ipc/component-schemas.ts`: zod schemas generated from the field table.
  Refused, with messages that name the field (e.g. "Kv: Unit must be one of
  rpm/V"):
  - a manufacturer value without a URL or document title, or without the date it
    was read;
  - non-http(s) URLs;
  - wrong units and negative values;
  - non-whole counts;
  - fields from another category;
  - duplicate port names;
  - min > max (compared in SI, so 4500 mV vs 5.5 V works);
  - malformed tables.
- Migration `0005_component_library.sql` (schema v5): `components` gains `origin`
  (built-in / user / imported), `schema_version`, `revision` and `notes`, plus a
  category + name index.
- Repository and IPC: list (optionally by category), get, create, update,
  delete and duplicate.
  - Updates use the same stale-revision rejection as assemblies, and a component
    cannot change category.
  - Built-in records are read-only. Duplicate makes an editable user copy that
    keeps every value's provenance.

**Deviation from the plan**: values are stored as the source states them (e.g.
"1300 mAh", "5 in"), not converted to SI. This way a stored value can be compared
with its datasheet directly. Checks convert with `toSI`. The links from parts to
components and the wiring tables will come in their own migrations (3.4 and 3.6),
when they are used.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 133 passed, 21 new:
  - exact unit definitions, a C rating × capacity example, and AWG against
    standard values (12 AWG = 3.309 mm², 20 AWG = 0.5176 mm²) with round trips;
  - field-table integrity;
  - an exact IPC round trip;
  - the citation rule;
  - nine refusal cases with their messages;
  - thrust tables, ports, cross-unit voltage ranges;
  - stale updates, category changes, read-only built-ins and duplication.
- `playwright`: 25 passed (no UI yet; the library page is milestone 3.2).
- Typecheck and lint clean.

## 2026-11-21 — Phase 2, milestones 2.6–2.7: inspection, building tools, hardening

Scope revised with the user before starting: four gaps against the approved plan
were added (fit including parts, drag onto a mount, gizmo hidden by parts, status
strip), plus three tools the user asked for (copy to all motor mounts, image
export, measure).

**Built**
- Inspection maths (`inspection.ts`, pure and unit tested):
  - world matrices of all parts in one pass;
  - part and assembly bounds;
  - exploded-view offsets;
  - status counts;
  - mount snapping;
  - measurement.
- **Exploded view** (X, or the toolbar toggle and its spread slider):
  - parts on motor mounts move out along their arm, parts on plates move away from
    the plate, free parts move outward from the centre (or up when near it), and
    each stacked level lifts by the same distance;
  - full spread = 0.3 × the motor diagonal;
  - display only: the gizmo is off while it is shown, so offsets can never be saved.
- **Dimension overlay**: X/Y/Z extent lines on the selected part, in its own axes
  and drawn over everything, with constant-size mm labels that follow exploded
  positions.
- **Connection markers**: a constant-size dot on every mount while a part is
  selected. The current mount is filled, and the drag target is enlarged. They
  never take clicks: an earlier clickable version covered the gizmo's centre
  handle (caught by the drag e2e test), so attaching is by drag or "Attached to".
- **Drag onto a mount**: while moving with snapping on, a mount within 15 mm
  sideways (and within the part's half height + 15 mm vertically) lights up.
  Releasing attaches the part there. This is one undo step, and a release elsewhere
  is a normal move.
- **Fit**: F frames the selected part, or the whole assembly including parts when
  nothing is selected. Automatic re-framing uses the assembly bounds.
- **Gizmo**: drawn last (render order), so parts no longer hide it.
- **Status strip**: part count, plus "unattached", "without mass" and "model
  warning(s)" buttons; each selects the first matching part.
- **Copy to all motor mounts** (inspector button for a part on a motor mount):
  - copies the part and everything attached to it onto every motor mount without
    a part of that kind;
  - poses are kept relative to each mount (so copies follow motor tilt);
  - one undo step.
- **Save image of the view** (toolbar):
  - renders one frame at ≥ 2× device pixels without the gizmo, and encodes it as
    PNG in the renderer;
  - main validates the bytes (`viewport:savePng`: PNG signature, ≤ 50 MB), shows a
    Save dialog proposing a safe file name in Pictures, and writes the file.
- **Measure tool** (M):
  - two clicks on any surface; with snapping on, a click snaps to the nearest mesh
    vertex within 8 px;
  - the amber line and label show the distance, and the status strip shows
    distance and ΔX/ΔY/ΔZ in mm;
  - Esc clears the measurement, a second Esc leaves the tool;
  - labels let clicks through while measuring, and nothing is selected or saved.
- Narrow layouts: below a 640 px toolbar, Persp/Ortho and Grid hide (P and G still
  work), like the presets.
- Shortcuts also work while the explode slider has focus (its arrow keys stay its
  own).
- ADRs: 0003 (Z-up renderer) and 0004 (asset store and protocol).

**Real exports**: Blender 4.2.3 was found on this machine.
`tests/fixtures/blender/make_fixtures.py` builds a 100 × 60 × 50 mm camera pod and
exports it three ways:
- default GLB: accepted, 100 × 60 × 50 mm at the glTF defaults (m, +Y up), and
  loads;
- "glTF Separate" (.gltf + .bin): refused, naming `pod-separate.bin`;
- Draco GLB: refused.

**Performance** (this machine, `tests/e2e/performance.spec.ts`, 50 parts including
the Blender model, orbiting for about 2 s):

| Size | Rendered fps | Frame median | p95 |
|---|---|---|---|
| 1920×1080 | 59.8 | 16.6 ms | 16.7 ms |
| 3840×2160 | 42.6 | 16.9 ms | 33.5 ms |

The idle viewport rendered 0 frames over 1 s after the camera settled. The test
fails if the 1080p median falls below 50 fps.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 112 passed, 11 new:
  - bounds through all attachment kinds;
  - exploded offsets per attachment kind, with the saved doc unchanged;
  - status counts;
  - snap rule (sideways, height, current mount excluded, top vs bottom plate);
  - copy to mounts (hex, with a tilted mount);
  - PNG validation and safe file names (including `../`, reserved names and
    control characters);
  - measurement and vertex snapping;
  - the Blender exports.
- `playwright`: 25 passed, 8 new:
  - status strip, dimensions, markers, fit and exploded view (saved positions and
    save state unchanged);
  - drag onto the motor 1 marker (highlight halfway: no, at the marker: yes);
  - copy to mounts on a hex;
  - PNG export (≥ 2× size, PNG signature, proposed name);
  - measure (450.0 mm between motor pads, ΔZ 0);
  - **hex acceptance**: 6 motors and 6 propellers, two spins reversed, and the
    Blender GLB under the bottom plate. After a restart the stored assembly is
    deep-equal and the model loads.
  - **every edit kind** (frame, spin, tilt, add, nudge, rotate, resize, mass,
    rename, copy to mounts, duplicate, attach, detach, delete, import, model
    units): undone back to the empty assembly (stored state equals the initial
    one), then redone (equals the final one);
  - performance.
- Typecheck and lint clean; no console errors in any of these flows.

**Decided not to do**: splitting the 1.2 MB workshop chunk further. It already
loads only with the workshop, from local disk, so more files would not be
measurably faster.

**Known limits**
- Saved images contain the 3D scene only; the DOM labels (motor numbers,
  dimensions) are not in the PNG.
- Copies on other motor mounts keep the same orientation in the mount frame (no
  per-arm yaw), which suits round parts but not, for example, an ESC aligned to
  its arm.
- Exploded view and the measure tool are not saved by design.

## 2026-11-21 — Phase 2, milestone 2.5: model import (GLB / glTF)

**Built**
- `electron/main/assets/gltf.ts` (pure validator, main only). Accepts `.glb` and
  self-contained `.gltf` (glTF 2.0). Rejects with a message meant for the user:
  - files over 50 MB, checked from the file size before reading;
  - a wrong GLB signature, or a truncated container;
  - glTF versions other than 2.x;
  - buffers or images referencing another file or a URL (only `data:` URIs and
    GLB buffer views are allowed);
  - Draco, meshopt and KTX2 compression (no decoders are bundled);
  - files with no meshes, broken node references or node loops.
  It also computes the triangle count and the default scene's bounds. Bounds come
  from POSITION accessor min/max, which glTF 2.0 requires, transformed through the
  node hierarchy.
- Asset store (`electron/main/assets/store.ts`):
  - Files are copied to `<userData>/assets/<sha256>.<glb|gltf>`; identical bytes
    are stored once.
  - Migration `0004_assets.sql` (schema v4) records the file name, format, size,
    triangle count and bounds.
  - At startup, assets no part uses are deleted (row and file). Undo history does
    not survive a restart, so nothing that could still be redone is lost.
- `blaze-asset://model/<sha256>` protocol: privileged, fetch-capable, and serves
  only exact 64-hex ids from the store folder. The CSP `connect-src` now allows
  `blaze-asset:`, plus `blob:`/`data:`, which three.js uses for embedded textures.
- Import flow:
  - "Import model (.glb, .gltf)…" in the Add part panel. Main shows the native
    file dialog and validates the file.
  - An options dialog then asks for the file's units (m / mm / in) and up axis
    (+Y glTF, +Z CAD), and the part kind. It shows a live X × Y × Z size preview,
    flags sizes above 3 m or below 1 mm ("Check the units"), and warns above
    500,000 triangles.
  - The import is one undoable edit, and the part rests on the selected mount or
    part like any other part.
- Placement maths (`src/three/model-units.ts`, documented in the file): centre the
  file's bounding box on the part origin, rotate +90° about X for Y-up files (file
  +Y → world +Z, file +Z → world −Y), then scale by metres per unit (inch =
  0.0254 m exactly).
- Rendering:
  - three's `GLTFLoader` through `useLoader`, with each part getting its own clone.
  - While a model loads, or if it fails to load, its bounding box is drawn instead,
    so the part stays visible and selectable.
  - The selected model shows its box outline.
- Inspector for model parts: file name, units, up axis, display status
  ("Shown · N triangles", or the load error) and a size readout. The size readout
  now appears for every shape.

**Deviation from the plan**: units and up axis are stored per part (in its
shape) instead of per asset, so the same file can be used at different scales and
a wrong unit can be corrected later with undo. The `assets` table therefore holds
only facts about the file.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 101 passed, 13 new:
  - bounds through node translation, rotation and scale;
  - every rejection case above, including `../` and URL buffers and a `file:///`
    image;
  - content-addressed storage and dedupe;
  - a sparse 50 MB+ file refused without reading it;
  - protocol URL resolution refusing traversal, unknown ids, uppercase ids and
    other hosts;
  - saves referencing an unknown asset rejected;
  - garbage collection after a project is deleted;
  - unit and up-axis maths checked against the three.js quaternion;
  - model parts resting on a mount.
- `playwright`: 17 passed, 2 new:
  - Import a 100 × 20 × 50 (Y-up, mm) GLB. The preview is 100000 mm in metres,
    with a units warning, then 100 × 50 × 20 mm in millimetres. The model loads
    (12 triangles) and rests at z = 14 mm. Undo/redo of the import and of a unit
    change both work, it is identical after a restart, and there are no console
    errors.
  - An external-reference `.gltf` and a text file renamed `.glb` are both refused
    with their messages, and no part is added.
- Typecheck and lint clean.
- Screenshot check: an 80 mm-tall Y-up box stands upright on the motor 1 mount.

**Notes**: test fixtures are generated in code (`tests/fixtures/gltf.ts`), so no
third-party model files are in the repository. Real-world exporter files (Blender,
Fusion, Onshape) have not been tried yet.

## 2026-11-20 — Phase 2, milestone 2.4: parts and editing

**Built**
- Attachment model (`assembly-ops.ts`, pure). A part is free (world pose), on a
  frame mount (pose relative to the mount; follows frame size and motor tilt;
  `plate-bottom` faces down), or on another part (pose relative to it). Operations:
  add, delete (with everything attached), duplicate (subtree with fresh ids and the
  next free names), attach (rests the part on its new target), detach (keeps the
  world pose), and quaternion ↔ XYZ-degree conversion. Attaching a part to its own
  subtree is refused.
- Seven part kinds start with placeholder shapes (box or cylinder; propellers as
  their swept disc) and **no mass**. The UI says so; nothing is presented as a
  product specification.
- Viewport: parts render inside their mount/parent frames. Click to select; the
  drei `TransformControls` gizmo moves or rotates the selected part with 5 mm / 15°
  snapping (toggle with S). One drag is one undo step.
- Left panel: "Add part" library (adds to the selected mount or part, otherwise on
  top of the frame) and an Assembly tree grouped by mount, with attached parts
  nested and "no mass" flagged. Right panel: Part inspector with name, kind,
  attached-to (frame mounts and valid parts only), box/cylinder shape and size in
  mm, position (mm) and rotation (°) relative to the attachment, optional mass in g
  (stored with `source: 'user'`), Duplicate, and Delete (shows how many attached
  parts go with it).
- Keyboard: W move, E rotate, S snap, arrows/PgUp/PgDn nudge (5 mm, or 1 mm with
  snap off), Ctrl+D duplicate, Del delete, Esc deselect. Existing undo/redo covers
  all of it.
- Shared `NumberField` component (commit on Enter/blur, Esc reverts, reasons for
  invalid values).

**Verified**: `cargo test` 11, `vitest` 88 (7 new: placement on mount/part/frame,
cascade delete, subtree duplicate, loop refusal, detach keeping the world pose
through a 20° motor tilt, bottom-plate orientation, Euler round-trips),
`playwright` 15 (2 new: a full library/tree/inspector/keyboard flow with
persistence across restart; and a real mouse click in the 3D view that selects a
part, followed by a gizmo drag that moves it, snapped to 5 mm, with undo
available). Typecheck and lint clean, and no console errors in the parts flow.

**Notes**: the gizmo is not drawn above parts that hide it (three.js
`TransformControls` default). Model (GLB) parts render nothing until milestone 2.5.

## 2026-11-20 — Phase 2, milestone 2.3: parametric frame and motor mounts

**Source check**: motor numbering, positions and default spin were taken from
PX4-Autopilot v1.13.3 `src/lib/mixer/MultirotorMixer/geometries/{quad_x,hex_x,octa_x}.toml`
(fetched and read, not recalled). PX4's body y axis points right, so it is negated
for our y-left world. Spin is as seen from above. PX4 v1.14+ configures geometry
through control-allocation parameters instead; that numbering has not been checked
here.

**Built**
- `src/three/frame-geometry.ts` (pure): `buildFrame(layout, params, overrides)` →
  motor mount points (arm tip, top face; id `motor-n`, PX4 name, arm angle, spin,
  tilt, default spin, customised flag), plate top/bottom mounts, arm boxes and
  framing bounds. The frame sits on the ground plane: z ∈ [0, arm thickness].
- Migration `0003_motor_mounts.sql` (schema v3): `motors_json` holds per-motor
  overrides. Only motors that differ from the PX4 default are stored; resetting
  removes the entry. Validation: keys `motor-1`…`motor-8`, spin `cw`/`ccw`,
  tilt within ±30° (about the arm axis).
- Viewport draws the centre plate, arms (with edges), mount pads and spin arrows
  (270° arc, follows the tilt). The camera re-frames when the frame's size changes
  until the user moves it.
- Motor labels ("1 · CCW") are DOM buttons in an overlay, positioned by a projector
  inside the canvas (`screen-labels.tsx`). They stay a constant size and render on
  demand. This replaces drei `<Html>`, which dropped the first label under React 19
  StrictMode.
- Project panel: motor list in PX4 order (customised motors in amber). View
  panel: Motor inspector with mount name, position, arm angle, CW/CCW toggle, tilt
  in degrees, the PX4 default, and Reset. All edits go through undo/redo and the
  save. Esc or a click on empty space clears the selection.

**Bugs found and fixed**: the status strip could report "Top view" while a newly
opened project showed iso (the camera rig ignored the stored preset); the motor
selection carried over between projects.

**Verified**: `cargo test` 11, `vitest` 81 (16 geometry: every motor of all three
layouts within 0.01 mm of the PX4 unit vectors × half-diagonal, opposite motors
exactly one diagonal apart, X orientation, PX4 quad order and spins, CW/CCW
balance, overrides, bounds, plate mounts; plus storage, migration and validation of
overrides), `playwright` 13 (2 new: every layout's labels and default spins; spin
and tilt edit, undo, the ±30° limit, geometry following the diagonal, persistence,
reset). Typecheck and lint clean.

## 2026-11-20 — Phase 2, milestone 2.2: assembly model, saving, undo/redo

**Built**
- Migration `0002_assembly.sql` (schema v2): `assemblies` (one per project: revision,
  frame parameters) and `assembly_parts` (kind, shape, parent and mount, position,
  quaternion, optional mass with source). The parent foreign key is deferred, so a
  whole assembly can be written in any order. Everything is deleted with its project.
- Repository `assemblies.load` creates the assembly with starting frame values per
  layout on first open. `assemblies.save` replaces the document atomically, bumps the
  revision and the project's modified time, and throws `ConflictError` if the edit
  was based on an older revision.
- IPC `assembly:load`, `assembly:save`, plus `assembly:saveSync` (same handler,
  blocking), which is used only while a window unloads. zod validation covers frame
  limits and plate < diagonal; parts check unit quaternions, coordinates within a
  20 m cube, mass > 0 with `source: 'user'`, SHA-256 asset ids, unique ids,
  existing parents, no attachment loops, ≤ 500 parts. New error code `CONFLICT`.
- Renderer store (`assembly-store.ts`): snapshot-based undo/redo with labels (cap
  200), a 500 ms debounced save, at most one save in flight (later edits re-save on
  the new revision), and a conflict state that stops saving and offers Reload.
- Workshop: Frame editor (motor-to-motor diagonal, centre plate, arm width/thickness
  in mm, comma decimals accepted, reasons shown for invalid values, Esc reverts),
  undo/redo buttons with labels, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, and a save status
  with Retry/Reload in the status strip.
- Starting values are labelled as such in the UI. They are editable design
  dimensions, not component specifications.

**Bugs found and fixed**
- On quit, the database was closed before the windows. A save fired while the
  window unloaded could hit a closed database and the last edit was lost
  (intermittently). The database now closes on `will-quit`, after all windows.
  Verified by repeating the quick-close e2e 5×.
- With undo/redo added, the workshop toolbar overflowed by 8 px at 200 % zoom. The
  view-preset buttons now hide below 640 px of width; keys 1–4 still work.

**Verified**: `cargo test` 11, `vitest` 63 (24 new: v1→v2 upgrade, repository
round-trip, conflict, cascade, 12 validation cases, store undo/redo, debounce,
in-flight ordering, conflict, sync flush, mm parsing), `playwright` 11 (2 new:
edit, undo/redo, invalid input and restart persistence; closing the app inside the
save debounce keeps the edit). Typecheck and lint clean.

**Deviation from plan**: undo uses document snapshots rather than command objects.
Documents are small immutable values, so snapshots are simpler and cannot drift
from the data.

## 2026-11-20 — Phase 2, milestone 2.1: viewport shell

**Built**
- Drone Workshop enabled in the sidebar. `/workshop` lists projects to open;
  `/workshop/<id>` opens one. Project names on the Dashboard and Projects pages link
  into the workshop.
- The workshop route is lazy-loaded: three.js (separate ~1 MB chunk) is not loaded
  on any other page.
- Viewport (three 0.187, React Three Fiber 9, drei 10): Z-up world shared with the
  engine (`src/three/setup.ts`); perspective (35° vertical FOV) and orthographic
  cameras; Top / Front / Right / Iso presets; fit; 10 mm / 100 mm ground grid;
  origin axes; axis gizmo. Renders on demand only.
- Framing uses `fitToSphere` (keeps the viewing direction; `fitToBox` snaps to an
  axis). The view re-frames on every resize until the user moves the camera.
  Switching projection keeps the direction.
- Resizable, collapsible Project and View panels (`react-resizable-panels` v4);
  layout, projection and grid choice are remembered. Toolbar toggles follow the
  group layout, so panels squeezed shut by a narrow window show correctly.
- Shortcuts: 1–4 views, F fit, P projection, G grid.

**Verified**: `cargo test` 11, `vitest` 39 (6 new for view maths), `playwright` 9
(3 new). The new e2e tests cover three.js loading only in the workshop, every
preset and projection staying framed, the canvas exactly matching its container
from 880×560 to 3840×2160 and at 150 %/200 % zoom, panel collapse, layout
persisting across restarts, and the workshop added to the no-overflow matrix.
Typecheck and lint clean.

**Notes**: React Three Fiber 9 logs a `THREE.Clock` deprecation warning with three
0.187. It comes from the library, not our code. The frame-time log at 4K is
scheduled for milestone 2.7.

## 2026-11-20 — Renamed to Blaze UAV

- Product name **Blaze UAV**, project folder `Documents\Blaze UAV`, npm name `blaze-uav`.
- App ID `com.blazeuav.app`; installers `BlazeUAV-Setup-<version>.exe` and
  `BlazeUAV-Portable-<version>.exe`; Start menu and desktop shortcut "Blaze UAV".
- User data moves to `%APPDATA%\Blaze UAV\blaze-uav.db`. Data saved under the old
  name (`%APPDATA%\Drone Simulator`) is not migrated; it was test data only.
- Test-only variables renamed to `BLAZE_UAV_USER_DATA` and `BLAZE_UAV_ENGINE`.
- Unchanged internals: engine binary `drone-engine.exe` and the Rust crate names.

## 2026-11-20 — Phase 1, pass 2: new location, UI redesign, desktop hardening

**Moved** the project from `Documents\DroneSimulator` to `Documents\blaze`. Build
outputs were not copied. A fresh `npm ci`, release engine build and the full test
suite pass in the new location. `better-sqlite3`'s implicit `node-gyp` install
script is now denied in `allowScripts`: the package ships Node-API prebuilds, so
fresh installs no longer try to compile C++.

**UI redesign** (rules in `DESIGN.md`)
- IBM Plex Sans/Mono instead of Inter/JetBrains Mono. Colour follows
  glass-cockpit semantics (cyan interactive, green normal, amber caution, red
  failure). Graphite chrome sits one step darker than the work area.
- Boxed cards replaced by docked sections with hairlines. Uppercase eyebrow
  labels and filler subtitles removed. Values are monospaced and bright, units muted.
- New: rotor-layout glyphs (quad/hex/octo X) in tables and as the frame picker in
  the New project dialog; app icon and brand mark (`build/icon.svg` →
  `npm run icon`); window-wide status bar (engine state, round trip, schema, version).
- Developer details (Electron/Chromium/platform) moved from the dashboard to
  Help → About.

**Responsive behaviour**
- Sidebar becomes an icon rail below 1180 CSS px (zoom counts) or on demand;
  the choice is remembered.
- Page grids and tables use container queries; secondary columns drop out.
- Dialogs fit small windows. The native title bar, menus and scrollbars are dark.
- Window sized from the actual work area. Minimum lowered from 1100×700 to
  880×560, so the app fits a 1366×768 laptop at 125 %. The previous fixed
  1440×900 window overflowed this machine's 1536×864 work area.

**Hardening**: single-instance lock; engine-status revisions (fixes a stale
"Restarting" that could outlive a later "Failed"); plain-language engine start
errors; database-open failures shown in a native dialog instead of a silent hang;
3 s quit deadline.

**Verified**
- `cargo test`: 11 passed. `vitest`: 33 passed. Typecheck (node, web, e2e
  configs) and lint clean.
- `playwright`: 6 passed. Main flow with zero console errors, engine kill and
  recovery, missing engine binary → visible "Failed" with reason, second launch
  focuses the first window, window inside the work area with an 880×560 minimum,
  and no horizontal overflow at 880×560, 1093×566, 1280×672 at 150 % zoom,
  1100×700 at 200 % zoom, 1920×1040 and 2560×1400.
- `npm run dev` checked over CDP: renderer served by Vite, engine connected, no
  console errors or CSP violations.
- `npm audit --omit=dev`: 0 vulnerabilities in shipped dependencies. The 6
  moderate findings are in electron-builder's build-time `minimatch` chain.

## 2026-11-20 — Phase 1: Foundation

**Built**
- Repository analysis of Blaze-Simulator (`reference-analysis.md`). It has no license, so it is used as inspiration only.
- Architecture and ADRs: Rust sidecar engine (ADR 0001), SQLite in main (ADR 0002).
- Rust workspace: `engine-core` (math types, Z-up SI conventions) and `engine-host` (`drone-engine`, NDJSON protocol v1: hello/ping/shutdown).
- Electron main: secure window (sandbox, context isolation, CSP, navigation lock), `EngineSupervisor` (handshake, health ping, restart with backoff, failed state, clean shutdown), SQLite with migrations, typed and zod-validated IPC.
- React UI: dark engineering theme, navigation (unbuilt sections disabled with phase tags), dashboard (recent projects, simulation history, live system status, component count), projects page (create/rename/delete).
- electron-builder: NSIS installer and portable exe; engine bundled in `resources/engine`.

**Verified**
- `cargo test --workspace`: 11 passed (math, protocol, spawned-binary integration).
- `vitest`: 31 passed (migrations, repositories, FK cascade, IPC validation, channel parity with preload, supervisor against the real binary including crash-restart and failed state, stores).
- `playwright`: 2 passed (connect → create → persist across restart → rename → delete; disabled nav; engine killed → Restarting → Connected).
- Typecheck and lint clean.
- Packaged app (`win-unpacked`) launched: engine connected from `resources/engine`, project created in SQLite.
- NSIS installer (`DroneSimulator-Setup-0.1.0.exe`, 131 MB) on the dev machine: silent per-user install to `%LOCALAPPDATA%\Programs\Drone Simulator` → installed app connected to its engine and saved a project → silent uninstall removed the folder, desktop shortcut and registry entry.

**Design review** (`.ui-design/reviews/phase1-ui_20261120_2108.md`): fixed table wrapping at the 1100 px minimum, capped content width on large screens, raised tertiary contrast, compact timestamps, and minified the renderer (1,091 kB → 351 kB). Responsive-3D requirements added to the Phase 2 criteria.

**Not done / known gaps**
- Installer not yet tested on a *clean* Windows machine, and upgrade (0.1.0 → 0.1.1) not tested. Both are scheduled for Phase 8. Unsigned: SmartScreen will warn.
- ~~No app icon yet~~ (added in pass 2).
- No physics yet. The engine only implements the protocol handshake.
