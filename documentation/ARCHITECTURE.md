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
| `{"id":n,"type":"flight.session.start",environment,wind?,groundEffect?,startPositionM?,startClearanceM?,airDensityKgM3,cutoff,gains?,controller?,sampleEverySteps?}` | `{dtS,maxStepsPerRequest,diagnostic,channels?,samples?}`. Sampling adds the fixed channel order and one row at step 0. `sampleEverySteps` is a positive JSON safe integer. Omit it to leave sampling off. Starts a flight of the loaded vehicle with propulsion, replacing any session and its log. The battery cut-off is the user's choice of `voltageV` or `chargeMah` with a positive value. Environment, wind and ground effect use the batch run format. `controller:{mode,airmode?,thrustModelFactor?}` selects FlightLoop. Attitude-hold sessions use `gains.THR_MDL_FAC`. Mixer settings and [Return gains](../database/reference/README.md) are fixed at start. |
| `{"id":n,"type":"flight.session.step",steps,setpoint}` | `{stepsRun,diagnostic,contacts,contactsDropped,endReason,stateHash,samples?}`. When sampling is enabled, includes the rows taken during this request. Advances 1–100 fixed 1 ms steps, subject to the battery cut-off. FlightLoop takes rates or sticks and optional `setpoint.mode` to select the manual mode for this and subsequent steps. It also accepts `setpoint:{command:{type:"takeoff",altitudeM?}}`, `{command:{type:"hold"}}`, `{command:{type:"land"}}` or `{command:{type:"return"}}`. Takeoff altitude is metres above the starting CoM along world +Z and defaults to `MIS_TAKEOFF_ALT`. Attitude sessions refuse auto commands. `diagnostic.flightLoop` and batch `flightLoop` give the latest mode, `autoMode`, `takeoffState`, `landState`, `commandFinished`, setpoints, saturation, velocity integral and hover-thrust estimate. FlightLoop sessions also emit `returnState` while `autoMode` is `return`. Setpoint vectors use world Z-up with null for unavailable components. Hold is active when takeoff finishes or a hold setpoint is captured. Land and Return finish when the detector reports landed. `diagnostic.loads` includes wind at the CoM in world m/s, added thrust in N, per-motor ground-effect status, and wind range and validity flags. Ground-effect status is empty when off. A FlightLoop failure returns `INVALID_PARAMS` and ends the session. <br><br>The engine samples at step 0 and after each completed step whose absolute index is divisible by the interval. Each `samples` object pairs `steps` with `rows`, in increasing step order. A step request that advances no scheduled samples has empty arrays. The step at battery cut-off is eligible when it advances the simulation. Flags use 0 and 1. Inactive, missing, and non-finite values use null. The physical contact flag uses the simulation contact state, first updated by the physics step. See [the channel table](../src/domain/telemetry-channels.ts) for the column metadata and enum codes. |
| `{"id":n,"type":"flight.session.log"}` | `{start,steps}`. The original accepted start request and ordered accepted step requests, including their IDs and decimal tokens. Replay can assign new request IDs and uses the same loaded vehicle. The log is in memory, grows with accepted requests and is cleared on end or restart. Neither NDJSON line reader imposes a message-size limit. |
| `{"id":n,"type":"flight.session.end"}` | `{ended}`. Drops the session and its log. |
| `{"id":n,"type":"scenario.run",scenario:{type:"builtin",name,massKg?,offsetM?}\|{type:"custom",scenario},config}` | `{scenario,report,stateHash,channels?,samples?}`. Optional `config.sampleEverySteps` adds the channel order and all samples, including step 0. Flies a scripted scenario on the loaded vehicle. `config` supplies air density, cut-off, optional gains and `thrustModelFactor`, optional `wind` and `groundEffect` in batch format, and optional `environment` and `startPositionM` together. With a ground, it also accepts `startClearanceM`. Custom scenarios use either the legacy `script` and `checks` or a `flightScript` of timed Position, Takeoff, Hold and Land commands with empty legacy arrays. The duration limit is 60 s in free space and 10 s for custom or legacy scenarios with an environment. The two landing built-ins use their fixed 34 s sequence. The report adds `flight` measurements for the four acceptance built-ins. <br><br>The largest schedule is 60,001 rows at one sample per step (60 s at 1 ms, plus step 0). For `M` motors a row has `C = 125 + 8M` columns in FlightLoop or `C = 86 + 8M` in attitude hold. With at most 24 bytes per float (Cargo.lock's zmij formatter, `lib.rs:125`), the compact `samples` object is bounded by `60,001 × (25C + 9) + 22` bytes, including the step indices and JSON punctuation. The engine uses serde_json and zmij (simulation-engine/Cargo.lock:476-486,602-605). This is 236,043,956 bytes for four FlightLoop motors and 260,044,356 for six. Add the original response bytes, the compact channel list bytes and 23 bytes for the two member names and separators. Vehicle motor count and echoed scenario data have no fixed protocol cap, so the full response has no single byte maximum. |
| `{"id":n,"type":"stepTest.run",test:{step,holdS,durationS,decimationSteps},config}` | `{trace,stepTimeS,elapsedS,hoverCollective01,startImbalanceNm,gains,stateHash,endReason,error}`. Runs a rate, attitude, altitude or horizontal position step in free space for up to 60 s. `config` supplies air density, cut-off, optional gain and mixer overrides, and optional `wind` and `groundEffect` in batch format. Free space provides no surface for ground effect. The trace samples state and applied motor signals at the requested decimation. |

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

**Planned evolution:** simulation control commands (Phase 4–6) are added to the
same channel. High-rate state/telemetry streaming will use a dedicated
binary-framed stream forwarded to the renderer through a `MessagePort`, so the
renderer receives frames without going through `ipcMain` per message.

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
- `BLAZE_UAV_USER_DATA` and (unpackaged builds only) `BLAZE_UAV_ENGINE` override
  the data directory and engine path for tests.

## Storage

SQLite (`better-sqlite3`, Node-API prebuilds, loads in both Node and Electron)
at `<userData>/blaze-uav.db`, WAL mode, foreign keys on. Schema version =
`PRAGMA user_version`; migrations in `database/migrations/NNNN_*.sql` are
append-only and run in a transaction each. Opening a DB from a newer app version
is refused rather than risking data loss.

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
`blaze-asset://model/<sha256>`, a privileged protocol whose handler serves exact
ids from that folder and nothing else. Units and up axis are part of each model
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

## Security

`contextIsolation`, `sandbox`, no `nodeIntegration`; CSP header (`script-src 'self'`
in production); navigation and `window.open` blocked (https links go to the
system browser); every IPC payload validated with zod in main; renderer only
receives `{ok, data} | {ok:false, error:{code, message}}` with internal errors
logged, not leaked.

## Coordinate and unit conventions

SI units, `f64` state, right-handed Z-up world frame (+X forward, +Y left,
+Z up), gravity `(0, 0, -9.80665)`. Conversions (e.g. NED for PX4) happen only
at integration boundaries.
