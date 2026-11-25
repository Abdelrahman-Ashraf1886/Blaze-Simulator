# Phase 7 plan: telemetry

Status (2026-11-25): **Approved: D1–D20 decided, every recommendation accepted. 7.10 (attitude
estimator) and 7.11 (ULog) stay optional, not chosen yet.** Written against `blaze-sim` at d6f79ca
(Phase 6 done). Earlier phases' decisions are written "P5-D6", "P6-D18".

## Goal

Every flight leaves a record you can trust:
- watch any signal live, and open any past flight and graph it;
- replay it in the 3D view, and prove the record by flying it again to the same state hash;
- export it as CSV, and print a report that says which models and values it rests on;
- fly the rate loop on a gyro with noise, bias and PX4's own filters instead of perfect state.

A flight stays reproducible. With sensors off, results and hashes are today's, bit for bit.

## What is already delivered, and what Phase 7 adds

| Area | Already built | Phase 7 adds |
|---|---|---|
| Engine input log | P6-D18: `flight.session.log`, in memory, original request lines, replay proven equal in hash and chunking | Saving it, and replaying it from a file |
| Live values | `FlightFrame` (one per animation frame) and `DebugPanel.tsx`; 2 s of history in the page | Samples between frames, graphs, a chosen history |
| Time series from the engine | `step_test.rs` trace with a decimation; ScenarioReport measurements | The same for a live session and a scenario |
| Run list | Table `simulation_runs` (migration 0001) and the dashboard list that reads it. **Nothing writes it** | Writing it; the recording behind each row |
| Charts | `response-plot.ts` (SVG, step tests only) | A graph component for long series |
| Navigation | `/telemetry` disabled entry (`src/app/nav.ts`) | The page |
| Sensors, filters, estimator | None. Perfect state (ADR 0009, P5-D6) | D1 |
| Seeded noise | SplitMix64 and Box–Muller, platform-independent (`turbulence.rs`, 6.11) | Reused, one stream per sensor |
| Frame-time gate | `npm run test:flight-perf` (6.0b) | Rerun with recording on, same limits |

## Decisions (made with you)

Decided on 2026-11-25: every recommendation accepted.

| # | Question | Options | Decision |
|---|---|---|---|
| D1 | What flies on sensors? | (a) nothing: sensor signals are recorded only; (b) the rate loop uses a modelled gyro through PX4's filters, the rest stays true; (c) (b) + attitude from PX4's `attitude_estimator_q` (615 lines); (d) EKF2 (`src/modules/ekf2/EKF`, over 500 kB of source) | **(b)** in the core, **(c)** as optional 7.10. P5-D6 said Phase 7 brings "an estimator": (b) is less than that, and (d) is a phase of its own. `attitude_estimator_q` is not PX4's default for multicopters; the page would say so |
| D2 | Default | (a) perfect state, sensors off until you turn them on per project; (b) sensors on | **(a)**. Every existing result and hash stays |
| D3 | Where sensor numbers come from | (a) the flight controller's and GPS's component specs, with provenance, missing ones asked for; (b) PX4's simulator values (`sih.cpp` L465–486) | **(a)**. (b) are noise levels from a fixed-wing aircraft's flights (Bulka and Nahon 2018), for example 0.14 rad/s on the roll gyro; not this vehicle's |
| D4 | Vibration from motors and propellers | (a) not modelled, said on screen; (b) (a) + an optional extra noise you enter from your own log | **(b)**. No source gives vibration for a build we cannot measure. Empty means none, shown as "not modelled" |
| D5 | Bias | (a) none; (b) a constant bias per axis and a random walk, both your entries or "none"; no temperature | **(b)**. A datasheet's zero-rate tolerance is a limit, not a value, so it is shown beside the field and not used |
| D6 | Delay | (a) none; (b) a fixed delay per sensor, your entry, with PX4's assumption shown as a labelled suggestion where one exists (GPS 110 ms, `ekf2_params.c` L89) | **(b)** |
| D7 | Sample rate | (a) one gyro sample per 1 ms step, filters tuned for 1 kHz; (b) sub-stepped 8 kHz sampling | **(a)**, stated. PX4 samples at the raw rate and runs the rate loop at `IMU_GYRO_RATEMAX` (800 Hz for multicopters, `rc.mc_defaults` L13–16); ours runs every 1 ms |
| D8 | Which sensors | (a) gyro, accelerometer; (b) (a) + barometer and GPS as recorded channels; (c) (b) + magnetometer | **(b)**. A magnetometer needs the Earth's field at a place; it comes with 7.10, with the field as your entry |
| D9 | What a recording keeps | (a) the input log only; (b) samples only; (c) both, with the build payload, engine version and final hash | **(c)**. Samples open at once and survive an engine change; the log proves the run and can resample it at any rate |
| D10 | When to record | (a) every live flight, scenario and step test, saved when it ends; (b) only when you press Save | **(a)**, as a flight controller logs while armed. A switch turns it off; an aborted run is saved and marked |
| D11 | Sample rate of the saved channels | 100 Hz, 250 Hz or 1 kHz | **250 Hz** (every fourth step). About 80 channels × 8 bytes: 9.6 MB per minute. 100 Hz is 3.8 MB, 1 kHz is 38 MB. The log allows 1 kHz later without storing it |
| D12 | Where it is stored | (a) SQLite blobs; (b) one file per run beside the database, described by the row; our own format (a JSON header, then chunks of little-endian float64 columns); (c) an Arrow/Parquet dependency | **(b)**. Append-only chunks survive a crash; the format is documented and has a version. Main writes it in chunks (ADR 0002) |
| D13 | Retention | (a) keep everything, show sizes, you delete; (b) a size limit with automatic deletion | **(a)**. Nothing is deleted without you |
| D14 | Replay | (a) play the saved samples in the 3D view; (b) (a) + "Verify", which re-runs the log in the engine and compares the hash | **(b)**. A different engine version is reported as "cannot verify", not as a failure |
| D15 | Charts | (a) our own canvas component; (b) the `uPlot` library (one small dependency; licence and version checked when installed) | **(b)**. Pan, zoom and cursors over hundreds of thousands of points are its purpose; writing that again is work without a gain |
| D16 | Export | (a) CSV; (b) (a) + ULog, readable by PX4's own tools | **(a)** in the core, **ULog as optional 7.11** (its format is documented; our topics would be named as ours, not as PX4's) |
| D17 | Report | (a) flight; (b) (a) + scenario and step test; as a page you can print to PDF (Electron `printToPDF`) | **(b)** |
| D18 | Stream between engine and page | (a) keep the 6.0b lockstep, samples inside the step response; (b) a binary `MessagePort` stream (ARCHITECTURE's note) | **(a)**, gated: `test:flight-perf` must pass with recording on. (b) only if it fails, with its own ADR |
| D19 | Comparing runs | (a) one run at a time; (b) overlay two runs on one time axis, aligned by start or by a moment you pick | **(b)** |
| D20 | Cost gate for the sensor path | Nothing to choose: if sensors make a 1 ms step more than twice as slow, stop and report | Accept |

## Where each calculation lives (ADR 0006, ADR 0008)

| Calculation | Place |
|---|---|
| Sensor models, filters, noise, delay lines | `engine-core`: `sensors.rs`, `gyro_filters.rs`; in the 1 kHz loop, state in the hash only when on |
| Channel list, units and names | `src/domain/telemetry-channels.ts`, one table used by graphs, CSV, report and the file header |
| Sampling during a step request | `engine-host` (`flight_session.rs`, `scenario_run.rs`); values read from the existing diagnostics, no new physics |
| File format, run rows | `electron/main/telemetry/*`; renderer only through IPC |
| Metrics for reports (extremes, RMS, time above a limit) | `src/domain/flight-metrics.ts`, pure, each with its definition on screen |
| Graphs, replay, report pages | renderer, `src/features/telemetry/*` |

## Models and citations

**Gyro path, PX4 v1.13.3 (read for this plan):** `VehicleAngularVelocity.cpp` L709–764: two
optional notch filters (`IMU_GYRO_NF0_FRQ`, `IMU_GYRO_NF1_FRQ`, default 0 = off), then a
second-order low-pass at `IMU_GYRO_CUTOFF` 40 Hz (`imu_gyro_parameters.c` L118); the angular
acceleration is the difference of the filtered rate through a low-pass at `IMU_DGYRO_CUTOFF`
30 Hz (L160). Filter code: `LowPassFilter2p.hpp`, `NotchFilter.hpp`. The dynamic notch filters
(ESC RPM, FFT) are off by default (`IMU_GYRO_DNF_EN` 0, L173) and stay out. The rate loop's
D term then takes this acceleration instead of `controller.rs`'s own difference; with sensors
off nothing changes. Accelerometer low-pass: `IMU_ACCEL_CUTOFF` 30 Hz
(`imu_accel_parameters.c` L46).

**Noise from a density.** A sensor sheet gives a one-sided density N. Sampled at f_s with the
band limited to f_s/2, the standard deviation is σ = N·√(f_s/2). Our assumption: white over that
band. Example, not a default: 2.8 mdps/√Hz (ICM-42688-P, TDK product page) gives 0.063 °/s at
1 kHz.

**Sensors in the catalogue.** [Holybro's technical specification](https://docs.holybro.com/autopilot/pixhawk-6c/technical-specification)
lists an ICM-42688-P and a BMI088 for the Pixhawk 6C, with a DSK320X and a BMI423 on newer
boards. The PX4 v1.13 guide (`pixhawk6c.md` L52–55) lists the discontinued BMI055 as the second
IMU and identifies the IST8310 magnetometer and MS5611 barometer. Check which IMU your board
has and choose which one the rate loop uses. The GPS parts in the catalogue are the M10 and
M9N. Milestone 7.0 records each verified datasheet value with its source and asks for the
remaining values.

**Barometer** uses the ISA pressure already in `src/domain/atmosphere.ts` (moved to or mirrored
in the engine with a shared fixture, as the propulsion model is). **GPS** position and velocity
are the true ones plus white noise, at the receiver's rate and delay; satellite geometry is not
modelled.

**Not modelled, and said on screen:** vibration (D4), temperature, saturation and clipping
unless the range is entered, misalignment and scale errors, sensor failure.

## Milestones

File fences are for parallel work; one milestone per worktree.

| Milestone | Delivers | Files it may touch | After |
|---|---|---|---|
| 7.0 Sources and data | Datasheet values for the catalogue's IMUs, barometer and GPS; PX4 filter parameters and lines; spec fields for sensors on flight controllers and GPS parts | `database/reference/*`, `database/seed/components.v1.json`, `electron/ipc/component-fields.ts`, tests | – |
| 7.1 Engine sampling | Optional `sampleEverySteps` on sessions and scenarios; columns in the response; channel table; default off = today's response | `engine-host/*`, `electron/main/engine/protocol.ts`, `src/domain/telemetry-channels.ts` | – |
| 7.2 Recording store | File format with version and crash-safe chunks, writer, reader, run rows, deletion, migration 0016, IPC | `electron/main/telemetry/*`, `database/migrations/0016_*.sql`, `electron/ipc/*` | 7.1 (format only: none) |
| 7.3 Recording in use | Live flights, scenarios and step tests recorded (D10); dashboard list filled; perf gate with recording on (D18) | `EngineFlightSource.ts`, `FlightPage.tsx`, scenario and tuning pages, `DashboardPage.tsx` | 7.1, 7.2 |
| 7.4 Graphs | uPlot component, channel picker, live graphs beside the flight view, saved layouts as a view preference | `src/features/telemetry/*`, `package.json` | 7.1 |
| 7.5 History and replay | Run list, open, overlay two runs (D19), scrub with the 3D view, Verify (D14) | `src/features/telemetry/*`, `src/features/flight/FlightViewport.tsx` (read-only use) | 7.2, 7.4 |
| 7.6 CSV | Channel and time-range choice, units in the header, exact decimal round trip | `src/domain/telemetry-csv.ts`, `electron/main/telemetry/*` | 7.2 |
| 7.7 Reports | Flight, scenario and step-test report: build, conditions, parameters and overrides, graphs, metrics, model limits, provenance; print to PDF | `src/domain/flight-metrics.ts`, `src/features/telemetry/report/*` | 7.3, 7.4 |
| 7.8 Sensor models | Gyro, accelerometer, barometer, GPS: noise, bias, random walk, delay, rate; recorded channels; seeded; off = bit for bit | `engine-core/src/sensors.rs`, host and protocol fields, sensor form | 7.0, 7.1 |
| 7.9 Flying on the gyro | PX4 filters in front of the rate loop, D term on filtered acceleration; switch; tuning page says which signal is used; step tests with sensors | `engine-core/src/gyro_filters.rs`, `controller.rs`, `flight_loop.rs`, `step_test.rs` | 7.8 |
| 7.10 (optional) Attitude estimator | `attitude_estimator_q` with the modelled IMU and a magnetometer (your field) | `engine-core/src/attitude_estimator.rs` | 7.9, D1 |
| 7.11 (optional) ULog export | ULog file of a recording | `src/domain/ulog.ts` | 7.2, D16 |
| 7.12 Acceptance and docs | Record, verify, export and report a flight end to end; the same step test on perfect and modelled gyro with both results in the DEVLOG; ROADMAP, ARCHITECTURE, ADR for the sensor boundary and the recording format | docs, e2e | All above |

**Waves.** 1: 7.0, 7.1 and 7.2 in parallel. 2: 7.3, 7.4, 7.6 and 7.8. 3: 7.5, 7.7 and 7.9 (7.9 alone
in `controller.rs` and `flight_loop.rs`). 4: 7.10 and 7.11 if chosen, then 7.12.

## Automated tests

1. **Off is off:** with sampling and sensors off, every existing hash and response is unchanged.
2. **Sampling:** the sampled columns equal the diagnostics of a run stepped one step at a time;
   any chunking of requests gives the same columns.
3. **Format:** round trip of every channel including NaN-as-missing; a file cut at any byte opens to
   its last whole chunk and says it is incomplete; an unknown version is refused; deleting a run
   removes its file, and a missing file leaves a row that says so.
4. **Replay:** a saved log re-run gives the recorded hash, with wind, turbulence, sensors and auto
   modes; a changed byte in the log fails Verify; another engine version reports "cannot verify".
5. **CSV:** parses back to the same float64 values; header units match the channel table.
6. **Metrics:** each against a hand-computed series, including empty and single-sample ones.
7. **Noise:** sample variance inside the confidence bound computed from the sample count; mean within
   its bound; random walk variance grows linearly with time; same seed same series; draws per step
   fixed so chunking does not matter.
8. **Delay:** an impulse appears after exactly the entered delay; fractional-step delays are refused or
   rounded with the rule stated.
9. **Filters:** PX4's low-pass and notch against their analytic frequency response and a step
   response computed independently; reset behaviour.
10. **Closed loop:** on the catalogue quad with the datasheet gyro, hover and a rate step stay within
    limits stated before running; a deliberately excessive noise is reported, not hidden.
11. **Frame time:** `test:flight-perf` with recording and live graphs on, the 6.0b limits (run by me).
12. **e2e:** fly, stop, find the run, replay, verify, export, print the report; restart the app and
    open it again.

## Risks

- **Noise without vibration looks too good.** The datasheet figure is the sensor at rest. A real
  gyro on a quad sees far more from motors and propellers, so a tuning that looks fine here can
  still fail on the real machine. The page must say it wherever sensors are on.
- **Two D terms.** PX4 differentiates the filtered rate; our loop differences the measured rate. 7.9
  must keep the perfect-state path bit for bit and not merge them.
- **Disk use.** 9.6 MB per minute adds up; sizes are shown and nothing is deleted silently.
- **JSON samples cost time.** 250 Hz × 80 channels is about 4 rows per frame; if the perf gate fails,
  the first step is fewer channels per response, then D18(b).
- **Verification ages.** A recording verifies only on the engine that made it; samples stay readable.
- **The 2–5 hitches per 20 s found in 6.0b** are untraced. Recording may make them worse; test 11
  compares.
- **Scope.** Eleven core milestones and two optional. Recording, replay and graphs (7.1–7.6) are useful
  without sensors; 7.8 and 7.9 can be cut or moved without touching them.
