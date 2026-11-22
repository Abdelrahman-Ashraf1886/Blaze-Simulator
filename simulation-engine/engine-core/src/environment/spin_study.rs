//! Study of the spin a flat box gets when it lands (4.4 follow-up). Not a regression
//! test: run with `cargo test -p engine-core --release spin_study -- --ignored --nocapture`.
//! It prints, for rapier's default solver settings and each candidate change:
//! - the normal impulse at each corner of the landing (symmetry: equal for a flat landing);
//! - the peak angular speed;
//! - the rebound height with restitution 0.5 (expected e²·h = 120 mm), and for the
//!   one-point pyramid as the control;
//! - the time to rest (|v|, |ω| < 1e-6) and the rest height with restitution 0.

use super::*;
use crate::math::STANDARD_GRAVITY as G;
use crate::sim::{BodyInput, SimConfig, Simulation};
use crate::vehicle::fixtures::with_totals;
use crate::vehicle::{CollisionShape, PartBody, ShapePose, Vehicle};
use rapier3d_f64::prelude::IntegrationParameters;
use serde_json::json;

fn body(shape: CollisionShape, id: &str) -> Vehicle {
    let (m, a, b, c) = (1.0, 0.1, 0.1, 0.04);
    Vehicle::from_definition(with_totals(vec![PartBody {
        part_id: id.into(),
        mass_kg: m,
        com: [0.0; 3],
        inertia: [m * (b * b + c * c) / 12.0, m * (a * a + c * c) / 12.0, m * (a * a + b * b) / 12.0, 0.0, 0.0, 0.0],
        pose: ShapePose { position: [0.0; 3], quaternion: [0.0, 0.0, 0.0, 1.0] },
        shape,
    }]))
    .unwrap()
}

fn ground(e: f64) -> Environment {
    Environment::from_json(&json!({ "ground": { "friction": 0.5, "restitution": e }, "obstacles": [] })).unwrap()
}

pub struct Outcome {
    pub corner_impulses: Vec<f64>,
    pub peak_spin: f64,
    pub rebound_m: f64,
    pub rest_s: f64,
    pub rest_z: f64,
}

/// Drops `v` (lowest point 20 mm below its origin) from 0.5 m and measures.
pub fn drop(v: &Vehicle, e: f64, tweak: &dyn Fn(&mut IntegrationParameters)) -> Outcome {
    let mut sim = Simulation::with_environment(v, SimConfig::default(), &ground(e), [0.0, 0.0, 0.5]).unwrap();
    tweak(&mut sim.world_mut().integration_parameters);
    let still = BodyInput::default();
    let (mut corner_impulses, mut peak_spin, mut rebound_m, mut rising, mut rest_s) = (Vec::new(), 0.0_f64, 0.0_f64, false, 0.0);
    for _ in 0..4000 {
        sim.step(&still);
        if corner_impulses.is_empty() {
            for pair in sim.world_mut().narrow_phase.contact_pairs() {
                for m in pair.solver_manifolds() {
                    for p in &m.points {
                        if p.data.impulse > 0.0 {
                            corner_impulses.push(p.data.impulse);
                        }
                    }
                }
            }
        }
        let s = sim.state();
        let w = s.angular_velocity_radps.iter().map(|x| x * x).sum::<f64>().sqrt();
        let v = s.linear_velocity_mps.iter().map(|x| x * x).sum::<f64>().sqrt();
        peak_spin = peak_spin.max(w);
        if s.linear_velocity_mps[2] > 0.0 {
            rising = true;
        }
        if rising && s.time_s < 0.313 + 2.0 * e * (2.0 * 0.48 / G).sqrt() + 0.02 {
            rebound_m = rebound_m.max(s.position_m[2] - 0.02);
        }
        if v >= 1e-6 || w >= 1e-6 {
            rest_s = s.time_s;
        }
    }
    Outcome { corner_impulses, peak_spin, rebound_m, rest_s, rest_z: sim.state().position_m[2] }
}

#[test]
#[ignore]
fn spin_study() {
    let brick = body(CollisionShape::Box { half_extents: [0.05, 0.05, 0.02] }, "brick");
    let pyramid = body(
        CollisionShape::Hull { points: vec![[0.0, 0.0, -0.02], [0.05, 0.05, 0.02], [-0.05, 0.05, 0.02], [0.05, -0.05, 0.02], [-0.05, -0.05, 0.02]] },
        "pyramid",
    );
    let variants: Vec<(&str, Box<dyn Fn(&mut IntegrationParameters)>)> = vec![
        ("default", Box::new(|_| {})),
        ("contact_clustering off", Box::new(|p| p.contact_clustering = false)),
        ("warmstart_coefficient 0", Box::new(|p| p.warmstart_coefficient = 0.0)),
        ("stabilization iterations 4", Box::new(|p| p.num_internal_stabilization_iterations = 4)),
        ("pgs iterations 8", Box::new(|p| p.num_internal_pgs_iterations = 8)),
        ("substeps 16", Box::new(|p| p.num_solver_iterations = 16)),
        ("clustering off + pgs 8", Box::new(|p| {
            p.contact_clustering = false;
            p.num_internal_pgs_iterations = 8;
        })),
        ("stabilization 8", Box::new(|p| p.num_internal_stabilization_iterations = 8)),
        ("stabilization 4 + warmstart 0", Box::new(|p| {
            p.num_internal_stabilization_iterations = 4;
            p.warmstart_coefficient = 0.0;
        })),
        ("stabilization 4 + pgs 4", Box::new(|p| {
            p.num_internal_stabilization_iterations = 4;
            p.num_internal_pgs_iterations = 4;
        })),
        ("stabilization 4 + substeps 8", Box::new(|p| {
            p.num_internal_stabilization_iterations = 4;
            p.num_solver_iterations = 8;
        })),
    ];
    for (name, tweak) in &variants {
        let flat0 = drop(&brick, 0.0, tweak.as_ref());
        let flat5 = drop(&brick, 0.5, tweak.as_ref());
        let pyr5 = drop(&pyramid, 0.5, tweak.as_ref());
        let imp = &flat0.corner_impulses;
        let (lo, hi) = imp.iter().fold((f64::INFINITY, 0.0_f64), |(a, b), &x| (a.min(x), b.max(x)));
        println!(
            "SPIN {name:28} corners {} impulses {:?} (max/min {:.2}) | peak |w| e=0 {:.3} e=0.5 {:.3} | rebound e=0.5 brick {:.1} mm pyramid {:.1} mm (expected 120) | rest e=0 at {:.3} s, z {:.4} mm",
            imp.len(),
            imp.iter().map(|x| (x * 1e4).round() / 1e4).collect::<Vec<_>>(),
            hi / lo,
            flat0.peak_spin,
            flat5.peak_spin,
            flat5.rebound_m * 1e3,
            pyr5.rebound_m * 1e3,
            flat0.rest_s,
            flat0.rest_z * 1e3,
        );
    }
}

#[test]
#[ignore]
fn resting_run_time() {
    let brick = body(CollisionShape::Box { half_extents: [0.05, 0.05, 0.02] }, "brick");
    let mut sim = Simulation::with_environment(&brick, SimConfig::default(), &ground(0.0), [0.0, 0.0, 0.02]).unwrap();
    let t0 = std::time::Instant::now();
    for _ in 0..120_000 {
        sim.step(&BodyInput::default());
    }
    println!("SPIN resting 120000 steps: {:?}", t0.elapsed());
}

#[test]
#[ignore]
fn resting_run_time_20_parts() {
    // 20 boxes (5 × 4 grid, 30 mm apart) forming one rigid vehicle resting on the ground.
    let parts: Vec<PartBody> = (0..20)
        .map(|i| {
            let (x, y) = ((i % 5) as f64 * 0.03 - 0.06, (i / 5) as f64 * 0.03 - 0.045);
            PartBody {
                part_id: format!("p{i}"),
                mass_kg: 0.05,
                com: [x, y, 0.0],
                inertia: [1e-5, 1e-5, 1e-5, 0.0, 0.0, 0.0],
                pose: ShapePose { position: [x, y, 0.0], quaternion: [0.0, 0.0, 0.0, 1.0] },
                shape: CollisionShape::Box { half_extents: [0.0125, 0.0125, 0.01] },
            }
        })
        .collect();
    let v = Vehicle::from_definition(with_totals(parts)).unwrap();
    let mut sim = Simulation::with_environment(&v, SimConfig::default(), &ground(0.0), [0.0, 0.0, 0.01]).unwrap();
    let t0 = std::time::Instant::now();
    for _ in 0..120_000 {
        sim.step(&BodyInput::default());
    }
    println!("SPIN resting 20 parts 120000 steps: {:?}", t0.elapsed());
}
