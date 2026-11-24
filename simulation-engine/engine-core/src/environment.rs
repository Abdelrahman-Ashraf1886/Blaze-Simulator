//! The world around the vehicle: ground and fixed obstacles.
//!
//! - **Ground**: either the solid plane z = 0 (world frame, +Z up) or an
//!   imported heightfield surface. Both may be absent.
//! - **Obstacles**: fixed boxes, cylinders and convex hulls with a centre and attitude.
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

use crate::sim::{ALLOWED_LINEAR_ERROR_M, START_PENETRATION_TOLERANCE_M};
use rapier3d_f64::math::{Pose, Rotation, Vector};

use rapier3d_f64::parry::{bounding_volume::BoundingVolume, query::{self, PointQueryWithLocation}, utils::Array2};
use rapier3d_f64::prelude::{
    CoefficientCombineRule, Collider, ColliderBuilder, ColliderHandle, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, SharedShape,
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
    #[serde(flatten)]
    pub shape: ObstacleShape,
    /// x y z w, unit.
    pub quaternion: [f64; 4],
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ObstacleShape {
    Box { half_extents: [f64; 3] },
    /// Axis = the obstacle frame's Z.
    Cylinder { radius: f64, height: f64 },
    /// Points in the obstacle frame.
    Hull { points: Vec<[f64; 3]> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Terrain {
    rows: usize,
    columns: usize,
    cell_size_m: f64,
    corner_m: [f64; 2],
    heights_m: Vec<f64>,
    surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Environment {
    pub ground: Option<Surface>,
    pub terrain: Option<Terrain>,
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
    finite_array(items).or_else(|| {
        errors.push(err(p, format!("must be an array of {N} finite numbers")));
        None
    })
}

fn finite_array<const N: usize>(items: &[Value]) -> Option<[f64; N]> {
    let items: &[Value; N] = items.try_into().ok()?;
    let mut values = [0.0; N];
    for (value, item) in values.iter_mut().zip(items) {
        *value = item.as_f64().filter(|x| x.is_finite())?;
    }
    Some(values)
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

fn positive_number(obj: &Map<String, Value>, path: &str, key: &str, errors: &mut Vec<EnvironmentError>) -> Option<f64> {
    let value = number(obj, path, key, errors)?;
    if value <= 0.0 {
        errors.push(err(format!("{path}.{key}"), "must be positive"));
        return None;
    }
    Some(value)
}

impl Terrain {
    fn from_json(obj: &Map<String, Value>, errors: &mut Vec<EnvironmentError>) -> Option<Self> {
        let path = "environment.terrain";
        unknown_keys(obj, path, &["rows", "columns", "cellSizeM", "cornerM", "heightsM", "friction", "restitution"], errors);
        let mut dimension = |key| {
            let n = number(obj, path, key, errors)?;
            if n.fract() != 0.0 || n < 2.0 || n >= usize::MAX as f64 {
                errors.push(err(format!("{path}.{key}"), "must be a supported integer of at least 2"));
                return None;
            }
            Some(n as usize)
        };
        let rows = dimension("rows");
        let columns = dimension("columns");
        let cell_size_m = positive_number(obj, path, "cellSizeM", errors);
        let corner_m = array::<2>(obj, path, "cornerM", errors);
        let surface = surface(obj, path, errors);
        let Some(items) = obj.get("heightsM").and_then(Value::as_array) else {
            errors.push(err(format!("{path}.heightsM"), "must be an array of finite numbers"));
            return None;
        };
        if let (Some(r), Some(c)) = (rows, columns) {
            if r.checked_mul(c) != Some(items.len()) {
                errors.push(err(format!("{path}.heightsM"), "count must equal rows × columns"));
            }
        }
        let mut heights_m = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            match item.as_f64().filter(|x| x.is_finite()) {
                Some(height) => heights_m.push(height),
                None => errors.push(err(format!("{path}.heightsM[{i}]"), "must be a finite number")),
            }
        }
        let terrain = Self { rows: rows?, columns: columns?, cell_size_m: cell_size_m?, corner_m: corner_m?, heights_m, surface: surface? };
        let [width, length] = terrain.extent();
        let [west, south] = terrain.first_sample();
        for (axis, min, extent) in [(0, west, width), (1, south, length)] {
            let max = min + extent;
            if !max.is_finite() || max <= min {
                errors.push(err(format!("{path}.cornerM[{axis}]"), "sample bounds must be finite and distinct at this extent"));
            }
        }
        Some(terrain)
    }

    fn extent(&self) -> [f64; 2] {
        [(self.columns - 1) as f64 * self.cell_size_m, (self.rows - 1) as f64 * self.cell_size_m]
    }

    fn first_sample(&self) -> [f64; 2] {
        self.corner_m.map(|corner| corner + self.cell_size_m / 2.0)
    }

    /// Port of src/domain/terrain.ts:84–114, including the sample-centre bounds.
    fn height_at(&self, x_m: f64, y_m: f64) -> Option<f64> {
        let [west, south] = self.first_sample();
        let [width, length] = self.extent();
        if !x_m.is_finite() || !y_m.is_finite()
            || x_m < west || x_m > west + width || y_m < south || y_m > south + length
        {
            return None;
        }
        let x = ((x_m - west) / self.cell_size_m).min((self.columns - 1) as f64);
        let y = ((y_m - south) / self.cell_size_m).min((self.rows - 1) as f64);
        let column = (x as usize).min(self.columns - 2);
        let row_from_bottom = (y as usize).min(self.rows - 2);
        let u = x - column as f64;
        let v = y - row_from_bottom as f64;
        let top = (self.rows - 2 - row_from_bottom) * self.columns + column;
        let bottom = top + self.columns;
        let [sw, se, nw, ne] = [self.heights_m[bottom], self.heights_m[bottom + 1], self.heights_m[top], self.heights_m[top + 1]];
        Some(if u <= v {
            (1.0 - v) * sw + u * ne + (v - u) * nw
        } else {
            (1.0 - u) * sw + (u - v) * se + v * ne
        })
    }

    fn collider(&self) -> (ColliderBuilder, Pose) {
        // parry-heightfield3.rs:89–106,355–402: local X/Z span the whole grid,
        // D9 samples are metres, and the default diagonal is p10–p01.
        // The quarter turn maps local (x, y, z) to world (x, -z, y).
        let [width, length] = self.extent();
        let [west, south] = self.first_sample();
        let heights = Array2::from_fn(self.rows, self.columns, |row, col| self.heights_m[row * self.columns + col]);
        let pose = Pose::from_parts(Vector::new(west + width / 2.0, south + length / 2.0, 0.0), y_up_to_z_up());
        (ColliderBuilder::heightfield(heights, Vector::new(width, 1.0, length)), pose)
    }
}

fn y_up_to_z_up() -> Rotation {
    Rotation::from_rotation_x(std::f64::consts::FRAC_PI_2)
}

fn hull_points(obj: &Map<String, Value>, path: &str, errors: &mut Vec<EnvironmentError>) -> Option<Vec<[f64; 3]>> {
    let path = format!("{path}.points");
    let Some(items) = obj.get("points").and_then(Value::as_array) else {
        errors.push(err(path, "must be an array of 3D points"));
        return None;
    };
    if items.len() < 4 {
        errors.push(err(&path, "a convex hull needs at least 4 points"));
    }
    let mut points = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        match item.as_array().and_then(|coords| finite_array(coords)) {
            Some(point) => points.push(point),
            None => errors.push(err(format!("{path}[{i}]"), "must be an array of 3 finite numbers")),
        }
    }
    if points.len() != items.len() || points.len() < 4 {
        return None;
    }
    // The vehicle hull check in vehicle.rs:318–331 also rejects flat hulls
    // that Parry can build successfully.
    let spans_volume = convex_hull(&points).is_some_and(|shape| {
        let volume = shape.mass_properties(1.0).mass();
        let aabb = shape.compute_local_aabb();
        let side = (aabb.maxs - aabb.mins).max_element();
        volume.is_finite() && volume > 1e-9 * side * side * side
    });
    if !spans_volume {
        errors.push(err(path, "points do not span a volume (degenerate convex hull)"));
        return None;
    }
    Some(points)
}

fn convex_hull(points: &[[f64; 3]]) -> Option<SharedShape> {
    let points: Vec<_> = points.iter().copied().map(Vector::from_array).collect();
    SharedShape::convex_hull(&points)
}

impl ObstacleShape {
    fn from_json(obj: &Map<String, Value>, path: &str, errors: &mut Vec<EnvironmentError>) -> Option<Self> {
        // Existing obstacle JSON supplied halfExtents without a type. The tag
        // and shape names follow the vehicle's CollisionShape (vehicle.rs:56–65).
        let kind = match obj.get("type") {
            None => Some("box"),
            Some(tag) => tag.as_str(),
        };
        let fields: &[&str] = match kind {
            Some("box") => &["halfExtents"],
            Some("cylinder") => &["radius", "height"],
            Some("hull") => &["points"],
            _ => {
                errors.push(err(format!("{path}.type"), "must be box, cylinder or hull"));
                &["halfExtents", "radius", "height", "points"]
            }
        };
        for key in obj.keys() {
            if !["type", "id", "center", "quaternion", "friction", "restitution"].contains(&key.as_str())
                && !fields.contains(&key.as_str())
            {
                errors.push(err(format!("{path}.{key}"), "unknown field"));
            }
        }
        match kind {
            Some("box") => {
                let half_extents = array::<3>(obj, path, "halfExtents", errors)?;
                if half_extents.iter().any(|x| *x <= 0.0) {
                    errors.push(err(format!("{path}.halfExtents"), "must all be positive"));
                    return None;
                }
                Some(Self::Box { half_extents })
            }
            Some("cylinder") => {
                let radius = positive_number(obj, path, "radius", errors);
                let height = positive_number(obj, path, "height", errors);
                Some(Self::Cylinder { radius: radius?, height: height? })
            }
            Some("hull") => Some(Self::Hull { points: hull_points(obj, path, errors)? }),
            _ => None,
        }
    }

    fn collider(&self) -> ColliderBuilder {
        match self {
            Self::Box { half_extents: [hx, hy, hz] } => ColliderBuilder::cuboid(*hx, *hy, *hz),
            Self::Cylinder { radius, height } => {
                ColliderBuilder::cylinder(height / 2.0, *radius).position(Pose::from_rotation(y_up_to_z_up()))
            }
            Self::Hull { points } => ColliderBuilder::new(convex_hull(points).expect("obstacle hull was validated")),
        }
    }
}

impl Environment {
    /// Reads and checks an environment; returns every problem, not just the first.
    ///
    /// Use `ground` (plane coefficients or null) or `terrain` (the grid fields
    /// from src/domain/terrain.ts:1–8 plus friction and restitution). Each
    /// obstacle takes an id, centre, quaternion, friction and restitution plus
    /// its shape fields: halfExtents, radius/height, or points.
    pub fn from_json(value: &Value) -> Result<Environment, Vec<EnvironmentError>> {
        let mut errors = Vec::new();
        let Value::Object(root) = value else {
            return Err(vec![err("environment", "must be an object with ground or terrain, and obstacles")]);
        };
        unknown_keys(root, "environment", &["ground", "terrain", "obstacles"], &mut errors);
        let terrain = match root.get("terrain") {
            None | Some(Value::Null) => None,
            Some(Value::Object(t)) => {
                if root.get("ground").is_some_and(Value::is_object) {
                    errors.push(err("environment.terrain", "cannot be supplied with a ground plane"));
                }
                Terrain::from_json(t, &mut errors)
            }
            Some(_) => {
                errors.push(err("environment.terrain", "must be an object or null"));
                None
            }
        };
        let ground = match root.get("ground") {
            None if root.get("terrain").is_some_and(|value| !value.is_null()) => None,
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
                    let shape = ObstacleShape::from_json(o, &path, &mut errors);
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
                    let q = array::<4>(o, &path, "quaternion", &mut errors);
                    if let Some(q) = q {
                        let n = q.iter().map(|x| x * x).sum::<f64>().sqrt();
                        if (n - 1.0).abs() > 1e-9 {
                            errors.push(err(format!("{path}.quaternion"), format!("must be a unit quaternion (|q| = {n})")));
                        }
                    }
                    let s = surface(o, &path, &mut errors);
                    if let (Some(center), Some(shape), Some(quaternion), Some(surface)) = (center, shape, q, s) {
                        obstacles.push(Obstacle { id, center, shape, quaternion, surface });
                    }
                }
            }
            None => errors.push(err("environment.obstacles", "not set: give a list (it may be empty)")),
            Some(_) => errors.push(err("environment.obstacles", "must be an array")),
        }
        if errors.is_empty() {
            Ok(Environment { ground, terrain, obstacles })
        } else {
            Err(errors)
        }
    }

    /// Ground surface height in metres at world (x, y), excluding obstacles (D8).
    pub fn height_below(&self, x_m: f64, y_m: f64) -> Option<f64> {
        ground_height(self.ground.is_some(), self.terrain.as_ref(), x_m, y_m)
    }
}

fn ground_height(plane: bool, terrain: Option<&Terrain>, x_m: f64, y_m: f64) -> Option<f64> {
    match terrain {
        Some(terrain) => terrain.height_at(x_m, y_m),
        None => plane.then_some(0.0),
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
    /// The ground entry also retains the terrain grid when present.
    objects: Vec<(ColliderHandle, Object, Option<Terrain>)>,
    /// Part index → part id (collider user_data is the index, see `Vehicle::build_body`).
    part_ids: Vec<String>,
    open: BTreeMap<(usize, Object), f64>,
    events: Vec<ContactEvent>,
    dropped: u64,
}

/// The heightfield has no solid interior. Check actual collider points against
/// the surface above them, including a cylinder's lowest support point and
/// cap centres. Vertices cover the lowest faces of boxes and hulls. This is a
/// sample check: terrain under unsampled face or edge interiors relies on the
/// contact query, and points outside the sample-centre bounds do not count.
fn terrain_penetration(terrain: &Terrain, collider: &Collider, pose: &Pose) -> f64 {
    let mut depth: f64 = 0.0;
    let mut sample = |point: Vector| {
        if let Some(height) = terrain.height_at(point.x, point.y) {
            depth = depth.max(height - point.z);
        }
    };
    let shape = collider.shape();
    if shape.as_cuboid().is_some() {
        for vertex in shape.compute_local_aabb().vertices() {
            sample(*pose * vertex);
        }
    } else if let Some(hull) = shape.as_convex_polyhedron() {
        for &vertex in hull.points() {
            sample(*pose * vertex);
        }
    } else if let Some(support) = shape.as_support_map() {
        sample(support.support_point(pose, -Vector::Z));
        if let Some(cylinder) = shape.as_cylinder() {
            for y in [-cylinder.half_height, cylinder.half_height] {
                sample(*pose * Vector::new(0.0, y, 0.0));
            }
        }
    }
    depth
}

fn surface_contact(surface: &Collider, part: &Collider, pose: &Pose, prediction: f64) -> Option<query::Contact> {
    // Parry 0.31.1's dispatcher mis-places a half-space given second.
    query::contact(surface.position(), surface.shape(), pose, part.shape(), prediction).ok().flatten()
}

fn surface_penetration(surface: &Collider, part: &Collider, pose: &Pose, terrain: Option<&Terrain>) -> f64 {
    let depth = surface_contact(surface, part, pose, 0.0).map_or(0.0, |c| -c.dist);
    terrain.map_or(depth, |terrain| depth.max(terrain_penetration(terrain, part, pose)))
}

fn terrain_part_start_z(ground: &Collider, part: &Collider) -> Result<Option<f64>, String> {
    let shape = part.shape();
    let support = shape.as_support_map().ok_or("startClearanceM terrain sweep needs a convex part")?;
    let field = ground.shape().as_heightfield().ok_or("startClearanceM needs a heightfield for terrain placement")?;
    let ground_bounds = ground.compute_aabb();
    let part_bounds = part.compute_aabb();
    // Bound the sweep by the terrain and part extremes. Pad the footprint's cell
    // query so an exact grid-boundary contact still gets a triangle test.
    let high = (ground_bounds.maxs.z - part_bounds.mins.z).next_up();
    let low = (ground_bounds.mins.z - part_bounds.maxs.z).next_down();
    let travel = (high - low).next_up();
    let pose = ground.position().inv_mul(part.position());
    let up = ground.position().rotation.inverse() * Vector::Z;
    let at_height = |z| Pose::from_parts(pose.translation + up * z, pose.rotation);
    let top = at_height(high);
    let bottom = at_height(low);
    if !travel.is_finite() || !top.translation.is_finite() || !bottom.translation.is_finite() {
        return Err("startClearanceM terrain sweep exceeds the finite coordinate range".into());
    }
    let swept = shape.compute_aabb(&top).merged(&shape.compute_aabb(&bottom)).loosened(ALLOWED_LINEAR_ERROR_M);
    let options = query::ShapeCastOptions::with_max_time_of_impact(travel);
    let mut highest = None::<f64>;
    // Parry 0.31.1 shape_cast_heightfield_shape.rs:139–168 sweeps each
    // triangle and retains the first hit. Use the same support-map cast
    // (default_query_dispatcher.rs:481–484) for triangle edges and vertices.
    field.map_elements_in_local_aabb(&swept, &mut |_, tri| {
        // GJK's TOI is conservative. For a triangle interior use the exact
        // plane support height, which also bounds any edge or vertex hit.
        let upper = tri.normal().and_then(|normal| {
            let rise = normal.dot(up);
            let point = support.support_point(&pose, -normal);
            let z = normal.dot(tri.a - point) / rise;
            (rise > 0.0 && z.is_finite()).then_some((z, point + up * z))
        });
        let z = match upper {
            Some((z, point)) if tri.project_local_point_and_get_location(point, false).1.is_on_face() => z,
            _ => {
                let Some(hit) = query::details::cast_shapes_support_map_support_map(&top, -up, tri, support, options) else {
                    return;
                };
                let z = high - hit.time_of_impact;
                upper.map_or(z, |(plane_z, _)| z.min(plane_z))
            }
        };
        highest = Some(highest.map_or(z, |previous| previous.max(z)));
    });
    Ok(highest)
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
            objects.push((h, Object::Ground, None));
        } else if let Some(terrain) = &env.terrain {
            let (collider, pose) = terrain.collider();
            let body = world.bodies.insert(RigidBodyBuilder::fixed().pose(pose).build());
            let h = world.colliders.insert_with_parent(with(collider, &terrain.surface), body, &mut world.bodies);
            objects.push((h, Object::Ground, Some(terrain.clone())));
        }
        for o in &env.obstacles {
            let [x, y, z, w] = o.quaternion;
            let pose = Pose::from_parts(Vector::new(o.center[0], o.center[1], o.center[2]), Rotation::from_xyzw(x, y, z, w).normalize());
            let body = world.bodies.insert(RigidBodyBuilder::fixed().pose(pose).build());
            let h = world.colliders.insert_with_parent(with(o.shape.collider(), &o.surface), body, &mut world.bodies);
            objects.push((h, Object::Obstacle(o.id.clone()), None));
        }
        Placed { objects, part_ids, open: BTreeMap::new(), events: Vec::new(), dropped: 0 }
    }

    pub(crate) fn height_below(&self, x_m: f64, y_m: f64) -> Option<f64> {
        match self.objects.first() {
            Some((_, Object::Ground, terrain)) => ground_height(true, terrain.as_ref(), x_m, y_m),
            _ => None,
        }
    }

    /// Ground support at the vehicle's current pose, before the contact log has a sample.
    pub(crate) fn initial_ground_contact(&self, world: &PhysicsWorld, vehicle: RigidBodyHandle) -> bool {
        let Some((handle, Object::Ground, _)) = self.objects.first() else { return false; };
        let ground = &world.colliders[*handle];
        world.bodies[vehicle].colliders().iter().any(|&h| {
            let part = &world.colliders[h];
            surface_contact(ground, part, part.position(), ALLOWED_LINEAR_ERROR_M)
                .is_some_and(|contact| contact.dist <= ALLOWED_LINEAR_ERROR_M)
        })
    }

    /// First ground contact as the vehicle at the requested XY and Z = 0 is lowered.
    pub(crate) fn ground_start_z(&self, world: &PhysicsWorld, vehicle: RigidBodyHandle) -> Result<f64, String> {
        let Some((handle, Object::Ground, terrain)) = self.objects.first() else {
            return Err("startClearanceM requires a ground plane or terrain".into());
        };
        let ground = &world.colliders[*handle];
        let parts = world.bodies[vehicle].colliders();
        let mut start_z = None::<f64>;
        for &h in parts {
            let part = &world.colliders[h];
            let z = if terrain.is_some() {
                let Some(z) = terrain_part_start_z(ground, part)? else { continue; };
                z
            } else {
                // Parry 0.31.1 contact_halfspace_support_map.rs:12–25 projects
                // the exact deepest support point onto the plane normal.
                -surface_contact(ground, part, part.position(), f64::MAX)
                    .ok_or("startClearanceM could not find contact with the plane")?.dist
            };
            if !z.is_finite() {
                return Err("startClearanceM ground contact height must be finite".into());
            }
            start_z = Some(start_z.map_or(z, |highest| highest.max(z)));
        }
        let z = start_z.ok_or("startClearanceM found no vehicle part above the terrain samples")?;
        let mut touching = false;
        for &h in parts {
            let part = &world.colliders[h];
            let mut pose = *part.position();
            pose.translation.z += z;
            if surface_penetration(ground, part, &pose, terrain.as_ref()) > START_PENETRATION_TOLERANCE_M {
                return Err("startClearanceM ground sweep ended in penetration".into());
            }
            touching |= surface_contact(ground, part, &pose, ALLOWED_LINEAR_ERROR_M).is_some_and(|c| c.dist <= ALLOWED_LINEAR_ERROR_M);
        }
        if !touching {
            return Err("startClearanceM could not place the vehicle within the ground contact tolerance".into());
        }
        Ok(z)
    }

    /// Vehicle parts that start inside the ground or an obstacle, deeper than
    /// `tolerance_m`: (part id, object label, depth m).
    pub fn initial_penetrations(
        &self,
        world: &PhysicsWorld,
        vehicle: RigidBodyHandle,
        terrain: Option<&Terrain>,
        tolerance_m: f64,
    ) -> Vec<(String, String, f64)> {
        let mut out = Vec::new();
        for &vh in world.bodies[vehicle].colliders() {
            let v = &world.colliders[vh];
            for (eh, object, _) in &self.objects {
                let e = &world.colliders[*eh];
                let depth = surface_penetration(e, v, v.position(), if *object == Object::Ground { terrain } else { None });
                if depth > tolerance_m {
                    out.push((self.part_ids[v.user_data as usize].clone(), object.label(), depth));
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
            let find = |h: ColliderHandle| self.objects.iter().find(|(x, _, _)| *x == h).map(|(_, o, _)| o);
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
