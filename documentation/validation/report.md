# Validation report

**Not compared with a real flight.** [Phase 8, D11(a)](../plans/phase-8-quality.md#L62)

- Build commit `2699370f402b5a449fb6fa5747216d9fd6e63114` (working tree changes present)
- Engine version 0.1.0 · protocol 2
- Machine win32 10.0.22631 x64 · Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz
- Generated 2026-11-27T10:51:43.823Z
- Checks passed 267 engine-core unit tests, 1 ignored diagnostic, 53 referenced Vitest tests and 4 observation tests

| Verdict | Models |
| --- | ---: |
| analytical | 37 |
| independent reference | 2 |
| published data | 5 |
| self-consistency only | 14 |
| not validated | 4 |
| Total | 62 |

The [README](README.md) explains how to read results and regenerate this report. The [inventory](inventory.md) lists open evidence gaps.

## Mass and inertia

**Not validated** — Physical mass distribution of imported models.

### Shapes, assembly totals and tensor rotation

- **Verdict** — analytical
- **Model** — Uniform box Ixx=m(b²+c²)/12. Rotate each tensor as RIRᵀ, add the parallel-axis terms m[(r·r)I−rrᵀ], and use rCoM=Σmᵢrᵢ/Σmᵢ.
- **Source** — Uniform solid formulas, thin rods and the parallel-axis theorem [mass.ts:9](../../src/domain/mass.ts#L9); ADR 0003 axes [mass.ts:6](../../src/domain/mass.ts#L6) · Implementation [mass.ts:175](../../src/domain/mass.ts#L175) [mass.ts:204](../../src/domain/mass.ts#L204) [mass.ts:266](../../src/domain/mass.ts#L266) [vehicle.rs:380](../../simulation-engine/engine-core/src/vehicle.rs#L380)
- **Check** — Closed-form shapes, rotated tensor and point masses [`uniform box: m(b²+c²)/12 …`](../../tests/unit/mass.test.ts#L32) (passed) · [`uniform cylinder about its axis and across it`](../../tests/unit/mass.test.ts#L44) (passed) · [`propeller: thin rods to the tip, averaged over a turn`](../../tests/unit/mass.test.ts#L54) (passed) · [`a rotated part: 90° about Z swaps Ixx and Iyy; 45° gives a product of inertia`](../../tests/unit/mass.test.ts#L62) (passed) · [`CoM = Σ mᵢ rᵢ / Σ mᵢ for two point masses`](../../tests/unit/mass.test.ts#L79) (passed) · [`two_part_totals_match_hand_calculation`](../../simulation-engine/engine-core/src/vehicle.rs#L692) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — TS `1e-12 × max(1, abs(expected))`, rationale not found [mass.test.ts:29](../../tests/unit/mass.test.ts#L29); Rust hand case [vehicle.rs:692](../../simulation-engine/engine-core/src/vehicle.rs#L692)
- **Current test statements** — `const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)))` [mass.test.ts:29](../../tests/unit/mass.test.ts#L29)
- **Range and limits** — Positive finite masses and physical tensors [vehicle.rs:14](../../simulation-engine/engine-core/src/vehicle.rs#L14); imported mesh/hull uses a uniform bounding box, overrides may replace shape tensor and CoM [mass.ts:18](../../src/domain/mass.ts#L18)

### Principal axes and engine handoff

- **Verdict** — analytical
- **Model** — Diagonalize the symmetric tensor I=Q diag(λ) Qᵀ and pass its principal moments and axes to the engine.
- **Source** — Golub & Van Loan, Matrix Computations, 4th ed. §8.5 [mass.ts:212](../../src/domain/mass.ts#L212); ADR 0005 [vehicle.rs:188](../../simulation-engine/engine-core/src/vehicle.rs#L188) · Implementation [mass.ts:223](../../src/domain/mass.ts#L223) [vehicle.rs:201](../../simulation-engine/engine-core/src/vehicle.rs#L201) [vehicle.rs:399](../../simulation-engine/engine-core/src/vehicle.rs#L399)
- **Check** — Known rotated-box solution, reconstruction and Rust/TS agreement on totals [`a box rotated by a known quaternion: the box’s moments, the rotated axes (closed form)`](../../tests/unit/principal-axes.test.ts#L41) (passed) · [`principal_axes_handles_repeated_and_tiny_moments`](../../simulation-engine/engine-core/src/vehicle.rs#L791) (passed) · [`mass.ts output loads in the real engine, and the engine totals agree to 1e-9`](../../tests/unit/mass-engine-xcheck.test.ts#L61) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — TS tolerance [principal-axes.test.ts:20](../../tests/unit/principal-axes.test.ts#L20); engine agreement to 1e-9 [mass-engine-xcheck.test.ts:61](../../tests/unit/mass-engine-xcheck.test.ts#L61); tiny/repeated tensor reconstruction [vehicle.rs:791](../../simulation-engine/engine-core/src/vehicle.rs#L791)
- **Current test statements** — `function expectDecomposition(i: Inertia6, tol = 1e-12) {` [principal-axes.test.ts:20](../../tests/unit/principal-axes.test.ts#L20) · `moments.forEach((m, k) => expect(Math.abs(m - sorted[k]!)).toBeLessThan(1e-15))` [principal-axes.test.ts:46](../../tests/unit/principal-axes.test.ts#L46)
- **Range and limits** — Includes repeated and tiny moments in fixtures; reject nonphysical tensors and totals outside rounding [vehicle.rs:14](../../simulation-engine/engine-core/src/vehicle.rs#L14)

### Physical mass distribution of imported models

- **Verdict** — not validated
- **Model** — Assign uniform density to the bounding box and use its center and solid-box inertia unless explicit properties are supplied.
- **Source** — Uniform bounding-box assumption [mass.ts:18](../../src/domain/mass.ts#L18) · Implementation [mass.ts:175](../../src/domain/mass.ts#L175)
- **Check** — No check located.
- **Result this run** — No measurement or passing check available.
- **Assertion limits** — Not found
- **Range and limits** — Imported model/hull mass distribution unknown unless supplied by user [mass.ts:18](../../src/domain/mass.ts#L18)

### Static hover balance

- **Verdict** — analytical
- **Model** — Minimize Σ(fᵢ−mg/n)² subject to Σfᵢ=mg and zero roll/pitch moment about the CoM. A negative solution indicates required downward thrust.
- **Source** — Equal-load minimum adjustment subject to static vertical force and roll/pitch moment balance [mass.ts:310](../../src/domain/mass.ts#L310) · Implementation [mass.ts:335](../../src/domain/mass.ts#L335)
- **Check** — Closed form for centered and shifted quad; negative load outside support [`centred CoM: each motor carries a quarter of the weight`](../../tests/unit/mass.test.ts#L150) (passed) · [`CoM 30 mm forward: front motors carry (a + d)/(2a) of the weight`](../../tests/unit/mass.test.ts#L158) (passed) · [`CoM outside the motors: infeasible, naming the motor that would pull down`](../../tests/unit/mass.test.ts#L172) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — `close` [mass.test.ts:29](../../tests/unit/mass.test.ts#L29); exact infeasibility predicate [mass.test.ts:172](../../tests/unit/mass.test.ts#L172)
- **Current test statements** — `const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)))` [mass.test.ts:29](../../tests/unit/mass.test.ts#L29)
- **Range and limits** — Vertical thrust statics; fewer than three or collinear mounts cannot hold roll/pitch [mass.test.ts:192](../../tests/unit/mass.test.ts#L192)

### Frame mass allocation by primitive volume

- **Verdict** — analytical
- **Model** — Assign mᵢ=mframe Vᵢ/ΣVⱼ using the plate plus the portions of the arms outside it.
- **Source** — Uniform-volume partition of entered frame mass [mass-input.ts:98](../../src/features/workshop/mass-input.ts#L98) · Implementation [mass-input.ts:85](../../src/features/workshop/mass-input.ts#L85) [mass-input.ts:98](../../src/features/workshop/mass-input.ts#L98)
- **Check** — Hand overlap/arm geometry and symmetry of weighted frame CoM [`plate plus each arm outside the plate; the arm length outside is (r + w/2) − exit`](../../tests/unit/mass-input.test.ts#L19) (passed) · [`a symmetric frame alone has its CoM on the axis at half its thickness, and its mass is shared by volume`](../../tests/unit/mass-input.test.ts#L27) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Absolute 1e-12 m for arm length and 1e-15 in SI units for mass, CoM and inertia. Hand geometry stated, numeric rationale not found [mass-input.test.ts:19](../../tests/unit/mass-input.test.ts#L19) [mass-input.test.ts:27](../../tests/unit/mass-input.test.ts#L27)
- **Current test statements** — `close(boxes[1]!.size[0], 0.235 - 0.05 / Math.SQRT1_2, 1e-12)` [mass-input.test.ts:24](../../tests/unit/mass-input.test.ts#L24) · `close(mp.totalMassKg, 0.3, 1e-15)` [mass-input.test.ts:29](../../tests/unit/mass-input.test.ts#L29)
- **Range and limits** — Applies to the parametric frame proxy; frame mass must be supplied [mass-input.test.ts:43](../../tests/unit/mass-input.test.ts#L43)

### Rapier compound-body mass-property handoff

- **Verdict** — independent reference
- **Model** — Sum component masses and rotated tensors with the parallel-axis shift to the combined CoM.
- **Source** — Parallel-axis recomputation and Rapier body aggregation from explicit part properties [vehicle.rs:20](../../simulation-engine/engine-core/src/vehicle.rs#L20) [vehicle.rs:715](../../simulation-engine/engine-core/src/vehicle.rs#L715) · Implementation [vehicle.rs:380](../../simulation-engine/engine-core/src/vehicle.rs#L380) [vehicle.rs:399](../../simulation-engine/engine-core/src/vehicle.rs#L399)
- **Check** — Independent Rapier aggregation versus local totals from the same supplied part properties [`rapier_body_matches_recomputed_totals`](../../simulation-engine/engine-core/src/vehicle.rs#L719) (passed) · [`tilted_propeller_from_mass_ts_loads_and_rapier_agrees`](../../simulation-engine/engine-core/src/vehicle.rs#L829) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-9 relative to exercise rotated-shape frame changes; numerical threshold derivation not found [vehicle.rs:715](../../simulation-engine/engine-core/src/vehicle.rs#L715)
- **Range and limits** — Explicit physical part tensors; validates aggregation for tested rotated shapes [vehicle.rs:715](../../simulation-engine/engine-core/src/vehicle.rs#L715)


## Rigid body

### Gravity, frame transforms and rigid-body integration

- **Verdict** — analytical
- **Model** — Transform body loads with R(q), add gravity, and update velocity before position. Free fall has Δz=−gt²/2 and vz=−gt.
- **Source** — Rapier semi-implicit Euler; standard gravity per 3rd CGPM 1901 and ISO 80000-3:2019 item 3-9.2 [sim.rs:8](../../simulation-engine/engine-core/src/sim.rs#L8) · Implementation [sim.rs:3](../../simulation-engine/engine-core/src/sim.rs#L3)
- **Check** — Closed-form free fall, principal-axis spin and rotated force [`free_fall_matches_half_g_t_squared`](../../simulation-engine/engine-core/src/sim/tests.rs#L59) (passed) · [`constant_torque_spin_up_matches_alpha_tau_over_i`](../../simulation-engine/engine-core/src/sim/tests.rs#L108) (passed) · [`body_frame_force_follows_the_attitude`](../../simulation-engine/engine-core/src/sim/tests.rs#L134) (passed)
- **Result this run** — See measurements below.
  - free-fall position absolute error = 0.001225831250210696 m [tests.rs:81](../../simulation-engine/engine-core/src/sim/tests.rs#L81)
  - free-fall Euler term before roundoff allowance = 0.00122583125 m [tests.rs:81](../../simulation-engine/engine-core/src/sim/tests.rs#L81)
  - spin-up absolute angle error = 0.00009999933310145259 rad [tests.rs:127](../../simulation-engine/engine-core/src/sim/tests.rs#L127)
  - spin-up Euler term before roundoff allowance = 0.0001 rad [tests.rs:127](../../simulation-engine/engine-core/src/sim/tests.rs#L127)
- **Assertion limits** — Position `½gt·dt` with rounding allowance; velocity (1e-12 relative for free fall); spin angle Euler bound [tests.rs:55](../../simulation-engine/engine-core/src/sim/tests.rs#L55) [tests.rs:105](../../simulation-engine/engine-core/src/sim/tests.rs#L105)
- **Current test statements** — `assert!((vz + G * t).abs() < 1e-12 * G * t, "v = {vz}, expected {}", -G * t);` [tests.rs:71](../../simulation-engine/engine-core/src/sim/tests.rs#L71) · `assert!(err <= bound * (1.0 + 1e-9), "error {err:e} exceeds the symplectic-Euler bound {bound:e}");` [tests.rs:82](../../simulation-engine/engine-core/src/sim/tests.rs#L82) · `assert!(err <= bound * (1.0 + 1e-6), "error {err:e} exceeds {bound:e}");` [tests.rs:128](../../simulation-engine/engine-core/src/sim/tests.rs#L128)
- **Range and limits** — Fixed step, loads held over each step, one body [sim.rs:6](../../simulation-engine/engine-core/src/sim.rs#L6)


## Contact

**Not validated** — Flat-box rebound.

### Friction, single-point rebound and resting contact timing

- **Verdict** — analytical
- **Model** — Coulomb friction limits tangential impulse by μJn. Ideal normal rebound is vout=−e vin with apex e²h above contact.
- **Source** — Rapier 0.36.1 contact rules and solver allowed linear error [environment.rs:14](../../simulation-engine/engine-core/src/environment.rs#L14) [environment.rs:25](../../simulation-engine/engine-core/src/environment.rs#L25) · Implementation [environment.rs:11](../../simulation-engine/engine-core/src/environment.rs#L11) [environment.rs:22](../../simulation-engine/engine-core/src/environment.rs#L22)
- **Check** — Coulomb slider, ballistic pyramid impact and rest-height/time hand checks [`drop_onto_the_ground_comes_to_rest_at_its_half_height_and_reports_the_contact`](../../simulation-engine/engine-core/src/environment/tests.rs#L115) (passed) · [`restitution_sets_the_rebound_speed_and_height`](../../simulation-engine/engine-core/src/environment/tests.rs#L146) (passed) · [`friction_is_the_entered_coefficient`](../../simulation-engine/engine-core/src/environment/tests.rs#L180) (passed)
- **Result this run** — See measurements below.
  - diagnostic pyramid apex shortfall at e=0.5 = 0.9 mm [spin_study.rs:119](../../simulation-engine/engine-core/src/environment/spin_study.rs#L119)
- **Assertion limits** — Rebound speed 1%, height 2%; friction slide 1%; impact within one step plus roundoff; see explanations at [tests.rs:131](../../simulation-engine/engine-core/src/environment/tests.rs#L131) [tests.rs:143](../../simulation-engine/engine-core/src/environment/tests.rs#L143) [tests.rs:175](../../simulation-engine/engine-core/src/environment/tests.rs#L175)
- **Current test statements** — `assert!((up - v_up).abs() < 0.01 * v_up, "e = {e}: rebound speed {up}, expected {v_up}");` [tests.rs:167](../../simulation-engine/engine-core/src/environment/tests.rs#L167) · `assert!((peak - h_up).abs() < 0.02 * h_up, "e = {e}: rebound height {peak}, expected {h_up}");` [tests.rs:168](../../simulation-engine/engine-core/src/environment/tests.rs#L168)
- **Range and limits** — Vehicle-versus-environment pair coefficients; contact sampled at start of step with 0.1 mm gap allowance [environment.rs:11](../../simulation-engine/engine-core/src/environment.rs#L11)

### Fixed obstacle contact and initial overlap

- **Verdict** — analytical
- **Model** — Unilateral contact uses the shape-to-obstacle gap. Centered box rest height is obstacle top plus box half-height.
- **Source** — Rapier fixed colliders and contact event rules [environment.rs:22](../../simulation-engine/engine-core/src/environment.rs#L22) · Implementation [environment.rs:371](../../simulation-engine/engine-core/src/environment.rs#L371) [environment.rs:615](../../simulation-engine/engine-core/src/environment.rs#L615) [environment.rs:714](../../simulation-engine/engine-core/src/environment.rs#L714)
- **Check** — Hand brick/obstacle geometry and exact event identifiers, plus local box hash [`drop_onto_an_obstacle`](../../simulation-engine/engine-core/src/environment/tests.rs#L196) (passed) · [`cylinder_and_hull_report_the_part_and_id_and_refuse_containment`](../../simulation-engine/engine-core/src/environment/tests.rs#L477) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 0.12 m rest height within 0.12 mm (box upper allowance 1e-9 m). Lower allowance comes from measured solver penetration, upper allowance rationale not found. 70 mm containment reported to three decimal places [tests.rs:93](../../simulation-engine/engine-core/src/environment/tests.rs#L93) [tests.rs:208](../../simulation-engine/engine-core/src/environment/tests.rs#L208) [tests.rs:495](../../simulation-engine/engine-core/src/environment/tests.rs#L495)
- **Range and limits** — One centered 40 mm brick, flat-topped 100 mm fixed obstacles, zero restitution. Rotated or side impact errors not found in these checks [tests.rs:196](../../simulation-engine/engine-core/src/environment/tests.rs#L196) [tests.rs:477](../../simulation-engine/engine-core/src/environment/tests.rs#L477)

### Flat-box rebound

- **Verdict** — not validated
- **Model** — Four corner normal impulses affect linear and angular speed. The diagnostic compares the first rebound apex to e²h.
- **Source** — Same Rapier contact with four corner impulses [environment.rs:38](../../simulation-engine/engine-core/src/environment.rs#L38) · Implementation [environment.rs:38](../../simulation-engine/engine-core/src/environment.rs#L38)
- **Check** — Ballistic `e²h` used diagnostically [`spin_study`](../../simulation-engine/engine-core/src/environment/spin_study.rs#L81) (diagnostic ran)
- **Result this run** — See measurements below.
  - box rebound apex at e=0.5 = 65.7 mm [spin_study.rs:119](../../simulation-engine/engine-core/src/environment/spin_study.rs#L119)
  - box apex shortfall (from rounded diagnostic) = 54.3 mm [spin_study.rs:119](../../simulation-engine/engine-core/src/environment/spin_study.rs#L119)
  - box transient peak at e=0 = 12.785 rad/s [spin_study.rs:119](../../simulation-engine/engine-core/src/environment/spin_study.rs#L119)
- **Assertion limits** — not found; ignored diagnostic prints measurements
- **Range and limits** — Flat box rests after impact; multi-point restitution accuracy unresolved [environment.rs:38](../../simulation-engine/engine-core/src/environment.rs#L38)


## Motor

**Self-consistency only** — Build thrust-curve fit and residual.

### Ideal BLDC steady state and RK4 spin-up

- **Verdict** — analytical
- **Model** — Vm=ω/Kv+RI, Qm=Kt(I−I₀), and Jω̇=Qm−kQω². Solve the steady quadratic or integrate with RK4.
- **Source** — Winding/back-EMF and ideal power balance [propulsion.ts:29](../../src/domain/propulsion.ts#L29); rotor inertia stated or from mechanical time constant [propulsion.ts:677](../../src/domain/propulsion.ts#L677) · Implementation [propulsion.ts:196](../../src/domain/propulsion.ts#L196) [propulsion.rs:9](../../simulation-engine/engine-core/src/propulsion.rs#L9) [propulsion.rs:323](../../simulation-engine/engine-core/src/propulsion.rs#L323)
- **Check** — Hand quadratic, Riccati and no-drag exponential [`steady_speed_matches_the_hand_solution`](../../simulation-engine/engine-core/src/propulsion.rs#L391) (passed) · [`spin_up_matches_the_riccati_solution`](../../simulation-engine/engine-core/src/propulsion.rs#L402) (passed) · [`without_drag_the_motor_is_first_order_with_the_mechanical_time_constant`](../../simulation-engine/engine-core/src/propulsion.rs#L427) (passed) · [`rotor: stated, or J = τ_m K_t²/R; missing otherwise`](../../tests/unit/propulsion.test.ts#L362) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-5 rad/s steady, 1e-8 × steady speed Riccati, 1e-9 × steady speed exponential. Exact targets documented; threshold rationale not found [propulsion.rs:390](../../simulation-engine/engine-core/src/propulsion.rs#L390)
- **Range and limits** — Step fixture 10 V, one motor and constant duty, ideal ESC, constant no-load current, no reverse [propulsion.rs:9](../../simulation-engine/engine-core/src/propulsion.rs#L9) [propulsion.rs:402](../../simulation-engine/engine-core/src/propulsion.rs#L402)

### Bench effective duty map

- **Verdict** — published data
- **Model** — Solve Vd²−(ω/Kv)d−RIpack=0 per bench row, then interpolate the monotone fitted duty map.
- **Source** — T-Motor MN3110 test table, KV470 label T-MOTO13*4.4CF [propulsion.test.ts:215](../../tests/unit/propulsion.test.ts#L215); row-duty quadratic and isotonic medians [propulsion.ts:41](../../src/domain/propulsion.ts#L41) · Implementation [propulsion.ts:245](../../src/domain/propulsion.ts#L245) [propulsion.ts:295](../../src/domain/propulsion.ts#L295)
- **Check** — Published bench RPM/thrust with target prop excluded from duty-map fitting. Its thrust and torque coefficients still use its own rows [DEVLOG.md:720](../DEVLOG.md#L720) [`validates leave-one-prop-out: the map comes from the other propellers only`](../../tests/unit/propulsion.test.ts#L261) (passed) · [`before/after at full throttle (regression, measured 2026-11-22)`](../../tests/unit/propulsion.test.ts#L305) (passed)
- **Result this run** — See measurements below.
  - MN3110 KV470 / P13*4.4 CF propeller max absolute rpm error = 0.03377495943428553 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P13*4.4 CF propeller max absolute thrust error = 0.1004840734283455 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P13*4.4 CF propeller max absolute current error = 0.18401163916631727 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P13*4.4 CF propeller full-throttle RPM signed error = -0.029402382261685508 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P13*4.4 CF propeller full-throttle thrust signed error = -0.06258560795401993 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P15*5 CF propeller max absolute rpm error = 0.11347417130054861 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P15*5 CF propeller max absolute thrust error = 0.15019338332572504 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P15*5 CF propeller max absolute current error = 0.21843840328816566 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P15*5 CF propeller full-throttle RPM signed error = 0.047285857229400395 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV470 / P15*5 CF propeller full-throttle thrust signed error = 0.12747120949004803 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV700 / P13*4.4 CF propeller max absolute rpm error = 0.036446480032713606 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV700 / P13*4.4 CF propeller max absolute thrust error = 0.11086542238165065 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV700 / P13*4.4 CF propeller max absolute current error = 0.032512733801963734 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV700 / P13*4.4 CF propeller full-throttle RPM signed error = -0.0023520402689836636 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
  - MN3110 KV700 / P13*4.4 CF propeller full-throttle thrust signed error = -0.013105376585999482 fraction [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
- **Assertion limits** — Full-throttle errors rounded to 0.001 and matched to historical values; reason for that precision not found [propulsion.test.ts:305](../../tests/unit/propulsion.test.ts#L305)
- **Range and limits** — Tested bench and table speed/throttle range; nearest ratio held outside, no ESC-loss or temperature model [propulsion.ts:45](../../src/domain/propulsion.ts#L45) [DEVLOG.md:720](../DEVLOG.md#L720)

### Build thrust-curve fit and residual

- **Verdict** — self-consistency only
- **Model** — Fit fx²+(1−f)x to (ω(x)/ω(1))² by least squares with f constrained to [0,1].
- **Source** — PX4 motor_params.c:58–73 supplies polynomial [thrust-curve.ts:23](../../src/domain/thrust-curve.ts#L23); target produced by project steadyState with pack sag [thrust-curve.ts:87](../../src/domain/thrust-curve.ts#L87) · Implementation [thrust-curve.ts:87](../../src/domain/thrust-curve.ts#L87) [thrust-curve.ts:125](../../src/domain/thrust-curve.ts#L125)
- **Check** — Same propulsion model sampled afresh, with synthetic coefficient recovery also covered [thrust-curve.test.ts:16](../../tests/unit/thrust-curve.test.ts#L16) [`reports the built-in motor fit and its actual residual at nominal pack voltage with sag`](../../tests/unit/thrust-curve.test.ts#L75) (passed)
- **Result this run** — See measurements below.
  - fitted factor = 0.4909184285534448 fraction [thrust-curve.test.ts:93](../../tests/unit/thrust-curve.test.ts#L93)
  - RMS normalized thrust residual = 0.05338201116058304 fraction [thrust-curve.test.ts:93](../../tests/unit/thrust-curve.test.ts#L93)
  - max absolute normalized thrust residual = 0.10219982948875794 fraction [thrust-curve.test.ts:93](../../tests/unit/thrust-curve.test.ts#L93)
- **Assertion limits** — Residual bookkeeping to 14 decimal places, no physical acceptance bound or precision rationale found [thrust-curve.test.ts:86](../../tests/unit/thrust-curve.test.ts#L86)
- **Current test statements** — `expect(result.rmsError).toBeCloseTo(Math.sqrt(errors.reduce((sum, e) => sum + e ** 2, 0) / errors.length), 14)` [thrust-curve.test.ts:91](../../tests/unit/thrust-curve.test.ts#L91) · `expect(result.maxAbsError).toBeCloseTo(Math.max(...errors.map(Math.abs)), 14)` [thrust-curve.test.ts:92](../../tests/unit/thrust-curve.test.ts#L92)
- **Range and limits** — Built-in case 14.8 V and 0.12–1 throttle; curve can use extrapolated bench samples [thrust-curve.test.ts:75](../../tests/unit/thrust-curve.test.ts#L75)


## Propeller

**Self-consistency only** — Torque inferred from motor current.

### Static thrust fit, T-Motor source

- **Verdict** — published data
- **Model** — Fit T=kTω² with kT=Σ(Tω²)/Σω⁴.
- **Source** — MN3110 KV470 + P13×4.4, five T-MOTO13*4.4CF rows; manufacturer URL in test [propulsion.test.ts:215](../../tests/unit/propulsion.test.ts#L215) · Implementation [propulsion.ts:159](../../src/domain/propulsion.ts#L159) [propulsion.ts:557](../../src/domain/propulsion.ts#L557)
- **Check** — Published thrust rows used in fitting and separate least-squares expression [`MN3110 KV470 + P13*4.4: fit from the five cited rows, each within the reported error`](../../tests/unit/propulsion.test.ts#L215) (passed)
- **Result this run** — See measurements below.
  - max absolute thrust residual = 0.03649875447091618 fraction [propulsion.test.ts:233](../../tests/unit/propulsion.test.ts#L233)
- **Assertion limits** — Max residual <4%, rationale not found; residual recomputation to 12 decimals [propulsion.test.ts:223](../../tests/unit/propulsion.test.ts#L223)
- **Current test statements** — `expect(fit.kT.maxAbsError).toBeLessThan(0.04)` [propulsion.test.ts:233](../../tests/unit/propulsion.test.ts#L233)
- **Range and limits** — In-sample static data; other table yields ~5% different kT for same prop [DEVLOG.md:823](../DEVLOG.md#L823)

### Torque inferred from motor current

- **Verdict** — self-consistency only
- **Model** — Infer Q=Kt(Ipack/d−I₀), then fit Q=kQω² by least squares.
- **Source** — Same T-Motor rows; shaft-torque balance with solved effective duty and constant I₀ [propulsion.ts:56](../../src/domain/propulsion.ts#L56) · Implementation [propulsion.ts:56](../../src/domain/propulsion.ts#L56) [propulsion.ts:557](../../src/domain/propulsion.ts#L557)
- **Check** — Derived torque from same bench rows and regression against ideal-duty fit [`MN3110 KV470 + P13*4.4: fit from the five cited rows, each within the reported error`](../../tests/unit/propulsion.test.ts#L215) (passed) · [`k_Q scatter falls with the effective duty on every motor-table pair (regression)`](../../tests/unit/propulsion.test.ts#L250) (passed)
- **Result this run** — See measurements below.
  - KV470 P13×4.4 ideal duty max absolute torque residual = 0.19099696078388226 fraction [propulsion.test.ts:257](../../tests/unit/propulsion.test.ts#L257)
  - KV470 P13×4.4 effective duty max absolute torque residual = 0.10737585966000698 fraction [propulsion.test.ts:258](../../tests/unit/propulsion.test.ts#L258)
- **Assertion limits** — kQ to 15 decimals; rounded regression targets to 3 decimals and decrease in scatter; numeric tolerance rationale not found [propulsion.test.ts:234](../../tests/unit/propulsion.test.ts#L234) [propulsion.test.ts:250](../../tests/unit/propulsion.test.ts#L250)
- **Range and limits** — Torque input inferred from current; I₀ outside its 10 V specification unvalidated [DEVLOG.md:727](../DEVLOG.md#L727)

### APC fallback thrust/torque fit

- **Verdict** — published data
- **Model** — Fit T=kTω² and Q=kQω² to the applicable APC static table rows.
- **Source** — APC computed prop performance table, condition cites APC FAQ at 1.225 kg/m³ [propulsion.test.ts:324](../../tests/unit/propulsion.test.ts#L324) · Implementation [propulsion.ts:557](../../src/domain/propulsion.ts#L557) [propulsion.ts:568](../../src/domain/propulsion.ts#L568)
- **Check** — In-sample published computed thrust; torque source selection asserted [`falls back to the APC table (sea-level ISA, cited) inside the reachable speed domain`](../../tests/unit/propulsion.test.ts#L324) (passed)
- **Result this run** — See measurements below.
  - whole table max absolute thrust residual = 0.09259638313721028 fraction [propulsion.test.ts:324](../../tests/unit/propulsion.test.ts#L324)
  - whole table max absolute torque residual = 0.2016684572357954 fraction [propulsion.test.ts:324](../../tests/unit/propulsion.test.ts#L324)
  - capped max absolute thrust residual = 0.014261477045908189 fraction [propulsion.test.ts:324](../../tests/unit/propulsion.test.ts#L324)
  - capped max absolute torque residual = 0.24757627601938986 fraction [propulsion.test.ts:324](../../tests/unit/propulsion.test.ts#L324)
- **Assertion limits** — 15.407 N at 10,000 rpm to 9 decimals; point residual within its own max, no external accuracy bound [propulsion.test.ts:331](../../tests/unit/propulsion.test.ts#L331)
- **Range and limits** — Full 1,000–22,000 rpm table or supply-limited subset, static sea-level reference; no independent torque measurement [propulsion.test.ts:330](../../tests/unit/propulsion.test.ts#L330) [DEVLOG.md:825](../DEVLOG.md#L825)

### Rotor loads, reaction, gyroscopic and density scaling

- **Verdict** — analytical
- **Model** — Sum r×T, shaft reaction and rotor angular-momentum terms. Scale the static thrust and torque coefficients by ρ/ρref.
- **Source** — Angular-momentum balance and moment arm [flight.rs:7](../../simulation-engine/engine-core/src/flight.rs#L7); static kT/kQ with density ratio [tests.rs:380](../../simulation-engine/engine-core/src/flight/tests.rs#L380) · Implementation [flight.rs:7](../../simulation-engine/engine-core/src/flight.rs#L7) [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33)
- **Check** — Hand thrust/arm/gyro, closed angular-momentum balance and coefficient scaling [`rotor_loads_match_the_hand_calculation`](../../simulation-engine/engine-core/src/flight/tests.rs#L105) (passed) · [`rotor_spin_down_conserves_angular_momentum_up_to_prop_drag`](../../simulation-engine/engine-core/src/flight/tests.rs#L178) (passed) · [`the_coefficients_scale_with_the_air_density_ratio`](../../simulation-engine/engine-core/src/flight/tests.rs#L380) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-12 for hand thrust/arm and momentum, 1e-15 for reaction and gyro terms [tests.rs:97](../../simulation-engine/engine-core/src/flight/tests.rs#L97) [tests.rs:190](../../simulation-engine/engine-core/src/flight/tests.rs#L190); density assertions [tests.rs:380](../../simulation-engine/engine-core/src/flight/tests.rs#L380)
- **Range and limits** — Loads use start-of-step rotor speed, true rotor pose; inflow, rotor interactions and thermal limits omitted [flight.rs:4](../../simulation-engine/engine-core/src/flight.rs#L4) [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33)


## Battery

### Pack sag, charge use and configured cutoff

- **Verdict** — analytical
- **Model** — Vpack=Voc−RintΣI and charge used is ∫ΣI dt. The configured cutoff interrupts drive.
- **Source** — Ohm’s law/lumped resistance and charge integral [propulsion.rs:21](../../simulation-engine/engine-core/src/propulsion.rs#L21); user-entered internal resistance and cutoff [propulsion.ts:702](../../src/domain/propulsion.ts#L702) [flight.rs:111](../../simulation-engine/engine-core/src/flight.rs#L111) · Implementation [propulsion.rs:21](../../simulation-engine/engine-core/src/propulsion.rs#L21) [propulsion.rs:296](../../simulation-engine/engine-core/src/propulsion.rs#L296) [propulsion.ts:702](../../src/domain/propulsion.ts#L702) [flight.rs:111](../../simulation-engine/engine-core/src/flight.rs#L111)
- **Check** — Series-resistance reduction, constant-current integral and cutoff/freeze contract [`battery_sag_matches_the_series_resistance_solution`](../../simulation-engine/engine-core/src/propulsion.rs#L441) (passed) · [`charge_used_is_the_integral_of_the_current`](../../simulation-engine/engine-core/src/propulsion.rs#L463) (passed) · [`a_cutoff_ends_the_run_and_freezes_it`](../../simulation-engine/engine-core/src/flight/tests.rs#L343) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Speed 1e-6 relative for sag; voltage 1e-12 V; constant-current charge 1e-9 relative; threshold rationale not found [propulsion.rs:441](../../simulation-engine/engine-core/src/propulsion.rs#L441) [propulsion.rs:463](../../simulation-engine/engine-core/src/propulsion.rs#L463)
- **Range and limits** — Constant open-circuit voltage/internal resistance, no chemistry/thermal fit; cutoff opt-in [propulsion.rs:21](../../simulation-engine/engine-core/src/propulsion.rs#L21) [flight.rs:39](../../simulation-engine/engine-core/src/flight.rs#L39)


## Drag

### Projected-area union

- **Verdict** — analytical
- **Model** — Along each axis, estimate the area of the union of the projected shapes on two raster resolutions.
- **Source** — Convex projections and two-resolution raster estimate [aero.ts:101](../../src/domain/aero.ts#L101) [aero.ts:160](../../src/domain/aero.ts#L160) · Implementation [aero.ts:47](../../src/domain/aero.ts#L47) [aero.ts:101](../../src/domain/aero.ts#L101) [aero.ts:160](../../src/domain/aero.ts#L160)
- **Check** — Closed-form boxes and cylinder; grid delta is a resolution indicator [`an axis-aligned box: A_x = b·c, A_y = a·c, A_z = a·b`](../../tests/unit/aero.test.ts#L30) (passed) · [`a cylinder along z: A_z = π r², A_x = A_y = 2r·h`](../../tests/unit/aero.test.ts#L43) (passed) · [`reports a resolution error from the half-resolution grid`](../../tests/unit/aero.test.ts#L60) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1% relative for hand shape cases, rationale not found [aero.test.ts:14](../../tests/unit/aero.test.ts#L14); `5 × max(reported delta, 1e-7)` for cylinder, multiplier/floor rationale not found [aero.test.ts:60](../../tests/unit/aero.test.ts#L60)
- **Range and limits** — Non-propeller collision shapes only; overlapping projections counted once [aero.ts:160](../../src/domain/aero.ts#L160)

### Per-axis quadratic drag

- **Verdict** — analytical
- **Model** — Fᵢ=−ρCd,ᵢAᵢ|vrel,ᵢ|vrel,ᵢ/2 in body axes.
- **Source** — Body-axis formula with entered Cd and projected areas [aero.rs:3](../../simulation-engine/engine-core/src/aero.rs#L3) · Implementation [aero.ts:180](../../src/domain/aero.ts#L180) [aero.rs:3](../../simulation-engine/engine-core/src/aero.rs#L3) [flight.rs:22](../../simulation-engine/engine-core/src/flight.rs#L22)
- **Check** — Hand force and closed-form fall; shared fixture adds cross-language agreement [`hand case along x, and a yawed body using its side area`](../../tests/unit/aero.test.ts#L68) (passed) · [`matches_the_typescript_model_on_the_shared_fixture`](../../simulation-engine/engine-core/src/aero.rs#L123) (passed) · [`fall_with_body_drag_approaches_terminal_velocity`](../../simulation-engine/engine-core/src/flight/tests.rs#L201) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — TS hand 12 decimal places, rationale not found [aero.test.ts:68](../../tests/unit/aero.test.ts#L68); fall error <0.0025 m/s at 1 ms and coarse/fine ratio 2 ± 0.2 from first-order discretization [tests.rs:197](../../simulation-engine/engine-core/src/flight/tests.rs#L197)
- **Range and limits** — Through CoM, at start-of-step relative velocity; no validation of actual build Cd or wake [flight.rs:22](../../simulation-engine/engine-core/src/flight.rs#L22)


## Wind

### Constant mean velocity and drift

- **Verdict** — analytical
- **Model** — vrel=vbody−vwind in a common frame. A wind bearing gives the direction it comes from.
- **Source** — Phase 6 frame/bearing convention [wind.rs:3](../../simulation-engine/engine-core/src/wind.rs#L3); closed-form drift per Phase 6 test 2 [tests.rs:480](../../simulation-engine/engine-core/src/flight/tests.rs#L480) · Implementation [wind.rs:1](../../simulation-engine/engine-core/src/wind.rs#L1) [flight.rs:28](../../simulation-engine/engine-core/src/flight.rs#L28)
- **Check** — Cardinal vectors, closed-form quadratic-drag drift [`constant_wind_uses_world_from_bearings_at_any_height`](../../simulation-engine/engine-core/src/wind/tests.rs#L59) (passed) · [`drift_in_a_constant_wind_converges_to_the_analytic_solution`](../../simulation-engine/engine-core/src/flight/tests.rs#L480) (passed)
- **Result this run** — See measurements below.
  - catalogue hold XY error = 0.0013058368394365145 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - catalogue hold Z error = 0.0000713808112783286 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - catalogue tilt error versus force balance = 0.0002781523493866622 ° [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
- **Assertion limits** — Bearings <1e-12 in vector norm, rationale not found [tests.rs:59](../../simulation-engine/engine-core/src/wind/tests.rs#L59); 3 s drift at 1 ms <0.0025 m or m/s and ratio 2 ± 0.2 from first-order stepping [tests.rs:480](../../simulation-engine/engine-core/src/flight/tests.rs#L480)
- **Range and limits** — Horizontal wind, constant at all heights; hold fixture 5 m/s from 90° [DEVLOG.md:66](../DEVLOG.md#L66)


## Gust

### Cosine ramp and convected distance

- **Verdict** — analytical
- **Model** — The gust rises as A[1−cos(πs/L)]/2 with s accumulated using start-of-step mean-air-relative speed, then holds at A.
- **Source** — MIL-F-8785C §3.7.1.3; simulator uses start-of-step mean-air-relative distance [wind.rs:4](../../simulation-engine/engine-core/src/wind.rs#L4) · Implementation [wind.rs:4](../../simulation-engine/engine-core/src/wind.rs#L4) [wind.rs:291](../../simulation-engine/engine-core/src/wind.rs#L291) [flight.rs:28](../../simulation-engine/engine-core/src/flight.rs#L28)
- **Check** — Hand ramp endpoints, midpoint and derivative; schedule and integrated distance regression [`gust_values_and_first_derivative_match_on_both_sides`](../../simulation-engine/engine-core/src/wind/tests.rs#L98) (passed) · [`gust_start_distance_and_hash_words`](../../simulation-engine/engine-core/src/wind/tests.rs#L127) (passed) · [`gust_uses_start_of_step_distance_and_hashes_the_integral`](../../simulation-engine/engine-core/src/flight/tests.rs#L613) (passed)
- **Result this run** — See measurements below.
  - catalogue peak drift = 0.33256530155526265 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - catalogue recovery after full strength = 17.748 s [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
- **Assertion limits** — Speed <1e-12 m/s; one-sided derivative <1e-4 at 1e-5 m step; numeric threshold derivation not found [tests.rs:98](../../simulation-engine/engine-core/src/wind/tests.rs#L98)
- **Range and limits** — One horizontal onset along mean direction; full amplitude held after ramp [tests.rs:98](../../simulation-engine/engine-core/src/wind/tests.rs#L98)


## Shear

### Low-altitude logarithmic profile

- **Verdict** — analytical
- **Model** — U(z)=Uref log(z/z₀)/log(zref/z₀) on the profile interval with endpoint handling.
- **Source** — MIL-F-8785C §3.7.3.2, MathWorks height guidance and Phase 6 local endpoint behavior [wind.rs:4](../../simulation-engine/engine-core/src/wind.rs#L4) · Implementation [wind.rs:3](../../simulation-engine/engine-core/src/wind.rs#L3) [flight.rs:28](../../simulation-engine/engine-core/src/flight.rs#L28)
- **Check** — Closed-form preset speed ratios; integration checks CoM clearance and clamping [`shear_reference_hand_values_and_height_limits`](../../simulation-engine/engine-core/src/wind/tests.rs#L77) (passed) · [`shear_uses_com_clearance_and_flags_the_1000_ft_hold`](../../simulation-engine/engine-core/src/flight/tests.rs#L646) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — <0.0005 ratio vs three-decimal references; exact reference-height and lower-hold assertions [tests.rs:77](../../simulation-engine/engine-core/src/wind/tests.rs#L77)
- **Range and limits** — Reference 20 ft, hold below 3 ft, standalone refuses above 1,000 ft, flight holds and flags [tests.rs:77](../../simulation-engine/engine-core/src/wind/tests.rs#L77) [tests.rs:646](../../simulation-engine/engine-core/src/flight/tests.rs#L646)


## Turbulence

**Self-consistency only** — Dryden height parameter calibration.

### Dryden filter and stochastic stream

- **Verdict** — analytical
- **Model** — Advance the Dryden filter states with their discrete linear transition and Gaussian innovations. Check variance and spectral density.
- **Source** — MIL-F-8785C low altitude, Phase 6 lines 143,153–168 and 178–181; MathWorks formulas; exact Gaussian innovation vs Madden ZOH [turbulence.rs:1](../../simulation-engine/engine-core/src/turbulence.rs#L1) · Implementation [turbulence.rs:1](../../simulation-engine/engine-core/src/turbulence.rs#L1) [turbulence.rs:54](../../simulation-engine/engine-core/src/turbulence.rs#L54)
- **Check** — Theoretical marginal variance and three spectral formulas; seeded repeatability [`independent_initial_and_advanced_variances_match_dryden`](../../simulation-engine/engine-core/src/turbulence/tests.rs#L65) (passed) · [`averaged_periodograms_match_the_three_dryden_spectra`](../../simulation-engine/engine-core/src/turbulence/tests.rs#L98) (passed) · [`seeded_series_is_repeatable_across_height_changes`](../../simulation-engine/engine-core/src/turbulence/tests.rs#L48) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Simultaneous 95% Laurent–Massart bounds; spectral sampling allowance plus finite-window/aliasing bias [tests.rs:85](../../simulation-engine/engine-core/src/turbulence/tests.rs#L85) [tests.rs:132](../../simulation-engine/engine-core/src/turbulence/tests.rs#L132)
- **Range and limits** — 10–1,000 ft length domain, hold outside; spectrum normalized by model-derived lengths/intensities and tested at fixture conditions [turbulence.rs:1](../../simulation-engine/engine-core/src/turbulence.rs#L1) [tests.rs:98](../../simulation-engine/engine-core/src/turbulence/tests.rs#L98)

### Dryden height parameter calibration

- **Verdict** — self-consistency only
- **Model** — Filter length scales Lᵢ and intensities σᵢ depend on clearance and the entered reference wind. Hold at the supported height endpoints.
- **Source** — Same MIL/MathWorks provenance [turbulence.rs:1](../../simulation-engine/engine-core/src/turbulence.rs#L1) · Implementation [turbulence.rs:1](../../simulation-engine/engine-core/src/turbulence.rs#L1)
- **Check** — Endpoint hold and model-generated length/sigma in normalized statistical checks [`height_limits_hold_lengths_and_intensities_and_flag_only_outside`](../../simulation-engine/engine-core/src/turbulence/tests.rs#L31) (passed) · [`independent_initial_and_advanced_variances_match_dryden`](../../simulation-engine/engine-core/src/turbulence/tests.rs#L65) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact endpoint/flag behavior; variance bounds above do not constrain parameter formulas independently [tests.rs:31](../../simulation-engine/engine-core/src/turbulence/tests.rs#L31) [tests.rs:89](../../simulation-engine/engine-core/src/turbulence/tests.rs#L89)
- **Range and limits** — W20 from entered mean or shear reference, no atmospheric time series found [turbulence.rs:5](../../simulation-engine/engine-core/src/turbulence.rs#L5)


## Ground effect

**Not validated** — Multirotor predictive accuracy near ground.

### Single-rotor ratio and induced velocity

- **Verdict** — analytical
- **Model** — In hover, TIGE/TOGE=1/[1−(R/4Z)²] in the formula’s domain. Induced velocity follows the momentum balance.
- **Source** — Cheeseman & Bennett R&M 3021 §§2.1–2.2 eqs. 2/4; Glauert R&M 1111 p. 563 eq. 11; Chen NASA TM 102219 and Sanchez-Cuevas et al. ROBOT 2017 p. 5 for limits [ground_effect.rs:10](../../simulation-engine/engine-core/src/ground_effect.rs#L10) [ground_effect.rs:41](../../simulation-engine/engine-core/src/ground_effect.rs#L41) [ground_effect.rs:61](../../simulation-engine/engine-core/src/ground_effect.rs#L61) · Implementation [ground_effect.rs:8](../../simulation-engine/engine-core/src/ground_effect.rs#L8) [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33)
- **Check** — Hand equation ratios and induced velocity; Chen qualitative wake inequality; per-hub geometry [`equation_2_gives_the_exact_rationals`](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L34) (passed) · [`equation_4_gives_the_exact_rationals_with_airspeed`](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L66) (passed) · [`induced_velocity_matches_hand_values`](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L79) (passed) · [`the_wake_agrees_with_chen_beyond_twice_the_hover_velocity`](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L100) (passed) · [`each_rotor_uses_its_own_ground_clearance_on_the_slope`](../../simulation-engine/engine-core/src/flight/tests.rs#L745) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Rational checks use rounding allowance [tests.rs:1](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L1) and 5e-5 for four-decimal plan values [tests.rs:34](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L34); 1e-14 relative for momentum hand cases [tests.rs:79](../../simulation-engine/engine-core/src/ground_effect/tests.rs#L79)
- **Range and limits** — Z/R held at 0.5 below cited lower range; horizontal flow, uniform disc; excludes adverse effect and rotor interactions [ground_effect.rs:61](../../simulation-engine/engine-core/src/ground_effect.rs#L61)

### Multirotor predictive accuracy near ground

- **Verdict** — not validated
- **Model** — Evaluate the single-rotor thrust ratio at each hub’s clearance and scale the rotor thrust.
- **Source** — Single-rotor equation applied to each hub [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33) · Implementation [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33) [ground_effect.rs:3](../../simulation-engine/engine-core/src/ground_effect.rs#L3)
- **Check** — No held-out multirotor data found
- **Result this run** — No measurement or passing check available.
- **Assertion limits** — Not found
- **Range and limits** — Thrust only; interactions and inflow outside model [flight.rs:33](../../simulation-engine/engine-core/src/flight.rs#L33)


## Terrain

**Self-consistency only** — Integrated terrain landing.

### Grid ingest, triangle height and engine registration

- **Verdict** — analytical
- **Model** — Compute surface height by barycentric interpolation in the selected heightfield triangle and transform grid coordinates to the engine frame.
- **Source** — Phase 6 D10 metre input [terrain.ts:24](../../src/domain/terrain.ts#L24); parry-heightfield3.rs:101–106,355–369,391–402 [terrain.ts:118](../../src/domain/terrain.ts#L118) · Implementation [terrain.ts:25](../../src/domain/terrain.ts#L25) [terrain.ts:94](../../src/domain/terrain.ts#L94) [environment.rs:98](../../simulation-engine/engine-core/src/environment.rs#L98)
- **Check** — Hand planes and corners; TS grid parity and Rapier raycast [`preserves nodes and follows the two Parry triangle planes`](../../tests/unit/terrain.test.ts#L64) (passed) · [`height_below_matches_the_typescript_grid`](../../simulation-engine/engine-core/src/environment/tests.rs#L330) (passed) · [`terrain_collider_registers_the_correct_world_corner_and_triangles`](../../simulation-engine/engine-core/src/environment/tests.rs#L347) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Engine corner ≤23 f64 epsilons, height ≤allowed linear error [tests.rs:347](../../simulation-engine/engine-core/src/environment/tests.rs#L347); TS exact fixture values [terrain.test.ts:24](../../tests/unit/terrain.test.ts#L24)
- **Range and limits** — Metre heights across sample centers; outside returns undefined; invalid headers/sentinel refused [terrain.ts:25](../../src/domain/terrain.ts#L25) [terrain.ts:93](../../src/domain/terrain.ts#L93)

### Ground clearance and slide/rest

- **Verdict** — analytical
- **Model** — Clearance follows shape support relative to the ground. The Coulomb slide/rest threshold is tan(slope)=μ.
- **Source** — Rapier contacts and shape minimum/support vs terrain [environment.rs:22](../../simulation-engine/engine-core/src/environment.rs#L22) [tests.rs:243](../../simulation-engine/engine-core/src/environment/tests.rs#L243) · Implementation [environment.rs:22](../../simulation-engine/engine-core/src/environment.rs#L22) [environment.rs:512](../../simulation-engine/engine-core/src/environment.rs#L512)
- **Check** — Hand support geometry and Coulomb tan(slope) criterion [`clearance_on_plane_matches_the_lowest_point_of_each_shape`](../../simulation-engine/engine-core/src/environment/tests.rs#L243) (passed) · [`clearance_finds_a_ridge_and_bridges_a_pit_below_the_belly`](../../simulation-engine/engine-core/src/environment/tests.rs#L278) (passed) · [`terrain_slope_slides_above_and_rests_below_atan_of_friction`](../../simulation-engine/engine-core/src/environment/tests.rs#L417) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-9 m from the spawn-penetration threshold, held speed <1e-6 m/s with numeric rationale not found, sliding speed beyond contact slop per step [sim.rs:37](../../simulation-engine/engine-core/src/sim.rs#L37) [tests.rs:270](../../simulation-engine/engine-core/src/environment/tests.rs#L270) [tests.rs:439](../../simulation-engine/engine-core/src/environment/tests.rs#L439)
- **Range and limits** — Planar and stepped heightfields for support. Slide/rest sampled at half and twice the friction slope, with a brick placed flush [tests.rs:243](../../simulation-engine/engine-core/src/environment/tests.rs#L243) [tests.rs:278](../../simulation-engine/engine-core/src/environment/tests.rs#L278) [tests.rs:417](../../simulation-engine/engine-core/src/environment/tests.rs#L417)

### Integrated terrain landing

- **Verdict** — self-consistency only
- **Model** — Fly the takeoff, hold and landing state sequence against the terrain heightfield. Evaluate hold error, touchdown speed and the landed state.
- **Source** — Simulator acceptance contract [DEVLOG.md:66](../DEVLOG.md#L66) [DEVLOG.md:68](../DEVLOG.md#L68) · Implementation [flight_script.rs:192](../../simulation-engine/engine-core/src/scenario/flight_script.rs#L192) [flight_loop.rs:305](../../simulation-engine/engine-core/src/flight_loop.rs#L305)
- **Check** — Same simulator, prescribed pass and landing states on steep and shallow fixtures [`runs the four FlightLoop acceptance scripts on the catalogue build`](../../tests/unit/scenario-protocol.test.ts#L626) (passed)
- **Result this run** — See measurements below.
  - 45° (acceptance failed) hold XY error = 0.026026907503950033 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - 45° (acceptance failed) hold Z error = 0.0003014036885118365 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - 45° (acceptance failed) touchdown speed = 0.6361712530705562 m/s [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - 45° (acceptance failed) hold position limit = 0.01 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - 45° (acceptance failed) touchdown speed limit = 0.7 m/s [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - 5° (acceptance passed) hold XY error = 0.007855216085981899 m [scenario-protocol.test.ts:670](../../tests/unit/scenario-protocol.test.ts#L670)
  - 5° (acceptance passed) hold Z error = 0.000019197516386793012 m [scenario-protocol.test.ts:670](../../tests/unit/scenario-protocol.test.ts#L670)
  - 5° (acceptance passed) touchdown speed = 0.5417503322509388 m/s [scenario-protocol.test.ts:670](../../tests/unit/scenario-protocol.test.ts#L670)
  - 5° (acceptance passed) hold position limit = 0.01 m [scenario-protocol.test.ts:670](../../tests/unit/scenario-protocol.test.ts#L670)
  - 5° (acceptance passed) touchdown speed limit = 0.7 m/s [scenario-protocol.test.ts:670](../../tests/unit/scenario-protocol.test.ts#L670)
- **Assertion limits** — Exact pass/landed statuses. Acceptance uses <0.01 m hold per the 6.7 fixture and 0.7 m/s touchdown from MPC_LAND_SPEED [scenario-protocol.test.ts:624](../../tests/unit/scenario-protocol.test.ts#L624) [DEVLOG.md:68](../DEVLOG.md#L68)
- **Range and limits** — Catalogue build and ?=0.4, 5? and 45? fixtures. K5 records incomplete landing at 45? [DEVLOG.md:66](../DEVLOG.md#L66) [DEVLOG.md:77](../DEVLOG.md#L77)


## Mixer

### Rotor effectiveness, pseudoinverse and normalization

- **Verdict** — analytical
- **Model** — Allocate u=B⁺w from the rotor-effectiveness matrix B and normalize the selected allocation axes.
- **Source** — PX4 ControlAllocationPseudoInverse.cpp:57–169 [controller.rs:419](../../simulation-engine/engine-core/src/controller.rs#L419) · Implementation [controller.rs:416](../../simulation-engine/engine-core/src/controller.rs#L416)
- **Check** — Closed-form signs and allocation identity, hex and tilted cases [`quad_signs_and_pseudoinverse`](../../simulation-engine/engine-core/src/controller/tests.rs#L66) (passed) · [`hexa_x_and_tilted_motor`](../../simulation-engine/engine-core/src/controller/tests.rs#L103) (passed) · [`rectangular_quad_shares_roll_pitch_scale`](../../simulation-engine/engine-core/src/controller/tests.rs#L198) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-11 normalized units for f64 roundoff [tests.rs:45](../../simulation-engine/engine-core/src/controller/tests.rs#L45)
- **Current test statements** — `const EPS: f64 = 1e-11;` [tests.rs:47](../../simulation-engine/engine-core/src/controller/tests.rs#L47)
- **Range and limits** — Nominal geometry, rank-deficient rejected, uses mean kQ/kT, no actual CoM/inertia [closed_loop.rs:12](../../simulation-engine/engine-core/src/closed_loop.rs#L12) [tests.rs:181](../../simulation-engine/engine-core/src/controller/tests.rs#L181)

### Sequential desaturation and airmode

- **Verdict** — analytical
- **Model** — Adjust motor commands by gains along selected allocation directions, then clip to the command range.
- **Source** — PX4 ControlAllocationSequentialDesaturation.cpp functions and source ranges [controller.rs:565](../../simulation-engine/engine-core/src/controller.rs#L565) [controller.rs:651](../../simulation-engine/engine-core/src/controller.rs#L651) · Implementation [controller.rs:549](../../simulation-engine/engine-core/src/controller.rs#L549) [controller.rs:565](../../simulation-engine/engine-core/src/controller.rs#L565) [controller.rs:632](../../simulation-engine/engine-core/src/controller.rs#L632)
- **Check** — Hand-selected clipping priorities; bitwise compatibility with earlier local implementation [`airmode_disabled_reduces_high_thrust_but_never_raises_low_thrust`](../../simulation-engine/engine-core/src/controller/tests.rs#L213) (passed) · [`yaw_uses_fifteen_percent_headroom_then_reduces_thrust`](../../simulation-engine/engine-core/src/controller/tests.rs#L253) (passed) · [`airmode_zero_is_bit_identical_to_phase_4_7`](../../simulation-engine/engine-core/src/controller/tests.rs#L684) (passed) · [`airmode_zero_is_bit_identical_to_phase_4_7_on_random_demands`](../../simulation-engine/engine-core/src/controller/tests.rs#L731) (passed) · [`airmode_rp_raises_collective_for_both_attitude_axes_but_not_yaw`](../../simulation-engine/engine-core/src/controller/tests.rs#L766) (passed) · [`airmode_rpy_raises_collective_for_yaw_and_prioritizes_roll_pitch`](../../simulation-engine/engine-core/src/controller/tests.rs#L795) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact bits for airmode 0; 1e-11 f64 helper and policy assertions for selected demands [tests.rs:45](../../simulation-engine/engine-core/src/controller/tests.rs#L45) [tests.rs:684](../../simulation-engine/engine-core/src/controller/tests.rs#L684)
- **Range and limits** — Airmode 0/1/2; output in [0,1], temporary yaw headroom and saturation flags [controller.rs:549](../../simulation-engine/engine-core/src/controller.rs#L549) [controller.rs:565](../../simulation-engine/engine-core/src/controller.rs#L565)

### Motor command thrust transform

- **Verdict** — analytical
- **Model** — For desired normalized thrust t, invert t=fu²+(1−f)u on [0,1].
- **Source** — PX4 motor_params.c:57–73 and functions.hpp:141–165 [thrust_model.rs:3](../../simulation-engine/engine-core/src/thrust_model.rs#L3) [thrust_model.rs:8](../../simulation-engine/engine-core/src/thrust_model.rs#L8) · Implementation [thrust_model.rs:53](../../simulation-engine/engine-core/src/thrust_model.rs#L53) [thrust_model.rs:63](../../simulation-engine/engine-core/src/thrust_model.rs#L63)
- **Check** — Hand quadratic and PX4 closed-form expression evaluated in Rust; round trips [`endpoints_roundtrip_and_monotonicity`](../../simulation-engine/engine-core/src/thrust_model.rs#L88) (passed) · [`hand_values_and_px4_closed_form_agree`](../../simulation-engine/engine-core/src/thrust_model.rs#L107) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact endpoints/zero bits; 1e-15 hand inverse and 1e-12 for closed form/round trip, threshold rationale not found [thrust_model.rs:88](../../simulation-engine/engine-core/src/thrust_model.rs#L88) [thrust_model.rs:107](../../simulation-engine/engine-core/src/thrust_model.rs#L107)
- **Range and limits** — Signal and factor in [0,1], non-reversible motor; PX4 f32 vs port f64 [thrust_model.rs:1](../../simulation-engine/engine-core/src/thrust_model.rs#L1) [thrust_model.rs:8](../../simulation-engine/engine-core/src/thrust_model.rs#L8)


## Rate

### Body-rate PID, feed-forward and anti-windup

- **Verdict** — analytical
- **Model** — τ=Kp(ωsp−ω)+I−Kdω̇+Kffωsp. Saturation gates integrator growth.
- **Source** — PX4 RateControl.cpp, derivatives at lines 57–64; FLU conversion [controller.rs:5](../../simulation-engine/engine-core/src/controller.rs#L5) [controller.rs:345](../../simulation-engine/engine-core/src/controller.rs#L345) · Implementation [controller.rs:315](../../simulation-engine/engine-core/src/controller.rs#L315) [controller.rs:345](../../simulation-engine/engine-core/src/controller.rs#L345)
- **Check** — Hand torque and derivative on measurement, saturation freeze/unwind [`rate_integral_limit_freeze_unwind_and_d_measurement`](../../simulation-engine/engine-core/src/controller/tests.rs#L323) (passed) · [`gyro_d_uses_the_supplied_acceleration_on_the_first_tick`](../../simulation-engine/engine-core/src/controller/tests.rs#L841) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact clamp/freeze; 1e-11 f64 helper [tests.rs:45](../../simulation-engine/engine-core/src/controller/tests.rs#L45) [tests.rs:323](../../simulation-engine/engine-core/src/controller/tests.rs#L323)
- **Current test statements** — `const EPS: f64 = 1e-11;` [tests.rs:47](../../simulation-engine/engine-core/src/controller/tests.rs#L47)
- **Range and limits** — Angular acceleration from perfect-state finite difference or supplied gyro feedback; gains and rate limits in source units [controller.rs:14](../../simulation-engine/engine-core/src/controller.rs#L14) [controller.rs:345](../../simulation-engine/engine-core/src/controller.rs#L345)


## Attitude

### Reduced-quaternion attitude and yaw weighting

- **Verdict** — analytical
- **Model** — Align the thrust axes first, weight the residual yaw, then map the canonical quaternion error’s imaginary part to a rate demand.
- **Source** — PX4 AttitudeControl.cpp v1.13.3, FLU/Z-up port [controller.rs:3](../../simulation-engine/engine-core/src/controller.rs#L3) · Implementation [controller.rs:271](../../simulation-engine/engine-core/src/controller.rs#L271)
- **Check** — Small-angle/exact quaternion cases, sign equivalence and simulated roll response [`attitude_small_large_double_cover_and_yaw_weight`](../../simulation-engine/engine-core/src/controller/tests.rs#L287) (passed) · [`attitude_zero_yaw_weight_and_opposed_thrust_are_finite`](../../simulation-engine/engine-core/src/controller/tests.rs#L578) (passed) · [`closed_loop_ten_degree_roll`](../../simulation-engine/engine-core/src/controller/tests.rs#L506) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 1e-11 for numerical roundoff; small-angle cubic term <1e-15 [tests.rs:45](../../simulation-engine/engine-core/src/controller/tests.rs#L45) [tests.rs:287](../../simulation-engine/engine-core/src/controller/tests.rs#L287); 1% roll/altitude tracking after 9 s settling [tests.rs:506](../../simulation-engine/engine-core/src/controller/tests.rs#L506)
- **Range and limits** — Includes opposed thrust, zero yaw weight and double-cover cases; perfect attitude estimate [tests.rs:287](../../simulation-engine/engine-core/src/controller/tests.rs#L287) [tests.rs:578](../../simulation-engine/engine-core/src/controller/tests.rs#L578) [closed_loop.rs:6](../../simulation-engine/engine-core/src/closed_loop.rs#L6)


## Velocity and position control

**Self-consistency only** — Legacy vertical conformance; Integrated hover, payload and trim scenarios.

### Position P, velocity PID, thrust vector and limits

- **Verdict** — analytical
- **Model** — vsp=vff+Kp,pos(psp−p). Velocity PID plus acceleration feed-forward yields a thrust vector limited by tilt and thrust constraints.
- **Source** — PX4 PositionControl.cpp:105–236 and ControlMath.cpp:47–184,234–259 [position_control.rs:33](../../simulation-engine/engine-core/src/position_control.rs#L33) · Implementation [position_control.rs:540](../../simulation-engine/engine-core/src/position_control.rs#L540) [position_control.rs:772](../../simulation-engine/engine-core/src/position_control.rs#L772) [position_control.rs:796](../../simulation-engine/engine-core/src/position_control.rs#L796)
- **Check** — Closed-form 1 m P-only position step and hand velocity, D-filter, limit and anti-windup cases [`position_velocity_priority_and_vertical_limits`](../../simulation-engine/engine-core/src/position_control/tests.rs#L292) (passed) · [`velocity_d_and_acceleration_feedforward_have_engine_frame_signs`](../../simulation-engine/engine-core/src/position_control/tests.rs#L320) (passed) · [`filtered_derivative_first_sample_lowpass_and_px4_reset`](../../simulation-engine/engine-core/src/position_control/tests.rs#L350) (passed) · [`vertical_and_horizontal_anti_windup_equations_and_reset`](../../simulation-engine/engine-core/src/position_control/tests.rs#L406) (passed) · [`analytical_position_step_and_discretization_bound`](../../simulation-engine/engine-core/src/position_control/tests.rs#L625) (passed) · [`position_step_through_the_thrust_vector_stays_within_the_limit_tilt_bound`](../../simulation-engine/engine-core/src/position_control/tests.rs#L646) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Helper ≤1e-12, rationale not found [tests.rs:6](../../simulation-engine/engine-core/src/position_control/tests.rs#L6). Step <1 mm with coarse/fine error ratio bounds at 1/0.5 ms from first-order discretization; thrust-vector bound from tilt approximation and sampling [tests.rs:625](../../simulation-engine/engine-core/src/position_control/tests.rs#L625) [tests.rs:646](../../simulation-engine/engine-core/src/position_control/tests.rs#L646)
- **Current test statements** — `assert!((a - b).abs() <= 1e-12, "{a} != {b}");` [tests.rs:7](../../simulation-engine/engine-core/src/position_control/tests.rs#L7) · `coarse.0 < 2.1 * fine.0 && fine.0 < 0.55 * coarse.0,` [tests.rs:632](../../simulation-engine/engine-core/src/position_control/tests.rs#L632) · `assert!(coarse.0 < 0.001);` [tests.rs:635](../../simulation-engine/engine-core/src/position_control/tests.rs#L635)
- **Range and limits** — Finite estimates and valid setpoint layers, NaN disables layer; acceleration and thrust limits; perfect-state test plant [tests.rs:234](../../simulation-engine/engine-core/src/position_control/tests.rs#L234) [tests.rs:586](../../simulation-engine/engine-core/src/position_control/tests.rs#L586)

### Legacy vertical conformance

- **Verdict** — self-consistency only
- **Model** — Compare the vertical response and state hash to the legacy controller fixture.
- **Source** — Phase 4.7 local controller behavior [tests.rs:478](../../simulation-engine/engine-core/src/position_control/tests.rs#L478) · Implementation [position_control.rs:540](../../simulation-engine/engine-core/src/position_control.rs#L540) [closed_loop.rs:1](../../simulation-engine/engine-core/src/closed_loop.rs#L1)
- **Check** — Earlier local run/hash and baseline controller [`vertical_conformance_to_47_over_ten_second_profile`](../../simulation-engine/engine-core/src/position_control/tests.rs#L535) (passed) · [`vertical_conformance_to_47_through_both_thrust_limits`](../../simulation-engine/engine-core/src/position_control/tests.rs#L555) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact hash with numerical profile assertions [tests.rs:478](../../simulation-engine/engine-core/src/position_control/tests.rs#L478)
- **Range and limits** — Two scripted profiles including thrust limits; continuity with previous build [tests.rs:535](../../simulation-engine/engine-core/src/position_control/tests.rs#L535) [tests.rs:555](../../simulation-engine/engine-core/src/position_control/tests.rs#L555)

### Manual stick shaping and trajectory smoothing

- **Verdict** — analytical
- **Model** — Apply deadband and expo to the stick, map to tilt or velocity, and integrate a jerk-limited trajectory under velocity and acceleration constraints.
- **Source** — PX4 Functions.hpp:84–89,125–139; FlightTask manual and StickAccelerationXY source ranges; VelocitySmoothing.cpp:58–102,138–149,157–264 [flight_modes.rs:109](../../simulation-engine/engine-core/src/flight_modes.rs#L109) [flight_modes.rs:420](../../simulation-engine/engine-core/src/flight_modes.rs#L420) [flight_modes.rs:530](../../simulation-engine/engine-core/src/flight_modes.rs#L530) [flight_modes.rs:608](../../simulation-engine/engine-core/src/flight_modes.rs#L608) [flight_modes.rs:651](../../simulation-engine/engine-core/src/flight_modes.rs#L651) · Implementation [flight_modes.rs:109](../../simulation-engine/engine-core/src/flight_modes.rs#L109) [flight_modes.rs:330](../../simulation-engine/engine-core/src/flight_modes.rs#L330) [flight_modes.rs:420](../../simulation-engine/engine-core/src/flight_modes.rs#L420) [flight_modes.rs:530](../../simulation-engine/engine-core/src/flight_modes.rs#L530) [flight_modes.rs:608](../../simulation-engine/engine-core/src/flight_modes.rs#L608)
- **Check** — Hand tilt/coordinate and velocity/acceleration results; jerk/limit invariants [`stabilized_diagonal_limits_tilt_and_preserves_axis_angle_yaw`](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L100) (passed) · [`velocity_mode_shapes_then_rotates_and_limits_diagonals`](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L182) (passed) · [`acceleration_mode_limits_first_jerk_integrates_velocity_and_brakes`](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L209) (passed) · [`acceleration_mode_vertical_step_starts_with_bounded_jerk_and_reaches_stick_speed`](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L259) (passed) · [`vertical_unlock_copies_position_controller_feedback`](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L320) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — ≤1e-12 by reference to position test helper, which supplies no derivation; per-step jerk allowance `8·dt + 1e-12` [tests.rs:6](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L6) [tests.rs:259](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L259)
- **Range and limits** — Centered throttle in [-1,1], exact estimates and local task simplifications [flight_modes.rs:30](../../simulation-engine/engine-core/src/flight_modes.rs#L30)

### Integrated hover, payload and trim scenarios

- **Verdict** — self-consistency only
- **Model** — Compare steady thrust and moment balance (ΣT=mg and Σr×T=0) with hover, loaded and offset-CoM scenarios.
- **Source** — Weight and moment balance, with shared propulsion and pack-sag model for throttle and trim predictions [tests.rs:89](../../simulation-engine/engine-core/src/scenario/tests.rs#L89) [DEVLOG.md:171](../DEVLOG.md#L171) · Implementation [builtins.rs:26](../../simulation-engine/engine-core/src/scenario/builtins.rs#L26) [builtins.rs:91](../../simulation-engine/engine-core/src/scenario/builtins.rs#L91) [builtins.rs:110](../../simulation-engine/engine-core/src/scenario/builtins.rs#L110)
- **Check** — Same-model predicted throttle/trim, state hashes and expected scenario outcomes. A hand-derived 1.3076 N offset balance independently checks that observable [`builtins_match_their_predictions`](../../simulation-engine/engine-core/src/scenario/tests.rs#L108) (passed)
- **Result this run** — See measurements below.
  - balanced_hover final altitude error with estimator off = 0.00007349866851596071 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - balanced_hover final altitude error with estimator on = 0.00007861320458463934 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - balanced_hover max attitude error with estimator off = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - balanced_hover max attitude error with estimator on = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - payload final altitude error with estimator off = 0.000028325084465331577 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - payload final altitude error with estimator on = 0.000028982544022471062 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - payload max attitude error with estimator off = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - payload max attitude error with estimator on = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset final altitude error with estimator off = 0.00007390534823518279 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset final altitude error with estimator on = 0.00007908159454849896 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset max attitude error with estimator off = 1.6665 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset max attitude error with estimator on = 1.6665 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - overweight_payload final altitude error with estimator off = -918.3998019530945 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - overweight_payload final altitude error with estimator on = -918.3998019530945 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - overweight_payload max attitude error with estimator off = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - overweight_payload max attitude error with estimator on = 0 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset_beyond_authority final altitude error with estimator off = -99.63080817375771 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset_beyond_authority final altitude error with estimator on = -99.63080817375771 m [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset_beyond_authority max attitude error with estimator off = 179.998 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
  - com_offset_beyond_authority max attitude error with estimator on = 179.998 ° [tests.rs:134](../../simulation-engine/engine-core/src/scenario/tests.rs#L134)
- **Assertion limits** — Settled budgets 0.02 m, 0.01 rad and 10 ms saturation per prior fixture, command within 0.005 for finite integral settling, and offset balance within 0.02 N. Whole-run mean command within 0.05 of the prediction, with cold-start bias stated and numeric rationale not found [builtins.rs:91](../../simulation-engine/engine-core/src/scenario/builtins.rs#L91) [builtins.rs:110](../../simulation-engine/engine-core/src/scenario/builtins.rs#L110) [tests.rs:138](../../simulation-engine/engine-core/src/scenario/tests.rs#L138)
- **Range and limits** — Local fixture quad and separate catalogue comparison. Includes balanced, payload, overweight, offset and beyond-authority cases [tests.rs:89](../../simulation-engine/engine-core/src/scenario/tests.rs#L89) [DEVLOG.md:97](../DEVLOG.md#L97)


## Auto modes

**Self-consistency only** — Integrated takeoff/hold/land behavior.

### Takeoff state machine and signed climb ramp

- **Verdict** — analytical
- **Model** — Run the takeoff state machine and ramp the signed climb limit from its initial value to the commanded climb speed.
- **Source** — PX4 Takeoff.cpp:42–134, MulticopterPositionControl.cpp:406–442 and hysteresis [takeoff.rs:87](../../simulation-engine/engine-core/src/takeoff.rs#L87) [takeoff.rs:135](../../simulation-engine/engine-core/src/takeoff.rs#L135) [takeoff.rs:179](../../simulation-engine/engine-core/src/takeoff.rs#L179) · Implementation [takeoff.rs:87](../../simulation-engine/engine-core/src/takeoff.rs#L87) [takeoff.rs:135](../../simulation-engine/engine-core/src/takeoff.rs#L135)
- **Check** — Hand ramp samples and state/timestamp order [`switch_visits_all_states_and_falls_through_in_source_order`](../../simulation-engine/engine-core/src/takeoff/tests.rs#L43) (passed) · [`ramp_matches_hand_values_and_finishes_after_exact_integer_elapsed_time`](../../simulation-engine/engine-core/src/takeoff/tests.rs#L82) (passed) · [`ground_start_spools_and_the_climb_limit_follows_the_ramp`](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L240) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Ramp samples <1e-14 from hand values; threshold rationale not found [tests.rs:82](../../simulation-engine/engine-core/src/takeoff/tests.rs#L82); exact integer time/state
- **Range and limits** — Armed state, spool and ramp; climb limit is positive-up with signed initial limit [takeoff.rs:1](../../simulation-engine/engine-core/src/takeoff.rs#L1) [takeoff.rs:87](../../simulation-engine/engine-core/src/takeoff.rs#L87)

### Auto takeoff, hold and land target equations

- **Verdict** — analytical
- **Model** — Generate climb and hold setpoints, then interpolate descent speed between the configured height gates.
- **Source** — PX4 FlightTaskAuto.cpp:118–287,806–857, PositionSmoothing.cpp:129–145,286–326, reused VelocitySmoothing [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) · Implementation [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) [auto_modes.rs:305](../../simulation-engine/engine-core/src/auto_modes.rs#L305) [auto_modes.rs:592](../../simulation-engine/engine-core/src/auto_modes.rs#L592)
- **Check** — Exact target activation and hand interpolation of landing speeds [`land_speed_is_linear_in_start_relative_height_without_range_crawl`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L4) (passed) · [`takeoff_target_uses_run_origin_and_validates_an_explicit_height`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L18) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Midpoint ≤1e-12 following flight modes helper [tests.rs:4](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L4) [tests.rs:6](../../simulation-engine/engine-core/src/flight_modes/tests.rs#L6)
- **Range and limits** — Relative to run start; hold captures target, no multi-waypoint synchronization or range crawl [DEVLOG.md:61](../DEVLOG.md#L61) [tests.rs:4](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L4)

### Integrated takeoff/hold/land behavior

- **Verdict** — self-consistency only
- **Model** — Run scripted target changes through the flight loop and check hold errors, touchdown and detector transitions.
- **Source** — Simulator task, plant and acceptance contract [flight_script.rs:95](../../simulation-engine/engine-core/src/scenario/flight_script.rs#L95) [DEVLOG.md:68](../DEVLOG.md#L68) · Implementation [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) [flight_loop.rs:1](../../simulation-engine/engine-core/src/flight_loop.rs#L1) [flight_script.rs:192](../../simulation-engine/engine-core/src/scenario/flight_script.rs#L192)
- **Check** — Scenario targets, state ordering and same-simulator repeats [`quad_takes_off_holds_lands_and_stays_ready_deterministically`](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L302) (passed) · [`runs the four FlightLoop acceptance scripts on the catalogue build`](../../tests/unit/scenario-protocol.test.ts#L626) (passed)
- **Result this run** — See measurements below.
  - flat engine fixture hold XY error = 0.0038589293632677038 m [tests.rs:355](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L355)
  - flat engine fixture hold Z error = 0.00003312297271795828 m [tests.rs:355](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L355)
  - flat engine fixture resting XY error = 0.007186279550755939 m [tests.rs:355](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L355)
  - flat engine fixture resting Z error = -0.000025875556916597764 m [tests.rs:355](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L355)
  - flat catalogue fixture hold XY error = 0.007781063954254121 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - flat catalogue fixture hold Z error = 0.00002146078019649167 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - flat catalogue fixture touchdown speed = 0.5953454313637813 m/s [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - flat catalogue fixture hold position limit = 0.01 m [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
  - flat catalogue fixture touchdown speed limit = 0.7 m/s [scenario-protocol.test.ts:662](../../tests/unit/scenario-protocol.test.ts#L662)
- **Assertion limits** — <0.01 m hold, <0.00012 m resting height for flat unit fixture [tests.rs:302](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L302); catalogue landing speed limit from MPC_LAND_SPEED and wind tilt limit from centered-attitude tolerance [DEVLOG.md:68](../DEVLOG.md#L68)
- **Current test statements** — `const HOLD_TOLERANCE_M: f64 = 0.01;` [tests.rs:304](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L304) · `const LANDED_TOLERANCE_M: f64 = 1.2e-4;` [tests.rs:306](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L306)
- **Range and limits** — Tested on catalogue setup, K5 slope exception [DEVLOG.md:66](../DEVLOG.md#L66) [DEVLOG.md:75](../DEVLOG.md#L75)


## Return

**Self-consistency only** — Integrated return-to-start guidance.

### Altitude cone, straight-track trajectory and state order

- **Verdict** — analytical
- **Model** — Combine the return altitude cone with altitude bounds, then follow a straight horizontal track under velocity, acceleration and jerk caps.
- **Source** — PX4 rtl.cpp:274–309,683–717; PositionSmoothing.cpp:107–126,235–251,286–325 [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) [auto_modes.rs:375](../../simulation-engine/engine-core/src/auto_modes.rs#L375) [auto_modes.rs:460](../../simulation-engine/engine-core/src/auto_modes.rs#L460) [auto_modes.rs:518](../../simulation-engine/engine-core/src/auto_modes.rs#L518) · Implementation [auto_modes.rs:358](../../simulation-engine/engine-core/src/auto_modes.rs#L358) [auto_modes.rs:421](../../simulation-engine/engine-core/src/auto_modes.rs#L421) [auto_modes.rs:519](../../simulation-engine/engine-core/src/auto_modes.rs#L519) [auto_modes.rs:551](../../simulation-engine/engine-core/src/auto_modes.rs#L551)
- **Check** — Hand cone geometry, state-machine fixtures and speed/acceleration/jerk constraints [`return_altitude_uses_the_radius_cone_and_outer_altitude`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L37) (passed) · [`multicopter_return_advances_only_after_position_altitude_yaw_and_delay`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L70) (passed) · [`return_handles_direct_landing_unlimited_loiter_and_activation_already_landed`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L111) (passed) · [`straight_return_track_respects_speed_acceleration_and_jerk_and_stops`](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L142) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Cone exact except f32 EPS allowance at edge [auto_modes.rs:23](../../simulation-engine/engine-core/src/auto_modes.rs#L23) [tests.rs:37](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L37); track within 0.01 m after convergence from existing landing fixture, caps plus EPS [tests.rs:142](../../simulation-engine/engine-core/src/auto_modes/tests.rs#L142)
- **Range and limits** — Local XY instead of geodesic distance, fixed home and straight horizontal track; status widening omitted [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) [auto_modes.rs:518](../../simulation-engine/engine-core/src/auto_modes.rs#L518) [DEVLOG.md:84](../DEVLOG.md#L84)

### Integrated return-to-start guidance

- **Verdict** — self-consistency only
- **Model** — Follow climb → return → land → landed. Measure horizontal distance and vertical error relative to home.
- **Source** — Local simulator RTL adaptation [auto_modes.rs:1](../../simulation-engine/engine-core/src/auto_modes.rs#L1) [auto_modes.rs:518](../../simulation-engine/engine-core/src/auto_modes.rs#L518) · Implementation [auto_modes.rs:459](../../simulation-engine/engine-core/src/auto_modes.rs#L459) [flight_loop.rs:1](../../simulation-engine/engine-core/src/flight_loop.rs#L1)
- **Check** — Catalogue vehicle returns from a scripted 30 m separation in 5 m/s wind; model-generated state and target [`returns the catalogue quad from 30 m in 5 m/s wind and lands at home`](../../tests/unit/scenario-protocol.test.ts#L673) (passed)
- **Result this run** — See measurements below.
  - landing XY error = 0.003809861408527136 m [scenario-protocol.test.ts:733](../../tests/unit/scenario-protocol.test.ts#L733)
  - absolute landing Z error = 0.0000064114548407046 m [scenario-protocol.test.ts:733](../../tests/unit/scenario-protocol.test.ts#L733)
- **Assertion limits** — Exact climb/return/land/landed order; XY <0.01 m and Z <0.00012 m from existing landing check [scenario-protocol.test.ts:699](../../tests/unit/scenario-protocol.test.ts#L699) [tests.rs:302](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L302)
- **Current test statements** — ``expect(errorM[0], `landing errors [XY, Z] m: ${errorM}`).toBeLessThan(0.01)`` [scenario-protocol.test.ts:735](../../tests/unit/scenario-protocol.test.ts#L735) · ``expect(errorM[1], `landing errors [XY, Z] m: ${errorM}`).toBeLessThanOrEqual(1.2e-4)`` [scenario-protocol.test.ts:736](../../tests/unit/scenario-protocol.test.ts#L736)
- **Range and limits** — Tested on one catalogue build with a simulated starting surface and wind, no PX4 trajectory playback found


## Land detector

**Self-consistency only** — Ground contact, maybe-landed, landed and freefall predicates.

### Ground contact, maybe-landed, landed and freefall predicates

- **Verdict** — self-consistency only
- **Model** — Combine thrust and motion predicates with state-dependent hysteresis. Evaluate freefall by its acceleration predicate.
- **Source** — PX4 LandDetector.cpp:122–147, MulticopterLandDetector.cpp:149–325 including truncation/gates [land_detector.rs:1](../../simulation-engine/engine-core/src/land_detector.rs#L1) [land_detector.rs:178](../../simulation-engine/engine-core/src/land_detector.rs#L178) [land_detector.rs:217](../../simulation-engine/engine-core/src/land_detector.rs#L217) [land_detector.rs:261](../../simulation-engine/engine-core/src/land_detector.rs#L261) · Implementation [land_detector.rs:1](../../simulation-engine/engine-core/src/land_detector.rs#L1) [land_detector.rs:180](../../simulation-engine/engine-core/src/land_detector.rs#L180)
- **Check** — Hand-coded state outcomes and timer fixtures; low-thrust run repeats simulator [`levels_rise_in_order_and_clear_without_a_falling_delay`](../../simulation-engine/engine-core/src/land_detector/tests.rs#L95) (passed) · [`interrupted_requests_restart_each_level_timer`](../../simulation-engine/engine-core/src/land_detector/tests.rs#L116) (passed) · [`freefall_requires_300_ms_and_blocks_maybe_landed_on_same_tick`](../../simulation-engine/engine-core/src/land_detector/tests.rs#L170) (passed) · [`stale_vertical_velocity_uses_strict_eight_second_low_thrust_fallback`](../../simulation-engine/engine-core/src/land_detector/tests.rs#L211) (passed) · [`stationary_low_thrust_takeoff_attempt_never_reaches_flight_and_replays_exactly`](../../simulation-engine/engine-core/src/land_detector/tests.rs#L265) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact booleans and boundary ticks [tests.rs:95](../../simulation-engine/engine-core/src/land_detector/tests.rs#L95) [tests.rs:170](../../simulation-engine/engine-core/src/land_detector/tests.rs#L170) [tests.rs:211](../../simulation-engine/engine-core/src/land_detector/tests.rs#L211)
- **Range and limits** — Uses synchronous state; no range sensor, no ground-effect input; freefall needs specific force; K5 does not finish on steep fixture [land_detector.rs:1](../../simulation-engine/engine-core/src/land_detector.rs#L1) [land_detector.rs:92](../../simulation-engine/engine-core/src/land_detector.rs#L92) [DEVLOG.md:75](../DEVLOG.md#L75)


## Hover-thrust estimator

### Scalar EKF, variance and gating

- **Verdict** — analytical
- **Model** — Predict scalar variance with process noise, then update using K=PH/(H²P+R) when the innovation gate accepts the measurement.
- **Source** — PX4 zero_order_hover_thrust_ekf.cpp:44–156 and MulticopterHoverThrustEstimator.cpp:104–230, with Z-up sign conversion [hover_thrust.rs:31](../../simulation-engine/engine-core/src/hover_thrust.rs#L31) [hover_thrust.rs:185](../../simulation-engine/engine-core/src/hover_thrust.rs#L185) [hover_thrust.rs:240](../../simulation-engine/engine-core/src/hover_thrust.rs#L240) [hover_thrust.rs:279](../../simulation-engine/engine-core/src/hover_thrust.rs#L279) · Implementation [hover_thrust.rs:31](../../simulation-engine/engine-core/src/hover_thrust.rs#L31) [hover_thrust.rs:185](../../simulation-engine/engine-core/src/hover_thrust.rs#L185) [hover_thrust.rs:242](../../simulation-engine/engine-core/src/hover_thrust.rs#L242)
- **Check** — Closed-form true hover, scalar Riccati equilibrium and linearized payload-step time response; gates by synthetic samples [`converges_to_closed_form_hover_thrust_with_either_acceleration_sign`](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L88) (passed) · [`mass_step_response_matches_the_rate_implied_by_process_noise`](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L101) (passed) · [`outliers_are_gated_and_persistent_rejection_increases_uncertainty`](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L161) (passed) · [`first_valid_requires_two_seconds_of_passing_requests_then_survives_an_outlier`](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L221) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Error <sqrt(reported variance), equilibrium ≤1e-12 hand f64, slope error <10·fraction² with central-difference cancellation [tests.rs:32](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L32) [tests.rs:88](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L88) [tests.rs:101](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L101)
- **Range and limits** — Synchronous simulated acceleration/thrust with timing, clearance and validity gating; bounded by configured hover range [hover_thrust.rs:31](../../simulation-engine/engine-core/src/hover_thrust.rs#L31) [tests.rs:179](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L179) [tests.rs:245](../../simulation-engine/engine-core/src/hover_thrust/tests.rs#L245)


## Gyro filters

**Self-consistency only** — Noisy gyro closed-loop hover and roll-rate response.

### Static notch, two-pole low-pass and derivative alpha filter

- **Verdict** — analytical
- **Model** — Apply notch and low-pass biquads, and first-difference the filtered rate before first-order smoothing.
- **Source** — PX4 LowPassFilter2p.hpp:61–90,146–160; NotchFilter.hpp:78–87,133–147,173–187,217–229,267–285; AlphaFilter.hpp:67–88,102–119; VehicleAngularVelocity.cpp:160–190,735–763 [gyro_filters.rs:44](../../simulation-engine/engine-core/src/gyro_filters.rs#L44) [gyro_filters.rs:96](../../simulation-engine/engine-core/src/gyro_filters.rs#L96) [gyro_filters.rs:113](../../simulation-engine/engine-core/src/gyro_filters.rs#L113) [gyro_filters.rs:140](../../simulation-engine/engine-core/src/gyro_filters.rs#L140) [gyro_filters.rs:172](../../simulation-engine/engine-core/src/gyro_filters.rs#L172) · Implementation [gyro_filters.rs:44](../../simulation-engine/engine-core/src/gyro_filters.rs#L44) [gyro_filters.rs:96](../../simulation-engine/engine-core/src/gyro_filters.rs#L96) [gyro_filters.rs:140](../../simulation-engine/engine-core/src/gyro_filters.rs#L140) [gyro_filters.rs:172](../../simulation-engine/engine-core/src/gyro_filters.rs#L172)
- **Check** — Closed-form transfer-function phasor/step at selected bins and first derivative/reset [`two_pole_rate_response_and_reset`](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L73) (passed) · [`static_notch_response_and_reset`](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L89) (passed) · [`acceleration_alpha_response_and_zero_initial_derivative`](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L107) (passed) · [`px4_bypasses_zero_and_nyquist`](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L125) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Absolute <4e-5 for phasor components and step samples, allows f32 arithmetic [tests.rs:36](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L36) [tests.rs:52](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L52)
- **Current test statements** — `assert!((measured.0 - gain * phase.cos()).abs() < 4e-5, "{hz} Hz in-phase");` [tests.rs:55](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L55) · `assert!((measured.1 - gain * phase.sin()).abs() < 4e-5, "{hz} Hz quadrature");` [tests.rs:56](../../simulation-engine/engine-core/src/gyro_filters/tests.rs#L56)
- **Range and limits** — Fixed 1 kHz, static notch, f32 cutoff checks and bypass at zero/Nyquist; omits raw FIFO, publication throttling and dynamic notches [gyro_filters.rs:1](../../simulation-engine/engine-core/src/gyro_filters.rs#L1) [DEVLOG.md:36](../DEVLOG.md#L36)

### Noise-free filtered gyro feedback into the rate loop

- **Verdict** — independent reference
- **Model** — Compare the production filter path with separate direct-form I biquads and an alpha-smoothed rate derivative.
- **Source** — PX4 filter and derivative equations as cited in [gyro_filters.rs:113](../../simulation-engine/engine-core/src/gyro_filters.rs#L113) [gyro_filters.rs:140](../../simulation-engine/engine-core/src/gyro_filters.rs#L140) [gyro_filters.rs:172](../../simulation-engine/engine-core/src/gyro_filters.rs#L172) · Implementation [sensors.rs:195](../../simulation-engine/engine-core/src/sensors.rs#L195) [sensors.rs:215](../../simulation-engine/engine-core/src/sensors.rs#L215) [controller.rs:740](../../simulation-engine/engine-core/src/controller.rs#L740)
- **Check** — Separately implemented f64 direct-form I plus alpha derivative, fed into the same rate loop [`noise_free_gyro_flies_the_independent_filter_feedback`](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L416) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Rate <2e-5 rad/s, acceleration <2e-4 rad/s², motor command difference <2e-5. Numeric rationale not found [tests.rs:438](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L438) [tests.rs:452](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L452)
- **Range and limits** — 500 steps, 10°/s roll, 40/30 Hz cutoffs, zero sensor effects and no notches [tests.rs:421](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L421) [tests.rs:448](../../simulation-engine/engine-core/src/flight_loop/tests.rs#L448)

### Noisy gyro closed-loop hover and roll-rate response

- **Verdict** — self-consistency only
- **Model** — Compute RMS rate and tilt in hover and measure 10–90% rise time and overshoot in a rate step.
- **Source** — Catalogue gyro and simulation step fixture [scenario-protocol.test.ts:719](../../tests/unit/scenario-protocol.test.ts#L719) [scenario-protocol.test.ts:748](../../tests/unit/scenario-protocol.test.ts#L748) · Implementation [sensors.rs:210](../../simulation-engine/engine-core/src/sensors.rs#L210) [controller.rs:740](../../simulation-engine/engine-core/src/controller.rs#L740)
- **Check** — Engine truth vs chosen RMS and response bounds, plus perfect-state run from the same engine [`measures catalogue hover and true roll-rate step response with the datasheet gyro`](../../tests/unit/scenario-protocol.test.ts#L750) (passed)
- **Result this run** — See measurements below.
  - perfect-state rise time = 0.0689567639828032 s [scenario-protocol.test.ts:843](../../tests/unit/scenario-protocol.test.ts#L843)
  - perfect-state overshoot = 11.764091014615662 % [scenario-protocol.test.ts:843](../../tests/unit/scenario-protocol.test.ts#L843)
  - gyro rise time = 0.0599033392346483 s [scenario-protocol.test.ts:844](../../tests/unit/scenario-protocol.test.ts#L844)
  - gyro overshoot = 13.203764747339907 % [scenario-protocol.test.ts:844](../../tests/unit/scenario-protocol.test.ts#L844)
  - nominal true tilt RMS = 0.000015142899672909771 rad [scenario-protocol.test.ts:844](../../tests/unit/scenario-protocol.test.ts#L844)
  - nominal true rate RMS = 0.0002445581632308508 rad/s [scenario-protocol.test.ts:844](../../tests/unit/scenario-protocol.test.ts#L844)
- **Assertion limits** — Rate RMS < raw sigma, tilt RMS < sigma × 1 s and 10–90% rise <1 s, per hold assumptions. Excess noise raw RMS > its sigma/2 and motor activity >10× nominal have no stated numeric rationale. Exact zero clips with range disabled. Overshoot logged [scenario-protocol.test.ts:752](../../tests/unit/scenario-protocol.test.ts#L752) [scenario-protocol.test.ts:794](../../tests/unit/scenario-protocol.test.ts#L794) [scenario-protocol.test.ts:810](../../tests/unit/scenario-protocol.test.ts#L810)
- **Current test statements** — `const limits = { rateRms: sigma, tiltRms: sigma * holdS, riseS: holdS }` [scenario-protocol.test.ts:790](../../tests/unit/scenario-protocol.test.ts#L790) · `expect.soft(riseS!).toBeLessThan(limits.riseS)` [scenario-protocol.test.ts:848](../../tests/unit/scenario-protocol.test.ts#L848) · `expect.soft(excessive.rawGyroRmsRadps).toBeGreaterThan(excessiveSigma / 2)` [scenario-protocol.test.ts:849](../../tests/unit/scenario-protocol.test.ts#L849) · `expect.soft(excessive.clipped).toBe(0)` [scenario-protocol.test.ts:850](../../tests/unit/scenario-protocol.test.ts#L850) · `expect.soft(excessive.motorActivityRms).toBeGreaterThan(nominal.motorActivityRms * 10)` [scenario-protocol.test.ts:851](../../tests/unit/scenario-protocol.test.ts#L851)
- **Range and limits** — Catalogue quad, 10°/s roll step with 1 s hold and 10 s duration, nominal and 1,000× nominal sensor sigma in hover [scenario-protocol.test.ts:748](../../tests/unit/scenario-protocol.test.ts#L748) [scenario-protocol.test.ts:794](../../tests/unit/scenario-protocol.test.ts#L794)


## Sensors

**Self-consistency only** — Barometer pressure/inverse and noise.

**Not validated** — GPS stochastic error and barometer noise/bias calibration.

### IMU additive noise, vibration, bias walk and clipping

- **Verdict** — analytical
- **Model** — Add vibration and Gaussian noise to truth, walk bias with variance proportional to elapsed time, then clip and delay the sample.
- **Source** — Independent Gaussian draws and Wiener increment variance, PX4 residual bias comment VehicleAngularVelocity.cpp:916 [sensors.rs:17](../../simulation-engine/engine-core/src/sensors.rs#L17) [sensors.rs:123](../../simulation-engine/engine-core/src/sensors.rs#L123) · Implementation [sensors.rs:111](../../simulation-engine/engine-core/src/sensors.rs#L111) [sensors.rs:123](../../simulation-engine/engine-core/src/sensors.rs#L123)
- **Check** — Exact delayed clipped impulse and Gaussian/Wiener mean/variance from statistical theory [`delayed_impulse_preserves_clipping_flags_and_slow_samples_hold`](../../simulation-engine/engine-core/src/sensors/tests.rs#L72) (passed) · [`white_noise_and_vibration_have_the_expected_mean_and_sample_variance`](../../simulation-engine/engine-core/src/sensors/tests.rs#L122) (passed) · [`random_walk_variance_grows_linearly_with_elapsed_time`](../../simulation-engine/engine-core/src/sensors/tests.rs#L141) (passed) · [`gyro_feedback_waits_for_the_delayed_sample`](../../simulation-engine/engine-core/src/sensors/tests.rs#L162) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact delayed samples; Gaussian tail and Laurent–Massart variance bounds at ≥99.9% per bound [tests.rs:72](../../simulation-engine/engine-core/src/sensors/tests.rs#L72) [tests.rs:105](../../simulation-engine/engine-core/src/sensors/tests.rs#L105)
- **Range and limits** — Per-axis white terms, fixed entered bias, symmetric optional clipping and integral delay; no measured vibration spectrum [sensors.rs:15](../../simulation-engine/engine-core/src/sensors.rs#L15) [sensors.rs:123](../../simulation-engine/engine-core/src/sensors.rs#L123)

### Accelerometer mount kinematics

- **Verdict** — analytical
- **Model** — Rotate aCoM−g+α×r+ω×(ω×r) into the sensor axes.
- **Source** — Specific force with tangential/centripetal acceleration, finite differences at plant steps [sensors.rs:347](../../simulation-engine/engine-core/src/sensors.rs#L347) · Implementation [sensors.rs:232](../../simulation-engine/engine-core/src/sensors.rs#L232) [sensors.rs:347](../../simulation-engine/engine-core/src/sensors.rs#L347)
- **Check** — Hand spinning-mount force in post-step orientation with CoM offset [`spinning_mount_specific_force_uses_the_post_step_pose_and_com`](../../simulation-engine/engine-core/src/sensors/tests.rs#L46) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — <1e-10 in tested axes; numeric threshold rationale not found [tests.rs:46](../../simulation-engine/engine-core/src/sensors/tests.rs#L46)
- **Range and limits** — Body-frame offset from origin, relative to moving CoM, post-step result [sensors.rs:49](../../simulation-engine/engine-core/src/sensors.rs#L49) [sensors.rs:347](../../simulation-engine/engine-core/src/sensors.rs#L347)

### Barometer pressure/inverse and noise

- **Verdict** — self-consistency only
- **Model** — Use the ISA pressure power law and its inverse; add pressure bias and noise before holding the sample.
- **Source** — ISA convention [sensors.rs:362](../../simulation-engine/engine-core/src/sensors.rs#L362); additive pressure bias/noise [sensors.rs:235](../../simulation-engine/engine-core/src/sensors.rs#L235) · Implementation [sensors.rs:235](../../simulation-engine/engine-core/src/sensors.rs#L235) [sensors.rs:362](../../simulation-engine/engine-core/src/sensors.rs#L362)
- **Check** — Shared pressure fixture and algebraic inverse round trip; host checks held pressure at sample boundaries [flight-live.test.ts:946](../../tests/unit/flight-live.test.ts#L946) [`isa_pressure_and_inverse_match_the_shared_fixture`](../../simulation-engine/engine-core/src/sensors/tests.rs#L33) (passed) · [`matches the Rust pressure fixture and varies density with actual temperature`](../../tests/unit/sensors.test.ts#L111) (passed) · [`records post-step sensors reproducibly across chunks, recording schedules and log replay`](../../tests/unit/flight-live.test.ts#L924) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — ≤1e-8 Pa and ≤1e-8 m in Rust, allowance for deterministic math differences of a few ULPs [tests.rs:33](../../simulation-engine/engine-core/src/sensors/tests.rs#L33)
- **Range and limits** — ISA height [-5000,11000] m; pressure outside inverse domain yields missing altitude [sensors.rs:362](../../simulation-engine/engine-core/src/sensors.rs#L362) [ARCHITECTURE.md:89](../ARCHITECTURE.md#L89)

### GPS cadence and zero-noise truth

- **Verdict** — analytical
- **Model** — Sample local CoM position and velocity on the configured cadence, deliver after the configured delay, and hold between deliveries.
- **Source** — Synthetic local CoM position and velocity, held samples and delayed delivery [sensors.rs:84](../../simulation-engine/engine-core/src/sensors.rs#L84) [sensors.rs:246](../../simulation-engine/engine-core/src/sensors.rs#L246) · Implementation [sensors.rs:34](../../simulation-engine/engine-core/src/sensors.rs#L34) [sensors.rs:246](../../simulation-engine/engine-core/src/sensors.rs#L246)
- **Check** — Exact hand schedule for zero noise; payload checks for units and unset delay [`delayed_impulse_preserves_clipping_flags_and_slow_samples_hold`](../../simulation-engine/engine-core/src/sensors/tests.rs#L72) (passed) · [`reports units and input locations and leaves the PX4 GPS delay unapplied`](../../tests/unit/sensors.test.ts#L88) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact sample/hold equality, period 3 steps and delay 1 in fixture [tests.rs:72](../../simulation-engine/engine-core/src/sensors/tests.rs#L72)
- **Range and limits** — World-frame CoM, positive period in steps and optional nonnegative delay [ARCHITECTURE.md:75](../ARCHITECTURE.md#L75)

### GPS stochastic error and barometer noise/bias calibration

- **Verdict** — not validated
- **Model** — Perturb sensor truth with calibrated-input Gaussian noise and bias terms. The input calibration lacks independent observations.
- **Source** — Entered/cited component specifications and additive Gaussian model [sensor-specs.ts:1](../../src/domain/sensor-specs.ts#L1) [sensors.rs:235](../../simulation-engine/engine-core/src/sensors.rs#L235) · Implementation [sensors.rs:235](../../simulation-engine/engine-core/src/sensors.rs#L235) [sensors.rs:246](../../simulation-engine/engine-core/src/sensors.rs#L246) [sensor-specs.ts:1](../../src/domain/sensor-specs.ts#L1)
- **Check** — No check located.
- **Result this run** — No measurement or passing check available.
- **Assertion limits** — Not found
- **Range and limits** — GPS independent horizontal/vertical/velocity terms and pressure-domain barometer perturbations, no held-out hardware trace found [ARCHITECTURE.md:73](../ARCHITECTURE.md#L73) [sensors.rs:235](../../simulation-engine/engine-core/src/sensors.rs#L235)


## Atmosphere

### ISA troposphere and temperature override

- **Verdict** — published data
- **Model** — Use T=T₀−Lh, p=p₀(T/T₀)^(g/RL) and ρ=p/(RT). For a temperature override, use the overridden temperature in density.
- **Source** — US Standard Atmosphere 1976 layer b=0, eq. 33a and Table I [atmosphere.ts:8](../../src/domain/atmosphere.ts#L8) [atmosphere.test.ts:18](../../tests/unit/atmosphere.test.ts#L18) · Implementation [atmosphere.ts:8](../../src/domain/atmosphere.ts#L8) [atmosphere.ts:73](../../src/domain/atmosphere.ts#L73) [atmosphere.ts:86](../../src/domain/atmosphere.ts#L86)
- **Check** — Published sea-level density and hydrostatic/ideal-gas hand checks [`gives the cited sea-level density (USSA Table I: 1.2250 kg/m³) at 0 m`](../../tests/unit/atmosphere.test.ts#L18) (passed) · [`satisfies the hydrostatic equation dP/dH = −ρ g0 (central difference, 1e-7 relative)`](../../tests/unit/atmosphere.test.ts#L22) (passed) · [`a hot day lowers the density as T_std / T at the same pressure`](../../tests/unit/atmosphere.test.ts#L31) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Density <5e-5 kg/m³, consistent with printed 4 decimals; hydrostatic residual <1e-7 relative for 0.5 m central difference, threshold rationale not found; hot-day ratio 12 decimals, reason not found [atmosphere.test.ts:18](../../tests/unit/atmosphere.test.ts#L18) [atmosphere.test.ts:22](../../tests/unit/atmosphere.test.ts#L22) [atmosphere.test.ts:31](../../tests/unit/atmosphere.test.ts#L31)
- **Range and limits** — Geopotential height [-5000,11000] m; temperature override changes density at ISA pressure; absolute zero refused [atmosphere.ts:8](../../src/domain/atmosphere.ts#L8) [atmosphere.ts:73](../../src/domain/atmosphere.ts#L73) [atmosphere.test.ts:36](../../tests/unit/atmosphere.test.ts#L36)


## Electrical calculations

### Copper cable and steady-state network

- **Verdict** — analytical
- **Model** — R=ρ·2L/A for the cable pair. Sum branch currents, subtract IR drops, and compute resistive losses as I²R.
- **Source** — IEC 60028, NIST Handbook 100 and AWG ASTM B258; Ohm’s law and I²R [electrical.ts:18](../../src/domain/electrical.ts#L18) · Implementation [electrical.ts:18](../../src/domain/electrical.ts#L18) [electrical.ts:131](../../src/domain/electrical.ts#L131) [electrical.ts:152](../../src/domain/electrical.ts#L152)
- **Check** — Hand resistivity, resistance, sag, drops and loss; graph refusal tests [`copper resistivity follows IEC 60028`](../../tests/unit/electrical.test.ts#L61) (passed) · [`R = ρ·2L/A for 12 AWG, 150 mm at 20 °C`](../../tests/unit/electrical.test.ts#L67) (passed) · [`matches the hand calculation: currents, drops, sag, losses (each motor at 21 A, full charge)`](../../tests/unit/electrical.test.ts#L75) (passed) · [`refuses loops and two batteries, and needs a wired battery`](../../tests/unit/electrical.test.ts#L155) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — 0.001 relative for cable/load case helper and hot copper, 12 decimals at 20 °C; hand derivations present; threshold rationale not found [electrical.test.ts:34](../../tests/unit/electrical.test.ts#L34) [electrical.test.ts:61](../../tests/unit/electrical.test.ts#L61) [electrical.test.ts:67](../../tests/unit/electrical.test.ts#L67)
- **Range and limits** — One battery, radial wiring, fixed requested current/temperature; depends on entered cable/spec data, no switching transients [electrical.ts:1](../../src/domain/electrical.ts#L1) [electrical.test.ts:155](../../tests/unit/electrical.test.ts#L155)


## Compatibility checks

**Self-consistency only** — Mechanical/electrical/spec and wiring rules.

### Mechanical/electrical/spec and wiring rules

- **Verdict** — self-consistency only
- **Model** — Compare component limits, connector and port assignments, and geometric separation against the project rules.
- **Source** — Project rule definitions; source/current/cell limits from linked component entries, geometric warning margin [checks.ts:48](../../src/domain/checks.ts#L48) [checks.ts:51](../../src/domain/checks.ts#L51) · Implementation [checks.ts:48](../../src/domain/checks.ts#L48) [checks.ts:51](../../src/domain/checks.ts#L51) [checks.ts:444](../../src/domain/checks.ts#L444) [wiring.ts:1](../../src/domain/wiring.ts#L1)
- **Check** — Fixture-defined expected finding and missing-data behavior [`battery-cells: a 6S battery with a 4S-max ESC is an error naming both; in-range passes`](../../tests/unit/checks.test.ts#L90) (passed) · [`prop-clearance: overlap is an error, under 10 mm a warning; discs at different heights are not compared`](../../tests/unit/checks.test.ts#L173) (passed) · [`covers every rule with a passing, a failing and (where data can be missing) a cannot-check input`](../../tests/unit/checks.test.ts#L225) (passed) · [`moving the GPS onto the telemetry port is a port conflict naming both devices`](../../tests/unit/wiring.test.ts#L103) (passed) · [`wired ESC pairing lets the current check compare different ESCs motor by motor`](../../tests/unit/wiring.test.ts#L129) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact statuses and associated IDs; 10 mm is rule threshold, rationale not found [checks.ts:48](../../src/domain/checks.ts#L48) [checks.test.ts:173](../../tests/unit/checks.test.ts#L173) [checks.test.ts:225](../../tests/unit/checks.test.ts#L225)
- **Range and limits** — Catalogue and entered specs; only checks implemented rules, some prop geometry assumptions and incomplete input cannot-check [checks.test.ts:109](../../tests/unit/checks.test.ts#L109) [checks.test.ts:173](../../tests/unit/checks.test.ts#L173) [checks.test.ts:225](../../tests/unit/checks.test.ts#L225)


## Recording and replay

**Self-consistency only** — BLZR binary frames, corruption handling, persistence and export; Saved pose playback and verification.

### BLZR binary frames, corruption handling, persistence and export

- **Verdict** — self-consistency only
- **Model** — Check CRC-32 and complete-frame boundaries, recover the verified prefix, and export samples with the stored clock.
- **Source** — Local v1 frame layout, IEEE CRC-32 via node:zlib [format.ts:6](../../electron/main/telemetry/format.ts#L6); saved sample clock [reader.ts:152](../../electron/main/telemetry/reader.ts#L152) · Implementation [format.ts:1](../../electron/main/telemetry/format.ts#L1) [reader.ts:152](../../electron/main/telemetry/reader.ts#L152) [writer.ts:36](../../electron/main/telemetry/writer.ts#L36) [session-recorder.ts:68](../../electron/main/telemetry/session-recorder.ts#L68) [csv.ts:105](../../electron/main/telemetry/csv.ts#L105)
- **Check** — Own writer/reader, mutated/truncated byte prefixes and independently stated expected rows [`round trips doubles, signed zero, missing values and exact replay text`](../../tests/unit/recording-format.test.ts#L57) (passed) · [`opens every byte prefix at its last whole frame`](../../tests/unit/recording-format.test.ts#L75) (passed) · [`keeps the verified prefix after a flipped byte in any data or end chunk, or a zero-filled tail`](../../tests/unit/recording-format.test.ts#L117) (passed) · [`marks an injected disk-full write as failed and preserves the preceding complete frames`](../../tests/unit/recording-store.test.ts#L120) (passed) · [`exports stored time first, recorded units and full precision, and replaces an existing file`](../../tests/unit/recording-csv.test.ts#L85) (passed) · [`exports every sample once across batch boundaries`](../../tests/unit/recording-csv.test.ts#L106) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact float/signed-zero/request round-trip, complete-prefix and export row expectations [recording-format.test.ts:57](../../tests/unit/recording-format.test.ts#L57) [recording-format.test.ts:75](../../tests/unit/recording-format.test.ts#L75) [recording-csv.test.ts:106](../../tests/unit/recording-csv.test.ts#L106)
- **Range and limits** — BLZR v1; detects incomplete/corrupt frames; bounded writer queue; recovery keeps completed prefix [format.ts:1](../../electron/main/telemetry/format.ts#L1) [recording-format.test.ts:172](../../tests/unit/recording-format.test.ts#L172) [ARCHITECTURE.md:135](../ARCHITECTURE.md#L135)

### Telemetry min/max bucketing

- **Verdict** — analytical
- **Model** — Keep chronological bucket minima and maxima with missing-value markers as specified by the point budget.
- **Source** — Local rule for time-ordered extrema and missing markers [decimation.ts:3](../../electron/main/telemetry/decimation.ts#L3) · Implementation [decimation.ts:3](../../electron/main/telemetry/decimation.ts#L3) [decimation.ts:23](../../electron/main/telemetry/decimation.ts#L23) [reader.ts:277](../../electron/main/telemetry/reader.ts#L277)
- **Check** — Hand-selected extrema and gaps in eight fixed samples [`keeps peaks and a brief mixed-bucket gap in order, plus an all-missing bucket`](../../tests/unit/recording-format.test.ts#L209) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact equality for budgets 1, 2 and 5 [recording-format.test.ts:209](../../tests/unit/recording-format.test.ts#L209)
- **Range and limits** — Chronological, uniformly spaced rows. Test uses one channel. One-point budget keeps the first row [decimation.ts:3](../../electron/main/telemetry/decimation.ts#L3) [recording-format.test.ts:209](../../tests/unit/recording-format.test.ts#L209)

### Replay sample clock and window selection

- **Verdict** — analytical
- **Model** — Use the last sample at or before the query time and clamp requested windows to the stored sample range.
- **Source** — Saved sample clock and previous-sample hold [ARCHITECTURE.md:133](../ARCHITECTURE.md#L133) [ARCHITECTURE.md:141](../ARCHITECTURE.md#L141) · Implementation [replay-frame.ts:21](../../src/features/flight/replay-frame.ts#L21) [replay-frame.ts:26](../../src/features/flight/replay-frame.ts#L26) [replay-frame.ts:37](../../src/features/flight/replay-frame.ts#L37)
- **Check** — Hand-selected before-first, between-sample and after-last indices and time windows, plus a generated exact boundary [`holds the previous replay sample and maps exact edges across bounded windows`](../../tests/unit/telemetry-graphs.test.ts#L318) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact indices and window objects [telemetry-graphs.test.ts:318](../../tests/unit/telemetry-graphs.test.ts#L318)
- **Range and limits** — 501 samples on a 4 ms clock from 0.004 to 2.004 s. The check exercises index and window selection [telemetry-graphs.test.ts:319](../../tests/unit/telemetry-graphs.test.ts#L319)

### Saved pose playback and verification

- **Verdict** — self-consistency only
- **Model** — Hold the stored pose between sample times. Re-simulate the recorded inputs and compare the saved outputs and hash.
- **Source** — Local sample-and-hold playback, version-match re-simulation and exact samples/hash [ARCHITECTURE.md:141](../ARCHITECTURE.md#L141) [ARCHITECTURE.md:143](../ARCHITECTURE.md#L143) · Implementation [ReplayPanel.tsx:13](../../src/features/telemetry/ReplayPanel.tsx#L13) [verify.ts:80](../../electron/main/telemetry/verify.ts#L80)
- **Check** — Same engine across runs/chunking and saved samples; visual/verification flow scripted [`shows a live trace, then replays, scrubs and verifies a three-second recording`](../../tests/e2e/replay.spec.ts#L19) (source only) · [`samples legacy and FlightLoop scenarios like live one-step runs, with unchanged reports and hashes`](../../tests/unit/scenario-protocol.test.ts#L549) (passed) · [`replays saved wind and Dryden turbulence lines in a fresh engine with the recorded hash`](../../tests/unit/flight-live.test.ts#L1946) (passed) · [`verifies exact requests and rejects changed sticks, start state, CRC, truncation and engine version`](../../tests/unit/flight-live.test.ts#L1973) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Exact sample steps/values and final state/count for Verify [ARCHITECTURE.md:143](../ARCHITECTURE.md#L143); runtime e2e test cited as source only
- **Range and limits** — Matching engine/protocol versions and complete recordings required; samples held between recorded times [ARCHITECTURE.md:141](../ARCHITECTURE.md#L141) [ARCHITECTURE.md:143](../ARCHITECTURE.md#L143)

### FNV-1a state hash primitive

- **Verdict** — published data
- **Model** — XOR each ordered byte into the hash, then multiply by the FNV prime modulo 2⁶⁴.
- **Source** — FNV specification draft-eastlake-fnv [tests.rs:35](../../simulation-engine/engine-core/src/sim/tests.rs#L35) · Implementation [sim.rs:242](../../simulation-engine/engine-core/src/sim.rs#L242)
- **Check** — Published hash vectors, exact integers [`fnv1a_matches_published_test_vectors`](../../simulation-engine/engine-core/src/sim/tests.rs#L34) (passed)
- **Result this run** — Passed the cited assertions. The cited test source gives the bound or exact predicate below. No numeric residual was emitted.
- **Assertion limits** — Bit equality [tests.rs:34](../../simulation-engine/engine-core/src/sim/tests.rs#L34)
- **Range and limits** — 64-bit hash over ordered state words; same-hash regressions are repeatability evidence [sim.rs:242](../../simulation-engine/engine-core/src/sim.rs#L242)

## Offline PX4 v1.13.3 sources

The inventory lists the previously inspected [offline PX4 locators](inventory.md#offline-px4-source-availability). The supplied snapshot lacked `ROMFS/px4fmu_common/init.d/rc.mc_defaults`, which is outside PX4 `src/`. The named gyro filter coefficients are tested against the local fixtures.
