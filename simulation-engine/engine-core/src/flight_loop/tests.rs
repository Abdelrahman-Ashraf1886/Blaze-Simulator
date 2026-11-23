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
        FlightLoop::new(&v, flight, yaw_ratio, Gains::px4_v1_13_3(), g, 0).unwrap();
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
