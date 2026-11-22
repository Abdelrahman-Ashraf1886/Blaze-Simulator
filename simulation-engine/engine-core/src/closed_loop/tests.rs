//! The PX4 controller flying the 4.5/4.6 plant (plan, tests areas 8, 9, 10).
//! Each bound is stated with its derivation.

use super::*;
use crate::vehicle::Quat;
use crate::math::STANDARD_GRAVITY as G;
use crate::propulsion::{BatteryParams, MotorPropulsion, Propulsion, PropulsionDefinition};
use crate::sim::SimConfig;
use crate::vehicle::fixtures::{box_part, with_totals};
use crate::vehicle::{MotorBody, Spin};

const A: f64 = 0.15;
const KT: f64 = 2e-5;
const LEVEL: Quat = [0.0, 0.0, 0.0, 1.0];

/// The test motor of `flight/tests.rs` (not a catalogue part).
fn motor(id: &str) -> MotorPropulsion {
    MotorPropulsion {
        part_id: id.into(),
        kv_rad_per_sv: 100.0,
        resistance_ohm: 0.1,
        no_load_current_a: 0.5,
        thrust_coef_ns2: KT,
        torque_coef_nms2: 1e-7,
        inertia_kg_m2: 2e-5,
        throttle_map: None,
    }
}

/// Quad X about the frame origin (arm A); the body's CoM at `com`.
fn quad(mass: f64, com: [f64; 3]) -> Vehicle {
    let mut def = with_totals(vec![box_part("body", mass, com, [0.01, 0.01, 0.02, 0.0, 0.0, 0.0])]);
    let m = |i: usize, x: f64, y: f64, s: Spin| MotorBody { part_id: format!("m{i}"), position: [x, y, 0.0], thrust_axis: [0.0, 0.0, 1.0], spin: s };
    def.motors = vec![m(1, A, -A, Spin::Ccw), m(2, -A, A, Spin::Ccw), m(3, A, A, Spin::Cw), m(4, -A, -A, Spin::Cw)];
    Vehicle::from_definition(def).unwrap()
}

fn propulsion(v: &Vehicle) -> Propulsion {
    let def = PropulsionDefinition {
        version: 1,
        motors: v.definition.motors.iter().map(|m| motor(&m.part_id)).collect(),
        battery: BatteryParams { open_circuit_voltage_v: 10.0, internal_resistance_ohm: 0.01, capacity_c: 18_720.0 },
    };
    Propulsion::from_definition(def, &v.definition).unwrap()
}

/// Runs the closed loop for `seconds` holding level attitude at CoM height `z`.
fn fly(v: &Vehicle, z: f64, seconds: f64) -> (Simulation, ClosedLoop) {
    let p = propulsion(v);
    let yaw = p.yaw_ratio();
    let flight = Flight::new(v, p, None, None).unwrap();
    let mut cl = ClosedLoop::new(v, flight, yaw, Gains::px4_v1_13_3()).unwrap();
    let mut sim = Simulation::new(v, SimConfig::default()).unwrap();
    let sp = Setpoint { attitude: LEVEL, yaw_rate: 0.0, z: Some(z), z_velocity: 0.0 };
    for _ in 0..(seconds * 1000.0).round() as u64 {
        cl.step(&mut sim, &sp);
    }
    (sim, cl)
}

/// Tilt from level (any axis), rad: 2 acos |w| of the attitude quaternion.
fn tilt(sim: &Simulation) -> f64 {
    2.0 * sim.state().quaternion[3].abs().clamp(0.0, 1.0).acos()
}

fn thrusts(cl: &ClosedLoop) -> Vec<f64> {
    cl.flight().motors().iter().map(|m| m.thrust_n).collect()
}

/// From rest at z = 0 to a 1 m hover: the CoM within 1 cm of 1 m and the
/// attitude within 0.1° after 10 s (1 % of the step, as the controller's own
/// closed-loop tests), and each motor carries a quarter of the weight (0.5 %,
/// the same settling margin).
#[test]
fn hovers_at_the_altitude_setpoint() {
    let v = quad(1.0, [0.0; 3]);
    let (sim, cl) = fly(&v, 1.0, 10.0);
    let s = sim.state();
    assert!((s.com_m[2] - 1.0).abs() < 0.01, "z = {}", s.com_m[2]);
    assert!(tilt(&sim) < 0.1f64.to_radians(), "tilt = {}", tilt(&sim));
    for t in thrusts(&cl) {
        assert!((t - G / 4.0).abs() < 0.005 * G / 4.0, "thrust {t}");
    }
}

/// CoM 20 mm towards +y. Moment balance about the CoM, with the +y motors
/// (m2, m3) at arm A − d and the −y motors (m1, m4) at A + d:
/// 2 T₊ (A − d) = 2 T₋ (A + d) and 2 (T₊ + T₋) = W, so
/// T₊ = W (A + d) / (4A), T₋ = W (A − d) / (4A).
/// Pitch and yaw stay balanced (one high and one low motor on each side and
/// of each spin). The controller does not know the offset: the roll rate
/// integrator holds the trim. Bounds: tilt < 0.1°, thrusts within 0.5 %.
#[test]
fn trims_a_com_offset_with_the_hand_calculated_motor_imbalance() {
    let d = 0.02;
    let v = quad(1.0, [0.0, d, 0.0]);
    let (sim, cl) = fly(&v, 1.0, 15.0);
    assert!(tilt(&sim) < 0.1f64.to_radians(), "tilt = {}", tilt(&sim));
    let w = G;
    let (hi, lo) = (w * (A + d) / (4.0 * A), w * (A - d) / (4.0 * A));
    let t = thrusts(&cl);
    for (i, expected) in [(0, lo), (1, hi), (2, hi), (3, lo)] {
        assert!((t[i] - expected).abs() < 0.005 * expected, "m{}: {} vs {expected}", i + 1, t[i]);
    }
    assert!(cl.summary().rate_integral[0].abs() > 0.01, "the roll integrator holds the trim: {:?}", cl.summary().rate_integral);
}

/// CoM beyond the motors (|y| = 0.2 m > A = 0.15 m): no positive thrust
/// distribution can cancel the roll moment, so the motors saturate and the
/// attitude is lost (> 10°, the controller's own loss criterion).
#[test]
fn an_offset_beyond_the_motors_saturates_and_loses_attitude() {
    let v = quad(1.0, [0.0, 0.2, 0.0]);
    let (sim, cl) = fly(&v, 1.0, 3.0);
    assert!(cl.summary().saturated_steps > 0);
    assert!(tilt(&sim) > 10f64.to_radians(), "tilt = {}", tilt(&sim));
}

/// Steady rotor speed for a throttle held on every motor (propulsion alone).
fn steady_speed(v: &Vehicle, d: f64) -> f64 {
    let p = propulsion(v);
    let mut s = p.rest();
    let d = vec![d; p.motors.len()];
    for _ in 0..5000 {
        p.step(&mut s, &d, 1e-3);
    }
    s.omega[0]
}

/// Payload: the hover throttle the controller settles on equals the throttle
/// whose steady thrust is a quarter of the weight (bisection on the plant,
/// within 0.5 %), and it rises with the mass.
#[test]
fn a_payload_raises_the_hover_throttle_as_predicted() {
    let mut previous = 0.0;
    for mass in [1.0, 1.4] {
        let v = quad(mass, [0.0; 3]);
        let (_, cl) = fly(&v, 1.0, 10.0);
        let throttle = cl.flight().motors().iter().map(|m| m.throttle).sum::<f64>() / 4.0;
        let target = (mass * G / (4.0 * KT)).sqrt();
        let (mut lo, mut hi) = (0.0, 1.0);
        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            if steady_speed(&v, mid) < target {
                lo = mid
            } else {
                hi = mid
            }
        }
        let predicted = 0.5 * (lo + hi);
        assert!((throttle - predicted).abs() < 0.005 * predicted, "{mass} kg: {throttle} vs {predicted}");
        assert!(throttle > previous);
        previous = throttle;
    }
}

/// Above the maximum thrust (weight 20 % over 4 k_T ω_max² at full throttle)
/// the vehicle cannot climb: asked for 1 m, it is lower after 2 s than at the
/// start, with the collective at its limit.
#[test]
fn above_maximum_thrust_it_cannot_climb() {
    let probe = quad(1.0, [0.0; 3]);
    let w_max = steady_speed(&probe, 1.0);
    let mass = 1.2 * 4.0 * KT * w_max * w_max / G;
    let v = quad(mass, [0.0; 3]);
    let (sim, cl) = fly(&v, 1.0, 2.0);
    assert!(sim.state().com_m[2] < 0.0, "z = {}", sim.state().com_m[2]);
    assert!(cl.summary().collective_thrust >= 1.0 - 1e-12);
}

#[test]
fn the_closed_loop_is_deterministic() {
    let v = quad(1.0, [0.01, 0.02, 0.0]);
    let hash = || {
        let (sim, cl) = fly(&v, 1.0, 3.0);
        sim.state_hash_with(&cl.flight().hash_words())
    };
    assert_eq!(hash(), hash());
}

#[test]
fn gains_take_px4_overrides_by_exact_name() {
    let o: Map<String, Value> = serde_json::from_str(r#"{"MC_ROLL_P": 7.0, "MPC_Z_P": 0.8}"#).unwrap();
    let g = gains_with_overrides(Some(&o)).unwrap();
    assert_eq!((g.mc_roll_p, g.mpc_z_p, g.mc_pitch_p), (7.0, 0.8, 6.5));
    for bad in [r#"{"MC_NOPE": 1}"#, r#"{"mc_roll_p": 1}"#, r#"{"MC_ROLL_P": "x"}"#, r#"{"MC_ROLL_P": -1}"#] {
        let o: Map<String, Value> = serde_json::from_str(bad).unwrap();
        assert!(gains_with_overrides(Some(&o)).is_err(), "{bad}");
    }
    assert_eq!(gains_with_overrides(None).unwrap(), Gains::px4_v1_13_3());
}

/// `Controller::step` asserts a unit estimate within 1e-9 and a panic would end
/// the sidecar, while rapier's integrated quaternion is only unit to rounding.
/// A quaternion off by 1e-8 in |q|² (outside the assert) makes the controller
/// panic as it is, and runs once normalised.
#[test]
fn the_estimate_is_normalised_before_the_controllers_unit_assert() {
    let v = quad(1.0, [0.0; 3]);
    let p = propulsion(&v);
    let mut c = Controller::new(&v.definition.motors, p.yaw_ratio(), Gains::px4_v1_13_3()).unwrap();
    let drifted = [0.0, 0.0, 0.0, (1.0f64 + 1e-8).sqrt()];
    let sp = Setpoint { attitude: LEVEL, yaw_rate: 0.0, z: Some(1.0), z_velocity: 0.0 };
    let input = |attitude| ControllerInput { attitude, body_rates: [0.0; 3], z: 0.0, z_velocity: 0.0 };
    let raw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Controller::new(&v.definition.motors, p.yaw_ratio(), Gains::px4_v1_13_3()).unwrap().step(&input(drifted), &sp, 1e-3).collective_thrust
    }));
    assert!(raw.is_err(), "the raw drifted quaternion trips the assert");
    let unit = unit_attitude(drifted);
    assert!((unit.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() < 1e-15);
    assert!(c.step(&input(unit), &sp, 1e-3).collective_thrust.is_finite());
}

/// Long run with rapier's own quaternion in the loop: 60 s of yaw at 6 rad/s
/// (60 000 steps, ≈57 turns) flies on. In free flight the raw norm stayed at
/// 6e-16 (|q|² − 1) here, so this guards the whole path rather than proving the
/// drift; the test above proves the normalisation.
#[test]
fn a_long_yawing_run_flies_on() {
    let v = quad(1.0, [0.0; 3]);
    let p = propulsion(&v);
    let yaw = p.yaw_ratio();
    let flight = Flight::new(&v, p, None, None).unwrap();
    let mut cl = ClosedLoop::new(&v, flight, yaw, Gains::px4_v1_13_3()).unwrap();
    let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
    let sp = Setpoint { attitude: LEVEL, yaw_rate: 6.0, z: Some(1.0), z_velocity: 0.0 };
    for _ in 0..60_000 {
        cl.step(&mut sim, &sp);
    }
    assert!(sim.state().time_s > 59.9);
    assert!(cl.control().torque_demand.iter().all(|x| x.is_finite()));
}
