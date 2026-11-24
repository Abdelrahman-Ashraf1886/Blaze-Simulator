//! Scenario runner tests on the real models: the PX4 controller, the motor and
//! battery model and rapier, with no scripted plant response. The vehicle is the
//! quad of `closed_loop/tests.rs` (1 kg, arm 0.15 m, X layout), reproduced here
//! because that helper is private to its test module.
//!
//! Motor (synthetic SI data of `propulsion.rs`, not a catalogue part):
//! K_v = 100 rad/(s·V), R = 0.1 Ω, I₀ = 0.5 A, k_T = 2e-5 N·s², k_Q = 1e-7 N·m·s²,
//! J = 2e-5 kg·m²; pack 10 V open circuit, 10 mΩ, 18 720 C (5.2 Ah).

use super::*;
use crate::{
    controller::Gains,
    environment::{Environment, Surface},
    propulsion::{BatteryParams, MotorPropulsion, PropulsionDefinition},
    vehicle::{
        fixtures::{box_part, with_totals},
        MotorBody, Spin,
    },
};

const A: f64 = 0.15;

/// Each motor's data are taken to be fitted at the standard sea-level density
/// (its `referenceDensityKgM3` entry, as the 4.8 flight scaling requires).
const REF_RHO: f64 = 1.225;

fn quad() -> (Vehicle, Propulsion) {
    quad_with(Some(REF_RHO))
}

fn quad_with(reference_density: Option<f64>) -> (Vehicle, Propulsion) {
    let mut def = with_totals(vec![box_part("body", 1.0, [0.0; 3], [0.01, 0.01, 0.02, 0.0, 0.0, 0.0])]);
    let m = |i: usize, x: f64, y: f64, s: Spin| MotorBody {
        part_id: format!("m{i}"),
        position: [x, y, 0.0],
        thrust_axis: [0.0, 0.0, 1.0],
        spin: s,
    };
    def.motors = vec![m(1, A, -A, Spin::Ccw), m(2, -A, A, Spin::Ccw), m(3, A, A, Spin::Cw), m(4, -A, -A, Spin::Cw)];
    let p = Propulsion::from_definition(
        PropulsionDefinition {
            version: 1,
            motors: def
                .motors
                .iter()
                .map(|m| MotorPropulsion {
                    part_id: m.part_id.clone(),
                    kv_rad_per_sv: 100.0,
                    resistance_ohm: 0.1,
                    no_load_current_a: 0.5,
                    thrust_coef_ns2: 2e-5,
                    torque_coef_nms2: 1e-7,
                    inertia_kg_m2: 2e-5,
                    throttle_map: None,
                    reference_density_kg_m3: reference_density,
                })
                .collect(),
            battery: BatteryParams { open_circuit_voltage_v: 10.0, internal_resistance_ohm: 0.01, capacity_c: 18_720.0 },
        },
        &def,
    )
    .unwrap();
    (Vehicle::from_definition(def).unwrap(), p)
}

const DRAG: BodyDrag = BodyDrag { cd_body: [1.0; 3], area_m2: [0.01; 3] };

/// Flying at the motors' own reference density: ρ = ρ_ref, ratio 1.
fn config() -> ScenarioConfig {
    ScenarioConfig {
        gains: Gains::px4_v1_13_3(),
        air_density_kg_m3: REF_RHO,
        cutoff: None,
        ground: None,
    }
}

fn execute_with(v: &Vehicle, p: &Propulsion, c: &ScenarioConfig, s: &Scenario) -> ScenarioReport {
    run(v, p.clone(), Some(DRAG), c, s).unwrap()
}
fn execute(v: &Vehicle, p: &Propulsion, s: &Scenario) -> ScenarioReport {
    execute_with(v, p, &config(), s)
}
fn check(r: &ScenarioReport, pick: impl Fn(&Check) -> bool) -> &CheckResult {
    r.checks.iter().find(|c| pick(&c.check)).unwrap()
}

/// Every built-in, flown on the real models, and its prediction.
///
/// - balanced_hover: the controller's own closed-loop test settles to 1 cm /
///   0.1° in 10 s; after 19 s the budgets are 2 cm, 0.01 rad (0.573°) and no
///   saturation run over 10 ms. Hover throttle = the throttle whose steady
///   thrust (4.5's solver, with the pack sag) is W/4 per motor, ±0.005.
/// - payload (0.5 kg, at the CoM): same budgets; the throttle is the one for
///   1.5 kg, higher than for 1 kg.
/// - com_offset (20 mm): per motor T_front = W(A+d)/(4A) = 2.7785 N and
///   T_rear = W(A−d)/(4A) = 2.1248 N (W = 9.80665 N), so Σ x_i T_i / A =
///   2(T_front − T_rear) = 2 W d/(2A) = 1.3076 N (budget 0.02 N); the pitch rate
///   integrator holds the matching torque trim, which the builtin solves
///   through the shared-sag electrical balance (budget 0.001 normalised).
/// - overweight_payload: weight is twice the zero-sag full-duty thrust bound, so
///   with every motor commanded at MPC_THR_MAX the vehicle never climbs.
/// - com_offset_beyond_authority: the CoM lies beyond the outermost motors, so
///   no positive thrust distribution balances it; the motors saturate and the
///   tilt passes 30°.
#[test]
fn builtins_match_their_predictions() {
    let (v, p) = quad();
    let c = config();
    let balanced = execute(&v, &p, &balanced_hover(&v, &p, &c).unwrap());
    let loaded = execute(&v, &p, &payload(&v, &p, &c, 0.5).unwrap());
    let offset = execute(&v, &p, &com_offset(&v, &p, &c, 0.02).unwrap());
    let overweight = execute(&v, &p, &overweight_payload(&v, &p, &c).unwrap());
    let beyond = execute(&v, &p, &com_offset_beyond_authority(&v, &p, &c).unwrap());
    for r in [&balanced, &loaded, &offset, &overweight, &beyond] {
        assert!(r.passed, "{}: {:#?}", r.name, r.checks);
        assert_eq!(r.end_reason, ScenarioEnd::Duration);
    }
    // Whole-loop hashes recorded from the pre-switch 4.7 controller, which had no hover
    // estimator: with MPC_USE_HTE = 0 the new vertical loop reproduces them bit for bit.
    let mut off = c.clone();
    off.gains.mpc_use_hte = 0.0;
    for (scenario, reference) in [
        (balanced_hover(&v, &p, &off).unwrap(), "af9ee8edce279002"),
        (payload(&v, &p, &off, 0.5).unwrap(), "61788a0a4243cc4a"),
        (com_offset(&v, &p, &off, 0.02).unwrap(), "9276b50498625d18"),
        (overweight_payload(&v, &p, &off).unwrap(), "4e193a090a25a3b1"),
        (com_offset_beyond_authority(&v, &p, &off).unwrap(), "953d2542adf2ee75"),
    ] {
        let report = execute_with(&v, &p, &off, &scenario);
        assert_eq!(report.final_state_hash, reference, "{}", report.name);
        let on = [&balanced, &loaded, &offset, &overweight, &beyond].into_iter().find(|r| r.name == report.name).unwrap();
        println!("{}: altitude error m, off {:?} on {:?}; max attitude error deg, off {:.4} on {:.4}; mean throttle, off {:.5} on {:.5}; hash on {}",
            report.name, report.final_altitude_error_m, on.final_altitude_error_m, report.max_attitude_error_deg, on.max_attitude_error_deg,
            report.mean_throttle.iter().sum::<f64>() / 4.0, on.mean_throttle.iter().sum::<f64>() / 4.0, on.final_state_hash);
    }
    // The independent hand numbers.
    let balance = check(&offset, |c| matches!(c, Check::ThrustBalance { .. }));
    assert!((balance.measured.unwrap() - 1.3076).abs() < 0.02, "{balance:?}");
    let u1 = predicted_hover_throttle(&v, &p, 1.0).unwrap();
    let u15 = predicted_hover_throttle(&v, &p, 1.5).unwrap();
    assert!(u15 > u1);
    let mean = |r: &ScenarioReport| r.mean_throttle.iter().sum::<f64>() / 4.0;
    assert!(mean(&loaded) > mean(&balanced));
    // The cold start takes the mean above the settled value; both stay near.
    assert!((mean(&balanced) - u1).abs() < 0.05 && (mean(&loaded) - u15).abs() < 0.05);
    // Beyond authority the run ends 5 s in, with attitude lost.
    assert_eq!(beyond.elapsed_s, 5.0);
    assert!(beyond.saturated_fraction > 0.0);
}

/// The controller is built from the nominal vehicle only. At the first step the
/// estimate is level at the target height with no rate, so the commands are the
/// hover parameter MPC_THR_HOVER = 0.5 on every motor whatever the plant's mass
/// or CoM: a payload, a CoM offset and the balanced vehicle give identical
/// commands, and differ only afterwards (through the plant).
#[test]
fn the_controller_never_sees_the_payload_or_the_com() {
    let (v, p) = quad();
    let c = config();
    let first = |mut s: Scenario| {
        s.duration_s = 0.5;
        s.checks.clear();
        execute(&v, &p, &s)
    };
    let a = first(balanced_hover(&v, &p, &c).unwrap());
    let b = first(payload(&v, &p, &c, 0.5).unwrap());
    let d = first(com_offset(&v, &p, &c, 0.02).unwrap());
    assert_eq!(a.first_throttle, vec![0.5; 4]);
    assert_eq!(a.first_throttle, b.first_throttle);
    assert_eq!(a.first_throttle, d.first_throttle);
    // The plant does differ: a different state after the same commands.
    assert_ne!(a.final_state_hash, b.final_state_hash);
    assert_ne!(a.final_state_hash, d.final_state_hash);
}

/// The vehicle the controller is given is never modified.
#[test]
fn modifications_recompute_totals_and_leave_nominal_unchanged() {
    let (v, p) = quad();
    let c = config();
    let s = payload(&v, &p, &c, 0.5).unwrap();
    let plant = modified_vehicle(&v, &s).unwrap();
    assert_eq!(plant.totals.mass_kg, 1.5);
    assert_eq!(v.totals.mass_kg, 1.0);
    assert_eq!(plant.definition.motors, v.definition.motors);
    // Shifting the only part by d/(m/m) = d moves the CoM by d.
    let s = com_offset(&v, &p, &c, 0.02).unwrap();
    let plant = modified_vehicle(&v, &s).unwrap();
    assert_eq!(plant.totals.com, [0.02, 0.0, 0.0]);
    assert_eq!(v.totals.com, [0.0; 3]);
}

fn close_json(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match (a, b) {
        (Number(x), Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-12 * x.abs().max(y.abs()).max(1e-300)
        }
        (Array(x), Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| close_json(x, y)),
        (Object(x), Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close_json(v, w))),
        _ => a == b,
    }
}

/// Deterministic: two runs give the same report to the bit, hash included, and
/// the scenario and the report survive JSON.
#[test]
fn ten_second_determinism_and_json() {
    let (v, p) = quad();
    let c = config();
    let mut s = com_offset(&v, &p, &c, 0.02).unwrap();
    s.duration_s = 10.0;
    s.checks.clear();
    let text = serde_json::to_string(&s).unwrap();
    let round: Scenario = serde_json::from_str(&text).unwrap();
    assert_eq!(s, round);
    let a = execute(&v, &p, &s);
    let b = execute(&v, &p, &round);
    assert_eq!(a, b);
    assert_eq!(a.final_state_hash.len(), 16);
    assert_eq!(a.elapsed_s, 10.0);
    // serde_json parses floats to within an ulp (not bit-exact without its
    // `float_roundtrip` feature), so the report is compared to 1e-12 relative.
    let round: ScenarioReport = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    assert_eq!(a.final_state_hash, round.final_state_hash);
    assert!(close_json(&serde_json::to_value(&a).unwrap(), &serde_json::to_value(&round).unwrap()));
    // Unknown fields are refused.
    assert!(serde_json::from_str::<Scenario>(&text.replace("\"name\"", "\"nom\"")).is_err());
}

#[test]
fn invalid_inputs_are_errors_not_panics() {
    let (v, p) = quad();
    let c = config();
    let base = balanced_hover(&v, &p, &c).unwrap();
    for duration in [-1.0, 0.0, f64::NAN, f64::INFINITY] {
        let mut s = base.clone();
        s.duration_s = duration;
        assert!(s.validate(4).unwrap_err().contains("duration"));
    }
    let mut s = base.clone();
    s.script.clear();
    assert!(s.validate(4).unwrap_err().contains("script"));
    let mut s = base.clone();
    s.script[0].yaw_rate_radps = f64::NAN;
    assert!(s.validate(4).unwrap_err().contains("finite"));
    let mut s = base.clone();
    s.script[0].attitude = Attitude::Quaternion { xyzw: [0.0; 4] };
    assert!(s.validate(4).unwrap_err().contains("unit"));
    let mut s = base.clone();
    s.modifications.push(Modification::ShiftPart { part_id: "missing".into(), delta_m: [0.0; 3] });
    assert!(modified_vehicle(&v, &s).unwrap_err().contains("unknown part"));
    let mut s = base.clone();
    s.modifications.push(Modification::ShiftPart { part_id: "body".into(), delta_m: [f64::INFINITY, 0.0, 0.0] });
    assert!(modified_vehicle(&v, &s).unwrap_err().contains("finite"));
    let mut s = base.clone();
    s.checks.push(Check::RateTrim { after_s: 0.0, axis: 3, expected: 0.0, tolerance: 1.0 });
    assert!(s.validate(4).unwrap_err().contains("check"));
    for mass in [-1.0, 0.0, f64::NAN, f64::INFINITY] {
        assert!(payload(&v, &p, &c, mass).is_err());
    }
    let mut s = base.clone();
    s.modifications.push(Modification::Payload {
        part_id: "extra".into(),
        mass_kg: 1.0,
        position_m: [0.0; 3],
        box_size_m: Some([0.1, f64::NAN, 0.1]),
    });
    assert!(modified_vehicle(&v, &s).unwrap_err().contains("payload"));
    let mut s = base.clone();
    s.script.push(s.script[0].clone());
    assert!(s.validate(4).is_err());
    let mut s = base.clone();
    s.checks.push(Check::Altitude { after_s: 1.0, tolerance_m: f64::NAN });
    assert!(s.validate(4).is_err());
    let mut s = base.clone();
    s.checks.push(Check::ThrustBalance { after_s: 1.0, weights: vec![1.0; 3], expected_n: 0.0, tolerance_n: 1.0 });
    assert!(s.validate(4).is_err(), "one weight per motor");

    // The config: densities, cut-off and gains are validated, never defaulted.
    let with = |f: &dyn Fn(&mut ScenarioConfig)| {
        let mut c = config();
        f(&mut c);
        run(&v, p.clone(), Some(DRAG), &c, &base).unwrap_err()
    };
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(with(&|c| c.air_density_kg_m3 = bad).to_lowercase().contains("density"));
        assert!(with(&|c| c.cutoff = Some(Cutoff::VoltageV(bad))).contains("cut-off"));
        assert!(balanced_hover(&v, &p, &ScenarioConfig { air_density_kg_m3: bad, ..config() }).is_err());
    }
    assert!(with(&|c| c.gains.mc_roll_p = -1.0).contains("MC_ROLL_P"));
    // A motor without a reference density is refused with the engine's error,
    // by the run and by every built-in (no default is assumed).
    let (v0, p0) = quad_with(None);
    let e = run(&v0, p0.clone(), Some(DRAG), &config(), &base).unwrap_err();
    assert!(e.contains("reference density") && e.contains("m1"), "{e}");
    assert!(balanced_hover(&v0, &p0, &config()).unwrap_err().contains("reference density"));
    assert!(overweight_payload(&v0, &p0, &config()).is_err());
    // A start inside the ground is refused, naming the part.
    let ground = Ground {
        environment: Environment { ground: Some(Surface { friction: 0.5, restitution: 0.0 }), terrain: None, obstacles: vec![] },
        start_m: [0.0, 0.0, -0.01],
    };
    assert!(with(&|c| c.ground = Some(ground.clone())).contains("inside"));
}

/// Setpoint segments apply at the first step starting at or after `from_s`, and
/// a check whose window is never reached is a failure with no measurement.
#[test]
fn script_holds_and_missing_windows_fail() {
    let (v, p) = quad();
    let mut s = balanced_hover(&v, &p, &config()).unwrap();
    s.duration_s = 0.003;
    s.script.push(Segment {
        from_s: 0.001,
        attitude: Attitude::Quaternion { xyzw: [0.0, 0.0, 0.0, -1.0] },
        yaw_rate_radps: 0.0,
        z_m: Some(1.0),
        z_velocity_mps: 0.0,
    });
    s.checks = vec![Check::Altitude { after_s: 0.002, tolerance_m: 0.1 }];
    let r = execute(&v, &p, &s);
    assert!(!r.passed);
    // Steps 2 and 3 (time 0.002 and 0.003 after the step) are in the window.
    assert_eq!(r.checks[0].samples, 2);
    assert!(r.final_altitude_error_m.unwrap() < -0.9);
    s.checks = vec![Check::CannotClimb { after_s: 0.0, min_throttle: 1.0 }];
    let r = execute(&v, &p, &s);
    assert_eq!(r.checks[0].measured, None);
    assert!(!r.passed);
}

/// Over the first 10 ms the commands are nearly equal (the controller has barely
/// reacted) and the rotors are still near rest, so the thrust T is the same on
/// both: a(loaded) − a(nominal) = T(1/1.5 − 1) < 0, and the heavier plant sinks
/// further. (On step 1 the rotors are at rest, T = 0, and both only fall at g.)
#[test]
fn payload_reduces_actual_initial_acceleration_at_equal_commands() {
    let (v, p) = quad();
    let c = config();
    let mut a = balanced_hover(&v, &p, &c).unwrap();
    let mut b = payload(&v, &p, &c, 0.5).unwrap();
    for s in [&mut a, &mut b] {
        s.duration_s = 0.01;
        s.checks.clear();
    }
    let a = execute(&v, &p, &a);
    let b = execute(&v, &p, &b);
    assert_eq!(a.first_throttle, b.first_throttle);
    assert!(b.final_altitude_error_m.unwrap() < a.final_altitude_error_m.unwrap());
}

/// A cut-off ends the run when the pack reaches it, and the report says why; a
/// run cut short has no evidence for a late window and fails acceptance. A 11 V
/// voltage cut-off on a 10 V pack is met by the first step; 1 mAh of charge is met
/// within one step (the loop checks after each step) of being drawn.
#[test]
fn a_cutoff_ends_the_run_and_fails_acceptance() {
    let (v, p) = quad();
    let s = balanced_hover(&v, &p, &config()).unwrap();
    let r = execute_with(&v, &p, &ScenarioConfig { cutoff: Some(Cutoff::VoltageV(11.0)), ..config() }, &s);
    assert_eq!(r.end_reason, ScenarioEnd::VoltageCutoff);
    assert_eq!(r.elapsed_s, DT);
    assert!(!r.passed);
    assert!(r.checks.iter().all(|c| c.measured.is_none() && !c.passed));
    let r = execute_with(&v, &p, &ScenarioConfig { cutoff: Some(Cutoff::ChargeMah(1.0)), ..config() }, &s);
    assert_eq!(r.end_reason, ScenarioEnd::ChargeCutoff);
    assert!(r.elapsed_s > 0.0 && r.elapsed_s < 20.0);
    // At most one step of hover current (< 10 A for 1 ms = 0.003 mAh) past the cut-off.
    assert!(r.charge_used_mah >= 1.0 && r.charge_used_mah < 1.01, "{}", r.charge_used_mah);
    assert!(!r.passed);
}

/// Thinner air lowers k_T and k_Q by ρ/ρ_ref (each motor's own), so the same weight needs a higher
/// throttle: the builtin's prediction uses the scaled propulsion and the run
/// agrees, while the unscaled prediction would not. ρ = 0.9, ρ_ref = 1.225.
#[test]
fn the_air_density_scales_the_prediction_and_the_flight() {
    let (v, p) = quad();
    let c = ScenarioConfig { air_density_kg_m3: 0.9, ..config() };
    let s = balanced_hover(&v, &p, &c).unwrap();
    let r = execute_with(&v, &p, &c, &s);
    assert!(r.passed, "{:#?}", r.checks);
    let thin = predicted_hover_throttle(&v, &scaled_propulsion(&v, &p, c.air_density_kg_m3).unwrap(), 1.0).unwrap();
    let sea = predicted_hover_throttle(&v, &p, 1.0).unwrap();
    assert!(thin > sea + 0.02, "{thin} vs {sea}");
    let h = check(&r, |c| matches!(c, Check::HoverThrottle { .. }));
    assert!((h.measured.unwrap() - thin).abs() < 0.005);
}

/// The gains the scenario runs with set the beyond-authority offset: a larger
/// pitch integrator limit gives a larger offset (arm·(1 + D·I_lim/min(u, 1−u))).
#[test]
fn the_beyond_authority_offset_follows_the_gains_in_use() {
    let (v, p) = quad();
    let shift = |lim: f64| {
        let mut c = config();
        c.gains.mc_pr_int_lim = lim;
        let s = com_offset_beyond_authority(&v, &p, &c).unwrap();
        let Modification::ShiftPart { delta_m, .. } = s.modifications[0].clone() else { panic!() };
        delta_m[0]
    };
    assert!(shift(0.6) > shift(0.3));
    // With a zero integrator limit the offset is the outermost arm itself.
    assert!((shift(1e-12) - A).abs() < 1e-9);
}

/// A scenario can start on the ground (4.4): hovering at 0.5 m above it.
#[test]
fn a_scenario_can_start_in_an_environment() {
    let (v, p) = quad();
    let ground = Ground {
        environment: Environment { ground: Some(Surface { friction: 0.5, restitution: 0.0 }), terrain: None, obstacles: vec![] },
        start_m: [0.0, 0.0, 0.5],
    };
    let c = ScenarioConfig { ground: Some(ground), ..config() };
    let mut s = balanced_hover(&v, &p, &c).unwrap();
    s.script[0].z_m = Some(0.5);
    s.duration_s = 2.0;
    s.checks = vec![Check::Attitude { after_s: 0.0, max_deg: 10.0 }];
    let r = execute_with(&v, &p, &c, &s);
    assert_eq!(r.elapsed_s, 2.0);
    assert!(r.checks[0].passed, "{:?}", r.checks[0]);
}

/// Only the ratio ρ_air/ρ_ref reaches the flight: the same ratio from a different
/// reference density (every motor 1.0 at air 1.0, against 1.225 at 1.225, ratio 1)
/// gives a bit-identical run (without body drag, which uses ρ_air itself).
#[test]
fn only_the_ratio_to_the_motors_reference_density_matters() {
    let (v, p) = quad();
    let (v1, p1) = quad_with(Some(1.0));
    let mut s = balanced_hover(&v, &p, &config()).unwrap();
    s.duration_s = 1.0;
    s.checks.clear();
    let a = run(&v, p.clone(), None, &config(), &s).unwrap();
    let b = run(&v1, p1, None, &ScenarioConfig { air_density_kg_m3: 1.0, ..config() }, &s).unwrap();
    assert_eq!(a.final_state_hash, b.final_state_hash);
}
