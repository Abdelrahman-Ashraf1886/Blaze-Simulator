//! Spikes and analytical tests for the simulation core (plan, tests area 10).
//! Every tolerance is stated next to its derivation or measurement.

use super::*;
use crate::vehicle::fixtures::{box_part, with_totals};
use crate::vehicle::Vehicle;

const G: f64 = STANDARD_GRAVITY;

/// One box part, principal axes = body axes, CoM at the origin.
fn principal_vehicle(mass: f64, inertia: [f64; 3]) -> Vehicle {
    let [a, b, c] = inertia;
    Vehicle::from_definition(with_totals(vec![box_part("body", mass, [0.0; 3], [a, b, c, 0.0, 0.0, 0.0])]))
        .unwrap()
}

/// An asymmetric body with off-diagonal inertia and its CoM off the origin, so
/// the principal frame differs from the body frame.
fn asymmetric_vehicle() -> Vehicle {
    Vehicle::from_definition(with_totals(vec![
        box_part("frame", 0.6, [0.01, -0.005, 0.02], [0.0062, 0.0081, 0.0129, -0.0004, 0.0002, 0.0001]),
        box_part("battery", 0.45, [0.03, 0.01, 0.05], [0.0002, 0.0007, 0.0008, 0.0, 0.0, 0.0]),
    ]))
    .unwrap()
}

fn run(sim: &mut Simulation, steps: u64, input: impl Fn(u64) -> BodyInput) {
    for k in 0..steps {
        sim.step(&input(k));
    }
}

#[test]
fn fnv1a_matches_published_test_vectors() {
    // Reference values from the FNV specification (draft-eastlake-fnv).
    let mut h = Fnv1a::new();
    assert_eq!(h.finish(), 0xcbf2_9ce4_8422_2325);
    h.write(b"a");
    assert_eq!(h.finish(), 0xaf63_dc4c_8601_ec8c);
    let mut h = Fnv1a::new();
    h.write(b"foobar");
    assert_eq!(h.finish(), 0x8594_4171_f739_67e8);
}

#[test]
fn rejects_bad_config() {
    let v = principal_vehicle(1.0, [0.01, 0.01, 0.01]);
    assert!(Simulation::new(&v, SimConfig { dt_s: 0.0, ..SimConfig::default() }).is_err());
    assert!(Simulation::new(&v, SimConfig { dt_s: f64::NAN, ..SimConfig::default() }).is_err());
    assert!(Simulation::new(&v, SimConfig { gravity_mps2: -1.0, ..SimConfig::default() }).is_err());
}

/// Free fall: z(t) = −½ g t², v(t) = −g t.
/// Symplectic Euler gives v_n = −g n dt exactly (constant acceleration), and
/// z_n = −g dt² n(n+1)/2 = −½ g t² − ½ g t dt. So the position error is
/// ½ g t dt (4.9 mm at t = 1 s, dt = 1 ms; relative error dt/t), the velocity
/// error only rounding.
#[test]
fn free_fall_matches_half_g_t_squared() {
    let v = asymmetric_vehicle();
    let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
    let start = sim.state().com_m;
    let z0 = start[2];
    run(&mut sim, 1000, |_| BodyInput::default());
    let s = sim.state();
    let t = s.time_s;
    assert_eq!(s.steps, 1000);
    assert!((t - 1.0).abs() < 1e-15);

    let vz = s.linear_velocity_mps[2];
    assert!((vz + G * t).abs() < 1e-12 * G * t, "v = {vz}, expected {}", -G * t);

    let dz = s.com_m[2] - z0;
    let exact = -0.5 * G * t * t;
    // rapier splits each step into 4 substeps (IntegrationParameters::
    // num_solver_iterations, default 4), so the symplectic-Euler step is
    // h = dt/4 and the error is ½ g t h: 1.23 mm at 1 s.
    let h = SimConfig::default().dt_s / 4.0;
    let bound = 0.5 * G * t * h;
    let err = (dz - exact).abs();
    eprintln!("free fall 1 s: dz = {dz} m, ½gt² = {exact} m, |error| = {err:e} m, bound {bound:e} m");
    assert!(err <= bound * (1.0 + 1e-9), "error {err:e} exceeds the symplectic-Euler bound {bound:e}");
    // The discrete solution itself: z_N = −g h² N(N+1)/2 with N = 4000 substeps.
    let n = 4000.0;
    assert!((dz + G * h * h * n * (n + 1.0) / 2.0).abs() < 1e-12, "not symplectic Euler: {dz}");
    // No sideways drift and no rotation.
    assert!((s.com_m[0] - start[0]).abs() < 1e-12 && s.linear_velocity_mps[0] == 0.0);
    assert_eq!(s.angular_velocity_radps, [0.0; 3]);
}

/// A body-frame force of m·g along +Z exactly cancels gravity: the vehicle hovers.
#[test]
fn upward_body_force_of_mg_hovers() {
    let v = asymmetric_vehicle();
    let m = v.totals.mass_kg;
    let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
    let z0 = sim.state().com_m[2];
    run(&mut sim, 1000, |_| BodyInput { force_body_n: Vector::new(0.0, 0.0, m * G), ..Default::default() });
    let s = sim.state();
    assert!((s.com_m[2] - z0).abs() < 1e-12, "drifted {} m", s.com_m[2] - z0);
    assert!(s.linear_velocity_mps[2].abs() < 1e-12);
}

/// Constant torque about a principal axis: α = τ/I, ω(t) = α t, θ(t) = ½ α t².
/// ω is exact up to rounding (constant α); θ has the symplectic-Euler error
/// ½ α t h with h = dt/4 (rapier's substeps), as for free fall.
#[test]
fn constant_torque_spin_up_matches_alpha_tau_over_i() {
    let izz = 0.0231;
    let tau = 0.0231 * 0.8; // α = 0.8 rad/s²
    let v = principal_vehicle(1.2, [0.0123, 0.0145, izz]);
    let config = SimConfig { gravity_mps2: 0.0, ..SimConfig::default() };
    let mut sim = Simulation::new(&v, config).unwrap();
    run(&mut sim, 1000, |_| BodyInput { torque_body_nm: Vector::new(0.0, 0.0, tau), ..Default::default() });
    let s = sim.state();
    let (t, alpha) = (s.time_s, tau / izz);

    let wz = s.angular_velocity_radps[2];
    assert!((wz - alpha * t).abs() < 1e-12, "ω = {wz}, expected {}", alpha * t);
    assert!(s.angular_velocity_radps[0].abs() < 1e-15 && s.angular_velocity_radps[1].abs() < 1e-15);

    let [_, _, qz, qw] = s.quaternion;
    let theta = 2.0 * qz.atan2(qw);
    let exact = 0.5 * alpha * t * t;
    let bound = 0.5 * alpha * t * config.dt_s / 4.0;
    let err = (theta - exact).abs();
    eprintln!("spin-up 1 s: θ = {theta} rad, ½αt² = {exact} rad, |error| = {err:e}, bound {bound:e}");
    assert!(err <= bound * (1.0 + 1e-6), "error {err:e} exceeds {bound:e}");
}

/// Inputs are body-frame: after the body has turned 90° about Z, a body +X
/// force must accelerate it along world +Y.
#[test]
fn body_frame_force_follows_the_attitude() {
    // Coast at π/2 rad/s for 1 s about the principal Z axis, then stop.
    let v = principal_vehicle(2.0, [0.02, 0.02, 0.03]);
    let config = SimConfig { gravity_mps2: 0.0, ..SimConfig::default() };
    let mut sim = Simulation::new(&v, config).unwrap();
    sim.set_velocity(Vector::ZERO, Vector::new(0.0, 0.0, std::f64::consts::FRAC_PI_2));
    run(&mut sim, 1000, |_| BodyInput::default());
    sim.set_velocity(Vector::ZERO, Vector::ZERO);
    let [_, _, qz, qw] = sim.state().quaternion;
    let yaw = 2.0 * qz.atan2(qw);
    // rapier's rotation update is accurate to ~2e-8 rad over these 4000 substeps.
    assert!((yaw - std::f64::consts::FRAC_PI_2).abs() < 1e-7, "yaw {yaw}");

    run(&mut sim, 100, |_| BodyInput { force_body_n: Vector::new(4.0, 0.0, 0.0), ..Default::default() });
    let s = sim.state();
    // a = R·F/m = 2 m/s² along the body's +X, now world (cos yaw, sin yaw, 0),
    // for 0.1 s → v = 0.2 m/s along it.
    let expected = [0.2 * yaw.cos(), 0.2 * yaw.sin()];
    assert!((s.linear_velocity_mps[0] - expected[0]).abs() < 1e-12, "{:?}", s.linear_velocity_mps);
    assert!((s.linear_velocity_mps[1] - expected[1]).abs() < 1e-12, "{:?}", s.linear_velocity_mps);
}

mod spikes {
    use super::*;

    /// Torque-free tumbling of an asymmetric body for 10 s.
    /// Returns (max relative drift of world L, max relative drift of energy).
    fn tumble(gyro: bool) -> (f64, f64) {
        let v = asymmetric_vehicle();
        let config = SimConfig { gravity_mps2: 0.0, ..SimConfig::default() };
        let mut sim = Simulation::new(&v, config).unwrap();
        sim.enable_rapier_gyroscopic_term(gyro);
        // Not near a principal axis, so the motion is a genuine tumble.
        sim.set_velocity(Vector::ZERO, Vector::new(3.0, -1.5, 4.0));
        let l0 = sim.angular_momentum_world();
        let e0 = sim.rotational_energy();
        let (mut dl, mut de) = (0.0_f64, 0.0_f64);
        for _ in 0..10_000 {
            sim.step(&BodyInput::default());
            dl = dl.max((sim.angular_momentum_world() - l0).length() / l0.length());
            de = de.max((sim.rotational_energy() - e0).abs() / e0);
        }
        (dl, de)
    }

    /// Spike (a): does rapier include the gyroscopic term −ω×(Iω)?
    ///
    /// Without torque, the world-frame angular momentum L = R I Rᵀ ω is
    /// constant. A solver that omitted −ω×(Iω) would keep ω constant in the
    /// world frame instead, so L would swing as the body turns. Measured with
    /// rapier 0.36.1 (dt = 1 ms, 10 s, |ω₀| = 5.2 rad/s):
    /// - term on (rapier's default): max |ΔL|/|L| = 4.5e-4, max |ΔE|/E = 2.1e-3
    ///   (rapier applies the explicit term per substep, then rescales the
    ///   body-frame momentum to its previous magnitude, as Jolt does);
    /// - term off: max |ΔL|/|L| = 0.54 (ω stays constant in the world frame,
    ///   so energy is kept to 6e-15 but L swings with the body).
    /// Conclusion: rapier includes it; we must not add it a second time.
    #[test]
    fn gyroscopic_term_is_included_by_rapier() {
        let (dl_on, de_on) = tumble(true);
        let (dl_off, de_off) = tumble(false);
        eprintln!("gyroscopic on:  max |ΔL|/|L| = {dl_on:e}, max |ΔE|/E = {de_on:e}");
        eprintln!("gyroscopic off: max |ΔL|/|L| = {dl_off:e}, max |ΔE|/E = {de_off:e}");
        assert!(dl_on < L_TOL, "angular momentum drifted {dl_on:e} with the term on");
        assert!(de_on < E_TOL, "energy drifted {de_on:e} with the term on");
        assert!(dl_off > 100.0 * dl_on, "turning the term off should break conservation");
    }

    /// Analytical test: torque-free angular momentum conservation at the
    /// default step. Tolerances: 5e-3 relative for L and for energy over
    /// 10 s, about 2.4× the measured energy drift and 11× the L drift.
    pub(super) const L_TOL: f64 = 5e-3;
    pub(super) const E_TOL: f64 = 5e-3;

    #[test]
    fn torque_free_angular_momentum_is_conserved() {
        let (dl, de) = tumble(true);
        assert!(dl < L_TOL && de < E_TOL, "ΔL {dl:e}, ΔE {de:e}");
    }

    /// Spike (b): identical inputs give an identical state hash over 10 s.
    /// Inputs vary every step so that every code path is exercised.
    #[test]
    fn identical_inputs_give_identical_hash_over_10_s() {
        let input = |k: u64| {
            let t = k as f64 * 1e-3;
            BodyInput {
                force_body_n: Vector::new(0.3 * (7.0 * t).sin(), 0.2 * (3.0 * t).cos(), 10.4 + (t * 1.3).sin()),
                torque_body_nm: Vector::new(0.002 * (5.0 * t).sin(), -0.001 * (2.0 * t).cos(), 0.0005),
            }
        };
        let simulate = |perturb: f64| {
            let v = asymmetric_vehicle();
            let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
            run(&mut sim, 10_000, |k| {
                let mut i = input(k);
                if k == 5_000 {
                    i.force_body_n.x += perturb;
                }
                i
            });
            (sim.state_hash(), sim.state())
        };
        let (h1, s1) = simulate(0.0);
        let (h2, s2) = simulate(0.0);
        eprintln!("10 s hash: {}", hash_hex(h1));
        assert_eq!(h1, h2);
        assert_eq!(s1, s2);
        assert_eq!(s1.steps, 10_000);
        // The hash is sensitive: a 1e-12 N change at one step changes it.
        let (h3, _) = simulate(1e-12);
        assert_ne!(h1, h3);
    }
}
