//! Environment input checks and contact response (plan, test area 5).
//! Every tolerance is stated next to where it comes from.

use super::*;
use crate::math::STANDARD_GRAVITY as G;
use crate::sim::{BodyInput, SimConfig, Simulation};
use crate::vehicle::fixtures::with_totals;
use crate::vehicle::{CollisionShape, PartBody, ShapePose, Vehicle};
use serde_json::json;

/// A 1 kg box 100 × 100 × 40 mm centred on the body origin (uniform solid inertia).
fn brick() -> Vehicle {
    let (m, a, b, c) = (1.0, 0.1, 0.1, 0.04);
    let part = PartBody {
        part_id: "brick".into(),
        mass_kg: m,
        com: [0.0; 3],
        inertia: [m * (b * b + c * c) / 12.0, m * (a * a + c * c) / 12.0, m * (a * a + b * b) / 12.0, 0.0, 0.0, 0.0],
        pose: ShapePose { position: [0.0; 3], quaternion: [0.0, 0.0, 0.0, 1.0] },
        shape: CollisionShape::Box { half_extents: [a / 2.0, b / 2.0, c / 2.0] },
    };
    Vehicle::from_definition(with_totals(vec![part])).unwrap()
}

fn env(value: serde_json::Value) -> Environment {
    Environment::from_json(&value).unwrap()
}

fn ground(friction: f64, restitution: f64) -> Environment {
    env(json!({ "ground": { "friction": friction, "restitution": restitution }, "obstacles": [] }))
}

fn steps(sim: &mut Simulation, n: u64, input: &BodyInput) {
    for _ in 0..n {
        sim.step(input);
    }
}

fn paths(e: Vec<EnvironmentError>) -> Vec<String> {
    e.into_iter().map(|e| e.path).collect()
}

#[test]
fn friction_and_restitution_have_no_default() {
    let missing = Environment::from_json(&json!({
        "ground": {},
        "obstacles": [{ "id": "a", "center": [0, 0, 0], "halfExtents": [1, 1, 1], "quaternion": [0, 0, 0, 1] }]
    }));
    assert_eq!(
        paths(missing.unwrap_err()),
        [
            "environment.ground.friction",
            "environment.ground.restitution",
            "environment.obstacles[0].friction",
            "environment.obstacles[0].restitution"
        ]
    );
    let e = Environment::from_json(&json!({ "obstacles": [] })).unwrap_err();
    assert_eq!(paths(e), ["environment.ground"]);
    let e = Environment::from_json(&json!({ "ground": null })).unwrap_err();
    assert_eq!(paths(e), ["environment.obstacles"]);
    // Explicit free space is fine.
    assert_eq!(env(json!({ "ground": null, "obstacles": [] })), Environment::default());
}

#[test]
fn refuses_impossible_values_and_unknown_fields() {
    let e = Environment::from_json(&json!({
        "ground": { "friction": -0.1, "restitution": 1.5 },
        "obstacles": [
            { "id": "a", "center": [0, 0, 0], "halfExtents": [1, 0, 1], "quaternion": [0, 0, 0, 2], "friction": 0.5, "restitution": 0 },
            { "id": "a", "center": [0, 0], "halfExtents": [1, 1, 1], "quaternion": [0, 0, 0, 1], "friction": 0.5, "restitution": 0, "colour": "red" }
        ],
        "wind": 3
    }))
    .unwrap_err();
    let mut got = paths(e);
    got.sort();
    let mut want = vec![
        "environment.wind",
        "environment.ground.friction",
        "environment.ground.restitution",
        "environment.obstacles[0].halfExtents",
        "environment.obstacles[0].quaternion",
        "environment.obstacles[1].colour",
        "environment.obstacles[1].id",
        "environment.obstacles[1].center",
    ];
    want.sort();
    assert_eq!(got, want);
}

/// Measured resting penetration: rapier leaves ALLOWED_LINEAR_ERROR_M (0.1 mm)
/// uncorrected, and the brick settles 0.106 mm into the ground; 0.12 mm allows for that.
const REST_PENETRATION_M: f64 = 1.2e-4;

/// Plan test 5: dropped from 0.5 m (bottom face 480 mm above the ground) with
/// restitution 0, the brick lands at t = √(2·0.48/g) = 0.3129 s and comes to
/// rest flat, with its centre at its half height (20 mm) and zero velocity.
///
/// Tolerances
/// - height: 20 mm − REST_PENETRATION_M to 20 mm (measured 19.894 mm);
/// - velocity: |v| < 1e-6 m/s and |ω| < 1e-6 rad/s at every step from 1.5 s
///   to 2.5 s (measured: below from 0.89 s and 1.18 s; the resting contact
///   damps the last motion by about e per 0.1 s);
/// - landing time: the contact is timed at the first state found touching,
///   so within one step (1 ms) after the analytic impact.
///
/// rapier solves the four corner contacts one after another, so a perfectly
/// flat landing still gives the brick a brief spin (up to ~13 rad/s for a few
/// steps). It lands back flat, which the attitude check covers; with bounce
/// (restitution > 0) the spin takes energy from the rebound, so restitution
/// is tested with a single contact point below.
#[test]
fn drop_onto_the_ground_comes_to_rest_at_its_half_height_and_reports_the_contact() {
    let v = brick();
    let mut sim = Simulation::with_environment(&v, SimConfig::default(), &ground(0.5, 0.0), [0.0, 0.0, 0.5]).unwrap();
    let still = BodyInput::default();
    steps(&mut sim, 1500, &still);
    for _ in 0..1000 {
        sim.step(&still);
        let s = sim.state();
        let speed = s.linear_velocity_mps.iter().map(|x| x * x).sum::<f64>().sqrt();
        let spin = s.angular_velocity_radps.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!(speed < 1e-6 && spin < 1e-6, "at {} s: |v| = {speed}, |w| = {spin}", s.time_s);
        let z = s.position_m[2];
        assert!(z <= 0.02 + 1e-9 && z >= 0.02 - REST_PENETRATION_M, "rest height {z}");
        assert!(s.quaternion[3].abs() > 1.0 - 1e-6, "not flat: {:?}", s.quaternion);
    }
    let (events, dropped) = sim.contacts();
    assert_eq!(dropped, 0);
    assert_eq!(events.len(), 1, "{events:?}");
    let c = &events[0];
    assert_eq!((c.part_id.as_str(), c.with.as_str(), c.end_s), ("brick", "ground", None));
    let impact = (2.0 * 0.48 / G).sqrt();
    assert!(c.start_s >= impact && c.start_s <= impact + 1e-3 + 1e-12, "contact at {} s, impact {impact} s", c.start_s);
}

/// A pyramid touching the ground with its apex only, right below the CoM (one
/// contact point, so no spin). Dropped from 480 mm with restitution e, it
/// leaves the ground at e·√(2·g·h) and rises e²·h. Measured with rapier
/// 0.36.1: speed 0.28 % low and height 0.66–0.88 % low for e = 0.25 to 0.8;
/// tested to 1 % and 2 %. Each bounce is a separate contact event.
#[test]
fn restitution_sets_the_rebound_speed_and_height() {
    let mut part = brick().definition.parts[0].clone();
    part.part_id = "pyramid".into();
    part.shape = CollisionShape::Hull {
        points: vec![[0.0, 0.0, -0.02], [0.05, 0.05, 0.02], [-0.05, 0.05, 0.02], [0.05, -0.05, 0.02], [-0.05, -0.05, 0.02]],
    };
    let v = Vehicle::from_definition(with_totals(vec![part])).unwrap();
    for e in [0.25, 0.5, 0.8] {
        let mut sim = Simulation::with_environment(&v, SimConfig::default(), &ground(0.5, e), [0.0, 0.0, 0.5]).unwrap();
        let still = BodyInput::default();
        steps(&mut sim, 300, &still); // just before the impact at 0.313 s
        let (mut up, mut peak) = (0.0_f64, 0.0_f64);
        for _ in 0..(20.0 + 1000.0 * 2.0 * e * (2.0 * 0.48 / G).sqrt()) as u64 {
            sim.step(&still);
            let s = sim.state();
            up = up.max(s.linear_velocity_mps[2]);
            if up > 0.0 {
                peak = peak.max(s.position_m[2] - 0.02);
            }
        }
        let (v_up, h_up) = (e * (2.0 * G * 0.48).sqrt(), e * e * 0.48);
        assert!((up - v_up).abs() < 0.01 * v_up, "e = {e}: rebound speed {up}, expected {v_up}");
        assert!((peak - h_up).abs() < 0.02 * h_up, "e = {e}: rebound height {peak}, expected {h_up}");
        let (events, _) = sim.contacts();
        assert_eq!(events[0].part_id, "pyramid");
        assert!(events[0].end_s.is_some(), "e = {e}: left the ground: {events:?}");
    }
}

/// Friction μ = 0.5 holds a 1 kg brick against a horizontal 4 N push (less than
/// μ·m·g = 4.903 N) and lets a 6 N push accelerate it at (6 − μ·m·g)/m =
/// 1.0967 m/s² (within 1 % after 1 s): the entered value is the coefficient of
/// the contact, unchanged by rapier's combine rule.
#[test]
fn friction_is_the_entered_coefficient() {
    let v = brick();
    let run = |push: f64| {
        let mut sim = Simulation::with_environment(&v, SimConfig::default(), &ground(0.5, 0.0), [0.0, 0.0, 0.02]).unwrap();
        steps(&mut sim, 1000, &BodyInput { force_body_n: Vector::new(push, 0.0, 0.0), ..BodyInput::default() });
        sim.state().linear_velocity_mps[0]
    };
    assert!(run(4.0).abs() < 1e-6, "held: vx = {}", run(4.0));
    let a = 6.0 - 0.5 * G;
    let vx = run(6.0);
    assert!((vx - a * 1.0).abs() < 0.01 * a, "vx = {vx}, expected {a}");
}

/// A box obstacle 100 mm tall (top at z = 0.1 m): the brick dropped onto it
/// rests at 100 + 20 mm and the contact names the obstacle.
#[test]
fn drop_onto_an_obstacle() {
    let table = env(json!({
        "ground": { "friction": 0.5, "restitution": 0.0 },
        "obstacles": [{
            "id": "table", "center": [0, 0, 0.05], "halfExtents": [0.3, 0.3, 0.05], "quaternion": [0, 0, 0, 1],
            "friction": 0.6, "restitution": 0.0
        }]
    }));
    let v = brick();
    let mut sim = Simulation::with_environment(&v, SimConfig::default(), &table, [0.0, 0.0, 0.4]).unwrap();
    steps(&mut sim, 1500, &BodyInput::default());
    let z = sim.state().position_m[2];
    assert!(z <= 0.12 + 1e-9 && z >= 0.12 - REST_PENETRATION_M, "rest height {z}");
    let (events, _) = sim.contacts();
    assert_eq!(events.iter().map(|e| e.with.as_str()).collect::<Vec<_>>(), ["obstacle:table"]);
}

#[test]
fn refuses_to_start_inside_the_ground_and_runs_deterministically() {
    let v = brick();
    let e = Simulation::with_environment(&v, SimConfig::default(), &ground(0.5, 0.0), [0.0, 0.0, 0.015]).err().unwrap();
    assert!(e.contains("brick is 5.000 mm inside the ground"), "{e}");
    // Touching exactly is allowed.
    assert!(Simulation::with_environment(&v, SimConfig::default(), &ground(0.5, 0.0), [0.0, 0.0, 0.02]).is_ok());
    let run = || {
        let mut sim = Simulation::with_environment(&v, SimConfig::default(), &ground(0.4, 0.3), [0.01, 0.0, 0.3]).unwrap();
        steps(&mut sim, 2000, &BodyInput { torque_body_nm: Vector::new(0.001, 0.0, 0.0), ..BodyInput::default() });
        (sim.state_hash(), sim.contacts())
    };
    assert_eq!(run(), run());
}
