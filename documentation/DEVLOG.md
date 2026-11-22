# Development log

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
