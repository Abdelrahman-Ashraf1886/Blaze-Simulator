# K4 flat-box rebound

A 100 × 100 × 40 mm, 1 kg box released with its origin at 0.5 m has 480 mm of fall clearance. At restitution 0.5, a level vertical rebound should reach 120 mm above its resting origin, from $e^2h$. The one-point pyramid uses the same origin, clearance, mass and inertia. The 4.4 result was 65.7 mm for the box and 119.1 mm for the pyramid. [4.4 measurements](../DEVLOG.md#L403-L413) · [Fixture](../../simulation-engine/engine-core/src/environment/spin_study.rs#L18-L45) · [Shapes](../../simulation-engine/engine-core/src/environment/spin_study.rs#L79-L86)

## Solver path

Dependency citations below are relative to the extracted crate directories in `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f`. `Rapier` is `rapier3d-f64-0.36.1` with `enhanced-determinism` and `Parry` is `parry3d-f64-0.31.1`. The local Rapier package lacks `CHANGELOG.md`, so the 0.35 and issue #974 attribution comes from the task. The implementation confirms the current behavior directly. [Cargo pin](../../simulation-engine/engine-core/Cargo.toml#L13) · [Locked Parry version](../../simulation-engine/Cargo.lock#L328)

- **Manifold.** Parry chooses the polygonal support feature facing the half-space and projects each eligible vertex onto the plane. A flat cuboid exposes all four corners. Rapier has four 3D solver slots and preserves a list of four or fewer. For a longer list it takes the deepest point, the eligible point furthest from it, and the extremes across that segment. It sorts the selected points lexicographically in the contact plane before building the solver contacts. Clustering requires multiple manifolds for the pair, so a single box and plane take the ordinary path. `Parry/src/shape/polygonal_feature_map.rs:51–55`, `Parry/src/shape/cuboid.rs:271–387`, `Parry/src/query/contact_manifolds/contact_manifolds_halfspace_pfm.rs:55–78`, `Rapier/src/lib.rs:291`, `Rapier/src/geometry/manifold_reduction.rs:4–83`, `Rapier/src/geometry/narrow_phase/pair_update.rs:470–488,536–617`.
- **Coefficient and threshold.** Rapier picks the combine rule with the higher discriminant. The precedence is GeometricMean > ClampedSum > Max > Multiply > Min > Average. The engine's ground uses Max and the vehicle uses Average with coefficient zero, so the ground's value becomes the manifold's value. For a new point any positive restitution is eligible. For a persisted point restitution must be at least 1. The new flag is set when the tracked impulse is zero. Rapier captures `e * v_normal` at prepare time per point, and the restitution update requires a negative seed and a positive accumulated step impulse. The prepare-time velocity gate is zero closing speed. There is no separate positive minimum impact speed in these paths. `Rapier/src/dynamics/coefficient_combine_rule.rs:38–87`, `Rapier/src/geometry/narrow_phase/pair_update.rs:359–370,530–531,604–608`, `Rapier/src/geometry/contact_pair.rs:918–944`, `Rapier/src/dynamics/solver/contact_constraint/contact_with_twist_friction.rs:215–219,243–274`, `Rapier/src/dynamics/solver/contact_constraint/contact_constraint_element.rs:519–533`. [Engine materials](../../simulation-engine/engine-core/src/environment.rs#L615-L637)
- **Timing.** The substeps use speculative separation and penetration bias. The worker then runs one end-of-step restitution stage after the regular and stabilization iterations. The default 3D simplified friction model uses the twist builder. Its restitution stage, the Coulomb alternative and the generic multibody path each visit the eligible normal rows in sequence. Each row reads the velocities left by the previous row, clamps its updated last-substep normal impulse to be nonnegative, and immediately applies the difference to both linear and angular velocity. Restitution shares a coefficient across the manifold and solves a separate velocity constraint at each point. No second sweep or coupled normal block is run in this stage. `Rapier/src/dynamics/integration_parameters.rs:13–29,433–434`, `Rapier/src/dynamics/solver/staged_island_solver/init.rs:559–561`, `Rapier/src/dynamics/solver/staged_island_solver/worker.rs:713–813`, `Rapier/src/dynamics/solver/contact_constraint/contact_with_twist_friction.rs:477–498,568–597`, `Rapier/src/dynamics/solver/contact_constraint/contact_with_coulomb_friction.rs:504–532`, `Rapier/src/dynamics/solver/contact_constraint/generic_contact_constraint.rs:514–542`, `Rapier/src/dynamics/solver/contact_constraint/generic_contact_constraint_element.rs:534–554`.
- **Skin and prediction.** Parry's candidate distance includes the skins. Rapier subtracts both skins from the geometric separation before checking the prediction margin or the one-step extrapolated separation. Separated solver rows spend their positive separation through the speculative velocity term. The restitution stage still requires actual impulse transfer and uses the same point order. The stock prediction is 20 mm at length unit 1 and the collider default skin is zero. `Rapier/src/geometry/narrow_phase/pair_update.rs:329–355,437–446,579–617`, `Rapier/src/dynamics/integration_parameters.rs:382–383,419–430`, `Rapier/src/geometry/collider.rs:740–758`, `Rapier/src/dynamics/solver/contact_constraint/contact_with_twist_friction.rs:477–498`.

## Why four corners lose about half the rebound

For ground normal $n$, a row at arm $r_i$ has torque axis $t_i = r_i \times n$. Its inverse effective mass is $K_{ii}=1/m+t_i^T I^{-1}t_i$. A normal impulse increment $\Delta J_i$ changes the CoM normal speed by $\Delta J_i/m$, angular velocity by $I^{-1}t_i \Delta J_i$, and any other row's speed by $(1/m+t_j^T I^{-1}t_i)\Delta J_i$. The reference box has $I_x=I_y=(0.1^2+0.04^2)/12$ kg·m², so the diagonal is 6.1724 kg⁻¹, adjacent corners couple at +1 kg⁻¹, and opposite corners couple at −4.1724 kg⁻¹. The first row therefore puts only about one-sixth of its point-speed correction into CoM speed. Subsequent rows change the speeds at the corners already visited. An ordered sweep from zero translation and spin reaches 73.8% of the target CoM speed, or 54.5% of the ballistic height. A centered tip has zero normal lever arm, so one update achieves the target speed. `Rapier/src/dynamics/solver/contact_constraint/contact_with_twist_friction.rs:258–289,577–596`, `Rapier/src/dynamics/solver/contact_constraint/contact_constraint_element.rs:519–533`. [Box inertia](../../simulation-engine/engine-core/src/environment/spin_study.rs#L18-L25)

The paired drops with $e=0$ and $e=0.5$ have the same incoming state and post-impact position on step 313. The $e=0$ velocities give the state immediately before restitution, $v_z=-0.324233352$ m/s and $\omega=(0,-12.784694256,0)$ rad/s. The restitution target at all four corners is +1.529837400 m/s, from the incoming −3.059674800 m/s. All four points pass the impulse gate. Replaying the actual row order and clamp gives these values, in solver order. [Sweep diagnostic](../../simulation-engine/engine-core/src/environment/spin_study.rs#L349-L406) · `Rapier/src/dynamics/solver/contact_constraint/contact_with_twist_friction.rs:800–816`

| Quantity | First | Second | Third | Fourth |
|---|---:|---:|---:|---:|
| Pre-pass normal impulse, N·s | 0.595914 | 0.595914 | 0.776710 | 0.776710 |
| Predicted restitution increment, N·s | 0.403943 | 0.338500 | 0.360192 | 0.356678 |
| Measured restitution increment, N·s | 0.403943 | 0.338500 | 0.360192 | 0.356678 |
| Point normal speed after the sweep, m/s | 0.740322 | 0.383645 | 1.886515 | 1.529837 |

Each impulse increment matches within the diagnostic tolerance of 1e−9 N·s. The last row reaches the target. The previous rows finish with residuals as large as 1.146 m/s. Predicted and actual CoM speed are both +1.135079873 m/s, with angular velocity (3.566777543, −11.461928092, 0) rad/s. Starting from the measured impact height, that CoM speed predicts a 65.818 mm continuous ballistic apex. The stepped result is 65.687 mm. The shortfall comes from the once-through angularly coupled normal solve. Regular stabilization changes its starting state, which explains the modest spread between settings even though the stage runs once in each case.

## Ignored studies

The test uses a Rapier-only world with the engine's gravity along negative Z and the box fixture's friction, mass and inertia. It asserts the active solver point count at the first step that transfers normal impulse. The two-point hull has a centered edge, and the three-point hull has a triangle centered under the CoM. They keep the same nominal bottom and top positions. The matrix uses the production integration parameters read from `Simulation::with_environment`. The 0.120 m and 1.920 m clearances are a quarter and four times the 0.480 m reference. Heights are the first apex of the origin minus its nominal 20 mm resting height. The point locations and moment arms affect the results as well as the point count, which explains why the triangle rebounds higher than the edge and box here. [Setup and measurement](../../simulation-engine/engine-core/src/environment/spin_study.rs#L176-L306) · [Matrix](../../simulation-engine/engine-core/src/environment/spin_study.rs#L309-L345) · [Gravity constant](../../simulation-engine/engine-core/src/math.rs#L14)

| Clearance, m | Restitution | Ideal, mm | 1 point, mm | 2 points, mm | 3 points, mm | 4 points, mm |
|---:|---:|---:|---:|---:|---:|---:|
| 0.120 | 0.2 | 4.800 | 4.734 | 2.187 | 3.422 | 2.607 |
| 0.120 | 0.5 | 30.000 | 29.736 | 13.770 | 21.288 | 16.603 |
| 0.120 | 0.8 | 76.800 | 76.216 | 35.315 | 54.445 | 41.607 |
| 0.480 | 0.2 | 19.200 | 19.016 | 8.802 | 12.690 | 11.551 |
| 0.480 | 0.5 | 120.000 | 119.136 | 55.214 | 82.545 | 65.687 |
| 0.480 | 0.8 | 307.200 | 305.171 | 141.472 | 213.565 | 167.421 |
| 1.920 | 0.2 | 76.800 | 76.461 | 35.429 | 53.323 | 42.532 |
| 1.920 | 0.5 | 480.000 | 478.456 | 221.824 | 337.692 | 259.414 |
| 1.920 | 0.8 | 1228.800 | 1225.218 | 568.121 | 867.506 | 665.312 |

The low-speed probe uses the engine's 0.1 mm slop as the drop clearance. At restitution 0.5 it gives −0.03923 m/s incoming and +0.01961 m/s outgoing for the tip. The box leaves the same step at +0.01428 m/s. Both transfer a bounce impulse at that speed. [Probe](../../simulation-engine/engine-core/src/environment/spin_study.rs#L332-L336)

### Engine overrides and dependency defaults

The engine sets the step to 1 ms, allowed linear error to 0.1 mm and recycling off. Rapier stock uses 1/60 s, 5 mm and recycling on. Both runs here use the same gravity, material and geometry. Changing only the two contact overrides, together or separately at 1 ms, gives the same apex to the printed precision. Coulomb friction takes a separate restitution path and gives the same shortfall. The original engine fixture also reproduces 65.7 mm and 119.1 mm with its shipped settings. [Engine construction](../../simulation-engine/engine-core/src/sim.rs#L27-L49) · [World setup](../../simulation-engine/engine-core/src/sim.rs#L101-L104) · [Contact overrides](../../simulation-engine/engine-core/src/sim.rs#L142-L149) · [Variant inputs](../../simulation-engine/engine-core/src/environment/spin_study.rs#L319-L331) · `Rapier/src/dynamics/integration_parameters.rs:406–435`

| Solver settings, 480 mm clearance and restitution 0.5 | Tip, mm | Box, mm |
|---|---:|---:|
| Engine | 119.136 | 65.687 |
| Rapier stock, 1/60 s | 105.658 | 53.429 |
| Rapier stock, 1 ms | 119.136 | 65.687 |
| Engine with Rapier's 5 mm slop | 119.136 | 65.687 |
| Engine with recycling enabled | 119.136 | 65.687 |
| Engine with Coulomb friction | 119.136 | 65.484 |

### Skin and prediction

Box apex in mm at 480 mm clearance and restitution 0.5. The probes use zero, the engine and Rapier linear slops, and Rapier's default prediction. The reported heights use the geometric plane as reference, so a raised support from a positive skin is included. Zero to 0.1 mm prediction lets the box start impact after overlap, at −0.758 mm without skin, compared with +2.308 mm at 5 to 20 mm. The best result above the plane is 70.645 mm with 5 mm skin, or 65.645 mm above its raised support plane. [Probe inputs](../../simulation-engine/engine-core/src/environment/spin_study.rs#L336-L344)

| Prediction, mm | Skin 0 mm | Skin 0.1 mm | Skin 5 mm |
|---:|---:|---:|---:|
| 0 | 67.386 | 67.400 | 70.645 |
| 0.1 | 67.386 | 67.400 | 70.645 |
| 5 | 65.687 | 65.676 | 39.156 |
| 20 | 65.687 | 65.676 | 39.151 |

## Options and cost

| Option | Scope and cost |
|---|---|
| Adjust configuration | The measured variants do not recover the 120 mm box rebound while preserving the one-point result. Rerunning the 4.4 study across clustering, warm-start, stabilization, PGS and substep variants gives 59.3–71.6 mm for the box and 119.1–119.3 mm for the tip. Four stabilization iterations plus four PGS iterations reduce the inelastic peak spin to 0.090 rad/s and still produce only 64.4 mm of box rebound. The historical 120,000-step resting run took 1.7 s with the shipped setting, 2.7 s with four stabilization iterations and 4.8 s with eight. That is about 14.2, 22.5 and 40.0 µs per step for that workload. [Legacy study settings](../../simulation-engine/engine-core/src/environment/spin_study.rs#L87-L129) · [4.4 timings](../DEVLOG.md#L403-L413) |
| Vendor a minimal Rapier patch | Use a local `[patch.crates-io]` override for `rapier3d-f64`. Preserve the seed and impulse gate, capture the active mask on entry, and run a bounded deterministic repeat of the normal-only restitution sweep for multi-point rigid contacts in both twist and Coulomb builders. Keep the one-point path and the no-seed fast path. Choose the budget from contact-speed residuals and check energy and order sensitivity on oblique impacts, stacks and joints. Each extra sweep costs up to one scalar row update per active point per bouncing manifold. The generic multibody path warrants its own follow-up and tests. No vendor build or timing was done. |
| File an upstream issue | Send the standalone box reproduction below with the point-speed residuals and the one-point control. It gives maintainers a regression fixture for comparing a bounded iterative sweep with a coupled block solve. The issue is drafted here. |
| Keep K4 documented | No runtime or maintenance cost. The ground material still underpredicts flat rebounds in drop tests and flight contact. [Flight follow-ups](../DEVLOG.md#L215-L219) |

Recommend filing the upstream issue and keeping K4 documented while an upstream solver fix is evaluated. No configuration or patch is proposed for shipping from this investigation. There are no candidate-specific hash changes to list. A broad contact configuration change would require rerunning `drop_onto_the_ground_comes_to_rest_at_its_half_height_and_reports_the_contact` (hash `dfe219fa9c21b4bd`), `drop_onto_an_obstacle` (hash `a30649724c1c9d2f`), `restitution_sets_the_rebound_speed_and_height`, and landing/session replay coverage. The fixed Rust hashes are for zero-restitution tests. A restitution-only patch with the existing no-seed fast path should leave those two zero-restitution cases unchanged, which would need verification. [Plane and rebound checks](../../simulation-engine/engine-core/src/environment/tests.rs#L115-L168) · [Obstacle check](../../simulation-engine/engine-core/src/environment/tests.rs#L196-L209) · [Landing replay](../../tests/unit/flight-live.test.ts#L1179-L1221) · [Exact-bit hash scope](../../simulation-engine/engine-core/src/sim.rs#L242-L273)

## Checks

From `simulation-engine` with `CARGO_BUILD_JOBS=1` and `CARGO_NET_OFFLINE=true`:

- `cargo test -p engine-core --release -- --ignored spin` passed with 5 passed and 0 failed, with 267 unit and 2 integration tests filtered out.
- `cargo clippy -p engine-core -- -D warnings` completed with exit code 0.
- The standalone reproduction compiled and ran against the release Rapier artifacts. It printed `First rebound: 65.687 mm (ideal 120 mm)`.

## Upstream issue draft

**3D box on a half-space rebounds to about 55% of the expected height with restitution 0.5**

I can reproduce this with `rapier3d-f64 = "=0.36.1"` and feature `enhanced-determinism`. With 480 mm of fall clearance, the expected rebound is about 120 mm. The box reaches about 66 mm and acquires pitch and roll on the first impact. Replacing the box with a centered point support while retaining its mass and inertia gives about 119 mm. The four corner impulses and the resulting velocity match a single sequential restitution sweep. Could the end-of-step pass iterate or solve the coupled normal rows for a multi-point impact?

In a Rust binary, put `rapier3d-f64 = { version = "=0.36.1", features = ["enhanced-determinism"] }` under `[dependencies]` and use the following `main.rs`:

```rust
use rapier3d_f64::prelude::*;

fn main() {
    let half = Vector::new(0.05, 0.05, 0.02);
    let mut world = PhysicsWorld::new();
    world.gravity = -Vector::Z * 9.80665;
    world.integration_parameters.dt = 0.001;

    let shape = SharedShape::cuboid(half.x, half.y, half.z);
    let density = 1.0 / (8.0 * half.x * half.y * half.z);
    let mass = MassProperties::new(Vector::ZERO, 1.0, shape.mass_properties(density).principal_inertia());
    let (body, _) = world.insert(
        RigidBodyBuilder::dynamic().translation(Vector::Z * 0.5).can_sleep(false),
        ColliderBuilder::new(shape).mass_properties(mass).friction(0.0),
    );
    world.bodies[body].recompute_mass_properties_from_colliders(&world.colliders);
    world.insert(
        RigidBodyBuilder::fixed(),
        ColliderBuilder::new(SharedShape::halfspace(Vector::Z))
            .friction(0.5)
            .friction_combine_rule(CoefficientCombineRule::Max)
            .restitution(0.5)
            .restitution_combine_rule(CoefficientCombineRule::Max),
    );

    let mut rising = false;
    let mut apex: f64 = 0.0;
    let fall_time = (2.0 * (0.5 - half.z) / -world.gravity.z).sqrt();
    for _ in 0..(4.0 * fall_time / world.integration_parameters.dt).ceil() as usize {
        world.step();
        let rb = &world.bodies[body];
        if rb.linvel().z > 0.0 {
            rising = true;
        }
        if rising {
            apex = apex.max(rb.translation().z - half.z);
            if rb.linvel().z <= 0.0 {
                break;
            }
        }
    }
    println!("First rebound: {:.3} mm (ideal 120 mm)", apex * 1000.0);
}
```
