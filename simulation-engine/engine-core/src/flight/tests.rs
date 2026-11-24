//! Analytical tests for the flight step (plan, tests areas 6, 7, 9, 10).
//! Each tolerance is stated next to its derivation.

use super::*;
use crate::environment::{Environment, Surface};
use crate::math::STANDARD_GRAVITY as G;
use crate::propulsion::{BatteryParams, MotorPropulsion, PropulsionDefinition};
use crate::sim::SimConfig;
use crate::vehicle::fixtures::{box_part, with_totals};
use crate::vehicle::MotorBody;
use serde_json::{json, Value};

const DT: f64 = 1e-3;
const IXX: f64 = 0.01;
const IZZ: f64 = 0.02;
const QUAD_ARM_M: f64 = 0.15;

/// The hand-solution motor of `propulsion.rs`: K_v = 100 rad/(s·V), R = 0.1 Ω,
/// I₀ = 0.5 A, k_T = 2e-5 N·s², k_Q = 1e-7 N·m·s², J = 2e-5 kg·m².
fn motor(id: &str) -> MotorPropulsion {
    MotorPropulsion {
        part_id: id.into(),
        kv_rad_per_sv: 100.0,
        resistance_ohm: 0.1,
        no_load_current_a: 0.5,
        thrust_coef_ns2: 2e-5,
        torque_coef_nms2: 1e-7,
        inertia_kg_m2: 2e-5,
        throttle_map: None,
        // APC states the sea-level standard atmosphere for its data; the other tests fly at that density.
        reference_density_kg_m3: Some(1.225),
    }
}

/// A box body (CoM at the origin, principal axes = body axes) with motors at
/// `motors` = (position, spin), all thrusting along +z.
fn vehicle(mass: f64, motors: &[([f64; 3], Spin)]) -> Vehicle {
    let mut def = with_totals(vec![box_part("body", mass, [0.0; 3], [IXX, IXX, IZZ, 0.0, 0.0, 0.0])]);
    def.motors = motors
        .iter()
        .enumerate()
        .map(|(i, (p, s))| MotorBody { part_id: format!("m{}", i + 1), position: *p, thrust_axis: [0.0, 0.0, 1.0], spin: *s })
        .collect();
    Vehicle::from_definition(def).unwrap()
}

/// Quad X, arm a = 0.15 m: m1 front-right and m2 rear-left CCW, m3 front-left and m4 rear-right CW.
fn quad(mass: f64) -> Vehicle {
    let a = QUAD_ARM_M;
    vehicle(mass, &[([a, -a, 0.0], Spin::Ccw), ([-a, a, 0.0], Spin::Ccw), ([a, a, 0.0], Spin::Cw), ([-a, -a, 0.0], Spin::Cw)])
}

fn propulsion(v: &Vehicle) -> Propulsion {
    let def = PropulsionDefinition {
        version: 1,
        motors: v.definition.motors.iter().map(|m| motor(&m.part_id)).collect(),
        battery: BatteryParams { open_circuit_voltage_v: 10.0, internal_resistance_ohm: 0.01, capacity_c: 18_720.0 },
    };
    Propulsion::from_definition(def, &v.definition).unwrap()
}

fn sim(v: &Vehicle) -> Simulation {
    Simulation::new(v, SimConfig { dt_s: DT, ..SimConfig::default() }).unwrap()
}

/// The steady rotor speed for a throttle held on every motor: the propulsion
/// model alone run to rest (5 s; the rotor time constant is ~10 ms).
fn steady_speed(v: &Vehicle, d: f64) -> f64 {
    let p = propulsion(v);
    let mut s = p.rest();
    let d = vec![d; p.motors.len()];
    for _ in 0..5000 {
        p.step(&mut s, &d, DT);
    }
    s.omega[0]
}

/// Throttle whose steady speed gives thrust = weight / n (bisection to 1e-12).
fn hover_throttle(v: &Vehicle) -> f64 {
    let n = v.definition.motors.len() as f64;
    let target = (v.totals.mass_kg * G / (n * 2e-5)).sqrt();
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..45 {
        let mid = 0.5 * (lo + hi);
        if steady_speed(v, mid) < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

fn close(a: f64, b: f64, tol: f64, what: &str) {
    assert!((a - b).abs() <= tol, "{what}: {a} vs {b} (tolerance {tol})");
}

/// One motor 0.2 m forward of the CoM at ω = 500 rad/s:
/// F = k_T ω² = 2e-5 × 250 000 = 5 N along +z;
/// p × F = (0.2, 0, 0) × (0, 0, 5) = (0, −1, 0) N·m;
/// drag reaction −s k_Q ω² a = ∓ 0.025 N·m about z (CCW: −, CW: +);
/// rotor gyroscopic term with the body rolling at 1 rad/s:
/// h = s J ω a = ±0.01 z, −ω_b × h = −(1, 0, 0) × (0, 0, ±0.01) = (0, ±0.01, 0).
#[test]
fn rotor_loads_match_the_hand_calculation() {
    for (spin, s) in [(Spin::Ccw, 1.0), (Spin::Cw, -1.0)] {
        let v = vehicle(1.0, &[([0.2, 0.0, 0.0], spin)]);
        let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
        f.set_rotor_speeds(&[500.0]).unwrap();
        let l = f.rotor_loads(Vector::ZERO);
        close(l.force_body_n.z, 5.0, 1e-12, "thrust");
        close(l.force_body_n.x.abs() + l.force_body_n.y.abs(), 0.0, 0.0, "no side force");
        close(l.torque_body_nm.y, -1.0, 1e-12, "pitch torque p × F");
        close(l.torque_body_nm.z, -s * 0.025, 1e-15, "drag reaction");
        let g = f.rotor_loads(Vector::new(1.0, 0.0, 0.0));
        close(g.torque_body_nm.y - l.torque_body_nm.y, s * 0.01, 1e-15, "rotor gyroscopic coupling");
    }
}

/// Hover: with every rotor at its steady speed for the hover throttle, the
/// net vertical acceleration is a = (Σ k_T ω² − m g)/m, held constant, so
/// v_z(1 s) = a × 1 s (symplectic Euler is exact for constant acceleration).
/// The trim leaves |a| < 1e-6 m/s²; the symmetric quad (two CCW, two CW at
/// mirrored positions) keeps every body rate at rounding level.
#[test]
fn hover_trim_holds_altitude_and_attitude() {
    let v = quad(1.0);
    let d = hover_throttle(&v);
    let w = steady_speed(&v, d);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[w; 4]).unwrap();
    let mut s = sim(&v);
    for _ in 0..1000 {
        f.step(&mut s, &[d; 4]);
    }
    let a = (4.0 * 2e-5 * w * w - G) / 1.0;
    assert!(a.abs() < 1e-6, "trim residual {a}");
    let st = s.state();
    close(st.linear_velocity_mps[2], a, 1e-9, "vertical velocity");
    for (i, r) in st.angular_velocity_body_radps.iter().enumerate() {
        close(*r, 0.0, 1e-12, &format!("body rate {i}"));
    }
    // Each motor carries a quarter of the weight.
    for m in f.motors() {
        close(m.thrust_n, G / 4.0, 1e-6, "thrust per motor");
        close(m.throttle, d, 0.0, "throttle reading");
    }
}

/// Full throttle from the steady full-throttle speed: constant acceleration
/// a = (4 k_T ω² − m g)/m, so v(t) = a t and z(t) = ½ a t² + ½ a t h, with
/// h = dt/4 (rapier's substeps; symplectic Euler, as for free fall in sim/tests.rs).
#[test]
fn full_throttle_climb_matches_constant_acceleration() {
    let v = quad(1.0);
    let w = steady_speed(&v, 1.0);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[w; 4]).unwrap();
    let mut s = sim(&v);
    for _ in 0..500 {
        f.step(&mut s, &[1.0; 4]);
    }
    let a = 4.0 * 2e-5 * w * w - G;
    assert!(a > 10.0, "the test motor lifts 1 kg with margin ({a} m/s²)");
    let t = 0.5;
    let st = s.state();
    // The rotors stay at their steady speed to ~1e-9 relative (RK4 at rest point).
    close(st.linear_velocity_mps[2], a * t, 1e-6, "climb rate");
    close(st.position_m[2], 0.5 * a * t * t + 0.5 * a * t * DT / 4.0, 1e-6, "height");
}

/// Angular momentum about z of body + rotor: a CCW rotor on the CoM axis
/// coasts down (throttle 0). The body receives −s(Q + J dω/dt) each step and
/// rapier integrates I_zz ω̇_z exactly for a constant torque over a step, so
/// I_zz ω_z(n) + s J ω_r(n) = s J ω_r(0) − s Σ Q_k dt
/// (the only external torque on body + rotor is the air drag Q on the prop).
#[test]
fn rotor_spin_down_conserves_angular_momentum_up_to_prop_drag() {
    let v = vehicle(1.0, &[([0.0, 0.0, 0.0], Spin::Ccw)]);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[800.0]).unwrap();
    let mut s = Simulation::new(&v, SimConfig { dt_s: DT, gravity_mps2: 0.0 }).unwrap();
    let mut drag_impulse = 0.0;
    for _ in 0..300 {
        drag_impulse += 1e-7 * f.state.omega[0].powi(2) * DT;
        f.step(&mut s, &[0.0]);
    }
    let wz = s.state().angular_velocity_body_radps[2];
    let wr = f.state.omega[0];
    assert!(wr < 800.0 && wz > 0.0, "the rotor slowed ({wr}) and the body turned CCW ({wz})");
    let lhs = IZZ * wz + 2e-5 * wr;
    let rhs = 2e-5 * 800.0 - drag_impulse;
    close(lhs, rhs, 1e-12, "angular momentum balance");
}

/// Free fall with body drag only (rotors stopped): v(t) = −v_t tanh(g t / v_t),
/// v_t = √(2 m g / (ρ C_d A)). The drag is evaluated at the start of each step
/// (explicit), a first-order error: halving dt halves it (ratio 2 ± 0.2), and at
/// dt = 1 ms it stays below 2.5e-3 m/s over 3 s (measured 1.8e-3 at 0.5 s).
#[test]
fn fall_with_body_drag_approaches_terminal_velocity() {
    let v = vehicle(1.0, &[([0.0, 0.0, 0.0], Spin::Ccw)]);
    let drag = BodyDrag { cd_body: [1.0, 1.0, 1.2], area_m2: [0.1, 0.1, 0.5] };
    let rho = 1.225;
    let vt = (2.0 * G / (rho * 1.2 * 0.5)).sqrt();
    let max_error = |dt: f64| {
        let mut f = Flight::new(&v, propulsion(&v), Some(drag), Some(rho)).unwrap();
        let mut s = Simulation::new(&v, SimConfig { dt_s: dt, ..SimConfig::default() }).unwrap();
        let steps = (3.0 / dt).round() as u64;
        let mut worst: f64 = 0.0;
        for k in 1..=steps {
            f.step(&mut s, &[0.0]);
            let t = k as f64 * dt;
            worst = worst.max((s.state().linear_velocity_mps[2] + vt * (G * t / vt).tanh()).abs());
        }
        worst
    };
    let (e1, e2) = (max_error(DT), max_error(DT / 2.0));
    assert!(e1 < 2.5e-3, "error at 1 ms: {e1}");
    assert!((e1 / e2 - 2.0).abs() < 0.2, "first-order convergence: {e1} / {e2}");
}

/// Battery: the reading obeys V = V_oc − R_int I, and at a steady hover the
/// charge used is I × t (RK4 at a rest point: 1e-9 relative).
#[test]
fn battery_sags_with_current_and_counts_charge() {
    let v = quad(1.0);
    let d = hover_throttle(&v);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[steady_speed(&v, d); 4]).unwrap();
    let mut s = sim(&v);
    for _ in 0..1000 {
        f.step(&mut s, &[d; 4]);
    }
    let b = f.battery();
    close(b.voltage_v, 10.0 - 0.01 * b.current_a, 1e-12, "pack sag");
    assert!(b.current_a > 1.0, "hover draws current ({} A)", b.current_a);
    close(b.charge_used_c, b.current_a * 1.0, 1e-9 * b.current_a, "charge = I t");
    close(b.state_of_charge, 1.0 - b.charge_used_c / 18_720.0, 1e-15, "state of charge");
}

/// One motor working harder than the others pitches/rolls the quad the way
/// r × F says: more thrust on m3 (front-left) gives +roll (y > 0 side up…
/// torque x = y F > 0) and −pitch (x > 0: torque y = −x F < 0).
#[test]
fn unequal_thrust_tilts_the_way_r_cross_f_says() {
    let v = quad(1.0);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[300.0, 300.0, 400.0, 300.0]).unwrap();
    let l = f.rotor_loads(Vector::ZERO);
    let extra = 2e-5 * (400.0f64.powi(2) - 300.0f64.powi(2));
    close(l.torque_body_nm.x, 0.15 * extra, 1e-12, "roll torque");
    close(l.torque_body_nm.y, -0.15 * extra, 1e-12, "pitch torque");
    // m3 is CW: its larger drag torque yaws the body CCW (+z).
    close(l.torque_body_nm.z, 1e-7 * (400.0f64.powi(2) - 300.0f64.powi(2)), 1e-15, "yaw torque");
}

#[test]
fn identical_runs_give_identical_hashes_including_the_rotors() {
    let v = quad(1.2);
    let run = |throttle: f64| {
        let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
        let mut s = sim(&v);
        for k in 0..2000 {
            let wobble = if k % 7 == 0 { 0.03 } else { 0.0 };
            f.step(&mut s, &[throttle + wobble, throttle, throttle, throttle - wobble]);
        }
        s.state_hash_with(&f.hash_words())
    };
    assert_eq!(run(0.6), run(0.6));
    assert_ne!(run(0.6), run(0.6000001));
}

#[test]
fn refuses_drag_without_air_density_and_motors_without_data() {
    let v = quad(1.0);
    let drag = BodyDrag { cd_body: [1.0; 3], area_m2: [0.1; 3] };
    assert!(Flight::new(&v, propulsion(&v), Some(drag), None).unwrap_err().contains("air density"));
    assert!(Flight::new(&v, propulsion(&v), Some(drag), Some(0.0)).is_err());
    let one = vehicle(1.0, &[([0.0; 3], Spin::Cw)]);
    assert!(Flight::new(&v, propulsion(&one), None, None).unwrap_err().contains("no propulsion data"));
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    assert!(f.set_rotor_speeds(&[1.0, 2.0]).is_err());
    assert!(f.set_rotor_speeds(&[-1.0, 0.0, 0.0, 0.0]).is_err());
}

/// The last step's loads by source (4.8). One CCW motor 0.2 m forward at
/// ω = 500 rad/s with zero throttle (the rotor spins down), body at rest:
/// thrust 5 N along +z, arm torque (0.2, 0, 0) × (0, 0, 5) = (0, −1, 0) N·m,
/// drag reaction −s k_Q ω² a = −0.025 N·m about z, no gyroscopic term (no body
/// rate), spin-up reaction −s J (ω₁ − ω₀)/dt a with the rotor's own change of
/// speed, and the total is the sum of the four, which is what was applied.
#[test]
fn step_loads_are_split_by_source_and_sum_to_the_applied_torque() {
    let v = vehicle(1.0, &[([0.2, 0.0, 0.0], Spin::Ccw)]);
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[500.0]).unwrap();
    let mut s = sim(&v);
    f.step(&mut s, &[0.0]);
    let l = f.loads();
    close(l.thrust_body_n[2], 5.0, 1e-12, "thrust");
    close(l.arm_torque_nm[1], -1.0, 1e-12, "arm torque");
    close(l.drag_reaction_torque_nm[2], -0.025, 1e-15, "drag reaction");
    assert_eq!(l.rotor_gyro_torque_nm, [0.0; 3]);
    let dw = f.state.omega[0] - 500.0;
    assert!(dw < 0.0, "the rotor spins down");
    close(l.spin_up_reaction_torque_nm[2], -2e-5 * dw / DT, 1e-12, "spin-up reaction");
    for k in 0..3 {
        let sum = l.arm_torque_nm[k] + l.drag_reaction_torque_nm[k] + l.spin_up_reaction_torque_nm[k] + l.rotor_gyro_torque_nm[k];
        close(l.total_torque_nm[k], sum, 1e-12, "total torque");
    }
    // Body rolling at 1 rad/s: the gyroscopic term appears, as in `rotor_loads_match_the_hand_calculation`.
    let mut s = sim(&v);
    s.step(&BodyInput { force_body_n: Vector::ZERO, torque_body_nm: Vector::new(1e-3, 0.0, 0.0) });
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_rotor_speeds(&[500.0]).unwrap();
    f.step(&mut s, &[0.0]);
    assert!(f.loads().rotor_gyro_torque_nm.iter().any(|x| x.abs() > 0.0));
}

/// Body drag is reported through the CoM: with the air density and a body at
/// rest it is zero; moving it opposes the velocity, −½ ρ C_d A v|v| per axis.
#[test]
fn step_loads_report_the_drag_force() {
    let v = vehicle(1.0, &[([0.2, 0.0, 0.0], Spin::Ccw)]);
    let drag = BodyDrag { cd_body: [1.0, 1.0, 1.2], area_m2: [0.01, 0.01, 0.03] };
    let mut f = Flight::new(&v, propulsion(&v), Some(drag), Some(1.2)).unwrap();
    let mut s = sim(&v);
    f.step(&mut s, &[0.0]);
    assert_eq!(f.loads().drag_body_n, [0.0; 3]);
    s.step(&BodyInput { force_body_n: Vector::new(0.0, 0.0, G + 1.0), torque_body_nm: Vector::ZERO });
    let v_z = s.state().linear_velocity_mps[2];
    f.step(&mut s, &[0.0]);
    assert!(v_z.abs() > 1e-3, "the body moves (falling a little): {v_z}");
    close(f.loads().drag_body_n[2], -0.5 * 1.2 * 1.2 * 0.03 * v_z * v_z.abs(), 1e-12, "drag along z");
}

/// The battery cut-off ends the run (4.8): a charge cut-off at 0.5 mAh (1.8 C,
/// reached within a second at hover current) and a voltage cut-off at 9.9 V
/// (the 10 V pack sags below it as the rotors draw their start-up
/// current, R = 0.1 Ω motors on 0.01 Ω), and the flight is frozen afterwards.
#[test]
fn a_cutoff_ends_the_run_and_freezes_it() {
    let v = quad(1.0);
    let d = hover_throttle(&v);
    for (cutoff, reason) in [(Cutoff::ChargeMah(0.5), EndReason::ChargeCutoff), (Cutoff::VoltageV(9.9), EndReason::VoltageCutoff)] {
        let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
        f.set_cutoff(cutoff).unwrap();
        let mut s = sim(&v);
        assert!(f.ended().is_none());
        let mut steps = 0;
        while f.ended().is_none() && steps < 5000 {
            f.step(&mut s, &[d; 4]);
            steps += 1;
        }
        assert_eq!(f.ended(), Some(reason));
        assert!(steps >= 1 && steps < 5000, "{reason:?} after {steps} steps");
        let (hash, words) = (s.state_hash(), f.hash_words());
        f.step(&mut s, &[d; 4]);
        assert_eq!((s.state_hash(), f.hash_words()), (hash, words), "an ended flight does not step");
    }
    // Without a cut-off nothing ends; a cut-off must be positive and finite.
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    let mut s = sim(&v);
    for _ in 0..200 {
        f.step(&mut s, &[d; 4]);
    }
    assert!(f.ended().is_none());
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(f.set_cutoff(Cutoff::VoltageV(bad)).is_err());
        assert!(f.set_cutoff(Cutoff::ChargeMah(bad)).is_err());
    }
}

/// Thrust T = k_T w^2 and drag torque Q = k_Q w^2 scale as rho / rho_ref,i per motor (4.8): at half the
/// reference density the same rotor speed gives half the thrust and half the torque, the reaction torque on the
/// body follows, a density equal to the reference changes nothing, and each motor uses its own reference density.
/// A motor without one, or an invalid density, is refused and changes nothing.
#[test]
fn the_coefficients_scale_with_the_air_density_ratio() {
    let v = vehicle(1.0, &[([0.2, 0.0, 0.0], Spin::Ccw)]);
    let loads = |rho: f64| {
        let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
        f.scale_to_air_density(rho).unwrap();
        f.set_rotor_speeds(&[500.0]).unwrap();
        (f.rotor_loads(Vector::ZERO), f.motors()[0].thrust_n, f.motors()[0].drag_torque_nm)
    };
    let (base, t1, q1) = loads(1.225);
    close(t1, 5.0, 1e-12, "unchanged at the reference density");
    close(q1, 0.025, 1e-15, "drag torque unchanged");
    let (thin, t2, q2) = loads(0.6125);
    close(t2, 2.5, 1e-12, "half the density, half the thrust");
    close(q2, 0.0125, 1e-15, "half the drag torque");
    close(thin.force_body_n.z, 0.5 * base.force_body_n.z, 1e-12, "thrust on the body");
    close(thin.torque_body_nm.z, 0.5 * base.torque_body_nm.z, 1e-15, "reaction torque on the body");

    // Scaling twice replaces the scaling, it does not compound it.
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.scale_to_air_density(0.6125).unwrap();
    f.scale_to_air_density(0.6125).unwrap();
    f.set_rotor_speeds(&[500.0]).unwrap();
    close(f.motors()[0].thrust_n, 2.5, 1e-12, "the second call with the same density changes nothing");
    f.scale_to_air_density(1.225).unwrap();
    close(f.motors()[0].thrust_n, 5.0, 1e-12, "and a later call starts from the data's coefficients");

    // Each motor scales by its own reference density: a motor whose data was taken at 0.6125 kg/m³ is unchanged at 0.6125.
    let q = quad(1.0);
    let mut p = propulsion(&q);
    p.motors[1].reference_density = Some(0.6125);
    let mut f = Flight::new(&q, p, None, None).unwrap();
    f.scale_to_air_density(0.6125).unwrap();
    f.set_rotor_speeds(&[500.0; 4]).unwrap();
    let t: Vec<f64> = f.motors().iter().map(|m| m.thrust_n).collect();
    close(t[0], 2.5, 1e-12, "m1: data at 1.225, flown at 0.6125");
    close(t[1], 5.0, 1e-12, "m2: its own data was taken at 0.6125");

    // A motor without a reference density, and invalid densities, are refused and leave the scaling as it was.
    let mut p = propulsion(&q);
    p.motors[2].reference_density = None;
    let mut f = Flight::new(&q, p, None, None).unwrap();
    f.set_rotor_speeds(&[500.0; 4]).unwrap();
    let err = f.scale_to_air_density(1.225).unwrap_err().to_string();
    assert!(err.contains("m3") && err.contains("reference density"), "{err}");
    close(f.motors()[0].thrust_n, 5.0, 1e-12, "nothing changed");
    for air in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(Flight::new(&q, propulsion(&q), None, None).unwrap().scale_to_air_density(air).is_err(), "{air}");
    }
}
// Reference wind case (phase-6-flight-environment.md:318-326).
const WIND_SPEED: f64 = 8.0;
const WIND_MASS: f64 = 1.5;
const WIND_RHO: f64 = 1.225;
const WIND_AREA: f64 = 0.022;
const WIND_DRAG: BodyDrag = BodyDrag { cd_body: [1.0; 3], area_m2: [WIND_AREA; 3] };

// Wind from north, blowing along −world x with no y component (wind.rs:165-166).
fn constant_wind(gust: Value) -> Wind {
    Wind::from_json(&json!({
        "fromDeg": 0.0, "mean": {"kind": "constant", "speedMps": WIND_SPEED}, "gust": gust
    })).unwrap()
}

fn shear_wind() -> Wind {
    Wind::from_json(&json!({
        "fromDeg": 0.0,
        "mean": {"kind": "shear", "speedAt20FtMps": WIND_SPEED, "roughness": {"kind": "categoryC"}},
        "gust": null
    })).unwrap()
}

// Same floor as environment/tests.rs:115-118.
fn ground_plane() -> Environment {
    Environment { ground: Some(Surface { friction: 0.5, restitution: 0.0 }), ..Environment::default() }
}

#[test]
fn explicit_calm_preserves_off_state_loads_and_hash() {
    // Repeat the 2 s throttle profile of identical_runs_give_identical_hashes_including_the_rotors.
    let v = quad(WIND_MASS);
    let run = |wind| {
        let mut f = Flight::new(&v, propulsion(&v), Some(WIND_DRAG), Some(WIND_RHO)).unwrap();
        let mut s = sim(&v);
        if let Some(wind) = wind {
            f.set_wind(wind);
        }
        for k in 0..2000 {
            let wobble = if k % 7 == 0 { 0.03 } else { 0.0 };
            f.step(&mut s, &[0.6 + wobble, 0.6, 0.6, 0.6 - wobble]);
        }
        let words = f.hash_words();
        (s.state_hash_with(&words), words, f.loads().clone())
    };
    let off = run(None);
    let calm = run(Some(Wind::calm()));
    assert_eq!(calm, off);
    assert_eq!(calm.0, 0x832a_f796_7d94_7fa9, "calm flight hash");
}

#[test]
fn drift_in_a_constant_wind_converges_to_the_analytic_solution() {
    // Same 3 s, 1 ms/0.5 ms and first-order bounds as the fall-with-drag test.
    // Use magnitudes along the wind (−x). k and the solution are from plan test 2.
    let v = vehicle(WIND_MASS, &[]);
    let k = WIND_RHO * WIND_AREA / (2.0 * WIND_MASS);
    let errors = |dt: f64| {
        let mut f = Flight::new(&v, propulsion(&v), Some(WIND_DRAG), Some(WIND_RHO)).unwrap();
        f.set_wind(constant_wind(Value::Null));
        let mut s = Simulation::new(&v, SimConfig { dt_s: dt, gravity_mps2: 0.0 }).unwrap();
        let (mut e_x, mut e_v) = (0.0_f64, 0.0_f64);
        for _ in 0..(3.0 / dt).round() as usize {
            f.step(&mut s, &[]);
            let state = s.state();
            let t = state.time_s;
            let kwt = k * WIND_SPEED * t;
            let x = WIND_SPEED * t - kwt.ln_1p() / k;
            let speed = WIND_SPEED * kwt / (1.0 + kwt);
            e_x = e_x.max((x + state.com_m[0]).abs());
            e_v = e_v.max((speed + state.linear_velocity_mps[0]).abs());
        }
        [e_x, e_v]
    };
    for (coarse, fine) in errors(DT).into_iter().zip(errors(DT / 2.0)) {
        assert!(coarse < 2.5e-3, "error at 1 ms: {coarse}");
        close(coarse / fine, 2.0, 0.2, "first-order convergence");
    }
}

#[test]
fn drag_is_bit_identical_for_equal_air_velocity_across_attitudes() {
    let v = vehicle(WIND_MASS, &[]);
    let get_drag = |attitude, velocity, wind| {
        let mut s = sim(&v);
        s.world_mut().bodies.iter_mut().next().unwrap().1.set_rotation(attitude, true);
        s.set_velocity(velocity, Vector::ZERO);
        let mut f = Flight::new(&v, propulsion(&v), Some(WIND_DRAG), Some(WIND_RHO)).unwrap();
        if let Some(wind) = wind {
            f.set_wind(wind);
        }
        f.step(&mut s, &[]);
        f.loads().drag_body_n.map(f64::to_bits)
    };
    // Fixed-seed xorshift64* from controller/tests.rs:731-741. Uniform 53-bit samples.
    let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
    let mut uniform = || {
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        let bits = seed.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
        bits as f64 / (1_u64 << 53) as f64
    };
    let wind = constant_wind(Value::Null);
    let w = wind.mean_velocity(0.0).unwrap();
    // Use the generator's mantissa width as the sample count, with angles in [0, 2π).
    for _ in 0..f64::MANTISSA_DIGITS {
        let mut angle = || std::f64::consts::TAU * uniform();
        let attitude = Rotation::from_rotation_x(angle()) * Rotation::from_rotation_y(angle()) * Rotation::from_rotation_z(angle());
        let mut speed = || WIND_SPEED * (2.0 * uniform() - 1.0);
        let velocity = Vector::new(speed(), speed(), speed());
        assert_eq!(get_drag(attitude, velocity, Some(wind)), get_drag(attitude, velocity - w, None));
    }
}

#[test]
fn position_hold_in_wind_matches_the_per_axis_force_balance() {
    use crate::controller::Gains;
    use crate::flight_loop::FlightLoop;
    use crate::flight_modes::{FlightCommand, Sticks};
    use crate::hover_thrust::HoverThrustParams;
    use crate::position_control::PositionGains;

    // Settled horizontal error ≤ 1 cm and tilt error ≤ 0.1°, as in flight_loop/tests.rs:99-118.
    const POSITION_TOLERANCE_M: f64 = 0.01;
    let tilt_tolerance = 0.1_f64.to_radians();

    // Wind points along −x, so +θ around world y points the thrust into the wind.
    // The x/z components of air velocity in body axes are W·cosθ and W·sinθ.
    // Include the world vertical drag in the vertical thrust balance before
    // multiplying by tanθ to find the horizontal thrust (plan test 4).
    let balance = |tilt: f64| {
        let (sin, cos) = tilt.sin_cos();
        let scale = -0.5 * WIND_RHO * WIND_AREA * WIND_SPEED * WIND_SPEED;
        let (drag_x_body, drag_z_body) = (scale * cos * cos, scale * sin * sin);
        let drag_x = cos * drag_x_body + sin * drag_z_body;
        let drag_z = -sin * drag_x_body + cos * drag_z_body;
        (WIND_MASS * G - drag_z) * tilt.tan() + drag_x
    };
    let gains = PositionGains::px4_v1_13_3();
    let (mut lo, mut hi) = (0.0, gains.mpc_tiltmax_air.to_radians());
    assert!(balance(lo) < 0.0 && balance(hi) > 0.0);
    // Same bisection depth as flight_loop/tests.rs:130-145.
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if balance(mid) < 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let expected_tilt = (lo + hi) / 2.0;

    // The quad and motor/pack fixtures here match scenario/tests.rs:1-8,31-64,
    // with the wind case's reference mass and drag. Use the real FlightLoop.
    let v = quad(WIND_MASS);
    let p = propulsion(&v);
    let yaw_ratio = p.yaw_ratio();
    let mut f = Flight::new(&v, p, Some(WIND_DRAG), Some(WIND_RHO)).unwrap();
    f.set_wind(constant_wind(Value::Null));
    let mut loop_ = FlightLoop::new(&v, f, yaw_ratio, Gains::px4_v1_13_3(), gains, 0, HoverThrustParams::default()).unwrap();
    // Start above the hover estimator's in-air gate, as in flight_loop/tests.rs:158-161.
    let mut s = Simulation::with_environment(&v, SimConfig::default(), &ground_plane(), [0.0, 0.0, gains.mpc_land_alt2]).unwrap();
    let target = s.state().com_m;
    let hold = FlightCommand::Position(Sticks::default());
    // Allow the horizontal integral to reject the constant disturbance.
    // Use the velocity PI time scale P/I (PX4 PositionControl.cpp:143-144,190-191,
    // mc_pos_control_params.c:282,295). Budget enough such time scales for
    // exponential decay from the wind travel in one time scale to the tolerance.
    let integral_time_s = gains.mpc_xy_vel_p_acc / gains.mpc_xy_vel_i_acc;
    let settle_s = integral_time_s * (WIND_SPEED * integral_time_s / POSITION_TOLERANCE_M).ln();
    for _ in 0..(settle_s / DT).ceil() as usize {
        loop_.step(&mut s, hold).unwrap();
    }
    let state = s.state();
    assert!(loop_.hover_thrust_estimate().valid);
    let [dx, dy, _] = arr(vec(state.com_m) - vec(target));
    close(dx.hypot(dy), 0.0, POSITION_TOLERANCE_M, "horizontal position error");
    let [x, y, z, w] = state.quaternion;
    let thrust_axis = Rotation::from_xyzw(x, y, z, w) * Vector::Z;
    assert!(thrust_axis.x > 0.0, "tilt must oppose the wind");
    close(thrust_axis.z.acos(), expected_tilt, tilt_tolerance, "tilt in wind");
}

#[test]
fn gust_uses_start_of_step_distance_and_hashes_the_integral() {
    let v = vehicle(WIND_MASS, &[]);
    // Gust fixture from wind/tests.rs:17, with a start halfway through step 2.
    let wind = constant_wind(json!({"amplitudeMps": 8.0, "lengthM": 4.0, "startS": 1.5 * DT}));
    let run = |chunks: &[usize]| {
        let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
        let mut s = Simulation::new(&v, SimConfig { dt_s: DT, gravity_mps2: 0.0 }).unwrap();
        let no_gust_words = f.hash_words();
        f.set_wind(wind);
        assert_eq!(f.hash_words()[no_gust_words.len()..], [(1.5 * DT).to_bits(), 0.0_f64.to_bits()]);
        let mut gust = wind.gust_state().unwrap();
        for &steps in chunks {
            for _ in 0..steps {
                let expected = wind.velocity(0.0, gust.distance_m()).unwrap();
                f.step(&mut s, &[]);
                assert_eq!(f.loads().wind_com_world_mps, arr(expected));
                // No body drag or thrust, so the vehicle stays at rest in the mean flow.
                gust.advance(WIND_SPEED, DT).unwrap();
                let words = f.hash_words();
                assert_eq!(words[..no_gust_words.len()], no_gust_words);
                assert_eq!(words[no_gust_words.len()..], gust.hash_words());
            }
        }
        let hash = s.state_hash_with(&f.hash_words());
        assert_ne!(hash, s.state_hash_with(&no_gust_words));
        (hash, gust)
    };
    let (hash, gust) = run(&[4]);
    close(gust.distance_m(), WIND_SPEED * 2.5 * DT, 1e-12, "integral since gust start");
    assert_eq!(run(&[1, 3]), (hash, gust));
}

#[test]
fn shear_uses_com_clearance_and_flags_the_1000_ft_hold() {
    // Height conversion and 20/1000 ft levels from wind.rs:16-21.
    let reference = 20.0 * 0.3048;
    let limit = 1000.0 * 0.3048;
    let v = vehicle(WIND_MASS, &[]);
    let terrain = Environment::from_json(&json!({
        "terrain": {
            "rows": 2, "columns": 2, "cellSizeM": reference, "cornerM": [-reference, -reference],
            "heightsM": [reference, reference, reference, reference], "friction": 0.5, "restitution": 0.0
        }, "obstacles": []
    })).unwrap();
    let wind = shear_wind();
    let mut f = Flight::new(&v, propulsion(&v), None, None).unwrap();
    f.set_wind(wind);
    for (env, z, expected_height, above_range) in [
        (&terrain, 2.0 * reference, reference, false),
        (&Environment::default(), 2.0 * reference, 2.0 * reference, false),
        (&ground_plane(), limit + reference, limit, true),
        (&ground_plane(), limit, limit, false),
    ] {
        let mut s = Simulation::with_environment(&v, SimConfig::default(), env, [0.0, 0.0, z]).unwrap();
        f.step(&mut s, &[]);
        assert_eq!(f.loads().wind_com_world_mps, arr(wind.mean_velocity(expected_height).unwrap()));
        assert_eq!(f.loads().wind_above_range, above_range);
        assert!(!f.loads().wind_invalid);
    }
}

// Test radius equals the existing quad's arm (quad fixture above). The equation
// at zero horizontal airspeed is ground_effect.rs:18-19.
const TEST_RADIUS: f64 = QUAD_ARM_M;
fn still_air_ratio(height_over_radius: f64) -> f64 {
    let h = height_over_radius.max(ground_effect::MIN_HEIGHT_RATIO);
    1.0 / (1.0 - 1.0 / (16.0 * h * h))
}

#[test]
fn ground_effect_scales_only_thrust_and_reduces_hover_speed() {
    let v = quad(WIND_MASS);
    let p = propulsion(&v);
    let mut f = Flight::new(&v, p.clone(), None, Some(WIND_RHO)).unwrap();
    assert!(Flight::new(&v, p.clone(), None, None).unwrap().set_ground_effect(&[TEST_RADIUS; 4]).is_err());
    f.set_ground_effect(&[TEST_RADIUS; 4]).unwrap();
    assert!(f.set_ground_effect(&[TEST_RADIUS; 3]).is_err());
    for invalid in [0.0, -TEST_RADIUS, f64::NAN, f64::INFINITY] {
        assert!(f.set_ground_effect(&[TEST_RADIUS, TEST_RADIUS, TEST_RADIUS, invalid]).is_err());
    }
    let ratio = still_air_ratio(1.0);
    let omega_free = (v.totals.mass_kg * G / (4.0 * p.motors[0].k_thrust)).sqrt();
    let omega_ground = omega_free * (1.0 / ratio).sqrt();
    let mut free = Flight::new(&v, p.clone(), None, Some(WIND_RHO)).unwrap();
    let mut s = sim(&v);
    let mut near = Simulation::with_environment(&v, SimConfig::default(), &ground_plane(), [0.0, 0.0, TEST_RADIUS]).unwrap();
    let status_buffer = f.loads().ground_effect_status.as_ptr();

    // Analytic torque/power at a fixed start-of-step speed; both plants see
    // the same throttle and pack (which are independent of ground effect).
    for (flight, sim) in [(&mut free, &mut s), (&mut f, &mut near)] {
        flight.set_rotor_speeds(&[omega_free; 4]).unwrap();
        flight.step(sim, &[0.0; 4]);
    }
    let out = free.loads();
    let inside = f.loads();
    close(inside.thrust_body_n[2], ratio * out.thrust_body_n[2], 1e-12, "scaled thrust");
    close(inside.ground_effect_added_thrust_n, (ratio - 1.0) * out.thrust_body_n[2], 1e-12, "thrust increase");
    for (i, (m, reference)) in f.motors().iter().zip(free.motors()).enumerate() {
        assert_eq!(m.drag_torque_nm, reference.drag_torque_nm);
        assert_eq!(m.drag_torque_nm * f.state.omega[i], reference.drag_torque_nm * free.state.omega[i]);
    }
    assert_eq!(inside.drag_reaction_torque_nm, out.drag_reaction_torque_nm);
    assert_eq!(f.hash_words(), free.hash_words(), "propulsion state and hash words");
    assert_eq!(inside.thrust_body_n, arr(f.rotor_loads(Vector::ZERO).force_body_n));
    assert_eq!(inside.ground_effect_status.as_ptr(), status_buffer);
    let wire = serde_json::to_value(inside).unwrap();
    assert_eq!(wire.as_object().unwrap().len(), 7, "legacy StepLoads shape");

    // Solve the steady motor duty at the reduced trim speed using the actual
    // pack sag (flight_loop/tests.rs:130-145); hold that trim for 1 s as above.
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let duty = (lo + hi) / 2.0;
        let voltage = p.pack_voltage(&[omega_ground; 4], &[duty; 4]);
        if p.motors[0].omega_dot(omega_ground, duty * voltage) < 0.0 {
            lo = duty;
        } else {
            hi = duty;
        }
    }
    let mut near = Simulation::with_environment(&v, SimConfig::default(), &ground_plane(), [0.0, 0.0, TEST_RADIUS]).unwrap();
    f.set_rotor_speeds(&[omega_ground; 4]).unwrap();
    for _ in 0..(1.0 / DT).round() as usize {
        f.step(&mut near, &[(lo + hi) / 2.0; 4]);
    }
    close(near.state().com_m[2], TEST_RADIUS, 1e-6, "ground-effect hover altitude");
    close(near.state().linear_velocity_mps[2], 0.0, 1e-6, "ground-effect hover velocity");
    close(f.state.omega[0] / omega_free, (1.0 / ratio).sqrt(), 1e-9, "ground-effect hover speed ratio");
}

#[test]
fn each_rotor_uses_its_own_ground_clearance_on_the_slope() {
    let v = quad(WIND_MASS);
    let p = propulsion(&v);
    let arm = v.definition.motors[0].position[0];
    let cell = 2.0 * arm;
    let r = TEST_RADIUS;
    // Place terrain nodes at the four hubs (registration in environment/tests.rs:243-252).
    // A planar two-axis slope makes all four hub clearances distinct. The
    // highest ground gives Z/R = 1/4, below the model's 1/2 limit.
    let terrain = Environment::from_json(&json!({
        "terrain": {
            "rows": 2, "columns": 2, "cellSizeM": cell, "cornerM": [-cell, -cell],
            "heightsM": [0.0, 3.0 * r / 4.0, -r, -r / 4.0], "friction": 0.5, "restitution": 0.0
        }, "obstacles": []
    })).unwrap();
    let mut s = Simulation::with_environment(&v, SimConfig::default(), &terrain, [0.0, 0.0, r]).unwrap();
    let mut f = Flight::new(&v, p.clone(), None, Some(WIND_RHO)).unwrap();
    f.set_ground_effect(&[r; 4]).unwrap();
    // Same 500 rad/s hand load as rotor_loads_match_the_hand_calculation.
    f.set_rotor_speeds(&[500.0; 4]).unwrap();
    f.step(&mut s, &[0.0; 4]);
    let thrust = p.motors[0].thrust(500.0);
    let mut force = Vector::ZERO;
    let mut torque = Vector::ZERO;
    for (m, h) in v.definition.motors.iter().zip([1.25, 1.0, 0.25, 2.0]) {
        let scaled = Vector::Z * (thrust * still_air_ratio(h));
        force += scaled;
        torque += vec(m.position).cross(scaled);
    }
    for (actual, expected) in f.loads().thrust_body_n.into_iter().zip(arr(force)) {
        close(actual, expected, 1e-12, "slope thrust");
    }
    for (actual, expected) in f.loads().arm_torque_nm.into_iter().zip(arr(torque)) {
        close(actual, expected, 1e-12, "slope arm torque");
    }
    let diagnostic = f.rotor_loads(Vector::ZERO);
    assert_eq!(arr(diagnostic.force_body_n), f.loads().thrust_body_n);
    for axis in 0..3 {
        close(arr(diagnostic.torque_body_nm)[axis], arr(torque)[axis], 1e-12, "slope rotor torque diagnostic");
    }
    assert_eq!(f.loads().ground_effect_status, [false, false, true, false].map(|below_tested_range| {
        RotorGroundEffect::Applied { below_tested_range }
    }));
}

#[test]
fn ground_effect_samples_shear_and_rigid_body_velocity_at_the_hub() {
    use crate::ground_effect::thrust_ratio;

    // Reuse the hand-load rotor's speed, arm and body rate magnitude
    // (rotor_loads_match_the_hand_calculation). Mount it one radius above the CoM.
    let arm = 0.2;
    let height = 20.0 * 0.3048;
    let v = vehicle(WIND_MASS, &[([arm, 0.0, TEST_RADIUS], Spin::Ccw)]);
    let p = propulsion(&v);
    // Use the half-reference density case above to verify both scaled k_T and ρ.
    let rho = WIND_RHO / 2.0;
    let mut f = Flight::new(&v, p.clone(), None, None).unwrap();
    f.scale_to_air_density(rho).unwrap();
    f.set_ground_effect(&[TEST_RADIUS]).unwrap();
    f.set_rotor_speeds(&[500.0]).unwrap();
    let wind = shear_wind();
    f.set_wind(wind);
    let mut s = Simulation::with_environment(&v, SimConfig::default(), &ground_plane(), [0.0, 0.0, height]).unwrap();
    s.set_velocity(Vector::ZERO, Vector::Z);
    f.step(&mut s, &[0.0]);
    let t = p.motors[0].thrust(500.0) * (rho / WIND_RHO);
    let hub_height = height + TEST_RADIUS;
    let effect = thrust_ratio(&RotorInput {
        hub_height_m: hub_height, radius_m: TEST_RADIUS,
        horizontal_airspeed_m_s: wind.mean_velocity(hub_height).unwrap().x.hypot(arm),
        thrust_n: t, air_density_kg_m3: rho,
    }).unwrap();
    // Small increment at 20 ft: compare the excess as well as total thrust.
    close(f.loads().ground_effect_added_thrust_n, t * (effect.ratio - 1.0), 1e-12, "hub airspeed and density");
    assert_eq!(f.loads().wind_com_world_mps, arr(wind.mean_velocity(height).unwrap()));
}

#[test]
fn ground_effect_skips_inverted_rotors_and_free_space() {
    let upright = vehicle(WIND_MASS, &[([0.0; 3], Spin::Ccw)]);
    let mut inverted_def = upright.definition.clone();
    inverted_def.motors[0].thrust_axis = [0.0, 0.0, -1.0];
    let inverted = Vehicle::from_definition(inverted_def).unwrap();
    for (v, env) in [(&upright, Environment::default()), (&inverted, ground_plane())] {
        let mut s = Simulation::with_environment(v, SimConfig::default(), &env, [0.0, 0.0, TEST_RADIUS]).unwrap();
        let mut f = Flight::new(v, propulsion(v), None, Some(WIND_RHO)).unwrap();
        f.set_ground_effect(&[TEST_RADIUS]).unwrap();
        f.set_rotor_speeds(&[500.0]).unwrap();
        let free_air = f.rotor_loads(Vector::ZERO);
        f.step(&mut s, &[0.0]);
        assert_eq!(f.loads().ground_effect_status, [RotorGroundEffect::Inactive]);
        assert_eq!(f.loads().ground_effect_added_thrust_n, 0.0);
        assert_eq!(f.loads().thrust_body_n, arr(free_air.force_body_n));
    }
}
