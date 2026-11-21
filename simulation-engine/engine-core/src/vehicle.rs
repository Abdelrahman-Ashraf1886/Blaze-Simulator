//! The vehicle definition sent by the app, its validation, and the rapier body
//! built from it.
//!
//! The JSON shape is pinned in `documentation/plans/phase-4-physics.md`
//! ("Shared interface"). It is produced by `src/domain/mass.ts` and checked by
//! zod in `electron/main/engine/protocol.ts`; the three must change together.
//!
//! Conventions (ADR 0003): body axes +X forward, +Y left, +Z up; metres, kg,
//! seconds. The body origin is the frame centre at the bottom of the centre
//! plate. An inertia is `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]` (kg·m²) about the
//! stated point in body axes, with the tensor sign convention
//! (Ixy = −Σ m·x·y), so the matrix is [[Ixx,Ixy,Ixz],[Ixy,Iyy,Iyz],[Ixz,Iyz,Izz]].
//!
//! The engine trusts nothing it is sent:
//! - every number must be finite, every mass positive;
//! - every inertia (per part and total) must be positive definite and its
//!   principal moments must satisfy the triangle inequality
//!   (λa + λb ≥ λc), which any real mass distribution does;
//! - quaternions and thrust axes must be unit length;
//! - the totals are recomputed from `parts` and compared with the sent ones:
//!     m = Σ mᵢ
//!     c = Σ mᵢ rᵢ / m
//!     I = Σ (Iᵢ + mᵢ (|dᵢ|² E − dᵢ dᵢᵀ)),  dᵢ = rᵢ − c   (parallel axis theorem)
//!   `Iᵢ` is already in body axes (the app applied the part's rotation), so no
//!   rotation appears here. A difference beyond [`TOTALS_REL_TOL`] is an error,
//!   never a silent correction.

use rapier3d_f64::math::{Matrix, Pose, Rotation, Vector};
use rapier3d_f64::prelude::{
    ColliderBuilder, ColliderSet, MassProperties, RigidBodyBuilder, RigidBodyHandle, RigidBodySet,
    SharedShape,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// The only definition version this engine understands.
pub const VEHICLE_DEFINITION_VERSION: u32 = 1;

/// Allowed relative difference between the sent totals and our recomputation
/// (plan, "Shared interface"). Both sides sum in f64, so honest differences
/// are rounding only (~1e-16 relative); 1e-9 leaves a wide margin for that
/// while catching any real disagreement.
pub const TOTALS_REL_TOL: f64 = 1e-9;

/// Allowed deviation of a quaternion or thrust axis from unit length. The app
/// normalizes in f64, so a correct vector is within ~1e-15 of unit length.
pub const UNIT_TOL: f64 = 1e-9;

pub type Vec3 = [f64; 3];
/// x, y, z, w (three.js order).
pub type Quat = [f64; 4];
/// [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] in kg·m², tensor sign convention.
pub type Inertia6 = [f64; 6];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum CollisionShape {
    #[serde(rename_all = "camelCase")]
    Box { half_extents: Vec3 },
    /// Axis = the shape's local Z.
    #[serde(rename_all = "camelCase")]
    Cylinder { radius: f64, half_height: f64 },
    /// Points in the shape's local coordinates.
    Hull { points: Vec<Vec3> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShapePose {
    pub position: Vec3,
    pub quaternion: Quat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartBody {
    pub part_id: String,
    pub mass_kg: f64,
    /// Part CoM in body coordinates.
    pub com: Vec3,
    /// About the part's own CoM, body axes.
    pub inertia: Inertia6,
    /// Collision shape placement in body coordinates.
    pub pose: ShapePose,
    pub shape: CollisionShape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Spin {
    Cw,
    Ccw,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotorBody {
    pub part_id: String,
    /// Thrust point (prop hub) in body coordinates.
    pub position: Vec3,
    /// Unit vector in body axes (includes tilt).
    pub thrust_axis: Vec3,
    pub spin: Spin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleDefinition {
    pub version: u32,
    pub parts: Vec<PartBody>,
    pub motors: Vec<MotorBody>,
    pub total_mass_kg: f64,
    pub com: Vec3,
    /// About `com`, body axes.
    pub inertia: Inertia6,
    /// Part ids without a mass; a non-empty list blocks flight.
    pub missing_mass: Vec<String>,
}

/// One reason a definition was refused. `path` points into the JSON
/// (e.g. `parts[2].inertia`); it is empty when the JSON could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VehicleError {
    pub path: String,
    pub message: String,
}

impl VehicleError {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}

/// Mass properties recomputed from the parts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MassTotals {
    pub mass_kg: f64,
    pub com: Vec3,
    /// About `com`, body axes.
    pub inertia: Inertia6,
}

/// A definition that passed every check, with our own recomputed totals.
#[derive(Debug, Clone, PartialEq)]
pub struct Vehicle {
    pub definition: VehicleDefinition,
    pub totals: MassTotals,
}

// ---------------------------------------------------------------------------
// Conversions

pub fn vec(v: Vec3) -> Vector {
    Vector::new(v[0], v[1], v[2])
}

pub fn arr(v: Vector) -> Vec3 {
    [v.x, v.y, v.z]
}

/// [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] → symmetric matrix.
pub fn inertia_matrix(i: Inertia6) -> Matrix {
    let [xx, yy, zz, xy, xz, yz] = i;
    // glam matrices are built from columns; the matrix is symmetric anyway.
    Matrix::from_cols(
        Vector::new(xx, xy, xz),
        Vector::new(xy, yy, yz),
        Vector::new(xz, yz, zz),
    )
}

/// Symmetric matrix → [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (upper triangle).
pub fn inertia6(m: &Matrix) -> Inertia6 {
    [m.x_axis.x, m.y_axis.y, m.z_axis.z, m.y_axis.x, m.z_axis.x, m.z_axis.y]
}

fn quat(q: Quat) -> Rotation {
    Rotation::from_xyzw(q[0], q[1], q[2], q[3]).normalize()
}

/// Frobenius norm of a matrix.
fn frobenius(m: &Matrix) -> f64 {
    (m.x_axis.length_squared() + m.y_axis.length_squared() + m.z_axis.length_squared()).sqrt()
}

/// Principal moments and axes of a symmetric 3×3 matrix by the cyclic Jacobi
/// method (Golub & Van Loan, *Matrix Computations*, 4th ed., §8.5): repeated
/// plane rotations Jᵀ A J, each zeroing one off-diagonal element
/// (t = sgn θ / (|θ| + √(θ²+1)), θ = (a_qq − a_pp) / 2a_pq, c = 1/√(t²+1),
/// s = t·c), until the off-diagonal part is below rounding. Returns
/// (λ, R) with A = R diag(λ) Rᵀ, R a proper rotation (det +1).
///
/// Why our own: glamx 0.3.1's `symmetric_eigen` (used by rapier 0.36.1 for
/// `MassProperties::with_inertia_matrix`) returns a wrong frame when the
/// smallest moment is repeated (13 % reconstruction error for a tilted round
/// motor, any scale) and when the tensor is small (an absolute 1e-20
/// threshold: 29 % error at 1e-6 kg·m², typical for a motor). Jacobi is
/// unconditionally stable and accurate to rounding for both. See ADR 0005.
pub fn principal_axes(a: &Matrix) -> (Vector, Rotation) {
    let mut m = [
        [a.x_axis.x, a.y_axis.x, a.z_axis.x],
        [a.x_axis.y, a.y_axis.y, a.z_axis.y],
        [a.x_axis.z, a.y_axis.z, a.z_axis.z],
    ];
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let norm = frobenius(a);
    for _sweep in 0..32 {
        let off = (m[0][1] * m[0][1] + m[0][2] * m[0][2] + m[1][2] * m[1][2]).sqrt();
        if off <= 1e-17 * norm {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if m[p][q] == 0.0 {
                continue;
            }
            let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
            let t = if theta.abs() > 1e150 {
                0.5 / theta
            } else {
                theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt())
            };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            // A ← Jᵀ A J and V ← V J, with J the identity except
            // J_pp = J_qq = c, J_pq = s, J_qp = −s.
            for k in 0..3 {
                let (akp, akq) = (m[k][p], m[k][q]);
                m[k][p] = c * akp - s * akq;
                m[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (m[p][k], m[q][k]);
                m[p][k] = c * apk - s * aqk;
                m[q][k] = s * apk + c * aqk;
            }
            for row in &mut v {
                let (vp, vq) = (row[p], row[q]);
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    let col = |j: usize| Vector::new(v[0][j], v[1][j], v[2][j]);
    let (c0, c1) = (col(0), col(1));
    // Make the frame right-handed (flipping an eigenvector keeps it one).
    let c2 = c0.cross(c1);
    let r = Rotation::from_mat3(&Matrix::from_cols(c0, c1, c2)).normalize();
    (Vector::new(m[0][0], m[1][1], m[2][2]), r)
}

// ---------------------------------------------------------------------------
// Validation

fn check_finite(errors: &mut Vec<VehicleError>, path: &str, values: &[f64]) -> bool {
    let ok = values.iter().all(|v| v.is_finite());
    if !ok {
        errors.push(VehicleError::new(path, "must contain only finite numbers"));
    }
    ok
}

fn check_unit(errors: &mut Vec<VehicleError>, path: &str, values: &[f64]) {
    if !check_finite(errors, path, values) {
        return;
    }
    let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
    if (norm - 1.0).abs() > UNIT_TOL {
        errors.push(VehicleError::new(
            path,
            format!("must have unit length (|v| = {norm}, allowed deviation {UNIT_TOL})"),
        ));
    }
}

/// Positive definite, and the principal moments satisfy the triangle
/// inequality. The tolerance on the triangle inequality (1e-9 of the trace)
/// admits the limiting cases a thin plate or rod reaches exactly.
fn check_inertia(errors: &mut Vec<VehicleError>, path: &str, i: Inertia6) {
    if !check_finite(errors, path, &i) {
        return;
    }
    let (ev, _) = principal_axes(&inertia_matrix(i));
    let [a, b, c] = [ev.x, ev.y, ev.z];
    if a <= 0.0 || b <= 0.0 || c <= 0.0 {
        errors.push(VehicleError::new(
            path,
            format!("must be positive definite (principal moments {a}, {b}, {c} kg·m²)"),
        ));
        return;
    }
    let slack = 1e-9 * (a + b + c);
    if a + b < c - slack || a + c < b - slack || b + c < a - slack {
        errors.push(VehicleError::new(
            path,
            format!(
                "principal moments {a}, {b}, {c} kg·m² violate the triangle inequality \
                 (no real mass distribution has them)"
            ),
        ));
    }
}

/// The rapier shape and its pose in body coordinates. Rapier's cylinder axis
/// is its local Y; ours is local Z, so the shape is turned +90° about X
/// (which maps Y onto Z).
fn collider_shape(part: &PartBody) -> Result<(SharedShape, Pose), String> {
    let pose = Pose::from_parts(vec(part.pose.position), quat(part.pose.quaternion));
    match &part.shape {
        CollisionShape::Box { half_extents: [x, y, z] } => {
            Ok((SharedShape::cuboid(*x, *y, *z), pose))
        }
        CollisionShape::Cylinder { radius, half_height } => {
            let turn = Pose::from_rotation(Rotation::from_rotation_x(std::f64::consts::FRAC_PI_2));
            Ok((SharedShape::cylinder(*half_height, *radius), pose * turn))
        }
        CollisionShape::Hull { points } => {
            let pts: Vec<Vector> = points.iter().copied().map(vec).collect();
            // A flat or collinear point set has no volume; parry may still
            // build a (flat) hull, so check its volume against the size of its
            // bounding box: V < 1e-9 · (largest side)³ means degenerate.
            let degenerate = || "points do not span a volume (degenerate convex hull)".to_string();
            let shape = SharedShape::convex_hull(&pts).ok_or_else(degenerate)?;
            let volume = shape.mass_properties(1.0).mass();
            let aabb = shape.compute_local_aabb();
            let side = (aabb.maxs - aabb.mins).max_element();
            if !(volume > 1e-9 * side * side * side) {
                return Err(degenerate());
            }
            Ok((shape, pose))
        }
    }
}

fn check_shape(errors: &mut Vec<VehicleError>, path: &str, part: &PartBody) {
    let ok = match &part.shape {
        CollisionShape::Box { half_extents } => {
            check_finite(errors, &format!("{path}.halfExtents"), half_extents)
                && positive(errors, &format!("{path}.halfExtents"), half_extents)
        }
        CollisionShape::Cylinder { radius, half_height } => {
            check_finite(errors, path, &[*radius, *half_height])
                && positive(errors, &format!("{path}.radius"), &[*radius])
                && positive(errors, &format!("{path}.halfHeight"), &[*half_height])
        }
        CollisionShape::Hull { points } => {
            if points.len() < 4 {
                errors.push(VehicleError::new(
                    format!("{path}.points"),
                    "a convex hull needs at least 4 points",
                ));
                false
            } else {
                points
                    .iter()
                    .enumerate()
                    .all(|(k, p)| check_finite(errors, &format!("{path}.points[{k}]"), p))
            }
        }
    };
    if ok {
        if let Err(message) = collider_shape(part) {
            errors.push(VehicleError::new(path, message));
        }
    }
}

fn positive(errors: &mut Vec<VehicleError>, path: &str, values: &[f64]) -> bool {
    let ok = values.iter().all(|v| *v > 0.0);
    if !ok {
        errors.push(VehicleError::new(path, "must be greater than zero"));
    }
    ok
}

/// Mass totals from the parts (formulas in the module docs). Assumes the
/// parts passed validation.
pub fn recompute_totals(parts: &[PartBody]) -> MassTotals {
    let mass: f64 = parts.iter().map(|p| p.mass_kg).sum();
    let com = parts.iter().fold(Vector::ZERO, |acc, p| acc + vec(p.com) * p.mass_kg) / mass;
    let inertia = parts.iter().fold(Matrix::ZERO, |acc, p| {
        let d = vec(p.com) - com;
        let shift = (Matrix::from_diagonal(Vector::splat(d.length_squared()))
            - Matrix::from_cols(d * d.x, d * d.y, d * d.z))
            * p.mass_kg;
        acc + inertia_matrix(p.inertia) + shift
    });
    MassTotals { mass_kg: mass, com: arr(com), inertia: inertia6(&inertia) }
}

/// Compares the sent totals with ours:
/// - mass: |Δm| ≤ tol · m;
/// - CoM: |Δc| ≤ tol · L, with L the vehicle's extent (the largest |rᵢ| of a
///   part CoM, or |c|), because a CoM can be zero and has no scale of its own;
/// - inertia: ‖ΔI‖_F ≤ tol · ‖I‖_F (Frobenius norm), because off-diagonal
///   components are often zero.
fn compare_totals(
    errors: &mut Vec<VehicleError>,
    def: &VehicleDefinition,
    ours: &MassTotals,
    tol: f64,
) {
    let dm = (def.total_mass_kg - ours.mass_kg).abs();
    if dm > tol * ours.mass_kg {
        errors.push(VehicleError::new(
            "totalMassKg",
            format!(
                "is {} kg but the parts sum to {} kg (relative difference {:e}, allowed {tol:e})",
                def.total_mass_kg,
                ours.mass_kg,
                dm / ours.mass_kg
            ),
        ));
    }

    let extent = def
        .parts
        .iter()
        .map(|p| vec(p.com).length())
        .fold(vec(ours.com).length(), f64::max);
    let dc = (vec(def.com) - vec(ours.com)).length();
    if dc > tol * extent {
        errors.push(VehicleError::new(
            "com",
            format!(
                "is {:?} m but the parts give {:?} m (difference {dc:e} m, allowed {:e} m)",
                def.com,
                ours.com,
                tol * extent
            ),
        ));
    }

    let ours_m = inertia_matrix(ours.inertia);
    let di = frobenius(&(inertia_matrix(def.inertia) - ours_m));
    let scale = frobenius(&ours_m);
    if di > tol * scale {
        errors.push(VehicleError::new(
            "inertia",
            format!(
                "is {:?} kg·m² but the parts give {:?} kg·m² (relative difference {:e}, allowed {tol:e})",
                def.inertia,
                ours.inertia,
                di / scale
            ),
        ));
    }
}

impl Vehicle {
    /// Reads and validates a definition from JSON. Returns every problem
    /// found, not only the first.
    pub fn from_json(value: Value) -> Result<Vehicle, Vec<VehicleError>> {
        let def: VehicleDefinition = serde_json::from_value(value)
            .map_err(|e| vec![VehicleError::new("", format!("not a vehicle definition: {e}"))])?;
        Vehicle::from_definition(def)
    }

    pub fn from_definition(def: VehicleDefinition) -> Result<Vehicle, Vec<VehicleError>> {
        let mut errors = Vec::new();
        if def.version != VEHICLE_DEFINITION_VERSION {
            errors.push(VehicleError::new(
                "version",
                format!(
                    "is {}; this engine reads version {VEHICLE_DEFINITION_VERSION}",
                    def.version
                ),
            ));
            return Err(errors);
        }
        if def.parts.is_empty() {
            errors.push(VehicleError::new("parts", "no part has a mass"));
        }

        let mut ids = HashSet::new();
        for (k, p) in def.parts.iter().enumerate() {
            let path = format!("parts[{k}]");
            if p.part_id.is_empty() {
                errors.push(VehicleError::new(format!("{path}.partId"), "must not be empty"));
            } else if !ids.insert(p.part_id.as_str()) {
                errors.push(VehicleError::new(
                    format!("{path}.partId"),
                    format!("\"{}\" appears more than once", p.part_id),
                ));
            }
            if check_finite(&mut errors, &format!("{path}.massKg"), &[p.mass_kg]) {
                positive(&mut errors, &format!("{path}.massKg"), &[p.mass_kg]);
            }
            check_finite(&mut errors, &format!("{path}.com"), &p.com);
            check_inertia(&mut errors, &format!("{path}.inertia"), p.inertia);
            check_finite(&mut errors, &format!("{path}.pose.position"), &p.pose.position);
            check_unit(&mut errors, &format!("{path}.pose.quaternion"), &p.pose.quaternion);
            check_shape(&mut errors, &format!("{path}.shape"), p);
        }

        for (k, id) in def.missing_mass.iter().enumerate() {
            if ids.contains(id.as_str()) {
                errors.push(VehicleError::new(
                    format!("missingMass[{k}]"),
                    format!("\"{id}\" is listed as missing a mass but also has one in parts"),
                ));
            }
        }

        let mut motor_ids = HashSet::new();
        for (k, m) in def.motors.iter().enumerate() {
            let path = format!("motors[{k}]");
            if m.part_id.is_empty() {
                errors.push(VehicleError::new(format!("{path}.partId"), "must not be empty"));
            } else if !motor_ids.insert(m.part_id.as_str()) {
                errors.push(VehicleError::new(
                    format!("{path}.partId"),
                    format!("\"{}\" appears more than once", m.part_id),
                ));
            }
            check_finite(&mut errors, &format!("{path}.position"), &m.position);
            check_unit(&mut errors, &format!("{path}.thrustAxis"), &m.thrust_axis);
        }

        let totals_finite = check_finite(&mut errors, "totalMassKg", &[def.total_mass_kg])
            & check_finite(&mut errors, "com", &def.com);
        check_inertia(&mut errors, "inertia", def.inertia);

        if !errors.is_empty() {
            return Err(errors);
        }
        let totals = recompute_totals(&def.parts);
        if totals_finite {
            compare_totals(&mut errors, &def, &totals, TOTALS_REL_TOL);
        }
        if !errors.is_empty() {
            return Err(errors);
        }
        let vehicle = Vehicle { definition: def, totals };
        let (mut bodies, mut colliders) = (RigidBodySet::new(), ColliderSet::new());
        let h = vehicle.build_body(&mut bodies, &mut colliders);
        if !vehicle.rapier_agrees(&bodies[h]) {
            return Err(vec![VehicleError::new(
                "parts",
                "the physics engine (rapier 0.36.1) cannot represent this inertia exactly:                  a partial sum of the part tensors has two equal smallest principal moments,                  which its eigen solver mishandles (ADR 0005). Moving or re-weighting any                  part slightly avoids it.",
            )]);
        }
        Ok(vehicle)
    }

    /// Adds one dynamic rapier body, at the identity pose, with one collider
    /// per part. Each collider carries the part's explicit mass properties
    /// (never a density), expressed in the collider's own frame Pᵢ = (tᵢ, Rᵢ):
    ///   local CoM = Pᵢ⁻¹ · comᵢ,
    ///   principal moments λᵢ and axes Vᵢ of Iᵢ (our Jacobi, [`principal_axes`]),
    ///   local principal frame = Rᵢ⁻¹ Vᵢ,
    /// so rapier never has to diagonalize a part tensor. Rapier transforms them
    /// back and sums them with the parallel axis theorem.
    ///
    /// Rapier's sum re-diagonalizes each partial sum with glamx's solver (see
    /// [`principal_axes`]), which is wrong when a partial sum has a repeated
    /// smallest moment off the body axes, or is tiny. Parts are added heaviest
    /// first so partial sums are large; `from_definition` then builds the body
    /// once and refuses the vehicle if rapier's result differs from our totals
    /// (an honest error instead of simulating the wrong inertia). Zero-mass
    /// colliders cannot work around it: they still pass through the same sum.
    ///
    /// The body never sleeps: a resting drone must still react to the next
    /// input, and sleeping would change results depending on history.
    pub fn build_body(
        &self,
        bodies: &mut RigidBodySet,
        colliders: &mut ColliderSet,
    ) -> RigidBodyHandle {
        let handle = bodies.insert(RigidBodyBuilder::dynamic().can_sleep(false).build());
        let mut order: Vec<&PartBody> = self.definition.parts.iter().collect();
        order.sort_by(|a, b| b.mass_kg.total_cmp(&a.mass_kg).then_with(|| a.part_id.cmp(&b.part_id)));
        for part in order {
            let (shape, pose) = collider_shape(part).expect("shape was validated");
            let (moments, axes) = principal_axes(&inertia_matrix(part.inertia));
            let local_com = pose.inverse_transform_point(vec(part.com));
            let mprops = MassProperties::with_principal_inertia_frame(
                local_com,
                part.mass_kg,
                moments,
                (pose.rotation.inverse() * axes).normalize(),
            );
            let collider = ColliderBuilder::new(shape).position(pose).mass_properties(mprops).build();
            colliders.insert_with_parent(collider, handle, bodies);
        }
        bodies[handle].recompute_mass_properties_from_colliders(colliders);
        handle
    }

    /// Rapier's body mass, CoM and inertia equal our totals within
    /// [`TOTALS_REL_TOL`] (same norms as `compare_totals`).
    pub fn rapier_agrees(&self, rb: &rapier3d_f64::prelude::RigidBody) -> bool {
        let t = &self.totals;
        let extent = self
            .definition
            .parts
            .iter()
            .map(|p| vec(p.com).length())
            .fold(vec(t.com).length(), f64::max);
        let ours = inertia_matrix(t.inertia);
        let theirs = rb.mass_properties().local_mprops.reconstruct_inertia_matrix();
        (rb.mass() - t.mass_kg).abs() <= TOTALS_REL_TOL * t.mass_kg
            && (rb.local_center_of_mass() - vec(t.com)).length() <= TOTALS_REL_TOL * extent
            && frobenius(&(theirs - ours)) <= TOTALS_REL_TOL * frobenius(&ours)
    }
}


#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use serde_json::json;

    /// Two parts whose totals are worked by hand in `two_part_totals_match_hand_calculation`.
    pub fn two_part_json() -> Value {
        json!({
            "version": 1,
            "parts": [
                {
                    "partId": "a", "massKg": 1.0, "com": [0.1, 0.0, 0.0],
                    "inertia": [0.001, 0.002, 0.003, 0.0, 0.0, 0.0],
                    "pose": { "position": [0.1, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] },
                    "shape": { "type": "box", "halfExtents": [0.05, 0.03, 0.02] }
                },
                {
                    "partId": "b", "massKg": 3.0, "com": [-0.1, 0.0, 0.05],
                    "inertia": [0.004, 0.005, 0.006, 0.0, 0.0, 0.0],
                    "pose": { "position": [-0.1, 0.0, 0.05], "quaternion": [0.0, 0.0, 0.0, 1.0] },
                    "shape": { "type": "cylinder", "radius": 0.02, "halfHeight": 0.04 }
                }
            ],
            "motors": [
                { "partId": "m1", "position": [0.1, 0.1, 0.03], "thrustAxis": [0.0, 0.0, 1.0], "spin": "ccw" }
            ],
            "totalMassKg": 4.0,
            "com": [-0.05, 0.0, 0.0375],
            "inertia": [0.006875, 0.038875, 0.039, 0.0, 0.0075, 0.0],
            "missingMass": []
        })
    }

    /// Builds a definition whose totals are our own recomputation, so tests can
    /// use arbitrary parts.
    pub fn with_totals(parts: Vec<PartBody>) -> VehicleDefinition {
        let t = recompute_totals(&parts);
        VehicleDefinition {
            version: 1,
            parts,
            motors: vec![],
            total_mass_kg: t.mass_kg,
            com: t.com,
            inertia: t.inertia,
            missing_mass: vec![],
        }
    }

    pub fn box_part(id: &str, mass: f64, com: Vec3, inertia: Inertia6) -> PartBody {
        PartBody {
            part_id: id.into(),
            mass_kg: mass,
            com,
            inertia,
            pose: ShapePose { position: com, quaternion: [0.0, 0.0, 0.0, 1.0] },
            shape: CollisionShape::Box { half_extents: [0.05, 0.05, 0.05] },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use rapier3d_f64::glamx::DQuat;

    fn errors_of(value: Value) -> Vec<VehicleError> {
        Vehicle::from_json(value).expect_err("definition should be refused")
    }

    fn has_error(errors: &[VehicleError], path: &str) -> bool {
        errors.iter().any(|e| e.path == path)
    }

    fn rel(a: f64, b: f64) -> f64 {
        (a - b).abs() / b.abs().max(f64::MIN_POSITIVE)
    }

    #[test]
    fn two_part_totals_match_hand_calculation() {
        // m = 1 + 3 = 4 kg
        // c = (1·0.1 + 3·(−0.1), 0, 3·0.05) / 4 = (−0.05, 0, 0.0375)
        // dA = (0.15, 0, −0.0375), |dA|² = 0.02390625
        // dB = (−0.05, 0, 0.0125), |dB|² = 0.00265625
        // Ixx = 0.001 + 0.004 + 1·(0.02390625 − 0.0225) + 3·(0.00265625 − 0.0025) = 0.006875
        // Iyy = 0.002 + 0.005 + 1·0.02390625 + 3·0.00265625                     = 0.038875
        // Izz = 0.003 + 0.006 + 1·(0.02390625 − 0.00140625) + 3·0.0025           = 0.039
        // Ixz = −1·(0.15·−0.0375) − 3·(−0.05·0.0125) = 0.005625 + 0.001875       = 0.0075
        let v = Vehicle::from_json(two_part_json()).expect("valid");
        let t = v.totals;
        assert!(rel(t.mass_kg, 4.0) < 1e-15);
        let expected_com = [-0.05, 0.0, 0.0375];
        for k in 0..3 {
            assert!((t.com[k] - expected_com[k]).abs() < 1e-15, "com {k}: {:?}", t.com);
        }
        let expected_i = [0.006875, 0.038875, 0.039, 0.0, 0.0075, 0.0];
        for k in 0..6 {
            assert!((t.inertia[k] - expected_i[k]).abs() < 1e-15, "inertia {k}: {:?}", t.inertia);
        }
    }

    /// The milestone's cross-check: rapier's body, built from colliders that
    /// carry explicit mass properties, has exactly our recomputed mass, CoM
    /// and inertia (to 1e-9 relative). Uses rotated parts of every shape type
    /// with off-diagonal inertias, so rapier's frame changes are exercised.
    #[test]
    fn rapier_body_matches_recomputed_totals() {
        let q1 = DQuat::from_euler(rapier3d_f64::glamx::EulerRot::XYZ, 0.3, -0.7, 1.1);
        let q2 = DQuat::from_rotation_y(0.4);
        let parts = vec![
            PartBody {
                part_id: "frame".into(),
                mass_kg: 0.31,
                com: [0.0, 0.0, 0.012],
                inertia: [0.0021, 0.0023, 0.0041, -0.0001, 0.00002, 0.00003],
                pose: ShapePose { position: [0.0, 0.0, 0.01], quaternion: [0.0, 0.0, 0.0, 1.0] },
                shape: CollisionShape::Box { half_extents: [0.12, 0.12, 0.01] },
            },
            PartBody {
                part_id: "battery".into(),
                mass_kg: 0.42,
                com: [0.02, -0.01, 0.045],
                inertia: [0.00011, 0.00034, 0.00037, 0.00001, -0.00002, 0.0],
                pose: ShapePose {
                    position: [0.021, -0.012, 0.044],
                    quaternion: [q1.x, q1.y, q1.z, q1.w],
                },
                shape: CollisionShape::Box { half_extents: [0.07, 0.02, 0.018] },
            },
            PartBody {
                part_id: "motor-1".into(),
                mass_kg: 0.035,
                com: [0.11, 0.11, 0.03],
                inertia: [0.000004, 0.000004, 0.000006, 0.0, 0.0, 0.0],
                pose: ShapePose { position: [0.11, 0.11, 0.03], quaternion: [q2.x, q2.y, q2.z, q2.w] },
                shape: CollisionShape::Cylinder { radius: 0.014, half_height: 0.01 },
            },
            PartBody {
                part_id: "gps".into(),
                mass_kg: 0.02,
                com: [-0.05, 0.0, 0.08],
                inertia: [0.000002, 0.000002, 0.000003, 0.0, 0.0, 0.0],
                pose: ShapePose { position: [-0.05, 0.0, 0.08], quaternion: [0.0, 0.0, 0.0, 1.0] },
                shape: CollisionShape::Hull {
                    points: vec![
                        [-0.01, -0.01, 0.0],
                        [0.01, -0.01, 0.0],
                        [0.0, 0.012, 0.0],
                        [0.0, 0.0, 0.01],
                    ],
                },
            },
        ];
        let vehicle = Vehicle::from_definition(with_totals(parts)).expect("valid");
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let h = vehicle.build_body(&mut bodies, &mut colliders);
        let rb = &bodies[h];
        let t = vehicle.totals;

        assert!(rel(rb.mass(), t.mass_kg) < 1e-9, "mass {} vs {}", rb.mass(), t.mass_kg);
        let dc = (rb.local_center_of_mass() - vec(t.com)).length();
        assert!(dc < 1e-9 * vec(t.com).length(), "com {:?} vs {:?}", rb.local_center_of_mass(), t.com);
        let ri = rb.mass_properties().local_mprops.reconstruct_inertia_matrix();
        let ours = inertia_matrix(t.inertia);
        let di = frobenius(&(ri - ours)) / frobenius(&ours);
        assert!(di < 1e-9, "inertia {:?} vs {:?} (rel {di:e})", inertia6(&ri), t.inertia);
    }

    fn reconstruct(m: &Matrix) -> f64 {
        let (l, r) = principal_axes(m);
        let rm = Matrix::from_quat(r);
        frobenius(&(rm * Matrix::from_diagonal(l) * rm.transpose() - *m)) / frobenius(m)
    }

    /// The cases glamx 0.3.1 gets wrong (see `principal_axes`): our Jacobi
    /// reconstructs A = R Λ Rᵀ to rounding for each of them.
    #[test]
    fn principal_axes_handles_repeated_and_tiny_moments() {
        let r = Matrix::from_quat(Rotation::from_rotation_y(0.4) * Rotation::from_rotation_x(0.9));
        for scale in [1.0, 1e-3, 1e-6, 1e-9] {
            for d in [[1.0, 2.0, 3.0], [4.0, 4.0, 6.0], [4.0, 6.0, 6.0], [5.0, 5.0, 5.0]] {
                let a = r.transpose() * Matrix::from_diagonal(vec(d) * scale) * r;
                let e = reconstruct(&a);
                assert!(e < 1e-14, "scale {scale:e}, moments {d:?}: error {e:e}");
                let (l, q) = principal_axes(&a);
                assert!((Matrix::from_quat(q).determinant() - 1.0).abs() < 1e-12);
                let mut got = [l.x, l.y, l.z];
                got.sort_by(f64::total_cmp);
                for k in 0..3 {
                    assert!((got[k] - d[k] * scale).abs() < 1e-14 * scale * 6.0, "{got:?} vs {d:?}");
                }
            }
        }
    }

    /// Rapier's own sum is wrong when a partial sum has a repeated smallest
    /// moment off the body axes (two coaxial, tilted round parts here). The
    /// vehicle is refused rather than simulated with the wrong inertia.
    #[test]
    fn a_vehicle_rapier_cannot_sum_exactly_is_refused() {
        let r = Matrix::from_quat(Rotation::from_rotation_y(0.4) * Rotation::from_rotation_x(0.9));
        let i = inertia6(&(r.transpose() * Matrix::from_diagonal(Vector::new(0.04, 0.04, 0.06)) * r));
        let parts = vec![box_part("a", 1.0, [0.0, 0.0, 0.02], i), box_part("b", 0.5, [0.0, 0.0, 0.02], i)];
        let errors = Vehicle::from_definition(with_totals(parts)).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "parts");
        assert!(errors[0].message.contains("rapier"));
    }

    /// The part mass.ts (4.1) builds that is hardest for rapier: a propeller
    /// modelled as thin rods (Izz = m R²/3, Ixx = Iyy = m R²/6, so the smallest
    /// moment is repeated and Izz = Ixx + Iyy exactly), on a motor tilted 10°,
    /// with a tilted motor body under it and a frame plate. Inertias in body
    /// axes are R I Rᵀ, as mass.ts sends them.
    #[test]
    fn tilted_propeller_from_mass_ts_loads_and_rapier_agrees() {
        let tilt = Rotation::from_rotation_y(10f64.to_radians());
        let r = Matrix::from_quat(tilt);
        let body_axes = |d: [f64; 3]| inertia6(&(r * Matrix::from_diagonal(vec(d)) * r.transpose()));
        let (m, rp) = (0.012, 0.127);
        let prop = body_axes([m * rp * rp / 6.0, m * rp * rp / 6.0, m * rp * rp / 3.0]);
        let (mm, rm, hm) = (0.035, 0.014, 0.02);
        let side = mm * (3.0 * rm * rm + hm * hm) / 12.0;
        let motor = body_axes([side, side, mm * rm * rm / 2.0]);
        let q = [tilt.x, tilt.y, tilt.z, tilt.w];
        let part = |id: &str, mass, com: Vec3, inertia, shape| PartBody {
            part_id: id.into(),
            mass_kg: mass,
            com,
            inertia,
            pose: ShapePose { position: com, quaternion: q },
            shape,
        };
        let plate = 0.12 * (0.12f64.powi(2) + 0.003f64.powi(2)) / 12.0;
        let parts = vec![
            box_part("frame:plate", 0.12, [0.0, 0.0, 0.0015], [plate, plate, 0.12 * 2.0 * 0.0144 / 12.0, 0.0, 0.0, 0.0]),
            part("motor-1", mm, [0.16, 0.0, 0.02], motor, CollisionShape::Cylinder { radius: rm, half_height: hm / 2.0 }),
            part("prop-1", m, [0.16, 0.0, 0.035], prop, CollisionShape::Cylinder { radius: rp, half_height: 0.004 }),
        ];
        let vehicle = Vehicle::from_definition(with_totals(parts)).expect("valid");
        let (mut bodies, mut colliders) = (RigidBodySet::new(), ColliderSet::new());
        let h = vehicle.build_body(&mut bodies, &mut colliders);
        assert!(vehicle.rapier_agrees(&bodies[h]));
    }

    #[test]
    fn every_number_must_be_finite_json_cannot_carry_nan_but_huge_values_are_refused() {
        // JSON has no NaN/Infinity; an out-of-range literal fails to parse.
        let mut v = two_part_json();
        v["parts"][0]["massKg"] = serde_json::from_str("1e400").unwrap_or(Value::Null);
        let errors = errors_of(v);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "");
    }

    #[test]
    fn non_finite_values_are_refused_when_built_in_code() {
        let mut def: VehicleDefinition = serde_json::from_value(two_part_json()).unwrap();
        def.parts[0].com[1] = f64::NAN;
        def.motors[0].position[0] = f64::INFINITY;
        let errors = Vehicle::from_definition(def).unwrap_err();
        assert!(has_error(&errors, "parts[0].com"));
        assert!(has_error(&errors, "motors[0].position"));
    }

    #[test]
    fn wrong_version_is_refused() {
        let mut v = two_part_json();
        v["version"] = 2.into();
        assert!(has_error(&errors_of(v), "version"));
    }

    #[test]
    fn unknown_fields_are_refused() {
        let mut v = two_part_json();
        v["extra"] = 1.into();
        assert_eq!(errors_of(v)[0].path, "");
    }

    #[test]
    fn masses_must_be_positive() {
        let mut v = two_part_json();
        v["parts"][1]["massKg"] = 0.0.into();
        assert!(has_error(&errors_of(v), "parts[1].massKg"));
    }

    #[test]
    fn inertia_must_be_positive_definite() {
        let mut v = two_part_json();
        // Ixy so large that the tensor has a negative eigenvalue.
        v["parts"][0]["inertia"] = serde_json::json!([0.001, 0.002, 0.003, 0.005, 0.0, 0.0]);
        let errors = errors_of(v);
        let e = errors.iter().find(|e| e.path == "parts[0].inertia").unwrap();
        assert!(e.message.contains("positive definite"), "{}", e.message);
    }

    #[test]
    fn inertia_must_satisfy_the_triangle_inequality() {
        let mut v = two_part_json();
        v["parts"][0]["inertia"] = serde_json::json!([0.001, 0.001, 0.003, 0.0, 0.0, 0.0]);
        let errors = errors_of(v);
        let e = errors.iter().find(|e| e.path == "parts[0].inertia").unwrap();
        assert!(e.message.contains("triangle"), "{}", e.message);
    }

    #[test]
    fn a_thin_plate_reaches_the_triangle_limit_and_is_accepted() {
        // Thin square plate: Ixx = Iyy = m a²/12, Izz = Ixx + Iyy exactly.
        let ix = 0.5 * 0.2 * 0.2 / 12.0;
        let def = with_totals(vec![box_part("plate", 0.5, [0.0; 3], [ix, ix, 2.0 * ix, 0.0, 0.0, 0.0])]);
        assert!(Vehicle::from_definition(def).is_ok());
    }

    #[test]
    fn thrust_axes_and_quaternions_must_be_unit() {
        let mut v = two_part_json();
        v["motors"][0]["thrustAxis"] = serde_json::json!([0.0, 0.0, 1.001]);
        v["parts"][0]["pose"]["quaternion"] = serde_json::json!([0.0, 0.0, 0.0, 2.0]);
        let errors = errors_of(v);
        assert!(has_error(&errors, "motors[0].thrustAxis"));
        assert!(has_error(&errors, "parts[0].pose.quaternion"));
    }

    #[test]
    fn shapes_must_be_real_volumes() {
        let mut v = two_part_json();
        v["parts"][0]["shape"] = serde_json::json!({ "type": "box", "halfExtents": [0.05, 0.0, 0.02] });
        v["parts"][1]["shape"] = serde_json::json!({
            "type": "hull",
            "points": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]
        });
        let errors = errors_of(v);
        assert!(has_error(&errors, "parts[0].shape.halfExtents"));
        assert!(has_error(&errors, "parts[1].shape"), "{errors:?}");
    }

    #[test]
    fn duplicate_and_empty_ids_are_refused() {
        let mut v = two_part_json();
        v["parts"][1]["partId"] = "a".into();
        v["motors"][0]["partId"] = "".into();
        let errors = errors_of(v);
        assert!(has_error(&errors, "parts[1].partId"));
        assert!(has_error(&errors, "motors[0].partId"));
    }

    #[test]
    fn a_part_cannot_both_have_and_miss_a_mass() {
        let mut v = two_part_json();
        v["missingMass"] = serde_json::json!(["camera", "b"]);
        let errors = errors_of(v);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "missingMass[1]");
    }

    #[test]
    fn missing_mass_is_reported_not_refused() {
        let mut v = two_part_json();
        v["missingMass"] = serde_json::json!(["camera"]);
        let vehicle = Vehicle::from_json(v).unwrap();
        assert_eq!(vehicle.definition.missing_mass, vec!["camera".to_string()]);
    }

    #[test]
    fn no_parts_is_refused() {
        let mut v = two_part_json();
        v["parts"] = serde_json::json!([]);
        assert!(has_error(&errors_of(v), "parts"));
    }

    #[test]
    fn totals_must_match_the_parts() {
        // Each total is off by 1e-6 relative: far beyond rounding, so refused.
        let mut v = two_part_json();
        v["totalMassKg"] = (4.0 * (1.0 + 1e-6)).into();
        v["com"] = serde_json::json!([-0.05, 0.0, 0.0375 + 1e-7]);
        v["inertia"] = serde_json::json!([0.006875, 0.038875, 0.039 * (1.0 + 1e-6), 0.0, 0.0075, 0.0]);
        let errors = errors_of(v);
        assert!(has_error(&errors, "totalMassKg"));
        assert!(has_error(&errors, "com"));
        assert!(has_error(&errors, "inertia"));
    }

    #[test]
    fn totals_within_rounding_are_accepted() {
        // 1e-12 relative is what a different summation order can produce.
        let mut v = two_part_json();
        v["totalMassKg"] = (4.0 * (1.0 + 1e-12)).into();
        v["inertia"] = serde_json::json!([0.006875 * (1.0 + 1e-12), 0.038875, 0.039, 0.0, 0.0075, 0.0]);
        assert!(Vehicle::from_json(v).is_ok());
    }
}
