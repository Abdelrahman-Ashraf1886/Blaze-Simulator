# Phase 6 plan: flight environment

Status (2026-11-24): **Built through 6.10**, with 6.0b and the optional milestones open.

- **Built** — 6.0a (sources), 6.1 (wind), 6.2 (ground effect), 6.3 (flight loads), 6.4 (terrain and obstacles), 6.5 (host, storage and replay), 6.6 (input devices), 6.7 (takeoff and landing), 6.8 (cameras), 6.9 (UI), 6.10 (acceptance and docs).
- **6.0b pending** — user pass limits in D2. No stream measurement ran.
- **6.11 and 6.12 optional** — turbulence and return remain open.
- **6.10 catalogue result** — wind hold, gust recovery and the ground-plane sequence passed. The 45° terrain run failed horizontal hold and landing-state checks. [Measured results](../DEVLOG.md#2026-11-24--phase-6-flight-environment)

Written 2026-11-23 against `phase-1-foundation` at d23ccc7 (Phase 4 done; 5.0–5.2, 5.5 and
5.6 merged). 5.3 (`flight_modes.rs`) and 5.10a (`hover_thrust.rs`) exist only as unverified
work in progress on `codex/p5-3-flight-modes` and `codex/p5-10a-hover-thrust`; `flight_loop.rs`
does not exist yet. Names taken from them may change. Phase 5's decisions are written
"P5-D2", "P5-D7" here, to keep them apart from this plan's D1, D2, ….

## Goal

You can fly the drone you built in a place that resembles where it would fly:
- in wind, from a constant wind to gusts, and near the ground with a cited ground-effect model;
- over your own terrain, around obstacles that are more than boxes;
- with a gamepad or an RC transmitter, through a calibration you make;
- with a takeoff and a landing that behave as PX4's do, instead of our stand-in;
- seen from a camera you choose.

A flight stays reproducible: the same start, inputs and seed give the same state hash.

## What is already delivered, and what Phase 6 adds

| Area | Already built (or planned in Phase 5) | Phase 6 adds |
|---|---|---|
| Ground and box obstacles, friction and restitution entered by the user, contact reports | 4.4: `environment.rs`, `src/domain/environment.ts`, `EnvironmentPanel.tsx` (up to 50 boxes) | Nothing for these. Terrain and more obstacle shapes (D9, D11) |
| Engine ↔ renderer stream | 4.8: `flight.session.start/step/end`, one request per animation frame, at most 100 steps (the renderer caps it at 50) | A measurement first; a different stream only if it fails (D2) |
| Keyboard sticks | 4.8: `sticks.ts` (30°, 90°/s, 2 m/s UI limits). 5.3/5.4/5.8 replace these limits with PX4's stick mapping | Nothing for the keyboard. Gamepad and RC devices (D12) |
| Flight modes rates, stabilized, altitude, position | 5.3, 5.4, 5.8: they take normalised sticks | Nothing for these. Takeoff, land, hold (D15) |
| Takeoff and landed state | Phase 5's stand-in: altitude and position modes only without ground contact | PX4's takeoff ramp and landed detector replace it (D15) |
| Flight view, obstacles drawn, spinning propellers, debug panel, indicators | 4.8: `FlightViewport.tsx`, `DebugPanel.tsx`, `rotor-spin.ts` | Nothing for these, beyond drawing the new environment and showing the new loads |
| Camera | 4.8: one follow camera, fixed world offset, not turning with the vehicle | Chase, orbit, fixed, FPV (D17) |
| Air density | 4.8: ISA at the entered altitude and temperature, k_T and k_Q scaled per motor | Nothing |
| Body drag | 4.5/4.6: per body axis from the velocity over the **ground** (`Flight::step` passes the CoM velocity) | The same formula from the velocity through the **air** (wind, D3) |
| Wind, ground effect | Not built. In the ROADMAP under Phase 4, deferred by its plan; the Phase 5 plan recommends Phase 6 | D1 |
| Scripted scenarios | 4.9: `scenario.rs`, `scenario.run`, the page; 5.7 adds time series and step tests | Optional wind in a scenario's environment. No new scenario system |
| Determinism | 4.8: any chunking of one setpoint gives the hash of one `sim.run` | The same property with wind, turbulence, devices and auto modes (D18) |
| Graphs, telemetry, CSV, replay UI, sensor models | None; Phase 7 | None (D18 draws the line) |

## Candidate scope, judged against what exists

| Candidate | What exists | Judgement |
|---|---|---|
| **Free-running real-time stream** | Lockstep: no clock in the engine, so a run is a pure function of its inputs. Stick-to-motion delay is about one frame plus a round trip. A slow frame slows the simulation instead of dropping steps | Lockstep is probably enough; it was measured only indirectly (DEVLOG 4.4: a contact step ≈ 0.2 ms, so 17 steps ≈ 3.4 ms). A free-running engine would have to timestamp and log every input to stay reproducible, and would compete with the health ping of the single-threaded host. Measure first (6.0b) |
| **Terrain** | A plane at z = 0 | Worth adding by import. Nothing is generated: invented terrain would be data nobody stated. rapier 0.36.1 has a heightfield collider (`ColliderBuilder::heightfield`) |
| **Richer obstacles** | Boxes with a yaw | Cylinders (poles, trunks) are cheap. Imported models can reuse the 4.4 convex hulls. A concave mesh is not: it needs a triangle mesh, which is hollow |
| **Gamepad / RC transmitter** | Keyboard | Needed: position and stabilized modes are hard to judge with on/off keys. Chromium's Gamepad API covers devices that present themselves as a game controller, which RC transmitters in USB joystick mode do (**to verify** on your transmitter) |
| **Auto modes** | None. P5-D2 says they need a mission and a takeoff/land state machine, "which belong with Phase 6"; P5-D7 says "Phase 6 adds input devices, cameras, auto modes" | They belong here by those decisions, but not all of them. Takeoff ramp and landed detector are small (134 and 352 lines) and replace a stand-in. Missions are large (`mission.cpp` 1936 lines, plus navigator, waypoint storage and an editor) |
| **Cameras** | Follow | Cheap, renderer only. FPV needs a camera part's pose, which exists, and a field of view, which does not |
| **Constant wind, shear, gusts** | None | The most useful single addition: it exercises the position integrators that Phase 5 builds. The equation is the existing drag with a relative velocity |
| **Turbulence (Dryden, von Kármán)** | None | Cited formulas exist, but their validity at hover is disputed by a source we read (see Models). Worth adding only with that stated on screen |
| **Ground effect** | None | The single-rotor formula is read from the primary source. For several rotors the measurements found disagree with it, in both directions (see Models) |
| **Recording and replay** | None; the engine is replayable | Phase 7 owns it. Phase 6 only guarantees that a recorded input log would replay exactly (D18) |

## Decisions (made with you)

Decided on 2026-11-23: every recommendation accepted.

| # | Question | Options | Decision |
|---|---|---|---|
| D1 | Do wind and ground effect move to Phase 6? | (a) yes, both; (b) wind only; (c) a later phase | **Decided: (a)**, wind first. They act through the environment, and the Phase 5 plan already points here. The ROADMAP's Phase 4 row would then say so (edited in 6.10, not now) |
| D2 | Engine ↔ renderer stream | (a) keep the 4.8 lockstep; (b) lockstep with one request in flight while the previous frame is drawn; (c) a free-running engine clock with a binary stream over a `MessagePort` (ARCHITECTURE's planned evolution) | **Decided: (a)**, gated by 6.0b: frame time, request time and stick-to-frame delay at 60 Hz on a built-in build, with and without ground contact. You set the limits that count as failing. (b) if only throughput fails. (c) makes a run depend on wall-clock timing unless every input is logged with its step number, so it needs its own ADR |
| D3 | Which wind | (a) constant; (b) (a) + shear with height + one discrete gust; (c) (b) + turbulence | **Decided: (b)** in the core milestones, turbulence as D4. Speed, direction and gust values are your entries; "no wind" is an explicit state, not a missing value |
| D4 | Turbulence | (a) none; (b) Dryden; (c) von Kármán; (d) both | **Decided: (b)**, optional (6.11), off unless you turn it on, with the hover caveat on screen. Its filters are exact first- and second-order ones; von Kármán's filters are approximations to a spectrum that is not rational. If you would rather not ship a model a source calls "not applicable to hovering flight", choose (a) |
| D5 | Turbulence specification (if D4 is not (a)) | (a) MIL-F-8785C; (b) MIL-HDBK-1797 / 1797B | **Decided: (a)**. Madden (below) shows that the factor-of-2 difference in lateral and vertical length is a definition and the mathematics are the same; the 8785C form is simpler. Precondition: the primary text is obtained (6.0a) |
| D6 | How wind acts on the rotors | (a) only through body drag, rotor thrust stays the static k_T·ω² at any airspeed (as now), said on screen; (b) (a) plus a linear rotor-drag coefficient you enter; (c) inflow from propeller data at advance ratio | **Decided: (a)** now. Rotor drag is of the form −R·D·Rᵀ·v, identified per vehicle from flight data (Faessler et al.), so it cannot be derived; (b) is an optional field, "not modelled" when empty. (c) needs the V > 0 rows of the APC files, which are computed data and were not stored in Phase 4; a candidate for later |
| D7 | Ground-effect model | (a) none; (b) Cheeseman–Bennett eq. 2 (zero airspeed); (c) eq. 4 (with airspeed); (d) a multirotor correction | **Decided: (c)**, per rotor, off until you turn it on, labelled "single-rotor model; interaction between rotors is not modelled". (d) has no formula we could read |
| D8 | Where the ground effect applies | (a) the ground plane and terrain only; (b) also over obstacles | **Decided: (a)**. The derivation is an infinite flat ground (image method). Over the edge of a box it does not hold, and no source for a partial disc was read |
| D9 | Terrain | (a) none, plane only; (b) an imported heightfield replaces the plane; (c) (b) + a generated one | **Decided: (b)**. (c) invents data. One friction and one restitution for the whole terrain, your entries, as for the plane |
| D10 | Terrain file | (a) Esri ASCII grid (`.asc`); (b) GeoTIFF; (c) 16-bit greyscale image + sizes you enter | **Decided: (a)**: plain text, states its own cell size, no new dependency, read from the documentation. A `NODATA` cell or a vertical unit that is not metres is refused or asked, not filled in. (b) needs a decoder and a projection; (c) states neither scale nor units |
| D11 | Obstacle shapes | (a) boxes only; (b) + vertical cylinders; (c) (b) + imported models as convex hulls | **Decided: (c)**. Hulls come from 4.4's `hull.ts`, and the UI says the hull, not the visible mesh, is what collides. Concave meshes stay out (hollow triangle meshes, contact cost) |
| D12 | Input device access | (a) Gamepad API in the renderer; (b) WebHID; (c) a native module in main | **Decided: (a)**. Works in the sandbox, no permission handler and no native code. (b) exposes raw reports we would have to parse per device. (c) breaks "no Node ABI coupling" (ADR 0001) |
| D13 | When the device disconnects or the window loses focus in flight | (a) centre the sticks and go on; (b) pause the simulation; (c) PX4's RC-loss failsafe | **Decided: (b)**, stated on screen with a resume button; it needs nothing invented, because lockstep simply stops asking for steps. The keyboard keeps today's behaviour (focus loss clears keys). (c) needs the commander's failsafe logic, which is not ported |
| D14 | Where calibration is kept | (a) per machine and device id in `src/lib/prefs.ts`; (b) SQLite; (c) per project | **Decided: (a)**. It describes the device, not the build. The file's own rule is "never project data", and this is not. Losing it means calibrating again |
| D15 | Auto behaviours in Phase 6 | (a) none; (b) PX4 takeoff ramp and landed detector, plus takeoff, hold and land; (c) (b) + return; (d) (c) + missions | **Decided: (b)**, with return as optional 6.12 and missions as a phase or plan of their own (waypoint storage, editor, fence, delays). Hold alone is position mode with centred sticks, already in 5.3; here it is the state after a takeoff |
| D16 | Arming | (a) Start arms, Stop ends the run, no separate state; (b) explicit arm and disarm | **Decided: (a)**. PX4's takeoff states begin at "armed"; a separate arm step adds pre-arm checks we would not port. The spool-up time (`MPC_SPOOLUP_TIME`) still runs. After a landing the run stays in "ready for takeoff", as PX4 does when not disarmed |
| D17 | Cameras | (a) follow only; (b) + chase and orbit; (c) + fixed and FPV | **Decided: (c)**. FPV mounts on a camera part you pick, at its stored pose. The field of view is your entry on that part (no source states one for the built-in parts); without it FPV is listed as unavailable, with a link. Chase, orbit and fixed distances are view preferences, not physics |
| D18 | Recording boundary with Phase 7 | (a) nothing in Phase 6; (b) an input log (start request, then per request: steps, setpoint or sticks, mode) kept in memory, with a test that replaying it gives the same hash; (c) (b) + saved to disk and a replay UI | **Decided: (b)**. It fixes the format and proves determinism where it is cheapest. Saving, graphs, CSV and replay UI are Phase 7 |
| D19 | Order | (a) wind, ground effect, then terrain, devices, auto; (b) devices and cameras first | **Decided: (a)** for the engine work, with devices and cameras in parallel: their files do not overlap. See Waves |

## Where each calculation lives (ADR 0006, ADR 0008)

| Calculation | Where | Why |
|---|---|---|
| Wind at a point and time (constant, shear, gust, turbulence), seeded random numbers | `engine-core`: `wind.rs` | In the 1 kHz loop, deterministic, its state in the hash |
| Ground-effect ratio per rotor | `engine-core`: `ground_effect.rs` | Same |
| Wind and ground effect in the step, loads by source | `engine-core`: `flight.rs` | The only place forces are summed |
| Terrain and obstacle colliders, height below a point | `engine-core`: `environment.rs` | Contacts and heights from the same geometry |
| Terrain file → grid, its checks and refusals | `src/domain/terrain.ts` (pure TS); main validates the file, the engine re-validates the grid | The editor shows the same grid the engine collides with. "The engine trusts nothing" (ADR 0006) |
| Environment and wind documents → engine payload, missing values | `src/domain/environment.ts` (existing), `src/domain/wind.ts` (pure TS, conversions and readiness only, no wind formula) | One implementation of the model, in Rust |
| Axis calibration and mapping to sticks in [−1, 1] | `src/domain/input-mapping.ts` (pure TS) | Testable without a device. No expo and no limits: those are PX4's, in `flight_modes.rs` (P5-D7) |
| Polling the device | `src/features/input/*` (renderer) | Browser API |
| Takeoff ramp, landed detector, takeoff/hold/land setpoints | `engine-core`: `takeoff.rs`, `land_detector.rs`, `auto_modes.rs` | Same loop, same estimate as 5.3 |
| Protocol, session handling, input log | `engine-host` | No physics |
| Cameras, terrain mesh, wind arrow, panels | Renderer | Draws values. Camera motion never feeds back into the simulation |

**Storage.** Wind and the ground-effect switch extend `assemblies.flight_json`; terrain and
obstacle shapes extend `environment_json`. Both are JSON columns, so only their zod schemas
change. The terrain file itself goes to the asset store (ADR 0004). Its table fixes
`format IN ('glb','gltf')` and requires triangle counts, so terrain needs a migration, whose
number is taken when 6.5 starts (0013 is the latest now).

**Frames.** World Z-up, +X forward, +Y left (ADR 0003). Wind is entered as the direction it
blows **from**, in degrees **clockwise** seen from above, relative to world +X, because the
project has no north (the panel says so). A wind "from" angle β with speed W is
w = −W·(cos β, −sin β, 0). An Esri grid's row 1 is its top row; the mapping to world axes
is "column → +X, up the file → +Y", stated in the panel.

## Models and citations

Read on 2026-11-23 unless marked. "To verify" means: read before coding, and the plan changes
if it turns out different.

### Wind in the flight step

Drag as in 4.6 with the air-relative velocity: v_b = Rᵀ(v − w), F_b,i = −½ρ·C_d,i·A_i·v_b,i·|v_b,i|.
This is the definition of the existing formula (its velocity is relative to the air), not a
new constant. It acts through the CoM as now: no drag moment and no wind shear across the
vehicle (stated). Vertical wind affects drag only; rotor inflow is not modelled (D6).

**Rotor drag** (optional, D6(b)): v̇ = −g·z_W + c·z_B − R·D·Rᵀ·v, eq. 2 of Faessler, Franchi and
Scaramuzza, "Differential Flatness of Quadrotor Dynamics Subject to Rotor Drag…", IEEE RA-L
2018, https://ar5iv.labs.arxiv.org/html/1712.02402. The model is stated for no wind; D is
mass-normalised and identified per vehicle from measured flight data. So D is a user input
with its source, and replacing v by v − w is our extension, labelled as such.

### Mean wind with height, and a discrete gust

Source read: MathWorks Aerospace Blockset documentation, which cites **MIL-F-8785C**
(5 November 1980) for both:
- shear, https://www.mathworks.com/help/aeroblks/windshearmodel.html:
  u(h) = W20·ln(h/z0)/ln(20/z0), h and z0 in ft, 3 ft < h < 1000 ft; z0 = 0.15 ft for
  Category C (terminal phases), 2.0 ft otherwise;
- gust, https://www.mathworks.com/help/aeroblks/discretewindgustmodel.html: 0 for x < 0,
  (V_m/2)(1 − cos(πx/d_m)) for 0 ≤ x ≤ d_m, V_m after; x the distance travelled.

**6.0a result (2026-11-23).** MIL-F-8785C was obtained and read in part (EverySpec scan, page images; not re-checked by the reviewer). It confirms the shear formula and both z0 (§3.7.3.2, p. 51) and the 1 − cos gust (§3.7.1.3, p. 48), so these two citations are now primary. It states no height range for the shear (3–1000 ft is MathWorks only, so the 3 ft hold and the 1000 ft refusal stay labelled secondary), gives 10–1000 ft for the low-altitude turbulence lengths, gives turbulence spectra but no filters, and does not say whether the gust x is measured through the air. The paragraph below is the text as first written.

Both are **secondary**: the primary text was not obtained (see Not found). The page does not
define how x follows from time. Our reading, to verify in 6.0a: x is the distance through the
air since the gust start, x = ∫|v − w_mean| dt. W20, the direction, z0 (one of the two cited values,
picked by you, or your own), V_m, d_m and the start are user inputs. Below 3 ft the speed at
3 ft is held: our convention, since the formula's range ends there.

### Turbulence (optional, D4)

Source read: MathWorks, https://www.mathworks.com/help/aeroblks/drydenwindturbulencemodelcontinuous.html
and `vonkarmanwindturbulencemodelcontinuous.html` on the same site, citing MIL-F-8785C,
MIL-HDBK-1797 (1997) and 1797B (2012). Dryden, MIL-F-8785C form:
- H_u = σ_u·√(2L_u/(πV)) / (1 + (L_u/V)s);
  H_v = σ_v·√(L_v/(πV))·(1 + √3(L_v/V)s)/(1 + (L_v/V)s)², H_w alike;
- below 1000 ft: L_w = h, L_u = L_v = h/(0.177 + 0.000823h)^1.2, σ_w = 0.1·W20,
  σ_u = σ_v = σ_w/(0.177 + 0.000823h)^0.4 (h, L in ft). Above 1000 ft is out of scope: refused.

The page text loses radical signs when fetched, so the square roots above come from the
spectra; 6.0a checks every formula against the primary text.

The white-noise normalisation, discretisation and verification method are in M. Madden,
"Verifying Implementation of the Dryden Turbulence Model and MIL-F-8785 Gust Gradient", NASA
Langley, https://ntrs.nasa.gov/citations/20190000875 (read in part): zero-order hold for the
noise input, numerators kept inside the filters because V and L vary, and a footnote that the
MIL-HDBK-1797 lengths differ by definition while "the mathematics remain unchanged".
Gust gradients (angular rates) use a wing span, which a multirotor does not have: **not
implemented**.

**Two limits that must be on screen:**
1. The model is a frozen field the vehicle moves through. Juhasz et al., "Turbulence Modeling
   of a Small Quadrotor UAS Using System Identification from Flight Data", AHS 2017
   (https://gcp-web.sjsu.edu/researchfoundation/docs/AHS_2017_Juhasz.pdf), say a Dryden-type
   model "is not applicable to hovering flight" and use an identified model instead, which
   needs flight data of the vehicle.
2. V is in every filter, and the source states no minimum. Our V is the airspeed relative to the mean wind,
   |v − w_mean|, so a hover in a mean wind has V = wind speed. Integrated over air distance ds = V·dt,
   the filters stay finite as V → 0 (the gust then stops changing). That is our derivation, and
   the physical limit is the frozen field itself.

The seed is a user-visible integer saved with the run. The generator is ours, in Rust with no
platform dependency; the algorithm is picked in 6.11 and cited.

### Ground effect

**Primary source, read as page images:** I. C. Cheeseman and W. E. Bennett, "The Effect of the
Ground on a Helicopter Rotor in Forward Flight", ARC R&M 3021, September 1955,
https://naca.central.cranfield.ac.uk/handle/1826.2/3590. Z is the height of the rotor hub
above the ground (list of symbols, p. 7), R the rotor radius:
- eq. 2 (p. 2), zero airspeed, **constant power**: T_g/T_∞ = 1/(1 − R²/(16Z²));
- eq. 4 (p. 2), forward speed: T_g/T_∞ = 1/(1 − (1/16)(R/Z)²·1/(1 + (V_i/v_i)²)), with
  V_i = V√σ_ρ (σ_ρ the relative air density) and v_i the induced velocity;
- "For very small values of Z/R large errors are introduced" (p. 2); no numeric limit is given.

How we would apply it, each point a stated assumption:
- T = G·k_T·ω², with Q = k_Q·ω² unchanged. At a given ω the shaft power Q·ω is then unchanged, as
  in the source's constant-power comparison. A fixed-pitch propeller may change its torque near the ground;
  that is not modelled. (The report's constant-speed form, eq. 6, needs blade chord and lift
  slope, which no source here states.)
- Z is the vertical height of the propeller hub above the ground or terrain; tilt is ignored.
- v_i in eq. 4: the report says it follows from momentum theory or empirical curves (p. 4); the
  exact expression is fixed in 6.2. V is the rotor's horizontal airspeed.
- R is the propeller part's radius. `PropulsionDefinition` does not carry it, so it is sent
  per motor with the ground-effect setting.

**What measurements say.** P. J. Sanchez-Cuevas, G. Heredia and A. Ollero (University of
Seville, ROBOT 2017, preprint, https://zenodo.org/record/2621464): a small single rotor (6 to
20 inch) follows eq. 2, significant from Z/R ≈ 2, with a measured ratio of about 1.2 at
Z/R ≈ 0.5, where eq. 2 gives 1.33. For **two** rotors side by side the thrust first falls
**below** its free value (minimum near Z/R ≈ 1.5) and then rises above it, and the classical
model "is not valid". The same paper cites others who find the effect in multirotors larger
than predicted. So near the ground the sign of the error for a multirotor is not known.

Consequence: below Z/R = 0.5, the lowest height in that test, the value at 0.5 is held and the
debug panel says "outside the tested range". The limit is cited (the test's lower end), the
hold is ours.

### Takeoff, landing and hold (PX4 v1.13.3, as Phase 5)

Prefix: `https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/`.

| What | Source | Our use |
|---|---|---|
| Takeoff states (disarmed, spool-up, ready, ramp-up, flight) | `src/modules/mc_pos_control/Takeoff/Takeoff.cpp` L48–110 | Ported (D15(b)) |
| Climb-speed ramp | same, L42–46, L112–134 | Ported; `MPC_TKO_RAMP_T` 3 s |
| Landed detector: ground contact, maybe landed, landed | `src/modules/land_detector/MulticopterLandDetector.cpp` L155–325, hysteresis L344–350; constants in the `.h` (300 ms, 2 s, 1 m) | Ported on true states; no distance sensor, so the close-to-ground check is skipped as PX4 does when unavailable (L235) |
| Land setpoints: descent speed by height, position held | `src/modules/flight_mode_manager/tasks/Auto/FlightTaskAuto.cpp` L232–287 | Ported without stick help, avoidance or gear. The descent limit is `MPC_Z_VEL_MAX_DN` (L239), not `MPC_Z_V_AUTO_DN`. The crawl below `MPC_LAND_ALT3` needs a range sensor (L241–245), which the vehicle has not, so `MPC_LAND_CRWL` and `MPC_LAND_ALT3` are not used. Without one, "height" is the height above the start, not above terrain (`tasks/FlightTask/FlightTask.cpp` L191–198) |
| Takeoff and hold setpoints: position target through a smoothed trajectory | same, L118–224; `src/lib/motion_planning/PositionSmoothing.cpp` (326 lines), `VelocitySmoothing.cpp` (303 lines) | **To verify**: both smoothing files are unread. If large, the first cut uses 5.1's limits without jerk smoothing and says so |
| Tilt limit until flight, thrust minimum, `MPC_TILTMAX_LND` | `MulticopterPositionControl.cpp` L425–450 (Phase 5 plan) | **To verify** with the Phase 5 code |
| Return (optional) | `src/modules/navigator/rtl.cpp` (940 lines: climb, return, descend, loiter, land) | States seen at L341–545, not read in detail |

Parameters (default, line): `MPC_TKO_SPEED` 1.5 (L451), `MPC_TKO_RAMP_T` 3.0 (L764),
`MPC_SPOOLUP_TIME` 1.0 (L797), `MPC_LAND_SPEED` 0.7 (L415), `MPC_LAND_CRWL` 0.3 (L425),
`MPC_LAND_ALT1/2/3` 10/5/1 (L721, L736, L751), `MPC_Z_V_AUTO_UP` 3 (L215), `MPC_Z_V_AUTO_DN` 1 (L245),
`MPC_JERK_AUTO` 4 (L621), `MPC_YAWRAUTO_MAX` 45 (L706) in `mc_pos_control_params.c`;
`LNDMC_TRIG_TIME` 1.0 (L48), `LNDMC_Z_VEL_MAX` 0.5 (L60), `LNDMC_XY_VEL_MAX` 1.5 (L72),
`LNDMC_ROT_MAX` 20 (L84) in `land_detector_params_mc.c`; `MIS_TAKEOFF_ALT` 2.5
(`navigator/mission_params.c` L58); for return, `RTL_RETURN_ALT` 60 (L59), `RTL_DESCEND_ALT` 30
(L75), `RTL_LAND_DELAY` 0 (L90), `RTL_MIN_DIST` 10 (L106) in `navigator/rtl_params.c`. Units and
ranges are read into the reference data in 6.0a.

### Input devices

W3C Gamepad, https://w3c.github.io/gamepad/: axes are normalised to [−1, 1] and buttons to
[0, 1]; −1 is forward/up/left, so **stick axes 1 and 3 are negated** for PX4's positive
forward and up; `mapping` is `"standard"` or `""` (unknown layout, the likely case for a
transmitter); values are polled; a device appears only after the user presses something on it.

Calibration is PX4's channel scaling, `src/modules/rc_update/rc_update.cpp` L449–494: clamp to
[min, max], scale below and above the trim separately, optional dead zone, reverse. Min, trim
and max are **measured** from your device in the calibration steps. PX4's `RC1_*` defaults
(1000/1500/2000, dead zone 10, `rc_update/params.c` L51–100) are pulse widths in µs and do not
apply to a normalised axis. The extra dead zone starts at 0 (off), because PX4's modes already
have `MPC_HOLD_DZ`.

Electron's documentation (`session`) lists a permission for `hid` (WebHID) and none for
gamepads; the handler sections were read only as a summary. **To verify** in 6.6: that a
packaged, sandboxed build sees the device, and that your transmitter appears as a controller.

## Data found and not found

**Found and read:** R&M 3021 (primary); Sanchez-Cuevas et al. 2017; Juhasz et al. 2017 (first
pages); Madden 2019 (in part); the Faessler equation; MathWorks pages (secondary for the
military specifications); the PX4 files with line numbers above; the W3C Gamepad text; the
Esri ASCII header and row order
(https://desktop.arcgis.com/en/arcmap/latest/manage-data/raster-and-images/esri-ascii-raster-format.htm).

**Not found, stays "to verify" or a user input**
- The primary text of MIL-F-8785C, MIL-HDBK-1797 and 1797B, including the minimum height of
  the low-altitude model. The background report ADA119421 (Moorhouse and Woodcock) refused
  the download. **Gate:** 6.0a obtains the primary text, or every shear, gust and turbulence
  citation stays marked secondary in the UI.
- Any formula for ground effect of several rotors. The journal paper by the same authors (Int.
  J. Aerospace Engineering 2017, article 1823056), which has tests with complete multirotors,
  could not be opened (403); it is the first thing to try in 6.0a.
- Partial ground effect over an edge, ceiling and wall effects beyond the two conference
  papers' tests of specific rotors: out of scope.
- Rotor-drag coefficients, camera field of view, terrain and obstacle friction and
  restitution, wind speeds of a place: user inputs.
- The stick-to-screen delay a pilot accepts: no source sought; your limit in D2.

## Milestones

Each ends with `npm run test:all` green, a DEVLOG entry and, for UI work, screenshots. "Files"
is what the milestone may touch. In one wave two milestones share no file, except the one-line
`pub mod` in `engine-core/src/lib.rs` (a trivial merge) and the DEVLOG.

| # | Scope | Files | Needs |
|---|---|---|---|
| 6.0a Sources and reference data | Obtain the primary texts above; PX4 takeoff, land and (if 6.12 is chosen) return parameters with lines, units and ranges; the z0 values; format note | `database/reference/physics.v1.json`, `database/reference/README.md`, `tests/unit/reference-data.test.ts` | Nothing |
| 6.0b Stream measurement | Frame time, request time and input-to-frame delay of the 4.8 lockstep, in free flight and in contact; the numbers in the DEVLOG against your limits (D2) | `tests/e2e/flight-performance.spec.ts`, DEVLOG | D2's limits |
| 6.1 Wind model | `Wind`: constant, shear, gust as a function of height, time and air distance; validation; hash words | `engine-core/src/wind.rs`, `wind/tests.rs`, `lib.rs` | 6.0a for shear and gust; constant wind can start now |
| 6.2 Ground-effect model | The ratio per rotor (eq. 2 and 4), the lower bound, its flag | `engine-core/src/ground_effect.rs`, `ground_effect/tests.rs`, `lib.rs` | Nothing (primary source read) |
| 6.3 Both in the flight step | `Flight` takes an optional wind and ground effect; drag from v − w; G on thrust; two more entries in `StepLoads`; hash words. With both off, bit-identical | `engine-core/src/flight.rs`, `flight/tests.rs`, `aero.rs` | 6.1, 6.2. No Phase 5 milestone lists these files |
| 6.4 Terrain and obstacle shapes, core | Heightfield from a grid; cylinder and hull obstacles; height below a point; start-penetration check; the TS parser | `engine-core/src/environment.rs`, `environment/tests.rs`, `sim.rs`, `src/domain/terrain.ts`, `src/domain/environment.ts`, `tests/unit/terrain.test.ts`, `environment.test.ts` | Nothing. `environment.rs` and `sim.rs` are in no Phase 5 milestone |
| 6.5 Protocol, host, storage | Wind, ground effect, terrain and shapes in `sim.run`, `flight.session.start` and `scenario.run`; the takeoff, hold and land commands in the session; the in-memory input log (D18); the zod mirrors; migration and store for terrain files; schemas. Optional fields (absent = off), so `PROTOCOL_VERSION` stays 2 | `engine-host/src/*`, `electron/main/engine/*`, `electron/ipc/*`, `electron/main/assets/*`, `database/migrations/NNNN_terrain.sql`, `src/domain/wind.ts`, ARCHITECTURE table | 6.3, 6.4, 6.7, and **5.4 and 5.7 merged** (they edit the same host and main files) |
| 6.6 Input devices | Mapping and calibration (pure), polling hook, calibration page, device list, disconnect rule (D13) | `src/domain/input-mapping.ts`, `src/features/input/*` (new), `tests/unit/input-mapping.test.ts`, `tests/e2e/input.spec.ts`, `src/app/nav.ts` | The pure half and the page: nothing, but `nav.ts` is also 5.8's, so after **5.8**. Flying with it: 6.9 |
| 6.7 Takeoff and landing, core | `takeoff.rs`, `land_detector.rs`, then `auto_modes.rs` (takeoff, hold, land) and their place in `flight_loop.rs`; the ground stand-in of 5.3 and 5.10 is replaced by the detector | `engine-core/src/takeoff.rs`, `land_detector.rs`, `auto_modes.rs` + their tests, `flight_loop.rs`, `hover_thrust.rs` (landed gate only), `lib.rs` | 6.0a. The two pure modules: 5.1 (merged). The wiring: **5.3 and 5.10 merged**, and not while 5.7 or 5.9 edit the loop |
| 6.8 Cameras | Camera maths (pose from frame, easing), chase, orbit, fixed, FPV; selector; FOV field on the camera part | `src/features/flight/cameras.ts`, `FlightViewport.tsx`, `tests/unit/cameras.test.ts`, the part panel and part schema for the FOV | The maths: nothing. `FlightViewport.tsx`: **after 5.8** (its folder). The schema edit: not while 6.5 runs |
| 6.9 Environment and flight UI | Wind panel, ground-effect switch with its label, terrain import, obstacle shapes, terrain drawn, wind arrow, new loads in the debug panel, device selection, takeoff/land controls, pause and resume | `src/features/flight/*` (except `cameras.ts`), `src/features/workshop/EnvironmentPanel.tsx`, `src/features/scenarios/*` (wind entry), `tests/e2e/environment.spec.ts` | 6.5, 6.6, 6.7, 6.8, **5.8 merged** |
| 6.10 Acceptance and docs | Wind-hold, gust, takeoff-and-land and terrain scenarios on a built-in build; ROADMAP (including the Phase 4 wind/ground-effect note), ARCHITECTURE, DEVLOG, ADR for the environment models and their limits | `engine-core/src/scenario/builtins.rs`, docs | All above, **5.9 merged** (it edits `scenario.rs`, `closed_loop.rs`) |
| 6.11 (optional) Turbulence | Dryden low-altitude filters, seeded generator, spectrum test, the two limits on screen | `engine-core/src/turbulence.rs`, `turbulence/tests.rs`, `wind.rs`, then small edits in 6.5's and 6.9's files | D4, 6.0a's gate, 6.3 |
| 6.12 (optional) Return | PX4's return states on the local position (home = start) | `engine-core/src/auto_modes.rs`, tests, then 6.9's controls | Chosen later (D15), 6.7 |

**Waves.**
- **Wave 1 (can start now, no Phase 5 file touched):** 6.0a, 6.0b, 6.1 (constant wind first),
  6.2, 6.4, and the pure halves of 6.6 and 6.8 (`input-mapping.ts`, `cameras.ts`). Then 6.3 (after
  6.1 and 6.2).
- **Wave 2 (Phase 5.3 and 5.10 merged):** 6.7.
- **Wave 3 (5.4, 5.7 and 5.8 merged):** 6.5, then 6.6's page and 6.8's view; then 6.9.
- **After 5.9:** 6.10. 6.11 and 6.12 when chosen.

6.1 to 6.4 are useful before any UI: a position-holding engine (5.3) can be tested in wind as
soon as both have merged.

## Automated tests

Tolerances are stated with each test before it is run, not tuned afterwards.

1. **Wind off** (6.3): every existing state hash (4.6, 4.7, 4.9, 4.8 chunking) is unchanged
   with no wind and no ground effect, and with a wind of exactly 0.
2. **Drift in a constant wind** (6.3): no thrust, gravity 0, level, wind W along body x from
   rest. v̇ = k(W − v)², k = ρC_dA/(2m), so v(t) = W·kWt/(1 + kWt) and
   x(t) = Wt − ln(1 + kWt)/k. First-order convergence in dt, as 4.6's fall with drag.
3. **Galilean check** (6.3): a body moving at v in wind w has the drag of one moving at v − w in
   still air, bit for bit, for random attitudes.
4. **Hold in a wind** (6.3 with 5.3): position hold settles with zero horizontal error and a
   tilt where m·g·tan θ balances the drag at that tilt (solved by bisection from the per-axis
   formula, not from the simulation). Reference size: 1.5 kg, C_dA = 0.022 m², ρ = 1.225,
   8 m/s gives 0.862 N; ignoring the tilt's effect on the axes, 3.36°.
5. **Shear and gust** (6.1): u = W20 at 20 ft for both z0; hand values (z0 = 0.15 ft, h = 100 ft:
   1.329·W20; z0 = 2 ft: 1.699·W20); held below 3 ft; refused above 1000 ft. Gust: 0, V_m/2 and
   V_m at x = 0, d_m/2 and d_m, and C¹ there.
6. **Ground-effect ratio** (6.2): eq. 2 at Z/R = 0.5, 0.6, 1, 2, 4 gives 1.3333, 1.2101, 1.0667,
   1.0159, 1.0039; eq. 4 equals eq. 2 at V = 0, falls with V, and tends to 1; the bound holds below 0.5
   and sets its flag; Z ≤ R/4 never divides by zero or turns negative.
7. **Ground effect in flight** (6.3): at a fixed rotor speed and height, thrust is G·k_T·ω², the
   drag torque and the shaft power are unchanged; hover at Z/R = 1 needs ω lower by
   √(1/1.0667) than out of ground effect; each rotor uses its own height over a slope.
8. **Terrain** (6.4): the parser reads the documented header in either keyword case and both
   corner/centre registrations, and refuses a wrong count, a `NODATA` cell, a non-number; the
   height query equals the source grid at nodes and the triangle's plane between; a box dropped on a
   flat heightfield rests at the same height as on the plane, within the contact tolerance; on
   a slope steeper than atan μ it slides, below it rests; a corner of a known grid lands at the right
   world x and y (axis mapping); a fast fall does not pass through.
9. **Obstacles** (6.4): contact with a cylinder and a hull is reported with the part and the id;
   a start inside is refused with the depth.
10. **Input mapping** (6.6): min, trim and max map to −1, 0, 1; each side is linear; reverse;
    dead zone continuous at its edge; no NaN when trim = min or trim = max; the standard mapping gives
    positive forward and up; disconnect pauses (fake device).
11. **Takeoff and landing** (6.7): state by state against the PX4 switch; the ramp starts at
    −g/P and ends at the desired speed after `MPC_TKO_RAMP_T` (by hand); each detector level's
    timing (`LNDMC_TRIG_TIME`/3 each); land speed equals `MPC_LAND_SPEED` below
    `MPC_LAND_ALT2` and `MPC_Z_VEL_MAX_DN` above `MPC_LAND_ALT1`, linear between, no crawl; a build that cannot lift off
    never reports flight; on the built-in build: takeoff, hold, land, landed, with final errors stated
    after the first run.
12. **Determinism and replay** (6.5): same start, inputs and seed give one hash; any
    chunking gives the same; the input log of a live session replayed through `sim.run`-style
    steps gives the same hash, with wind, device sticks and auto modes; a different seed differs.
13. **Cameras** (6.8): pose from a frame for a yawed and a rolled vehicle; FPV equals the
    part's pose composed with the body pose; chase does not jump at heading ±180°; the camera never writes to
    the session (a run with each camera has the same hash).
14. **Turbulence** (6.11): variance of each component equals σ² within the confidence bound
    computed from the number of independent samples; the spectrum against the Dryden form at
    several frequencies with Madden's method; V → 0 stays finite; same seed, same series; the UI
    text with the two limits is visible (e2e).
15. **Storage** (6.5): a project without wind or terrain loads and flies as before; a saved
    terrain survives a restart; a terrain file nobody uses is removed at startup; the migration
    upgrades from the previous version.

## Risks

- **Models near the ground and at hover are weak.** Ground effect is a single-rotor formula
  whose error for a multirotor has an unknown sign; Dryden is called not applicable to hover by
  a source we read. Both are off until you turn them on, and their labels are part of the
  acceptance.
- **Wind without rotor drag understates the push.** With D6(a) only the body's drag moves the
  vehicle, so tilt and drift in wind come out lower than a real multirotor's. The flight page
  and the DEVLOG must say so; a hold test proves the arithmetic, not the realism.
- **Secondary citations.** Shear, gust and turbulence rest on a vendor's documentation until
  6.0a obtains the standards.
- **Heightfield behaviour in rapier is unproven here.** It is Y-up in parry (rotated +90° about X for
  us); its `scale` is the whole extent in `heightfield3.rs` (the bounding box is ±scale/2),
  although rapier's comment says per-cell; it is a surface with nothing below, unlike the
  half-space ground, so tunnelling must be tested; parry 0.31.1 already misplaces a
  half-space in one query (`environment.rs`). Keep the plane as the default ground. Contact cost per
  step (≈ 0.2 ms with 20 boxes) and the flat-impact rebound defect (4.4) apply here too.
- **Device variety.** Transmitters differ in axis order and report an empty mapping; only devices you
  can plug in here can be tested. The calibration must not assume an order.
- **Parallel work with Phase 5.** 5.4, 5.7, 5.8 and 5.9 own the host, main-process and flight-page
  files until they merge; only wave 1 avoids them all. If Phase 5 re-plans a file, the fences
  above change first.
- **PX4 auto code may be large.** `PositionSmoothing`, `VelocitySmoothing` and the position
  controller's takeoff branch are unread. 6.7 may ship without jerk smoothing first, with the
  deviation stated.
- **Scope.** Twelve core milestones (6.0a to 6.10) and two optional. Wind (6.1, 6.3) and devices (6.6)
  give the most for the least; terrain and auto modes can be cut without
  touching them.
