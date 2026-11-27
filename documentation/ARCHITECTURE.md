# Architecture

```
┌──────────────────────────── Electron app ────────────────────────────┐
│                                                                      │
│  Renderer (sandboxed, no Node)          Main process (Node)          │
│  React · Router · Zustand · Tailwind    ┌──────────────────────┐     │
│  three / R3F (Phase 2+)                 │ IPC handlers (zod)   │     │
│        │  window.api (preload)          │ Repositories ─ SQLite│     │
│        └────── ipcRenderer.invoke ────▶ │ EngineSupervisor     │     │
│        ◀───── engine:statusChanged ──── └─────────┬────────────┘     │
│                                                   │ stdin/stdout     │
└───────────────────────────────────────────────────┼──────────────────┘
                                                    │ NDJSON protocol v2
                                      ┌─────────────▼─────────────┐
                                      │ drone-engine (Rust)       │
                                      │  engine-host: protocol,   │
                                      │    scheduling, threads    │
                                      │  engine-core: pure models │
                                      └───────────────────────────┘
```

## Processes and responsibilities

| Layer | Path | Owns | Must not |
|---|---|---|---|
| Renderer | `src/` | Presentation, interaction, view state | Touch disk, DB or the engine directly; run expensive computation |
| Preload | `electron/preload/` | Exposes the typed `window.api` (`DesktopApi`) | Import runtime libraries (keeps sandbox bundle tiny) |
| IPC contract | `electron/ipc/contract.ts` | Channel names, request schemas, result envelope, shared types | — |
| Main | `electron/main/` | Window/security, SQLite, engine lifecycle | Do simulation math |
| Engine host | `simulation-engine/engine-host` | Wire protocol, process loop, (later) real-time scheduler | Contain physics |
| Engine core | `simulation-engine/engine-core` | All physical models | Perform IO |

## Engine protocol (v2)

Newline-delimited JSON on stdin/stdout; stderr is log only.

| Request | Response `result` |
|---|---|
| `{"id":n,"type":"hello"}` | `{engineVersion, protocolVersion, threads}` |
| `{"id":n,"type":"ping"}` | `{engineUptimeUs}` |
| `{"id":n,"type":"shutdown"}` | `{}` then the process exits 0 |
| `{"id":n,"type":"vehicle.load","vehicle":VehicleDefinition}` | `{valid:true, partCount, motorCount, totals:{massKg, com, inertia}, missingMass}` or `{valid:false, errors:[{path, message}]}` (an invalid one clears the loaded vehicle) |
| `{"id":n,"type":"sim.run",durationS,environment,wind?,groundEffect?,startPositionM?,startClearanceM?,dtS?,forceBodyN?,torqueBodyNm?,throttle?,rotorSpeedsRadps?,airDensityKgM3?,controller?}` | `{steps,dtS,durationS,gravityMps2,startZM?,state,stateHash,contacts,contactsDropped,motors?,battery?,controller?,flightLoop?}`. Runs the loaded vehicle from `startPositionM` at rest, up to 120 000 steps. `environment` supplies a plane at world Z = 0 or a terrain grid, or uses `ground:null` for free space. Fixed obstacles are box, cylinder or hull shapes. All surfaces require friction and restitution. Without propulsion, the run accepts constant body loads. With propulsion, it requires air density and accepts per-motor throttles or the closed-loop controller. Optional `wind` takes `{fromDeg,mean,gust}` (null selects calm). Optional `groundEffect` takes propeller radii in metres in vehicle motor order. Both fields require propulsion. FlightLoop accepts `controller.mode` of `rates`, `stabilized`, `altitude` or `position`. Rates uses `bodyRadps` (body FLU) and `collective` in [0, 1]. Other modes use `sticks` with `forward`, `right`, `yawRight` and `throttle` in [−1, 1]. With FlightLoop, `dtS` must divide 10 ms and the hash includes `FlightLoop::hash_words`. Optional `airmode` takes 0, 1 or 2 and must agree with `gains.MC_AIRMODE` when both are supplied. Both controller paths accept `thrustModelFactor` or `gains.THR_MDL_FAC`. |
| `{"id":n,"type":"flight.session.start",environment,wind?,groundEffect?,startPositionM?,startClearanceM?,airDensityKgM3,cutoff,gains?,controller?,sampleEverySteps?,sensors?}` | `{dtS,maxStepsPerRequest,diagnostic,channels?,samples?}`. Sampling adds the fixed channel order and one row at step 0. `sampleEverySteps` is a positive JSON safe integer. Omit it to leave sampling off. Optional sensors use the configuration below. Starts a flight of the loaded vehicle with propulsion, replacing any session and its log. The battery cut-off is the user's choice of `voltageV` or `chargeMah` with a positive value. Environment, wind and ground effect use the batch run format. `controller:{mode,airmode?,thrustModelFactor?}` selects FlightLoop. Attitude-hold sessions use `gains.THR_MDL_FAC`. Mixer settings and [Return gains](../database/reference/README.md) are fixed at start. |
| `{"id":n,"type":"flight.session.step",steps,setpoint}` | `{stepsRun,diagnostic,contacts,contactsDropped,endReason,stateHash,samples?}`. When sampling is enabled, includes the rows taken during this request. Advances 1–100 fixed 1 ms steps, subject to the battery cut-off. FlightLoop takes rates or sticks and optional `setpoint.mode` to select the manual mode for this and subsequent steps. It also accepts `setpoint:{command:{type:"takeoff",altitudeM?}}`, `{command:{type:"hold"}}`, `{command:{type:"land"}}` or `{command:{type:"return"}}`. Takeoff altitude is metres above the starting CoM along world +Z and defaults to `MIS_TAKEOFF_ALT`. Attitude sessions refuse auto commands. `diagnostic.flightLoop` and batch `flightLoop` give the latest mode, `autoMode`, `takeoffState`, `landState`, `commandFinished`, setpoints, saturation, velocity integral and hover-thrust estimate. FlightLoop sessions also emit `returnState` while `autoMode` is `return`. Setpoint vectors use world Z-up with null for unavailable components. Hold is active when takeoff finishes or a hold setpoint is captured. Land and Return finish when the detector reports landed. `diagnostic.loads` includes wind at the CoM in world m/s, added thrust in N, per-motor ground-effect status, and wind range and validity flags. Ground-effect status is empty when off. A FlightLoop failure returns `INVALID_PARAMS` and ends the session. <br><br>The engine samples at step 0 and after each completed step whose absolute index is divisible by the interval. Each `samples` object pairs `steps` with `rows`, in increasing step order. A step request that advances no scheduled samples has empty arrays. The step at battery cut-off is eligible when it advances the simulation. Flags use 0 and 1. Inactive, missing, and non-finite values use null. The physical contact flag uses the simulation contact state, first updated by the physics step. See [the channel table](../src/domain/telemetry-channels.ts) for the column metadata and enum codes. |
| `{"id":n,"type":"flight.session.log"}` | `{start,steps}`. The original accepted start request and ordered accepted step requests, including their IDs and decimal tokens. Replay can assign new request IDs and uses the same loaded vehicle. The log is in memory, grows with accepted requests and is cleared on end or restart. Neither NDJSON line reader imposes a message-size limit. |
| `{"id":n,"type":"flight.session.end"}` | `{ended}`. Drops the session and its log. |
| `{"id":n,"type":"scenario.run",scenario:{type:"builtin",name,massKg?,offsetM?}\|{type:"custom",scenario},config}` | `{scenario,report,stateHash,channels?,samples?}`. Optional `config.sampleEverySteps` adds the channel order and all samples, including step 0. Optional `config.sensors` uses the configuration below. Flies a scripted scenario on the loaded vehicle. `config` supplies air density, cut-off, optional gains and `thrustModelFactor`, optional `wind` and `groundEffect` in batch format, and optional `environment` and `startPositionM` together. With a ground, it also accepts `startClearanceM`. Custom scenarios use either the legacy `script` and `checks` or a `flightScript` of timed Position, Takeoff, Hold and Land commands with empty legacy arrays. The duration limit is 60 s in free space and 10 s for custom or legacy scenarios with an environment. The two landing built-ins use their fixed 34 s sequence. The report adds `flight` measurements for the four acceptance built-ins. <br><br>The largest schedule is 60,001 rows at one sample per step (60 s at 1 ms, plus step 0). For `M` motors a row has `C = 125 + 8M` columns in FlightLoop or `C = 86 + 8M` in attitude hold. Add 20 columns with sensors enabled and another seven when flying on the gyro. With at most 24 bytes per float (Cargo.lock's zmij formatter, `lib.rs:125`), the compact `samples` object is bounded by `60,001 × (25C + 9) + 22` bytes, including the step indices and JSON punctuation. The engine uses serde_json and zmij (simulation-engine/Cargo.lock:476-486,602-605). This is 236,043,956 bytes for four FlightLoop motors and 260,044,356 for six with sensors off. Recorded sensors add at most 30,000,500 bytes to the samples object. Gyro feedback adds at most 10,500,175 bytes. Add the original response bytes, the compact channel list bytes and 23 bytes for the two member names and separators. Vehicle motor count and echoed scenario data have no fixed protocol cap, so the full response has no single byte maximum. |
| `{"id":n,"type":"stepTest.run",test:{step,holdS,durationS,decimationSteps},config}` | `{trace,rateLoopFeedback?,stepTimeS,elapsedS,hoverCollective01,startImbalanceNm,gains,stateHash,endReason,error}`. Runs a rate, attitude, altitude or horizontal position step in free space for up to 60 s. `config` supplies air density, cut-off, optional gain and mixer overrides, and optional `wind` and `groundEffect` in batch format. Free space provides no surface for ground effect. Optional `config.sensors` uses the configuration below. The trace samples true state and applied motor signals at the requested decimation. The response metrics use the true measured signal. With gyro feedback, `rateLoopFeedback` adds `{rateUsedRadps,angularAccelerationUsedRadps2,fromGyro}` entries aligned with `trace.samples`. |

Optional `startClearanceM` is a finite, non-negative vertical clearance in metres above the first ground contact of the collision shapes. The engine uses the request's X and Y and ignores the supplied Z. Placement requires a ground plane or a part over the terrain sample bounds. Obstacles still undergo the start penetration check. With clearance supplied, `sim.run` returns the resolved release height in `startZM`. A flight session exposes the start position in `diagnostic.state.positionM`.

Errors: `{"id":n|null,"ok":false,"error":{"code","message"}}` with code
`INVALID_JSON`, `INVALID_REQUEST`, `INVALID_PARAMS`, `NO_VEHICLE`,
`VEHICLE_INCOMPLETE`, `ENVIRONMENT_INCOMPLETE` (4.4), `RUN_TOO_LONG` (a `sim.run` that
needs more than 2 s of compute), `CUTOFF_REQUIRED`, `NO_SESSION` (4.8), `NO_PROPULSION`,
`REFERENCE_DENSITY_REQUIRED` or `INVALID_SCENARIO` (4.9). `VehicleDefinition` is pinned in
`documentation/plans/phase-4-physics.md`; main validates it with zod before
sending, and the engine validates it again in full (ADR 0006).
A malformed line never terminates the engine. Rust source of truth:
`engine-host/src/protocol.rs`; TS mirror: `electron/main/engine/protocol.ts`.

### Recorded sensors

`sensors` takes a signed JSON safe-integer `seed` and four required keys named `gyro`,
`accelerometer`, `barometer` and `gps`. Each group accepts null to disable it.
Omitting `sensors`, sending null, or disabling every group preserves the existing
response, channel list and hash for the same sampling request.

| Group | Fields in SI units and 1 ms steps |
| --- | --- |
| `gyro`, `accelerometer` | Nullable `noiseSigma` and `vibrationSigma` are per-sample standard deviations applied independently to each axis, in rad/s or m/s². Nullable `bias` holds three body-axis offsets. Nullable `randomWalk` is the bias increment density in (rad/s)/√s or (m/s²)/√s. Nullable `delaySteps` is a nonnegative safe integer. Nullable `range` is the positive magnitude of the symmetric clip limit. The accelerometer also requires `mountPositionM` in forward, left, up axes relative to the body origin. |
| `barometer` | `referenceAltitudeM` gives the ISA geopotential altitude at world Z zero and `referenceTemperatureK` accepts actual temperature or null for ISA. `sigmaPa` and `biasPa` are nullable. `periodSteps` is a positive safe integer and `delaySteps` is a nullable nonnegative safe integer. |
| `gps` | Nullable `positionSigmaHorizontalM` applies independently to X and Y. Nullable `positionSigmaVerticalM` applies to Z. Nullable `velocitySigmaMps` applies independently to each axis. Position and velocity use the centre of mass in world axes. `periodSteps` is a positive safe integer and `delaySteps` is a nullable nonnegative safe integer. |

Null effects contribute zero noise, bias, walk or delay, or disable clipping for a
null range. The TypeScript builder converts one-sided IMU density to per-sample
sigma using √(1000/2) and refuses fractional millisecond delays. PX4 v1.13.3
`src/modules/ekf2/ekf2_params.c:89` supplies the labelled 110 ms GPS suggestion.

Sensors acquire after the first plant step and then every step for IMUs or every
`periodSteps` for barometer and GPS. A sample acquired at step k arrives at k plus
its delay. The recorder emits null before the first arrival and holds the latest
slow sample until the next arrival. Barometer pressure uses ISA at
`referenceAltitudeM + CoM.z`, within −5000 to 11000 m. The supplied actual
temperature affects density in the flight setup. ISA pressure uses standard
temperature, as in `src/domain/atmosphere.ts:72–93`. Pressure altitude is null
when measured pressure falls outside the inverse model's domain.

The signed seed is interpreted as two's complement. Successive SplitMix64 outputs
seed fixed slots for gyro XYZ, accelerometer XYZ, barometer, GPS position XYZ and
GPS velocity XYZ. Each active stream draws six uniforms per plant step, including
steps between slow acquisitions. Recording cadence and request chunk sizes
preserve the sensor stream. When any group is active, sensor state extends the
plant and controller hash even without `sampleEverySteps`. Sampling appends gyro,
gyro clip flags, accelerometer, accelerometer clip flags, barometer pressure and
pressure altitude, then GPS position and velocity. Clip flags use 0 and 1.

Optional `sensors.flyOnGyro` is
`{gyroCutoffHz,dgyroCutoffHz,notch0,notch1}`, with each notch either
`{frequencyHz,bandwidthHz}` or null. Omission or null selects recorded-only
sensors. Feedback requires a gyro. At 1 kHz, a cutoff or notch frequency of
zero or at least 500 Hz bypasses that filter. Zero notch bandwidth also
bypasses the notch. The static notch cascade feeds the two-pole rate low-pass,
and the difference of the filtered rate feeds the angular acceleration alpha
filter (PX4 v1.13.3, `VehicleAngularVelocity.cpp:160–190,735–763`). The
simulation primes the filter history at the first delayed sample, with zero
initial angular acceleration. The entered gyro bias is the residual after the
correction PX4 normally applies (`VehicleAngularVelocity.cpp:916`).

Only the rate loop uses this feedback, on the tick after the delayed reading
arrives. It holds the initial state's true rates until that first tick. Sample
rows append `sensor.gyroFiltered.{x,y,z}` in rad/s,
`sensor.angularAccelerationFiltered.{x,y,z}` in rad/s² and
`controller.rateSource` (0 true, 1 gyro). The filtered columns are null
during the initial hold and otherwise show the feedback that produced that
row's step. The raw gyro columns retain their post-step acquisition timing.


At each tick the controller reads true attitude, position and velocity. The plant advances after control. Sensor acquisition and delivery then use the resulting plant state. The accelerometer models specific force at the mount, including tangential and centripetal terms. Barometer and GPS remain recorded signals, as does the accelerometer. With gyro feedback on, the controller uses filtered rate for rate error and filtered angular acceleration for the D term. The next tick consumes that feedback. There is no estimator. [Live step](../simulation-engine/engine-host/src/flight_session.rs#L390-L420) · [Sensor order](../simulation-engine/engine-host/src/telemetry.rs#L196-L260) · [Sensor models](../simulation-engine/engine-core/src/sensors.rs#L207-L257) · [Mount force](../simulation-engine/engine-core/src/sensors.rs#L347-L359) · [Rate controller](../simulation-engine/engine-core/src/controller.rs#L347)

## Telemetry

### Sampling and recording

The renderer drives the live session in lockstep. The engine host samples diagnostics at the schedule described in [Engine protocol](#engine-protocol-v2). Samples travel in the JSON response on the existing engine pipe. Main requests every fourth 1 ms step for recorded flights and scenarios (250 Hz). Step tests keep their own trace and decimation. [Engine sampler](../simulation-engine/engine-host/src/telemetry.rs#L196-L260) · [Flight handler](../electron/main/engine/flight-session.ts#L52-L73) · [Scenario handler](../electron/main/engine/scenario-run.ts#L48-L60) · [Trace conversion](../electron/main/telemetry/session-recorder.ts#L9-L60)

Main captures the serialised vehicle load, start request and live step requests. It queues the sample rows and closes the run with its end status, elapsed time and last state hash. A bounded writer drains the queue in order. Stop waits for finalisation. Window close and app quit also settle outstanding recordings. SQLite stores the run metadata for the dashboard and Telemetry history. [Recorder](../electron/main/telemetry/session-recorder.ts#L83-L224) · [Writer](../electron/main/telemetry/writer.ts#L104-L176) · [Stop](../electron/main/engine/flight-session.ts#L82-L116) · [Shutdown](../electron/main/index.ts#L399-L417) · [Migration 0016](../database/migrations/0016_recordings.sql#L1)

### Recording format and recovery

Each run file is `userData/recordings/<run UUID>.blzr`. The preamble is ASCII `BLZR` followed by a little-endian uint32 version (1). A frame contains a type byte, uint32 payload length, CRC-32 of those five bytes, CRC-32 of the payload, then the payload. Frames are appended in order. Type 0 is the UTF-8 JSON header with run and build identity, app, engine and protocol versions, load and start request text, sample clock and ordered channel metadata. Type 1 starts with the uint32 row count, then interleaves little-endian float64 channel values by row in header order. NaN represents a missing value. Type 2 stores one UTF-8 request line. Type 3 ends the file with UTF-8 JSON end metadata. The time of row `i` is `(firstSampleStep + i * samplePeriodSteps) * stepLengthS`. [Format](../electron/main/telemetry/format.ts#L1-L64)

A short tail is ignored. A missing end frame means incomplete. After a valid header, a CRC failure exposes the intact prefix and an integrity error. The reader rejects an unsupported version, invalid frame layout or extra bytes after the end. Startup scans rows left open, closes them as aborted and recovers counts and time from the valid prefix or end metadata. It leaves the bytes on disk and reports orphan files. History shows missing files. Explicit deletion unlinks the file before deleting its row. [Reader](../electron/main/telemetry/reader.ts#L58-L149) · [Startup recovery](../electron/main/telemetry/store.ts#L115-L144) · [Missing files](../electron/main/telemetry/store.ts#L43-L81) · [Deletion](../electron/main/db/repositories.ts#L267-L283)

### Reading, replay and export

The reader scans frame CRCs and indexes sample and request offsets. Main keeps the two most recently used indexes, keyed by path and matched on size, modification time, change time and inode. A range query binary-searches the sample clock and chunk offsets, then reads the requested columns over the overlapping rows. When a point budget applies, each channel is reduced with time-ordered min/max buckets and missing-value markers within the budget. [Reader index and queries](../electron/main/telemetry/reader.ts#L119-L280) · [Decimation](../electron/main/telemetry/decimation.ts#L1-L68)

Replay uses saved pose and holds each sample until the next. Play, scrub and sample navigation share a time cursor with the graphs. The viewport reconstructs the build and environment from saved requests. History graphs can overlay a second recording, aligned at the start or at selected times. They provide channel selection and save the layout as a view preference. [Replay](../src/features/telemetry/ReplayPanel.tsx#L13-L114) · [Replay scene](../src/features/telemetry/ReplayScene.tsx#L42) · [History graphs](../src/features/telemetry/RunGraphs.tsx#L140-L249)

Verify runs the saved load, start and step requests in a separate engine process. It checks engine and protocol versions, compares saved sample steps and values exactly, and checks the final step count and state hash. The result is Same, Different, Cannot verify, or Cancelled. Incomplete or corrupt files and version mismatches yield Cannot verify. [Verification](../electron/main/telemetry/verify.ts#L15-L166)

CSV streams full-resolution rows for the selected time range and channels. Headers include units. Numeric columns use decimal strings that round-trip to float64, and missing values are blank. Mode codes can be exported as names. Main writes through a temporary file and renames it into place after success. The report page reads saved build and conditions, overrides, graphs, metrics and model limits with provenance. Main prints the active report with Electron `printToPDF`, A4 print styles and a page footer. [CSV formatting](../src/domain/telemetry-csv.ts#L32) · [CSV writer](../electron/main/telemetry/csv.ts#L40-L102) · [Report](../src/features/telemetry/report/ReportPage.tsx#L41-L151) · [PDF](../electron/main/telemetry/report-pdf.ts#L23-L47)

### Live graphs and IPC

Live graphs use the same engine samples. Open the panel before start to request samples without recording. A recorded flight can send samples to the panel when it is opened during flight. `EngineFlightSource` forwards rows to a renderer ring buffer for the latest 10 simulated seconds. The live uPlot panels show altitude, body rates and battery. [IPC forwarding](../electron/ipc/handlers.ts#L91-L114) · [Flight source](../src/features/flight/EngineFlightSource.ts#L244-L301) · [Live buffer](../src/features/telemetry/live-buffer.ts#L8) · [Live graphs](../src/features/telemetry/LiveGraphs.tsx#L6-L25)

Run IPC uses `runs:list`, `runs:get`, `runs:delete` and the existing `runs:listRecent`. Recording IPC uses `recording:summary`, `recording:readSamples`, `recording:readRequests`, `recording:totalSize`, `recording:verify`, `recording:verifyCancel`, the `recording:verifyProgress` event, `recording:exportCsv` and `recording:printReportPdf`. Existing engine IPC accepts recording options on flight, scenario and step-test starts. Flight start and step also carry the live-view flag. Recording replies may include `recordingId` or `recordingError`. [IPC payloads](../electron/ipc/contract.ts#L539-L600) · [Channel names](../electron/ipc/contract.ts#L675-L687)

## Flight environment

- `engine-core/src/wind.rs` evaluates constant wind, logarithmic shear, one discrete gust and optional seeded Dryden turbulence (`turbulence: {kind:"dryden",seed}`). `flight.rs` samples the combined wind for body drag and for airspeed in the optional `ground_effect.rs` correction at each hub. Live loads report the Dryden vector at the CoM and whether any sample used the 10 or 1000 ft hold. `environment.rs` and `sim.rs` place plane, heightfield and obstacle colliders and resolve start clearance using the collision shapes.
- `engine-core/src/takeoff.rs` and `land_detector.rs` supply ramp and landing states. `auto_modes.rs` generates straight vertical takeoff and landing targets, and `flight_loop.rs` runs them through the PX4 cascade. The scenario host uses that same loop for environment acceptance.
- `src/domain/wind.ts`, `environment.ts` and `terrain.ts` validate project inputs. The Workshop Environment panel owns terrain and obstacles, and Flight setup owns wind and ground effect. `src/domain/input-mapping.ts` applies device calibration and `src/features/flight/cameras.ts` computes camera pose from telemetry. The live session keeps accepted input requests for deterministic in-memory replay.

Model boundaries and citations are in [ADR 0010](adr/0010-flight-environment.md).

## Flight control

`engine-core/src/controller.rs` contains the PX4 v1.13.3 attitude controller,
rate PID and allocator. `position_control.rs` owns position and velocity control
on all three axes, including the vertical path shared by `ClosedLoop` (direct
attitude/altitude setpoints and the original scenarios) and `FlightLoop` (manual and auto modes, step tests and environment acceptance scripts). `flight_modes.rs` maps pilot sticks to controller setpoints.
`hover_thrust.rs` estimates the hover collective from normalized vertical thrust
and exact simulated motion. Height is measured above the ground below. Free space
counts as airborne. The controller receives exact state at the estimator boundary
described in [ADR 0009](adr/0009-px4-controller-perfect-state.md).

`thrust_model.rs` converts each allocated thrust command to a motor signal before
the propulsion plant. Saturation reporting and anti-windup use the allocator
output. Engine requests default to zero and accept the factor in [0, 1], per
`database/reference/physics.v1.json:1102–1109`. When both `thrustModelFactor` and
`gains.THR_MDL_FAC` are present they must agree. The app fits one factor from the
build's equal-command steady thrust at nominal pack voltage with sag and sea-level
ISA density. The scenario request builder sends the fit and accepts a saved
override. An unavailable fit uses zero. The Flight and Tuning pages send saved
overrides for live flight and step tests. The derived defaults for those calls
and the saved override lookup on the Scenarios page are pending.

## Engine supervision

`EngineSupervisor` (`electron/main/engine/supervisor.ts`): spawn → `hello`
handshake (protocol version must match, otherwise `failed` without retry) →
health `ping` every 2 s (round-trip shown in UI) → on exit/timeout, restart with
backoff `[250, 1000, 3000] ms`; after 5 consecutive failed starts → `failed`.
Clean shutdown on app quit sends `shutdown`, then kills after 1 s; the app quits
after at most 3 s even if the engine never exits. Start failures are reported in
plain language ("Engine executable not found: …", "Not allowed to start …").

Every status carries a monotonically increasing `revision`. The renderer keeps
the highest revision it has seen, so a status snapshot that arrives after a newer
push cannot roll the UI back (e.g. from `failed` to `restarting`).

## Desktop shell

- **Single instance** per userData directory; a second launch focuses the
  existing window and exits.
- **Window size** is 90 % of the work area of the display under the cursor
  (≤ 1680×1050), centred. Minimum 880×560 DIP, which fits a 1366×768 laptop at
  125 % scaling. `nativeTheme` is forced dark, so the title bar and menus match.
- **Database errors at startup** (e.g. a file from a newer app version) show a
  native error box naming the file, then exit without modifying it.
- **Help → About** lists app, engine, Electron/Chromium/Node versions and the data
  file location. The menu bar auto-hides; press Alt to show it.
- Unpackaged builds accept `BLAZE_UAV_USER_DATA` and `BLAZE_UAV_ENGINE`
  as test overrides. Packaged builds disable these overrides, test hooks and
  DevTools. [Launch options](../electron/main/self-check.ts#L8-L15)

### Settings

Settings shows the data folder and storage sizes, database copies and restore,
log folder and diagnostics, graphics, recording preference, versions and notices.
Main reads the graphics preference from the data folder before Electron is ready.
A change takes effect on restart. The page reports the current WebGL renderer.
The recording preference is stored in renderer local storage.
[Settings sections](../src/features/settings/SettingsPage.tsx#L117-L137) ·
[GPU startup](../electron/main/index.ts#L98-L102) ·
[Graphics readout](../src/features/settings/GraphicsSection.tsx#L21-L46) ·
[Recording preference](../src/lib/prefs.ts#L71-L79)

### Logging and diagnostics

Main writes local logs under `<userData>/logs`. It rotates `main.log` at
2 MiB and keeps five files including the active log. Main registers handlers
for uncaught exceptions, unhandled rejections and renderer loss. Engine stderr
goes to the log at info, including the startup and exit messages.
[Main setup](../electron/main/index.ts#L54-L70) ·
[Rotation](../electron/main/logging/logger.ts#L5-L10) ·
[Crash handlers](../electron/main/logging/crashes.ts#L4-L53) ·
[Engine stderr](../electron/main/engine/supervisor.ts#L308-L313)

Settings previews the contents of a diagnostics ZIP. It contains the current
and rotated logs, system and version details, and recording filenames and sizes.
Logs may contain paths. The user can opt into a database snapshot. Main stages
the ZIP beside the chosen destination and publishes it by rename.
[Contents and writing](../electron/main/logging/diagnostics.ts#L8-L94) ·
[Settings opt-in](../src/features/settings/SettingsPage.tsx#L32-L38)

## Storage

SQLite (`better-sqlite3`, Node-API prebuilds, loads in both Node and Electron)
at `<userData>/blaze-uav.db`, WAL mode, foreign keys on. Schema version =
`PRAGMA user_version`; migrations in `database/migrations/NNNN_*.sql` are
append-only. Pending migrations run in one transaction. Startup refuses a
schema newer than the app supports.
[Migration transaction](../electron/main/db/database.ts#L41-L60)

**Assemblies** (schema v2): one per project, saved as a whole document with
optimistic concurrency. Each save carries the revision it was based on, and main
rejects it with `CONFLICT` if the stored revision differs. The renderer debounces
saves (500 ms), keeps at most one in flight, and on window unload saves
synchronously (`assembly:saveSync`). The database is closed on `will-quit`, after
every window has unloaded. Undo/redo lives in the renderer as document snapshots.

**Imported models** (schema v4): main validates a picked `.glb`/`.gltf`
(`electron/main/assets/gltf.ts`: 50 MB limit, signature, glTF 2.0, embedded data
only, no unsupported compression) and copies it to
`<userData>/assets/<sha256>.<ext>`; the `assets` table holds file facts (name,
size, triangles, bounds). The renderer loads models only through
`blaze-asset://model/<sha256>`, a privileged protocol whose handler resolves
digest-shaped IDs in that folder. Serving only database-registered assets
remains open. [Protocol handler](../electron/main/index.ts#L382-L388)
Units and up axis are part of each model
part's shape. Unused assets are removed at startup.

**Viewport images**: the renderer renders and encodes the PNG; main validates it
(`viewport:savePng`), asks where to save it, and writes the file. The renderer
never touches the disk. ADR 0003 covers the Z-up renderer, ADR 0004 the asset
store.

Component specifications (Phase 3) store each value as its source states it, with
provenance: `{value, unit, source: "manufacturer" | "measured" | "user", reference,
condition}`, converted to SI only where a check or calculation uses it (ADR 0007).
Checks, wiring rules and electrical calculations are pure modules in `src/domain/`,
with no React, three.js, IPC or Node imports; ESLint enforces this (ADR 0008).

### Data safety

Startup runs SQLite `quick_check` and checks the schema version. Before upgrading
an older database, main makes and verifies a standalone SQLite backup in
`<userData>/backups`. If the copy fails, startup stops before migration. It keeps
the latest three pre-migration copies. On an integrity check failure, startup
offers to quit, restore the newest usable copy if available, or continue in
read-only recovery mode.
[Integrity check](../electron/main/db/safety.ts#L42-L50) ·
[Copy and retention](../electron/main/db/safety.ts#L113-L159) ·
[Retention count](../electron/main/db/safety.ts#L12) ·
[Recovery prompt](../electron/main/index.ts#L304-L339)

Restore verifies and migrates a staged database, keeps the displaced file,
and journals the swap for startup recovery. Settings restarts the app after
restore. A database copy contains SQLite rows only. Model, terrain and
recording files stay in their separate stores.
[Restore and recovery](../electron/main/db/safety.ts#L180-L288) ·
[Restart](../electron/main/index.ts#L558-L574) ·
[Restore confirmation](../src/features/settings/SettingsSections.tsx#L87-L92)

Export writes one `.blazeproj` with project data, referenced components and
assets, and optional recordings. The container checks entry names, sizes and
SHA-256 digests. Import validates and stages its files, then publishes them
with a database transaction and a journal for interrupted imports.
[Container](../electron/main/projects/container.ts#L135-L214) ·
[Transfer](../electron/main/projects/transfer.ts#L193-L299) ·
[Import journal](../electron/main/projects/publish.ts#L32-L76)

## Security

`contextIsolation`, `sandbox`, no `nodeIntegration`; CSP header (`script-src 'self'`
in production). The packaged window blocks navigation and new Electron
windows. HTTPS citations open in the system browser. Main uses Zod schemas for
channel payloads and IPC result envelopes for validation errors.
[Window policy](../electron/main/index.ts#L113-L183) ·
[IPC handlers](../electron/ipc/handlers.ts)

### IPC guard

Async and sync bindings check the current main window, its top frame and the
app document URL before dispatch. The URL check ignores the route fragment.
The guard limits payload size and structure. It allows one active request in
each guarded group for engine work, asset imports and recording verification.
Flight End has its own slot so it can interrupt a step. The supervisor bounds
pipe lines and validates replies and the hello result.
[Main bindings](../electron/main/index.ts#L288-L293) ·
[Guard](../electron/ipc/handlers.ts#L96-L142) ·
[Engine reply bounds](../electron/main/engine/supervisor.ts#L41-L77)

## Packaging and self-check

0.8.0 packages an unsigned per-user NSIS installer and a portable Windows x64
executable. Uninstall keeps user data. The builder restricts the app to ASAR
and enables embedded ASAR integrity checks. It disables Electron's RunAsNode,
Node environment options and CLI inspection fuses. The Windows x64 SQLite
native module is unpacked. The engine, notices and self-check fixtures ship as
extra resources. The engine links the C runtime statically for clean Windows.
[Builder config](../electron-builder.yml#L12-L57) ·
[Static C runtime](../.cargo/config.toml#L1-L6)

The release script checks the packaged fuses, ASAR contents, engine version
and notices, then verifies both artifacts. It writes a release manifest and
SHA-256 checksums.
[Release verification](../scripts/release/build.mjs#L112-L145)

Help → Check this computer runs three bundled inputs in separate engine
processes. It checks the engine and protocol versions and compares the final
state hashes for balanced hover, a flight with sensors and a roll-rate step
test. The dialog reports the CPU and the result for each run.
[Help command](../electron/main/index.ts#L210-L226) ·
[Self-check logic](../electron/main/self-check.ts#L24-L102)

## Coordinate and unit conventions

SI units, `f64` state, right-handed Z-up world frame (+X forward, +Y left,
+Z up), gravity `(0, 0, -9.80665)`. Conversions (e.g. NED for PX4) happen only
at integration boundaries.
