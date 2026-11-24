use super::*;
use crate::flight_modes::Sticks;
// Quad, motor and battery from closed_loop/tests.rs:12-46. The helpers there
// are private. Keep the fixture within the milestone's file fence.
use crate::propulsion::{BatteryParams, MotorPropulsion, Propulsion, PropulsionDefinition};
use crate::sim::SimConfig;
use crate::vehicle::fixtures::{box_part, with_totals};
use crate::vehicle::{MotorBody, Spin};

const A: f64 = 0.15;
const KT: f64 = 2e-5;

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
        reference_density_kg_m3: None,
    }
}

/// Quad X about the frame origin (arm A); the body's CoM at `com`.
fn quad(mass: f64, com: [f64; 3]) -> Vehicle {
    let mut def = with_totals(vec![box_part(
        "body",
        mass,
        com,
        [0.01, 0.01, 0.02, 0.0, 0.0, 0.0],
    )]);
    let m = |i: usize, x: f64, y: f64, s: Spin| MotorBody {
        part_id: format!("m{i}"),
        position: [x, y, 0.0],
        thrust_axis: [0.0, 0.0, 1.0],
        spin: s,
    };
    def.motors = vec![
        m(1, A, -A, Spin::Ccw),
        m(2, -A, A, Spin::Ccw),
        m(3, A, A, Spin::Cw),
        m(4, -A, -A, Spin::Cw),
    ];
    Vehicle::from_definition(def).unwrap()
}

fn propulsion(v: &Vehicle) -> Propulsion {
    let def = PropulsionDefinition {
        version: 1,
        motors: v
            .definition
            .motors
            .iter()
            .map(|m| motor(&m.part_id))
            .collect(),
        battery: BatteryParams {
            open_circuit_voltage_v: 10.0,
            internal_resistance_ohm: 0.01,
            capacity_c: 18_720.0,
        },
    };
    Propulsion::from_definition(def, &v.definition).unwrap()
}

fn run(command: FlightCommand, pos_mode: f64) -> (Simulation, FlightLoop) {
    // Mass, settling duration and bounds from closed_loop/tests.rs:72-84.
    let v = quad(1.0, [0.0; 3]);
    let p = propulsion(&v);
    let yaw_ratio = p.yaw_ratio();
    let flight = Flight::new(&v, p, None, None).unwrap();
    let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
    let g = PositionGains {
        mpc_pos_mode: pos_mode,
        ..PositionGains::px4_v1_13_3()
    };
    // MC_AIRMODE, physics.v1.json:1084-1089.
    let mut controller =
        FlightLoop::new(&v, flight, yaw_ratio, Gains::px4_v1_13_3(), g, 0, HoverThrustParams::default()).unwrap();
    controller.step(&mut sim, command).unwrap();
    // Give the locked controller a horizontal disturbance. A one-weight
    // lateral force for one physics step produces a nonzero displacement.
    sim.step(&crate::sim::BodyInput {
        force_body_n: rapier3d_f64::math::Vector::X * crate::math::STANDARD_GRAVITY,
        // Apply that same force at one arm's lever distance as a roll impulse.
        torque_body_nm: rapier3d_f64::math::Vector::X * (A * crate::math::STANDARD_GRAVITY),
    });
    assert!(sim.state().angular_velocity_body_radps[0] > 0.0);
    for _ in 0..(10.0 / sim.config().dt_s).round() as usize {
        controller.step(&mut sim, command).unwrap();
    }
    assert!(controller.flight().ended().is_none());
    (sim, controller)
}

#[test]
fn position_recovers_its_lock_on_the_quad() {
    for mode in [0.0, 4.0] {
        let (sim, _) = run(FlightCommand::Position(Sticks::default()), mode);
        for coordinate in sim.state().com_m {
            assert!(
                coordinate.abs() < 0.01,
                "mode {mode}, position {:?}",
                sim.state().com_m
            );
        }
    }
}

#[test]
fn centered_stabilized_holds_level() {
    let (sim, _) = run(FlightCommand::Stabilized(Sticks::default()), 4.0);
    let [x, y, _, _] = unit_attitude(sim.state().quaternion);
    let tilt = (1.0 - 2.0 * (x * x + y * y)).clamp(-1.0, 1.0).acos();
    assert!(tilt < 0.1_f64.to_radians());
}

#[test]
fn repeated_inputs_reproduce_the_plant_and_rotor_hash() {
    let hash = || {
        let (sim, controller) = run(FlightCommand::Position(Sticks::default()), 4.0);
        sim.state_hash_with(&controller.flight().hash_words())
    };
    assert_eq!(hash(), hash());
}

// closed_loop/tests.rs:131-153 fixes the payload mass, bisection depth and
// 0.5% tolerance. Solve for zero motor acceleration at quarter-weight thrust,
// including pack sag (propulsion.rs:145-151,170-172,283-286).
fn predicted_hover(p: &Propulsion, mass: f64) -> f64 {
    let omega = (mass * crate::math::STANDARD_GRAVITY / (4.0 * KT)).sqrt();
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let duty = (lo + hi) / 2.0;
        let volts = p.pack_voltage(&[omega; 4], &[duty; 4]);
        if p.motors[0].omega_dot(omega, duty * volts) < 0.0 {
            lo = duty;
        } else {
            hi = duty;
        }
    }
    (lo + hi) / 2.0
}

fn hover_fixture(enabled: bool, config: SimConfig) -> (Simulation, FlightLoop, f64) {
    use crate::environment::{Environment, Surface};
    let mass = 1.4;
    let v = quad(mass, [0.0; 3]);
    let p = propulsion(&v);
    let predicted = predicted_hover(&p, mass);
    let yaw_ratio = p.yaw_ratio();
    let flight = Flight::new(&v, p, None, None).unwrap();
    let hover = HoverThrustParams { mpc_use_hte: enabled, ..Default::default() };
    let g = PositionGains { mpc_use_hte: u8::from(enabled) as f64, ..PositionGains::px4_v1_13_3() };
    // Ground surface from environment/tests.rs:115-118. Start at the lower
    // slowdown altitude, above the estimator's in-air gate (hover_thrust.rs:187-191).
    let env = Environment { ground: Some(Surface { friction: 0.5, restitution: 0.0 }), obstacles: vec![] };
    let sim = Simulation::with_environment(&v, config, &env, [0.0, 0.0, g.mpc_land_alt2]).unwrap();
    let controller = FlightLoop::new(&v, flight, yaw_ratio, Gains::px4_v1_13_3(), g, 0, hover).unwrap();
    (sim, controller, predicted)
}

#[test]
fn hover_estimate_converges_and_ground_contact_freezes_it() {
    for enabled in [true, false] {
        let (mut sim, mut controller, target) = hover_fixture(enabled, SimConfig::default());
        let initial = controller.position.hover_thrust();
        let tolerance = 0.005 * target;
        assert!((controller.hover_thrust_estimate().hover_thrust - target).abs() > tolerance);
        let hold = FlightCommand::Position(Sticks::default());
        // closed_loop/tests.rs:72-84 settles this quad for ten seconds.
        let settle_steps = (10.0 / sim.config().dt_s).round() as usize;
        for _ in 0..settle_steps {
            controller.step(&mut sim, hold).unwrap();
            if !enabled {
                assert_eq!(controller.position.hover_thrust(), initial);
            }
        }
        let airborne = controller.hover_thrust_estimate();
        assert!(airborne.valid);
        assert!((airborne.hover_thrust - target).abs() < tolerance, "{airborne:?} vs {target}");
        let retained = controller.position.hover_thrust();
        if enabled {
            assert_eq!(retained, airborne.hover_thrust);
        }
        let idle = FlightCommand::Rates { body_radps: [0.0; 3], collective: 0.0 };
        for _ in 0..settle_steps {
            controller.step(&mut sim, idle).unwrap();
        }
        assert!(sim.touching_ground());
        let landed = controller.hover_thrust_estimate();
        assert!(!landed.valid);
        assert_eq!(landed.hover_thrust, airborne.hover_thrust);
        assert!(landed.variance > airborne.variance); // prediction during descent
        for _ in 0..settle_steps {
            controller.step(&mut sim, idle).unwrap();
        }
        assert_eq!(controller.hover_thrust_estimate(), landed);
        assert_eq!(controller.position.hover_thrust(), retained);
    }
}

#[test]
fn airborne_estimation_replays_the_same_hash() {
    let replay = || {
        let (mut sim, mut controller, _) = hover_fixture(true, SimConfig::default());
        for _ in 0..(10.0 / sim.config().dt_s).round() as usize {
            controller.step(&mut sim, FlightCommand::Position(Sticks::default())).unwrap();
        }
        let estimate = controller.hover_thrust_estimate();
        assert!(estimate.valid);
        (sim.state_hash_with(&controller.flight().hash_words()), estimate)
    };
    assert_eq!(replay(), replay());
}

#[test]
fn last_step_reports_resolved_setpoints_and_the_active_mode() {
    use super::FlightMode;

    let (mut sim, mut controller, _) = hover_fixture(true, SimConfig::default());
    assert!(controller.last_step().is_none());
    controller.step(&mut sim, FlightCommand::Altitude(Sticks::default())).unwrap();
    let snapshot = controller.last_step().unwrap();
    assert_eq!(snapshot.mode, FlightMode::Altitude);
    assert!(snapshot.position_setpoint[..2].iter().all(|v| v.is_nan()));
    assert!(snapshot.position_setpoint[2].is_finite());
    assert_eq!(
        snapshot.velocity_setpoint.map(f64::to_bits),
        controller.velocity_feedback.unwrap().map(f64::to_bits),
    );
    assert!(snapshot.acceleration_setpoint.iter().all(|v| v.is_finite()));
    assert_eq!(snapshot.velocity_integral, controller.position.velocity_integral());
    assert_eq!(snapshot.hover_thrust, controller.hover_thrust_estimate());
    assert_eq!(snapshot.saturation.positive, controller.saturation.positive);
    assert_eq!(snapshot.saturation.negative, controller.saturation.negative);

    controller.step(&mut sim, FlightCommand::Stabilized(Sticks::default())).unwrap();
    let snapshot = controller.last_step().unwrap();
    assert_eq!(snapshot.mode, FlightMode::Stabilized);
    assert!(snapshot.position_setpoint.iter().chain(&snapshot.velocity_setpoint)
        .chain(&snapshot.acceleration_setpoint).all(|v| v.is_nan()));
}

#[test]
fn estimator_refuses_an_indivisible_step_before_advancing() {
    let config = SimConfig { dt_s: ESTIMATE_INTERVAL_S * 2.0 / 3.0, ..SimConfig::default() };
    let (mut sim, mut controller, _) = hover_fixture(true, config);
    let before = sim.state_hash();
    assert!(controller.step(&mut sim, FlightCommand::Position(Sticks::default())).unwrap_err().contains("divide"));
    assert_eq!(before, sim.state_hash());
}
