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
| `{"id":n,"type":"sim.run","durationS",environment,startPositionM?,dtS?,forceBodyN?,torqueBodyNm?,throttle?,rotorSpeedsRadps?,airDensityKgM3?,controller?}` | `{steps, dtS, durationS, gravityMps2, state, stateHash, contacts:[{partId, with, startS, endS}], contactsDropped, motors?:[{partId, throttle, rpm, thrustN, dragTorqueNm}], battery?:{voltageV, currentA, chargeUsedC, stateOfCharge}, controller?:{saturatedSteps, rateIntegral, collectiveThrust}}`: the loaded vehicle from rest at `startPositionM`, at most 120 000 steps. Without propulsion: constant body-frame inputs. With propulsion (4.6, engine-core `flight.rs`): the throttles (vehicle motor order, held) drive the motors, battery and body drag; `airDensityKgM3` is required with drag; `stateHash` then includes the rotor speeds and the charge used. With `controller` (4.7, engine-core `closed_loop.rs`): `{altitudeM?, climbRateMps?, attitude?, yawRateRadps?, gains?, thrustModelFactor?}` instead of `throttle`, the PX4 v1.13.3 controller flies the setpoint (gains overridden by exact PX4 name). `environment` is required: `{ground:{friction,restitution}\|null, obstacles:[{id,center,halfExtents,quaternion,friction,restitution}]}`, every coefficient the user's (no defaults). In 5.4, `controller.mode` selects `rates`, `stabilized`, `altitude` or `position`. Rates takes `bodyRadps` (body FLU) and `collective` in [0, 1]. The other modes take `sticks:{forward,right,yawRight,throttle}`, each in [−1, 1]. With a mode, `dtS` must divide 10 ms (PX4 `ekf2_params.c:53`). With a mode, `gains` also accepts position and HTE names and `MC_AIRMODE`. Optional `airmode` takes 0, 1 or 2, and must agree with `gains.MC_AIRMODE` when both are supplied. Both controller paths accept `thrustModelFactor` or `gains.THR_MDL_FAC`. The optional `flightLoop` result gives the final step's `{mode, positionSetpointM, velocitySetpointMps, accelerationSetpointMps2, saturation, velocityIntegral, hoverThrust:{estimate,variance,valid}}`. The mode reflects the ground stand-in. Setpoints use world Z-up with null for unavailable components. |
| `{"id":n,"type":"flight.session.start",environment?,startPositionM?,airDensityKgM3?,cutoff:{type:"voltageV"\|"chargeMah",value},gains?,controller?}` | `{dtS, maxStepsPerRequest, diagnostic}` (4.8): starts a live flight of the loaded vehicle (with propulsion) under the PX4 controller, replacing any session. The battery cut-off is the user's; there is no default. To use FlightLoop, pass `controller:{mode,airmode?,thrustModelFactor?}` and optional top-level `gains` as in the mode-based run. Attitude-hold sessions use `gains.THR_MDL_FAC`. Mixer settings are fixed when the session starts. |
| `{"id":n,"type":"flight.session.step","steps":n,"setpoint":{…}}` | `{stepsRun, diagnostic, contacts, contactsDropped, endReason, stateHash}`: advances at most 100 fixed 1 ms steps with the setpoint (`altitudeM?`, `climbRateMps?`, `attitude?`, `yawRateRadps?`) held. `diagnostic` = state, per-motor readings, battery, the loads by source, air density and the controller's last step. Any chunking of one setpoint ends in the hash of one controller `sim.run`. A FlightLoop session takes the same rates or stick fields as a mode-based run. `setpoint.mode` changes the selected mode for this and subsequent steps. `diagnostic.flightLoop` reports the latest step as above and `diagnostic.control` is reserved for 4.7. A FlightLoop failure returns `INVALID_PARAMS` with its message and ends the session. |
| `{"id":n,"type":"flight.session.end"}` | `{ended}` |
| `{"id":n,"type":"scenario.run",scenario:{type:"builtin",name,massKg?,offsetM?}\|{type:"custom",scenario},config}` | `{scenario, report, stateHash}` (4.9): flies a scripted scenario (`balanced_hover`, `payload`, `overweight_payload`, `com_offset`, `com_offset_beyond_authority`, or a full scenario) on the loaded vehicle. `config` gives the air density, the battery cut-off, optional gains and `thrustModelFactor`, and optionally a ground and a start position. At most 60 s of simulated time, 10 s with a ground |
| `{"id":n,"type":"stepTest.run",test:{step,holdS,durationS,decimationSteps},config}` | `{trace,stepTimeS,elapsedS,hoverCollective01,startImbalanceNm,gains,stateHash,endReason,error}` (5.7). Runs a rate, attitude, altitude, or horizontal position step on the loaded vehicle in free space for up to 60 s. `config` supplies air density, battery cut-off, and optional manual-flight gain and mixer overrides, including `thrustModelFactor`. The result reports the effective factor in `gains.THR_MDL_FAC` and the equilibrium collective in thrust space. The trace samples exact state and applied motor signals at simulation steps 0, n, 2n, … for the requested decimation n |

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

## Flight control

`engine-core/src/controller.rs` contains the PX4 v1.13.3 attitude controller,
rate PID and allocator. `position_control.rs` owns position and velocity control
on all three axes, including the vertical path shared by `ClosedLoop` (direct
attitude/altitude setpoints and scenarios) and `FlightLoop` (manual modes and
step tests). `flight_modes.rs` maps pilot sticks to controller setpoints.
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
