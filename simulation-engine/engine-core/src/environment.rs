//! The world around the vehicle: a ground plane and box obstacles (4.4).
//!
//! - **Ground**: the plane z = 0 (world frame, +Z up), solid below. Optional:
//!   `"ground": null` is free space, which the analytical tests use.
//! - **Obstacles**: fixed boxes, each with a centre, half extents and attitude.
//! - **Friction and restitution** of the ground and of every obstacle are the
//!   user's inputs. No source states them for a given surface, so nothing
//!   here has a default: a missing value refuses the environment, saying
//!   which one.
//!
//! How the entered values reach rapier
//! - rapier combines the coefficients of the two colliders in a contact with a
//!   rule; when the rules differ, the one with the higher priority wins
//!   (rapier 0.36.1 `CoefficientCombineRule`: GeometricMean > ClampedSum >
//!   Max > Multiply > Min > Average).
//! - Vehicle colliders get friction 0 and restitution 0 with the default
//!   rule (Average); environment colliders carry the entered values with the
//!   rule Max. A contact therefore uses max(0, entered) = the entered value
//!   exactly: the entered coefficient is the coefficient of the pair
//!   (vehicle against that surface), not of the surface alone.
//!
//! Contacts
//! - A vehicle part touches the ground or an obstacle when one of the pair's
//!   contact points is within the solver's allowed error of touching
//!   (distance ≤ `ALLOWED_LINEAR_ERROR_M`, 0.1 mm): rapier's speculative
//!   contacts stop a falling part at a gap of up to that, not at exactly 0.
//!   rapier's own "active contact" starts at its prediction distance
//!   (20 mm), which would report a landing ~5 ms early, so it is not used.
//! - The distances are those of the narrow phase at the start of each step,
//!   with rapier's contact recycling off (`Simulation::with_environment`):
//!   recycled pairs keep distances up to 50 mm stale.
//! - A contact event runs from the first state found touching to the first
//!   found apart; each is timed at that state (the start of the step whose
//!   narrow phase saw it), so within one step after the true instant.
//! - At most [`MAX_CONTACT_EVENTS`] events are kept per run; later ones are
//!   counted as dropped.
//!
//! Known limitation (measured, `environment/spin_study.rs`; rapier 0.36.1)
//! - A flat box landing on four corners gets unequal corner impulses (the two
//!   pairs differ by 1.30×) and a brief spin, peaking at 12.8 rad/s with
//!   restitution 0. It lands back flat and comes to rest (tested).
//! - With restitution 0.5 the spin takes energy from the bounce: the box rises
//!   65.7 mm, not e²·h = 120 mm. A single contact point (a pyramid on its apex)
//!   rises 119.1 mm, so restitution itself is right.
//! - Four or eight contact-stabilization iterations make the corners equal
//!   (1.01×) and cut the dead-landing spin to 1.2 rad/s, but do not fix the
//!   bounce (64.7 mm), and they make a contact step 1.6× to 2.9× slower (a
//!   120 000-step resting run: 2.7 s and 4.8 s against 1.7 s). Not applied.

use crate::sim::ALLOWED_LINEAR_ERROR_M;
use rapier3d_f64::math::{Pose, Rotation, Vector};

use rapier3d_f64::parry::query;
use rapier3d_f64::prelude::{
    CoefficientCombineRule, ColliderBuilder, ColliderHandle, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, SharedShape,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Upper bound on the contact events one run reports (a resting vehicle on a
/// hard limit cycle could otherwise produce one per step).
pub const MAX_CONTACT_EVENTS: usize = 10_000;

/// A contact pair coefficient pair, both the user's entries.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Surface {
    /// Coulomb friction coefficient, ≥ 0.
    pub friction: f64,
    /// Coefficient of restitution, 0 (no bounce) to 1.
    pub restitution: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Obstacle {
    pub id: String,
    /// World frame, m.
    pub center: [f64; 3],
    pub half_extents: [f64; 3],
    /// x y z w, unit.
    pub quaternion: [f64; 4],
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Environment {
    /// None: no ground (free space).
    pub ground: Option<Surface>,
    pub obstacles: Vec<Obstacle>,
}

/// One reason an environment was refused; `path` points into the JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvironmentError {
    pub path: String,
    pub message: String,
}

fn err(path: impl Into<String>, message: impl Into<String>) -> EnvironmentError {
    EnvironmentError { path: path.into(), message: message.into() }
}

fn number(obj: &Map<String, Value>, path: &str, key: &str, errors: &mut Vec<EnvironmentError>) -> Option<f64> {
    match obj.get(key) {
        None | Some(Value::Null) => {
            errors.push(err(format!("{path}.{key}"), "not set: enter it (no default is assumed)"));
            None
        }
        Some(v) => match v.as_f64() {
            Some(x) if x.is_finite() => Some(x),
            _ => {
                errors.push(err(format!("{path}.{key}"), "must be a finite number"));
                None
            }
        },
    }
}

fn array<const N: usize>(obj: &Map<String, Value>, path: &str, key: &str, errors: &mut Vec<EnvironmentError>) -> Option<[f64; N]> {
    let p = format!("{path}.{key}");
    let Some(Value::Array(items)) = obj.get(key) else {
        errors.push(err(p, format!("must be an array of {N} numbers")));
        return None;
    };
    let nums: Vec<f64> = items.iter().filter_map(Value::as_f64).filter(|x| x.is_finite()).collect();
    if items.len() != N || nums.len() != N {
        errors.push(err(p, format!("must be an array of {N} finite numbers")));
        return None;
    }
    let mut out = [0.0; N];
    out.copy_from_slice(&nums);
    Some(out)
}

fn surface(obj: &Map<String, Value>, path: &str, errors: &mut Vec<EnvironmentError>) -> Option<Surface> {
    let friction = number(obj, path, "friction", errors);
    let restitution = number(obj, path, "restitution", errors);
    if let Some(f) = friction {
        if f < 0.0 {
            errors.push(err(format!("{path}.friction"), "cannot be negative"));
        }
    }
    if let Some(e) = restitution {
        if !(0.0..=1.0).contains(&e) {
            errors.push(err(format!("{path}.restitution"), "must be between 0 and 1"));
        }
    }
    Some(Surface { friction: friction?, restitution: restitution? })
}

fn unknown_keys(obj: &Map<String, Value>, path: &str, allowed: &[&str], errors: &mut Vec<EnvironmentError>) {
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            errors.push(err(format!("{path}.{k}"), "unknown field"));
        }
    }
}

impl Environment {
    /// Reads and checks an environment; returns every problem, not just the first.
    ///
    /// `{"ground": {"friction": μ, "restitution": e} | null,
    ///   "obstacles": [{"id", "center", "halfExtents", "quaternion", "friction", "restitution"}]}`
    pub fn from_json(value: &Value) -> Result<Environment, Vec<EnvironmentError>> {
        let mut errors = Vec::new();
        let Value::Object(root) = value else {
            return Err(vec![err("environment", "must be an object with `ground` and `obstacles`")]);
        };
        unknown_keys(root, "environment", &["ground", "obstacles"], &mut errors);
        let ground = match root.get("ground") {
            None => {
                errors.push(err("environment.ground", "not set: give the ground's friction and restitution, or null for no ground"));
                None
            }
            Some(Value::Null) => None,
            Some(Value::Object(g)) => {
                unknown_keys(g, "environment.ground", &["friction", "restitution"], &mut errors);
                surface(g, "environment.ground", &mut errors)
            }
            Some(_) => {
                errors.push(err("environment.ground", "must be an object or null"));
                None
            }
        };
        let mut obstacles = Vec::new();
        match root.get("obstacles") {
            Some(Value::Array(items)) => {
                let mut ids = std::collections::HashSet::new();
                for (i, item) in items.iter().enumerate() {
                    let path = format!("environment.obstacles[{i}]");
                    let Value::Object(o) = item else {
                        errors.push(err(path, "must be an object"));
                        continue;
                    };
                    unknown_keys(o, &path, &["id", "center", "halfExtents", "quaternion", "friction", "restitution"], &mut errors);
                    let id = match o.get("id").and_then(Value::as_str) {
                        Some(s) if !s.is_empty() => s.to_string(),
                        _ => {
                            errors.push(err(format!("{path}.id"), "must be a non-empty string"));
                            String::new()
                        }
                    };
                    if !id.is_empty() && !ids.insert(id.clone()) {
                        errors.push(err(format!("{path}.id"), "is used by another obstacle"));
                    }
                    let center = array::<3>(o, &path, "center", &mut errors);
                    let half = array::<3>(o, &path, "halfExtents", &mut errors);
                    let q = array::<4>(o, &path, "quaternion", &mut errors);
                    if let Some(h) = half {
                        if h.iter().any(|x| *x <= 0.0) {
                            errors.push(err(format!("{path}.halfExtents"), "must all be positive"));
                        }
                    }
                    if let Some(q) = q {
                        let n = q.iter().map(|x| x * x).sum::<f64>().sqrt();
                        if (n - 1.0).abs() > 1e-9 {
                            errors.push(err(format!("{path}.quaternion"), format!("must be a unit quaternion (|q| = {n})")));
                        }
                    }
                    let s = surface(o, &path, &mut errors);
                    if let (Some(center), Some(half_extents), Some(quaternion), Some(surface)) = (center, half, q, s) {
                        obstacles.push(Obstacle { id, center, half_extents, quaternion, surface });
                    }
                }
            }
            None => errors.push(err("environment.obstacles", "not set: give a list (it may be empty)")),
            Some(_) => errors.push(err("environment.obstacles", "must be an array")),
        }
        if errors.is_empty() {
            Ok(Environment { ground, obstacles })
        } else {
            Err(errors)
        }
    }
}

/// What a vehicle part touched.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Object {
    Ground,
    Obstacle(String),
}

impl Object {
    /// "ground" or "obstacle:<id>".
    pub fn label(&self) -> String {
        match self {
            Object::Ground => "ground".into(),
            Object::Obstacle(id) => format!("obstacle:{id}"),
        }
    }
}

/// One contact between a vehicle part and the environment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactEvent {
    pub part_id: String,
    /// "ground" or "obstacle:<id>".
    pub with: String,
    pub start_s: f64,
    /// None: still touching at the end of the run.
    pub end_s: Option<f64>,
}

/// The environment inserted into a world, and the running contact log.
pub struct Placed {
    /// Environment colliders in insertion order (a few; looked up linearly).
    objects: Vec<(ColliderHandle, Object)>,
    /// Part index → part id (collider user_data is the index, see `Vehicle::build_body`).
    part_ids: Vec<String>,
    open: BTreeMap<(usize, Object), f64>,
    events: Vec<ContactEvent>,
    dropped: u64,
}

impl Placed {
    /// Adds the ground and obstacles as fixed bodies, and sets the vehicle's
    /// colliders to friction and restitution 0 (see the module docs).
    pub fn insert(env: &Environment, world: &mut PhysicsWorld, vehicle: RigidBodyHandle, part_ids: Vec<String>) -> Placed {
        let handles: Vec<ColliderHandle> = world.bodies[vehicle].colliders().to_vec();
        for h in handles {
            let c = &mut world.colliders[h];
            c.set_friction(0.0);
            c.set_restitution(0.0);
            c.set_friction_combine_rule(CoefficientCombineRule::Average);
            c.set_restitution_combine_rule(CoefficientCombineRule::Average);
        }
        let mut objects = Vec::new();
        let with = |b: ColliderBuilder, s: &Surface| {
            b.friction(s.friction)
                .restitution(s.restitution)
                .friction_combine_rule(CoefficientCombineRule::Max)
                .restitution_combine_rule(CoefficientCombineRule::Max)
                .build()
        };
        if let Some(g) = &env.ground {
            let body = world.bodies.insert(RigidBodyBuilder::fixed().build());
            let c = with(ColliderBuilder::new(SharedShape::halfspace(Vector::Z)), g);
            let h = world.colliders.insert_with_parent(c, body, &mut world.bodies);
            objects.push((h, Object::Ground));
        }
        for o in &env.obstacles {
            let [x, y, z, w] = o.quaternion;
            let pose = Pose::from_parts(Vector::new(o.center[0], o.center[1], o.center[2]), Rotation::from_xyzw(x, y, z, w).normalize());
            let body = world.bodies.insert(RigidBodyBuilder::fixed().pose(pose).build());
            let [hx, hy, hz] = o.half_extents;
            let h = world.colliders.insert_with_parent(with(ColliderBuilder::cuboid(hx, hy, hz), &o.surface), body, &mut world.bodies);
            objects.push((h, Object::Obstacle(o.id.clone())));
        }
        Placed { objects, part_ids, open: BTreeMap::new(), events: Vec::new(), dropped: 0 }
    }

    /// Vehicle parts that start inside the ground or an obstacle, deeper than
    /// `tolerance_m`: (part id, object label, depth m).
    pub fn initial_penetrations(&self, world: &PhysicsWorld, vehicle: RigidBodyHandle, tolerance_m: f64) -> Vec<(String, String, f64)> {
        let mut out = Vec::new();
        for &vh in world.bodies[vehicle].colliders() {
            let v = &world.colliders[vh];
            for (eh, object) in &self.objects {
                let e = &world.colliders[*eh];
                // The environment shape goes first: parry 0.31.1 mis-places a half-space given second.
                if let Ok(Some(c)) = query::contact(e.position(), e.shape(), v.position(), v.shape(), 0.0) {
                    if -c.dist > tolerance_m {
                        out.push((self.part_ids[v.user_data as usize].clone(), object.label(), -c.dist));
                    }
                }
            }
        }
        out
    }

    /// Updates the contact log after a step; `time_s` is the time at its start,
    /// the state the step's narrow phase saw.
    pub fn record(&mut self, world: &PhysicsWorld, time_s: f64) {
        let mut touching: Vec<(usize, Object)> = Vec::new();
        for pair in world.narrow_phase.contact_pairs() {
            if !pair.manifolds().iter().any(|m| m.points.iter().any(|p| p.dist <= ALLOWED_LINEAR_ERROR_M)) {
                continue;
            }
            let (a, b) = (pair.collider1, pair.collider2);
            let find = |h: ColliderHandle| self.objects.iter().find(|(x, _)| *x == h).map(|(_, o)| o);
            let (part, object) = match (find(a), find(b)) {
                (Some(o), None) => (b, o),
                (None, Some(o)) => (a, o),
                _ => continue,
            };
            touching.push((world.colliders[part].user_data as usize, object.clone()));
        }
        touching.sort();
        touching.dedup();
        for key in &touching {
            self.open.entry(key.clone()).or_insert(time_s);
        }
        let ended: Vec<(usize, Object)> = self.open.keys().filter(|k| touching.binary_search(k).is_err()).cloned().collect();
        for key in ended {
            let start = self.open.remove(&key).expect("listed above");
            self.push(&key, start, Some(time_s));
        }
    }

    fn push(&mut self, (part, object): &(usize, Object), start_s: f64, end_s: Option<f64>) {
        if self.events.len() >= MAX_CONTACT_EVENTS {
            self.dropped += 1;
            return;
        }
        self.events.push(ContactEvent { part_id: self.part_ids[*part].clone(), with: object.label(), start_s, end_s });
    }

    pub fn touching_ground(&self) -> bool {
        self.open.keys().any(|(_, object)| matches!(object, Object::Ground))
    }

    /// Every event so far, open ones with `end_s = None`, ordered by start time; and the number dropped.
    pub fn events(&self) -> (Vec<ContactEvent>, u64) {
        let mut all = self.events.clone();
        let mut dropped = self.dropped;
        for (key, &start) in &self.open {
            if all.len() >= MAX_CONTACT_EVENTS {
                dropped += 1;
                continue;
            }
            all.push(ContactEvent { part_id: self.part_ids[key.0].clone(), with: key.1.label(), start_s: start, end_s: None });
        }
        all.sort_by(|a, b| a.start_s.total_cmp(&b.start_s).then_with(|| a.part_id.cmp(&b.part_id)).then_with(|| a.with.cmp(&b.with)));
        (all, dropped)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod spin_study;
