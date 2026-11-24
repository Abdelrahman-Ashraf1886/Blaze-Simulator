//! Environment input checks and contact response (plan, test area 5).
//! Every tolerance is stated next to where it comes from.

use super::*;
use crate::math::STANDARD_GRAVITY as G;
use crate::sim::{BodyInput, SimConfig, Simulation, START_PENETRATION_TOLERANCE_M};
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
    assert_eq!(sim.state_hash(), 0xdfe219fa9c21b4bd, "pre-6.4 plane hash");
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
    assert_eq!(sim.state_hash(), 0xa30649724c1c9d2f, "pre-6.4 box obstacle hash");
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

fn terrain_grid(rows: usize, columns: usize, cell: f64, corner: [f64; 2], heights: &[f64], friction: f64) -> Value {
    json!({
        "rows": rows, "columns": columns, "cellSizeM": cell, "cornerM": corner, "heightsM": heights,
        "friction": friction, "restitution": 0
    })
}

fn flat_terrain(height: f64) -> Environment {
    // Same spacing as the TS fixture, centred about the drop axis.
    let cell = 2.0;
    env(json!({ "terrain": terrain_grid(2, 2, cell, [-cell; 2], &[height; 4], 0.5), "obstacles": [] }))
}

#[test]
fn clearance_on_plane_matches_the_lowest_point_of_each_shape() {
    let vehicle = brick();
    let CollisionShape::Box { half_extents: [x, y, z] } = &vehicle.definition.parts[0].shape else { unreachable!() };
    let (x, y, z) = (*x, *y, *z);
    let half_turn = std::f64::consts::FRAC_PI_4 / 2.0;
    let tilt = [0.0, half_turn.sin(), 0.0, half_turn.cos()];
    let identity = [0.0, 0.0, 0.0, 1.0];
    let cylinder = CollisionShape::Cylinder { radius: x, half_height: z };
    let hull = CollisionShape::Hull { points: vec![[-x, -y, z], [x, -y, z], [0.0, y, z], [0.0, 0.0, -z]] };
    let plane = ground(0.5, 0.0);
    for (shape, quaternion, expected) in [
        (vehicle.definition.parts[0].shape.clone(), identity, z),
        (hull, identity, z),
        (cylinder.clone(), identity, z),
        (cylinder, tilt, (z + x) * std::f64::consts::FRAC_1_SQRT_2),
    ] {
        let mut part = vehicle.definition.parts[0].clone();
        part.shape = shape;
        part.pose.quaternion = quaternion;
        let model = Vehicle::from_definition(with_totals(vec![part])).unwrap();
        let place = |clearance| Simulation::with_start_clearance(
            &model, SimConfig::default(), &plane, [x, y, -z], Some(clearance),
        ).unwrap();
        let contact = place(0.0);
        assert!(contact.initial_ground_contact());
        let [start_x, start_y, start_z] = contact.state().position_m;
        assert_eq!([start_x, start_y], [x, y]);
        assert!((start_z - expected).abs() <= START_PENETRATION_TOLERANCE_M);
        let released = place(z);
        assert!(!released.initial_ground_contact());
        assert!((released.state().position_m[2] - (expected + z)).abs() <= START_PENETRATION_TOLERANCE_M);
    }
}

#[test]
fn clearance_finds_a_ridge_and_bridges_a_pit_below_the_belly() {
    let vehicle = brick();
    let CollisionShape::Box { half_extents: [half_width, _, half_height] } = vehicle.definition.parts[0].shape else { unreachable!() };
    let ridge = [0.0, half_height, 0.0];
    let pit = [0.0, -half_height, 0.0];
    let config = SimConfig::default();
    for (profile, expected) in [(ridge, 2.0 * half_height), (pit, half_height)] {
        // The ridge peak is inside the bottom face; the pit floor is below its edges.
        let terrain = env(json!({ "terrain": terrain_grid(
            3, 3, half_width, [-1.5 * half_width; 2], &[profile; 3].concat(), 0.5,
        ), "obstacles": [] }));
        let place = |z, clearance| Simulation::with_start_clearance(
            &vehicle, config, &terrain, [0.0, 0.0, z], Some(clearance),
        ).unwrap();
        let contact = place(0.0, 0.0);
        assert!(contact.initial_ground_contact());
        let actual = contact.state().position_m[2];
        assert!((actual - expected).abs() <= START_PENETRATION_TOLERANCE_M, "{actual} vs {expected}");
        assert_eq!(contact.state_hash(), place(half_height, 0.0).state_hash());
        let released = place(0.0, half_height);
        assert!((released.state().position_m[2] - expected - half_height).abs() <= START_PENETRATION_TOLERANCE_M);
    }
}

#[test]
fn clearance_refuses_free_space_no_terrain_overlap_and_obstacle_penetration() {
    let vehicle = brick();
    let config = SimConfig::default();
    let plane = ground(0.5, 0.0);
    let mut blocked = plane.clone();
    blocked.obstacles.push(Obstacle {
        id: "block".into(),
        center: [0.0, 0.0, 0.0],
        shape: ObstacleShape::Box { half_extents: [0.05, 0.05, 0.02] },
        quaternion: [0.0, 0.0, 0.0, 1.0],
        surface: plane.ground.unwrap(),
    });
    let terrain = flat_terrain(0.0);
    for (environment, x, clearance, message) in [
        (&Environment::default(), 0.0, 0.0, "requires a ground"),
        (&terrain, 2.0, 0.0, "no vehicle part above the terrain samples"),
        (&blocked, 0.0, 0.0, "inside the obstacle block"),
        (&plane, 0.0, -ALLOWED_LINEAR_ERROR_M, "finite and non-negative"),
        (&plane, 0.0, f64::INFINITY, "finite and non-negative"),
        (&plane, 0.0, f64::NAN, "finite and non-negative"),
    ] {
        let error = Simulation::with_start_clearance(&vehicle, config, environment, [x, 0.0, 0.0], Some(clearance)).err().unwrap();
        assert!(error.contains(message), "{error}");
    }
}

#[test]
fn height_below_matches_the_typescript_grid() {
    // Same Ascii Grid, nodes, diagonal and interior points as tests/unit/terrain.test.ts:15–31.
    let grid = terrain_grid(2, 2, 2.0, [10.0, 20.0], &[2.0, 8.0, 0.0, 4.0], 0.5);
    let env = env(json!({ "ground": null, "terrain": grid, "obstacles": [] }));
    for (x, y, height) in [
        (11.0, 21.0, 0.0), (13.0, 21.0, 4.0), (11.0, 23.0, 2.0), (13.0, 23.0, 8.0),
        (11.5, 22.5, 3.0), (12.0, 22.0, 4.0), (12.5, 21.5, 4.0),
    ] {
        assert_eq!(env.height_below(x, y), Some(height));
    }
    assert_eq!(env.height_below(10.0, 20.0), None);
    assert_eq!(env.height_below(f64::NAN, 21.0), None);
    assert_eq!(ground(0.5, 0.0).height_below(10.0, 20.0), Some(0.0));
    assert_eq!(Environment::default().height_below(10.0, 20.0), None);
}

#[test]
fn terrain_collider_registers_the_correct_world_corner_and_triangles() {
    // Add a column to the TS grid to give the X and Y axes different extents.
    let grid = terrain_grid(2, 3, 2.0, [10.0, 20.0], &[2.0, 8.0, 8.0, 0.0, 4.0, 4.0], 0.5);
    let env = env(json!({ "terrain": grid, "obstacles": [] }));
    let (builder, pose) = env.terrain.as_ref().unwrap().collider();
    let collider = builder.build();
    let shape = collider.shape();
    let (nw, _) = shape.as_heightfield().unwrap().triangles_at(0, 0);
    let corner = pose * nw.unwrap().a;
    let error = (corner - Vector::new(11.0, 23.0, 2.0)).length();
    // The quarter turn and translation each introduce floating-point rounding.
    assert!(error <= 23.0 * f64::EPSILON, "northwest corner is {corner:?}");
    for (x, y) in [(11.5, 22.5), (12.5, 21.5), (14.0, 22.5)] {
        let z = env.height_below(x, y).unwrap();
        let ray = query::Ray::new(Vector::new(x, y, z + 2.0), -Vector::Z);
        let distance = shape.cast_ray(&pose, &ray, 4.0, false).unwrap();
        assert!((distance - 2.0).abs() <= ALLOWED_LINEAR_ERROR_M, "height at {x}, {y}: ray travelled {distance}");
    }
}

#[test]
fn terrain_validation_reports_paths() {
    let invalid = json!({
        "ground": { "friction": 0.5, "restitution": 0 },
        "terrain": {
            "rows": 1, "columns": 2.5, "cellSizeM": 0, "cornerM": [10, "east"],
            "heightsM": [2, null, "missing", 4], "friction": -1, "restitution": 2, "size": 1
        },
        "obstacles": []
    });
    let mut got = paths(Environment::from_json(&invalid).unwrap_err());
    got.sort();
    assert_eq!(got, [
        "environment.terrain", "environment.terrain.cellSizeM", "environment.terrain.columns",
        "environment.terrain.cornerM", "environment.terrain.friction", "environment.terrain.heightsM[1]",
        "environment.terrain.heightsM[2]", "environment.terrain.restitution", "environment.terrain.rows",
        "environment.terrain.size",
    ]);
    let wrong_count = terrain_grid(2, 2, 2.0, [10.0, 20.0], &[2.0, 8.0, 0.0], 0.5);
    let error = Environment::from_json(&json!({ "terrain": wrong_count, "obstacles": [] })).unwrap_err();
    assert_eq!(paths(error), ["environment.terrain.heightsM"]);
    let error = Environment::from_json(&json!({ "terrain": [], "obstacles": [] })).unwrap_err();
    assert_eq!(paths(error), ["environment.terrain"]);
}

#[test]
fn flat_terrain_rests_at_plane_height_and_is_deterministic() {
    let vehicle = brick();
    let run = |env: &Environment| {
        let mut sim = Simulation::with_environment(&vehicle, SimConfig::default(), env, [0.0, 0.0, 0.5]).unwrap();
        steps(&mut sim, 2500, &BodyInput::default());
        assert!(sim.touching_ground());
        assert_eq!(sim.contacts().0.last().map(|event| (event.part_id.as_str(), event.with.as_str(), event.end_s)),
            Some(("brick", "ground", None)));
        (sim.state(), sim.state_hash(), sim.contacts())
    };
    let plane = run(&ground(0.5, 0.0)).0;
    let terrain = flat_terrain(0.0);
    let (state, hash, contacts) = run(&terrain);
    assert!((state.position_m[2] - plane.position_m[2]).abs() <= ALLOWED_LINEAR_ERROR_M, "{state:?}");
    // At this speed the brick moves less than one contact tolerance in the
    // one-second resting observation window of the plane test.
    let rest_window_s = 1.0;
    assert!(Vector::from_array(state.linear_velocity_mps).length() < ALLOWED_LINEAR_ERROR_M / rest_window_s, "{state:?}");
    let (repeat, repeat_hash, repeat_contacts) = run(&terrain);
    assert_eq!((repeat, repeat_hash), (state, hash));
    assert_eq!(serde_json::to_value(contacts).unwrap(), serde_json::to_value(repeat_contacts).unwrap());
}

#[test]
fn terrain_slope_slides_above_and_rests_below_atan_of_friction() {
    let mu = 0.5;
    let config = SimConfig::default();
    // The test runs for one second. A half-width of g metres is twice the
    // maximum gravitational displacement from rest in that time.
    let half_width = G;
    let cell = 2.0 * half_width;
    let vehicle = brick();
    let run = |slope: f64| {
        let edge_z = half_width * slope;
        let grid = terrain_grid(2, 2, cell, [-cell; 2], &[-edge_z, edge_z, -edge_z, edge_z], mu);
        let env = env(json!({ "terrain": grid, "obstacles": [] }));
        let mut sim = Simulation::with_environment(&vehicle, config, &env, [0.0, 0.0, 0.5]).unwrap();
        // Place the 40 mm brick flush with the slope before the first step.
        let angle = slope.atan();
        let (_, body) = sim.world_mut().bodies.iter_mut().find(|(_, body)| body.is_dynamic()).unwrap();
        body.set_rotation(Rotation::from_rotation_y(-angle), true);
        body.set_translation(Vector::new(0.0, 0.0, 0.02 / angle.cos()), true);
        steps(&mut sim, 1000, &BodyInput::default());
        assert!(sim.touching_ground());
        sim.state().linear_velocity_mps[0]
    };
    let held_vx = run(mu / 2.0);
    let sliding_vx = run(2.0 * mu);
    assert!(held_vx.abs() < 1e-6, "held vx = {held_vx}");
    assert!(sliding_vx < -ALLOWED_LINEAR_ERROR_M / config.dt_s, "sliding vx = {sliding_vx}");
}

#[test]
fn terrain_refuses_a_start_wholly_below_the_surface() {
    let vehicle = brick();
    let terrain = flat_terrain(0.0);
    let start = |position| Simulation::with_environment(&vehicle, SimConfig::default(), &terrain, position);
    let error = start([0.0, 0.0, -0.5]).err().unwrap();
    assert!(error.contains("brick is 520.000 mm inside the ground"), "{error}");
    assert!(start([0.0, 0.0, 0.02]).is_ok());
    assert!(start([2.0, 0.0, -0.5]).is_ok());
}

#[test]
fn fast_fall_does_not_tunnel_through_terrain() {
    let config = SimConfig::default();
    let thickness = 0.04; // The brick fixture's Z extent.
    let terrain = flat_terrain(0.0);
    let mut sim = Simulation::with_environment(&brick(), config, &terrain, [0.0, 0.0, 2.0 * thickness]).unwrap();
    // 120 m/s travels three brick thicknesses in the 1 ms step. The lower
    // face starts 60 mm above the surface (past the 20 mm prediction gap),
    // and the upper face would end 20 mm below the surface if unchecked.
    // Rapier 0.36.1 rigid_body.rs:591–596 documents the automatic sweep
    // against fixed colliders.
    sim.set_velocity(Vector::new(0.0, 0.0, -3.0 * thickness / config.dt_s), Vector::ZERO);
    sim.step(&BodyInput::default());
    let z = sim.state().position_m[2];
    assert!(z >= thickness / 2.0 - REST_PENETRATION_M, "first step tunneled to z = {z}");
    // Contact reporting samples the state at the start of the step.
    sim.step(&BodyInput::default());
    assert!(sim.touching_ground(), "{:?}", sim.state());
}

#[test]
fn cylinder_and_hull_report_the_part_and_id_and_refuse_containment() {
    // Same top and width as the legacy table. The hull is the table's eight
    // vertices relative to its centre; the cylinder uses its full height.
    let points: Vec<_> = [-0.3, 0.3].into_iter().flat_map(|x| {
        [-0.3, 0.3].into_iter().flat_map(move |y| [-0.05, 0.05].into_iter().map(move |z| [x, y, z]))
    }).collect();
    for obstacle in [
        json!({ "id": "column", "type": "cylinder", "radius": 0.3, "height": 0.1 }),
        json!({ "id": "convex-table", "type": "hull", "points": points }),
    ] {
        let mut obstacle = obstacle;
        let id = obstacle["id"].as_str().unwrap().to_owned();
        obstacle["center"] = json!([0, 0, 0.05]);
        obstacle["quaternion"] = json!([0, 0, 0, 1]);
        obstacle["friction"] = json!(0.6);
        obstacle["restitution"] = json!(0);
        let env = env(json!({ "ground": null, "obstacles": [obstacle] }));
        let vehicle = brick();
        let error = Simulation::with_environment(&vehicle, SimConfig::default(), &env, [0.0, 0.0, 0.05]).err().unwrap();
        // A centred 40 mm brick inside a 100 mm obstacle takes 70 mm to clear it vertically.
        assert!(error.contains(&format!("brick is 70.000 mm inside the obstacle {id}")), "{error}");
        let mut sim = Simulation::with_environment(&vehicle, SimConfig::default(), &env, [0.0, 0.0, 0.4]).unwrap();
        steps(&mut sim, 1500, &BodyInput::default());
        let z = sim.state().position_m[2];
        assert!((z - 0.12).abs() <= REST_PENETRATION_M, "{id}: rest height {z}");
        let events = sim.contacts().0;
        assert!(events.iter().any(|c| c.part_id == "brick" && c.with == format!("obstacle:{id}") && c.end_s.is_none()), "{events:?}");
        assert!(!sim.touching_ground());
    }
}

#[test]
fn obstacle_shape_validation_reports_paths() {
    let mut obstacles = [
        json!({ "type": "cylinder", "radius": 0, "height": "unknown", "halfExtents": [1, 1, 1] }),
        json!({ "type": "hull", "points": [[0, 0, 0], [1, 0, null], [0, 1, 0]] }),
        json!({ "type": "hull", "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] }),
        json!({ "type": "mesh" }),
    ];
    for (i, obstacle) in obstacles.iter_mut().enumerate() {
        obstacle["id"] = json!(i.to_string());
        obstacle["center"] = json!([0, 0, 0]);
        obstacle["quaternion"] = json!([0, 0, 0, 1]);
        obstacle["friction"] = json!(0.6);
        obstacle["restitution"] = json!(0);
    }
    let mut got = paths(Environment::from_json(&json!({ "ground": null, "obstacles": obstacles })).unwrap_err());
    got.sort();
    assert_eq!(got, [
        "environment.obstacles[0].halfExtents", "environment.obstacles[0].height", "environment.obstacles[0].radius",
        "environment.obstacles[1].points", "environment.obstacles[1].points[1]",
        "environment.obstacles[2].points", "environment.obstacles[3].type",
    ]);
}

#[test]
fn open_ground_contact_survives_a_full_event_log() {
    let mut placed = Placed {
        objects: Vec::new(), part_ids: vec!["brick".into()], open: BTreeMap::new(),
        events: Vec::new(), dropped: 0,
    };
    let ground = (0, Object::Ground);
    let obstacle = (0, Object::Obstacle("box".into()));
    for _ in 0..MAX_CONTACT_EVENTS {
        placed.push(&ground, 0.0, Some(0.0));
    }
    placed.open.insert(obstacle, 0.0);
    assert!(!placed.touching_ground());
    placed.open.insert(ground.clone(), 0.0);
    assert_eq!(placed.events().1, 2);
    assert!(placed.touching_ground());
    placed.open.remove(&ground);
    placed.push(&ground, 0.0, Some(0.0));
    assert_eq!(placed.dropped, 1);
    assert!(!placed.touching_ground());
}
