//! Deterministic fixed-step rigid-body simulation of one vehicle (ADR 0005).
//!
//! rapier integrates the motion and (from 4.4) resolves contacts. Every force
//! and torque other than gravity comes from our code through [`BodyInput`].
//!
//! - Fixed step: `dt` (default 1 ms) never varies during a run, so a run is
//!   a pure function of the vehicle, the config and the input sequence.
//! - Gravity: (0, 0, −g) in the world frame, g = 9.80665 m/s², the standard
//!   acceleration of gravity (3rd CGPM, 1901; ISO 80000-3:2019, item 3-9.2).
//! - Inputs are body-frame and held constant over a step (zero-order hold):
//!   the force acts at the CoM and is rotated to the world frame with the
//!   attitude at the start of the step, F_w = R·F_b, τ_w = R·τ_b.
//! - Gyroscopic torque −ω×(Iω): rapier applies it itself (enabled by default
//!   for every dynamic body). The spike `spikes::gyroscopic_term_*` checks this
//!   against conservation of angular momentum, so we do not add it again.
//! - rapier integrates with symplectic (semi-implicit) Euler:
//!   v ← v + a·dt, then x ← x + v·dt. The analytical tests below state the
//!   resulting error bounds.

use crate::environment::{ContactEvent, Environment, Placed};
use crate::math::STANDARD_GRAVITY;
use crate::vehicle::{arr, inertia_matrix, Vehicle};
use rapier3d_f64::math::{Matrix, Vector};
use rapier3d_f64::prelude::{PhysicsWorld, RigidBodyHandle};
use serde::Serialize;

/// Default fixed step, s (plan: rapier at 1 ms, controller at 1 kHz).
pub const DEFAULT_DT_S: f64 = 1e-3;

/// Contact solver: penetration rapier leaves uncorrected, m. rapier's default
/// is 5 mm (`normalized_allowed_linear_error` 0.005 × `length_unit` 1), the
/// scale of a game object; a drone's skids are a few mm, so 0.1 mm is used.
/// A numerical tolerance of the solver, not a physical value; the drop test
/// states the resting error it gives.
pub const ALLOWED_LINEAR_ERROR_M: f64 = 1e-4;

/// A vehicle may start touching the ground or an obstacle, but not inside it
/// by more than this (m): rapier would push it out violently.
pub const START_PENETRATION_TOLERANCE_M: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SimConfig {
    pub dt_s: f64,
    pub gravity_mps2: f64,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self { dt_s: DEFAULT_DT_S, gravity_mps2: STANDARD_GRAVITY }
    }
}

/// External loads for one step, in body axes.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BodyInput {
    /// Force through the CoM, N.
    pub force_body_n: Vector,
    /// Torque about the CoM, N·m.
    pub torque_body_nm: Vector,
}

/// Snapshot of the vehicle's motion, world frame unless stated.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimState {
    pub steps: u64,
    /// steps × dt (a product, not a running sum).
    pub time_s: f64,
    /// Body origin (frame centre), m.
    pub position_m: [f64; 3],
    /// Attitude, body → world, x y z w.
    pub quaternion: [f64; 4],
    pub com_m: [f64; 3],
    /// Velocity of the CoM, m/s.
    pub linear_velocity_mps: [f64; 3],
    pub angular_velocity_radps: [f64; 3],
    pub angular_velocity_body_radps: [f64; 3],
}

pub struct Simulation {
    world: PhysicsWorld,
    body: RigidBodyHandle,
    /// Inertia about the CoM in body axes (our recomputation).
    inertia_body: Matrix,
    config: SimConfig,
    steps: u64,
    /// Ground, obstacles and the contact log; None for free space (`Simulation::new`).
    env: Option<Placed>,
}

impl Simulation {
    /// Starts from rest at the world origin with identity attitude.
    /// Fails if `dt` or `g` is not a finite positive / non-negative number.
    pub fn new(vehicle: &Vehicle, config: SimConfig) -> Result<Simulation, String> {
        if !(config.dt_s.is_finite() && config.dt_s > 0.0) {
            return Err(format!("dt must be a positive number of seconds (got {})", config.dt_s));
        }
        if !(config.gravity_mps2.is_finite() && config.gravity_mps2 >= 0.0) {
            return Err(format!("gravity must be finite and not negative (got {})", config.gravity_mps2));
        }
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::new(0.0, 0.0, -config.gravity_mps2);
        world.integration_parameters.dt = config.dt_s;
        let body = vehicle.build_body(&mut world.bodies, &mut world.colliders);
        Ok(Simulation {
            world,
            body,
            inertia_body: inertia_matrix(vehicle.totals.inertia),
            config,
            steps: 0,
            env: None,
        })
    }

    /// Starts from rest with identity attitude and the body origin at
    /// `start_m` (world frame), in `env` (ground plane or terrain, and
    /// obstacles). Fails if a part starts inside the environment, naming it.
    pub fn with_environment(vehicle: &Vehicle, config: SimConfig, env: &Environment, start_m: [f64; 3]) -> Result<Simulation, String> {
        Self::with_start_clearance(vehicle, config, env, start_m, None)
    }

    /// With a clearance, use the given XY and derive the start Z from the ground.
    pub fn with_start_clearance(
        vehicle: &Vehicle,
        config: SimConfig,
        env: &Environment,
        mut start_m: [f64; 3],
        clearance_m: Option<f64>,
    ) -> Result<Simulation, String> {
        if let Some(clearance) = clearance_m {
            if !clearance.is_finite() || clearance < 0.0 {
                return Err("startClearanceM must be finite and non-negative".into());
            }
            start_m[2] = 0.0;
        }
        if !start_m.iter().all(|x| x.is_finite()) {
            return Err("the start position must be finite".into());
        }
        if env.ground.is_some() && env.terrain.is_some() {
            return Err("environment.terrain cannot be supplied with a ground plane".into());
        }
        let mut sim = Simulation::new(vehicle, config)?;
        sim.world.integration_parameters.normalized_allowed_linear_error = ALLOWED_LINEAR_ERROR_M;
        // Contact distances must be current every step for the contact log (environment.rs).
        sim.world.integration_parameters.contact_recycling = false;
        let rb = &mut sim.world.bodies[sim.body];
        rb.set_translation(Vector::new(start_m[0], start_m[1], start_m[2]), true);
        let ids = vehicle.definition.parts.iter().map(|p| p.part_id.clone()).collect();
        let placed = Placed::insert(env, &mut sim.world, sim.body, ids);
        // Colliders follow their body only after a step; place them now for the start check.
        sim.world.bodies.propagate_modified_body_positions_to_colliders(&mut sim.world.colliders);
        if let Some(clearance) = clearance_m {
            start_m[2] = placed.ground_start_z(&sim.world, sim.body)? + clearance;
            if !start_m[2].is_finite() {
                return Err("startClearanceM yields a non-finite start height".into());
            }
            sim.world.bodies[sim.body].set_translation(Vector::from_array(start_m), true);
            sim.world.bodies.propagate_modified_body_positions_to_colliders(&mut sim.world.colliders);
            if clearance == 0.0 && !placed.initial_ground_contact(&sim.world, sim.body) {
                return Err("startClearanceM could not place the vehicle within the ground contact tolerance".into());
            }
        }
        let inside = placed.initial_penetrations(&sim.world, sim.body, env.terrain.as_ref(), START_PENETRATION_TOLERANCE_M);
        if !inside.is_empty() {
            let list: Vec<String> =
                inside.iter().map(|(p, o, d)| format!("{p} is {:.3} mm inside the {}", d * 1000.0, o.replace(':', " "))).collect();
            return Err(format!("the vehicle starts inside the environment: {}; raise the start position", list.join("; ")));
        }
        sim.env = Some(placed);
        Ok(sim)
    }

    /// Ground plane or terrain height at world (x, y), in metres. Excludes obstacles.
    pub fn height_below(&self, x_m: f64, y_m: f64) -> Option<f64> {
        self.env.as_ref().and_then(|env| env.height_below(x_m, y_m))
    }

    pub(crate) fn initial_ground_contact(&self) -> bool {
        self.env.as_ref().is_some_and(|env| env.initial_ground_contact(&self.world, self.body))
    }

    /// Contacts with the environment so far (open ones have no end), and how
    /// many were dropped beyond `MAX_CONTACT_EVENTS`.
    pub fn contacts(&self) -> (Vec<ContactEvent>, u64) {
        self.env.as_ref().map_or((Vec::new(), 0), Placed::events)
    }

    pub fn touching_ground(&self) -> bool {
        self.env.as_ref().is_some_and(Placed::touching_ground)
    }

    pub fn config(&self) -> SimConfig {
        self.config
    }

    /// Advances one fixed step with `input` held constant over it.
    pub fn step(&mut self, input: &BodyInput) {
        let rb = &mut self.world.bodies[self.body];
        let r = *rb.rotation();
        rb.reset_forces(false);
        rb.reset_torques(false);
        rb.add_force(r * input.force_body_n, true);
        rb.add_torque(r * input.torque_body_nm, true);
        self.world.step();
        self.steps += 1;
        if let Some(env) = &mut self.env {
            env.record(&self.world, (self.steps - 1) as f64 * self.config.dt_s);
        }
    }

    pub fn state(&self) -> SimState {
        let rb = &self.world.bodies[self.body];
        let q = *rb.rotation();
        let w = rb.angvel();
        SimState {
            steps: self.steps,
            time_s: self.steps as f64 * self.config.dt_s,
            position_m: arr(rb.translation()),
            quaternion: [q.x, q.y, q.z, q.w],
            com_m: arr(rb.center_of_mass()),
            linear_velocity_mps: arr(rb.linvel()),
            angular_velocity_radps: arr(w),
            angular_velocity_body_radps: arr(q.inverse() * w),
        }
    }

    /// Angular momentum about the CoM in the world frame:
    /// L = R I_b Rᵀ ω, with I_b our inertia about the CoM in body axes.
    pub fn angular_momentum_world(&self) -> Vector {
        let rb = &self.world.bodies[self.body];
        let r = Matrix::from_quat(*rb.rotation());
        r * self.inertia_body * r.transpose() * rb.angvel()
    }

    /// Rotational kinetic energy ½ ωᵀ I ω, J.
    pub fn rotational_energy(&self) -> f64 {
        let rb = &self.world.bodies[self.body];
        let wb = rb.rotation().inverse() * rb.angvel();
        0.5 * wb.dot(self.inertia_body * wb)
    }

    /// State hash: 64-bit FNV-1a over the step count and the exact bit
    /// patterns (`f64::to_bits`, little endian) of position, attitude
    /// quaternion, linear and angular velocity. Equal hashes mean
    /// bit-identical states (up to 64-bit collisions); any change of any bit
    /// changes the hash with overwhelming probability.
    pub fn state_hash(&self) -> u64 {
        self.state_hash_with(&[])
    }

    /// `state_hash` with further 64-bit words (e.g. rotor speeds, `flight.rs`)
    /// written after the body state; no extra words gives `state_hash`.
    pub fn state_hash_with(&self, extra: &[u64]) -> u64 {
        let rb = &self.world.bodies[self.body];
        let q = rb.rotation();
        let (p, v, w) = (rb.translation(), rb.linvel(), rb.angvel());
        let values = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z];
        let mut h = Fnv1a::new();
        h.write(&self.steps.to_le_bytes());
        for x in values {
            h.write(&x.to_bits().to_le_bytes());
        }
        for w in extra {
            h.write(&w.to_le_bytes());
        }
        h.finish()
    }

    #[cfg(test)]
    pub(crate) fn set_velocity(&mut self, linear_world: Vector, angular_body: Vector) {
        let rb = &mut self.world.bodies[self.body];
        let r = *rb.rotation();
        rb.set_linvel(linear_world, true);
        rb.set_angvel(r * angular_body, true);
    }

    /// The rapier world, for measurements in tests.
    #[cfg(test)]
    pub(crate) fn world_mut(&mut self) -> &mut PhysicsWorld {
        &mut self.world
    }

    #[cfg(test)]
    pub(crate) fn enable_rapier_gyroscopic_term(&mut self, enabled: bool) {
        self.world.bodies[self.body].enable_gyroscopic_forces(enabled);
    }
}

/// Formats a state hash as 16 lower-case hex digits.
pub fn hash_hex(h: u64) -> String {
    format!("{h:016x}")
}

/// 64-bit FNV-1a (Fowler–Noll–Vo), offset basis 0xcbf29ce484222325,
/// prime 0x100000001b3. Not cryptographic; used only to compare states.
struct Fnv1a(u64);

impl Fnv1a {
    fn new() -> Self {
        Fnv1a(0xcbf2_9ce4_8422_2325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[test]
fn placed_height_matches_the_environment_query() {
    use crate::vehicle::fixtures::{box_part, with_totals};
    use serde_json::json;

    let v = Vehicle::from_definition(with_totals(vec![
        box_part("body", 1.0, [0.0; 3], [1.0, 1.0, 1.0, 0.0, 0.0, 0.0]),
    ])).unwrap();
    let config = SimConfig::default();
    assert_eq!(Simulation::new(&v, config).unwrap().height_below(12.0, 22.0), None);
    // Grid and queries from environment/tests.rs:243-256.
    let terrain = json!({
        "rows": 2, "columns": 2, "cellSizeM": 2.0, "cornerM": [10.0, 20.0],
        "heightsM": [2.0, 8.0, 0.0, 4.0], "friction": 0.5, "restitution": 0
    });
    // The table from environment/tests.rs:196-202, moved underneath the centre query.
    let table = json!({
        "id": "table", "center": [12, 22, 0.05], "halfExtents": [0.3, 0.3, 0.05],
        "quaternion": [0, 0, 0, 1], "friction": 0.6, "restitution": 0
    });
    for definition in [
        json!({"terrain": terrain, "obstacles": []}),
        json!({"ground": {"friction": 0.5, "restitution": 0}, "obstacles": [table]}),
        json!({"ground": null, "obstacles": [table]}),
    ] {
        let env = Environment::from_json(&definition).unwrap();
        let sim = Simulation::with_environment(&v, config, &env, [12.0, 22.0, 10.0]).unwrap();
        for (x, y) in [(11.0, 21.0), (12.0, 22.0), (13.0, 23.0), (10.0, 20.0), (f64::NAN, 21.0)] {
            assert_eq!(sim.height_below(x, y), env.height_below(x, y));
        }
    }
}
