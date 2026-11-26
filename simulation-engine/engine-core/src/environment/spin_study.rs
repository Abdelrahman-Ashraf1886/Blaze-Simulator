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

mod k4 {
    use super::*;
    use crate::sim::ALLOWED_LINEAR_ERROR_M;
    use rapier3d_f64::prelude::*;

    // Same dimensions, mass, release origin and friction as body, ground and drop above.
    const HALF: Vector = Vector::new(0.05, 0.05, 0.02);
    const MASS: f64 = 1.0;
    const RELEASE_Z: f64 = 0.5;
    const FRICTION: f64 = 0.5;

    fn shape(points: usize) -> SharedShape {
        let (x, y, z) = (HALF.x, HALF.y, HALF.z);
        if points == 4 {
            return SharedShape::cuboid(x, y, z);
        }
        let mut vertices = vec![Vector::new(x, y, z), Vector::new(-x, y, z),
                                Vector::new(x, -y, z), Vector::new(-x, -y, z)];
        // Center each support under the CoM. Hold the box mass properties fixed.
        vertices.extend(match points {
            1 => vec![Vector::new(0.0, 0.0, -z)],
            2 => vec![Vector::new(-x, 0.0, -z), Vector::new(x, 0.0, -z)],
            3 => vec![Vector::new(-x, -y / 2.0, -z), Vector::new(x, -y / 2.0, -z),
                      Vector::new(0.0, y, -z)],
            _ => unreachable!(),
        });
        SharedShape::convex_hull(&vertices).unwrap()
    }

    fn principal_inertia() -> Vector {
        let density = MASS / (8.0 * HALF.x * HALF.y * HALF.z);
        SharedShape::cuboid(HALF.x, HALF.y, HALF.z).mass_properties(density).principal_inertia()
    }

    fn world(points: usize, clearance: f64, e: f64, skin: f64, params: IntegrationParameters)
        -> (PhysicsWorld, RigidBodyHandle)
    {
        let mut world = PhysicsWorld::new();
        world.gravity = -Vector::Z * G;
        world.integration_parameters = params;
        let body = world.bodies.insert(RigidBodyBuilder::dynamic()
            .translation(Vector::Z * (clearance + HALF.z)).can_sleep(false).build());
        let part = ColliderBuilder::new(shape(points))
            .mass_properties(MassProperties::new(Vector::ZERO, MASS, principal_inertia()))
            .friction(0.0).build();
        world.colliders.insert_with_parent(part, body, &mut world.bodies);
        world.bodies[body].recompute_mass_properties_from_colliders(&world.colliders);
        let ground = world.bodies.insert(RigidBodyBuilder::fixed().build());
        world.colliders.insert_with_parent(
            ColliderBuilder::new(SharedShape::halfspace(Vector::Z))
                .friction(FRICTION).friction_combine_rule(CoefficientCombineRule::Max)
                .restitution(e).restitution_combine_rule(CoefficientCombineRule::Max)
                .contact_skin(skin).build(),
            ground, &mut world.bodies,
        );
        (world, body)
    }

    struct Point {
        torque: Vector,
        dist: f64,
        new: bool,
        impulse: f64,
        last_impulse: f64,
    }

    struct Impact {
        step: usize,
        z: f64,
        incoming: Vector,
        incoming_spin: Vector,
        outgoing: Vector,
        outgoing_spin: Vector,
        points: Vec<Point>,
    }

    fn measure(points: usize, clearance: f64, e: f64, skin: f64, params: IntegrationParameters)
        -> (Impact, f64)
    {
        let (mut world, body) = world(points, clearance, e, skin, params);
        let mut impact = None;
        let mut apex: f64 = 0.0;
        let mut rising = false;
        // Four free-fall times cover the descent and the first rise for this matrix.
        let limit = (4.0 * (2.0 * clearance / G).sqrt() / params.dt).ceil() as usize;
        for step in 1..=limit {
            let incoming = world.bodies[body].linvel();
            let incoming_spin = world.bodies[body].angvel();
            world.step();
            let outgoing = world.bodies[body].linvel();
            let z = world.bodies[body].translation().z;
            if impact.is_none() {
                for pair in world.narrow_phase.contact_pairs() {
                    for m in pair.solver_manifolds() {
                        let dynamic_first = m.data.rigid_body1 == Some(body);
                        let normal = if dynamic_first { -m.data.normal } else { m.data.normal };
                        let contacts: Vec<_> = m.data.solver_contacts.iter().map(|c| {
                            let id = c.contact_indices()[0];
                            let data = &m.points[id as usize].data;
                            let arm = if dynamic_first { data.solver_dp1 } else { data.solver_dp2 };
                            Point { torque: arm.cross(normal), dist: c.dist, new: id != c.contact_id[0],
                                    impulse: data.impulse, last_impulse: data.warmstart_impulse }
                        }).collect();
                        if contacts.iter().any(|p| p.impulse > 0.0) {
                            assert_eq!(m.data.restitution, e);
                            impact = Some(Impact { step, z, incoming, incoming_spin, outgoing,
                                outgoing_spin: world.bodies[body].angvel(), points: contacts });
                        }
                    }
                }
            }
            if impact.is_some() && outgoing.z > 0.0 {
                rising = true;
                apex = apex.max(z - HALF.z);
            } else if rising {
                apex = apex.max(z - HALF.z);
                break;
            }
        }
        (impact.expect("drop must transfer a normal impulse"), apex)
    }

    fn engine_parameters() -> IntegrationParameters {
        let brick = body(CollisionShape::Box { half_extents: HALF.to_array() }, "k4");
        let mut sim = Simulation::with_environment(&brick, SimConfig::default(), &ground(0.5),
            [0.0, 0.0, RELEASE_Z]).unwrap();
        sim.world_mut().integration_parameters
    }

    fn show(label: &str, n: usize, clearance: f64, e: f64, skin: f64, p: IntegrationParameters) {
        let (hit, apex) = measure(n, clearance, e, skin, p);
        assert_eq!(hit.points.len(), n, "{label}");
        println!("K4 {label}: n={n} h={:.3} e={e:.1} step={} sep={:.3} vin={:.5} vout={:.5} spin={:.5} apex={:.3} mm ideal={:.3}",
            clearance, hit.step, hit.points[0].dist * 1e3, hit.incoming.z, hit.outgoing.z,
            hit.outgoing_spin.length(), apex * 1e3, e * e * clearance * 1e3);
    }

    #[test]
    #[ignore]
    fn spin_k4_matrix() {
        let engine = engine_parameters();
        let stock = IntegrationParameters::default();
        let h = RELEASE_Z - HALF.z;
        for clearance in [h / 4.0, h, h * 4.0] {
            for e in [0.2, 0.5, 0.8] {
                for n in 1..=4 {
                    show("engine", n, clearance, e, 0.0, engine);
                }
            }
        }
        for (label, p) in [
            ("stock", stock),
            ("stock at 1ms", IntegrationParameters { dt: engine.dt, ..stock }),
            ("stock slop", IntegrationParameters {
                normalized_allowed_linear_error: stock.normalized_allowed_linear_error, ..engine
            }),
            ("stock recycling", IntegrationParameters { contact_recycling: stock.contact_recycling, ..engine }),
            ("Coulomb", IntegrationParameters { friction_model: FrictionModel::Coulomb, ..engine }),
        ] {
            for n in [1, 4] {
                show(label, n, h, 0.5, 0.0, p);
            }
        }
        for n in [1, 4] {
            show("low speed", n, ALLOWED_LINEAR_ERROR_M, 0.5, 0.0, engine);
        }
        // Use zero and the two solver slops as geometric probes, plus the stock prediction.
        for prediction in [0.0, ALLOWED_LINEAR_ERROR_M, stock.normalized_allowed_linear_error,
            stock.normalized_prediction_distance] {
            let p = IntegrationParameters { normalized_prediction_distance: prediction, ..engine };
            for skin in [0.0, ALLOWED_LINEAR_ERROR_M, stock.normalized_allowed_linear_error] {
                show(&format!("prediction={prediction} skin={skin}"), 4, h, 0.5, skin, p);
            }
        }
    }

    #[test]
    #[ignore]
    fn spin_k4_impulse_sweep() {
        let h = RELEASE_Z - HALF.z;
        let e = 0.5;
        let p = engine_parameters();
        let (bounce, apex) = measure(4, h, e, 0.0, p);
        let (inelastic, _) = measure(4, h, 0.0, 0.0, p);
        assert_eq!(bounce.step, inelastic.step);
        assert_eq!(bounce.z, inelastic.z);
        assert_eq!(bounce.incoming, inelastic.incoming);
        assert_eq!(bounce.incoming_spin, inelastic.incoming_spin);

        // Replay the one-body normal rows against the measured pre-restitution state.
        let inertia = principal_inertia();
        let mut v = inelastic.outgoing.z;
        let mut w = inelastic.outgoing_spin;
        let mut impulses: Vec<_> = inelastic.points.iter().map(|p| p.last_impulse).collect();
        let mut deltas = Vec::new();
        let mut residuals = Vec::new();
        for (i, point) in inelastic.points.iter().enumerate() {
            let torque = point.torque;
            let seed = e * (inelastic.incoming.z + torque.dot(inelastic.incoming_spin));
            let inverse_inertia_torque = torque / inertia;
            let inverse_effective_mass = 1.0 / MASS + torque.dot(inverse_inertia_torque);
            let residual = v + torque.dot(w) + seed;
            let updated = if point.new && point.impulse > 0.0 && seed < 0.0 {
                (impulses[i] - residual / inverse_effective_mass).max(0.0)
            } else {
                impulses[i]
            };
            let delta = updated - impulses[i];
            impulses[i] = updated;
            v += delta / MASS;
            w += inverse_inertia_torque * delta;
            deltas.push(delta);
            residuals.push(residual);
        }
        let observed: Vec<_> = bounce.points.iter().zip(&inelastic.points)
            .map(|(b, a)| b.impulse - a.impulse).collect();
        let targets: Vec<_> = inelastic.points.iter()
            .map(|point| -e * (inelastic.incoming.z + point.torque.dot(inelastic.incoming_spin)))
            .collect();
        let solved: Vec<_> = inelastic.points.iter().map(|point| v + point.torque.dot(w)).collect();

        println!("K4 sweep: step={} z={:.9} vin={:.9} pre_vz={:.9} pre_spin={:?}",
            bounce.step, bounce.z, bounce.incoming.z, inelastic.outgoing.z, inelastic.outgoing_spin);
        println!("K4 sweep: torques={:?} pre_impulses={:?}",
            inelastic.points.iter().map(|p| p.torque.to_array()).collect::<Vec<_>>(),
            inelastic.points.iter().map(|p| p.impulse).collect::<Vec<_>>());
        println!("K4 sweep: residuals={residuals:?} predicted_dJ={deltas:?} observed_dJ={observed:?}");
        println!("K4 sweep: target={targets:?} final_point_speeds={solved:?}");
        println!("K4 sweep: predicted_vz={v:.9} actual_vz={:.9} predicted_spin={w:?} actual_spin={:?} ballistic_apex={:.3} mm actual_apex={:.3} mm",
            bounce.outgoing.z, bounce.outgoing_spin, (bounce.z - HALF.z + v * v / (2.0 * G)) * 1e3, apex * 1e3);
        assert!((v - bounce.outgoing.z).abs() < 1e-9);
        assert!((w - bounce.outgoing_spin).length() < 1e-9);
        for (expected, actual) in deltas.iter().zip(observed) {
            assert!((expected - actual).abs() < 1e-9);
        }
    }
}
