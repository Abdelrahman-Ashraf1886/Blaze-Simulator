//! Body drag (Phase 4.5 model; 4.6 applies it in the flight step).
//!
//! F_b,i = −½ ρ C_d,i A_i v_b,i |v_b,i| per body axis, with v_b = Rᵀ v_world
//! and F_world = R F_b, R the body → world rotation of the unit quaternion
//! (x, y, z, w; three.js order, as in the VehicleDefinition).
//!
//! C_d,i is the user's per-axis entry; A_i is derived on the TypeScript side
//! (`src/domain/aero.ts`: union of the non-propeller collision shapes projected
//! on the plane normal to axis i). ρ comes from the environment (ISA, 4.6).

use crate::math::Vec3;
use crate::vehicle::VehicleError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `aero` in `vehicle.load` (optional, additive).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyDrag {
    /// C_d along body x, y, z.
    pub cd_body: [f64; 3],
    /// Projected areas A_x, A_y, A_z, m².
    pub area_m2: [f64; 3],
}

/// Rotates `v` by the unit quaternion `q` = (x, y, z, w).
pub fn rotate(q: [f64; 4], v: Vec3) -> Vec3 {
    let [x, y, z, w] = q;
    let u = Vec3::new(x, y, z);
    // v' = v + 2w (u × v) + 2 u × (u × v)
    let t = u.cross(v) * 2.0;
    v + t * w + u.cross(t)
}

/// Rotates `v` by the inverse of `q` (world → body).
pub fn rotate_inverse(q: [f64; 4], v: Vec3) -> Vec3 {
    rotate([-q[0], -q[1], -q[2], q[3]], v)
}

impl BodyDrag {
    pub fn from_json(value: Value) -> Result<BodyDrag, Vec<VehicleError>> {
        let d: BodyDrag = serde_json::from_value(value)
            .map_err(|e| vec![VehicleError { path: "aero".into(), message: format!("not a body drag definition: {e}") }])?;
        let mut errors = Vec::new();
        for (name, xs) in [("cdBody", d.cd_body), ("areaM2", d.area_m2)] {
            for (i, x) in xs.iter().enumerate() {
                if !(x.is_finite() && *x > 0.0) {
                    errors.push(VehicleError { path: format!("aero.{name}[{i}]"), message: format!("must be a positive number (got {x})") });
                }
            }
        }
        if errors.is_empty() {
            Ok(d)
        } else {
            Err(errors)
        }
    }

    /// Drag force in world axes for attitude `q` and air density `rho`.
    /// Supply the world-axis air-relative velocity (body velocity minus local wind).
    pub fn force_world(&self, rho: f64, q: [f64; 4], air_velocity_world: Vec3) -> Vec3 {
        let vb = rotate_inverse(q, air_velocity_world);
        let f = |i: usize, v: f64| -0.5 * rho * self.cd_body[i] * self.area_m2[i] * v * v.abs();
        rotate(q, Vec3::new(f(0, vb.x), f(1, vb.y), f(2, vb.z)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const IDENTITY: [f64; 4] = [0.0, 0.0, 0.0, 1.0];

    fn drag() -> BodyDrag {
        BodyDrag { cd_body: [1.1, 1.2, 1.3], area_m2: [0.02, 0.03, 0.08] }
    }

    #[test]
    fn axis_aligned_flow_gives_the_hand_value_on_that_axis_only() {
        // v = 10 m/s along x: F_x = −½ · 1.225 · 1.1 · 0.02 · 100 = −1.3475 N.
        let f = drag().force_world(1.225, IDENTITY, Vec3::new(10.0, 0.0, 0.0));
        assert!((f.x + 1.3475).abs() < 1e-12, "{f:?}");
        assert_eq!((f.y, f.z), (0.0, 0.0));
        // Falling at 5 m/s: F_z = +½ · 1.225 · 1.3 · 0.08 · 25 = +1.5925 N.
        let f = drag().force_world(1.225, IDENTITY, Vec3::new(0.0, 0.0, -5.0));
        assert!((f.z - 1.5925).abs() < 1e-12);
    }

    #[test]
    fn a_yawed_body_uses_the_area_of_the_axis_facing_the_flow() {
        // Yaw +90°: body +y points along world −x, so flow along world x meets the body's y face.
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let q = [0.0, 0.0, s, s];
        let f = drag().force_world(1.225, q, Vec3::new(10.0, 0.0, 0.0));
        let expected = -0.5 * 1.225 * 1.2 * 0.03 * 100.0;
        assert!((f.x - expected).abs() < 1e-12, "{f:?}");
        assert!(f.y.abs() < 1e-12 && f.z.abs() < 1e-12);
    }

    #[test]
    fn drag_never_adds_energy() {
        let q = {
            let (a, b, c, d) = (0.3f64, -0.5, 0.7, 0.4);
            let n = (a * a + b * b + c * c + d * d).sqrt();
            [a / n, b / n, c / n, d / n]
        };
        for v in [Vec3::new(3.0, -4.0, 1.0), Vec3::new(-7.0, 0.5, 2.5), Vec3::new(0.1, 0.2, -9.0)] {
            assert!(drag().force_world(1.225, q, v).dot(v) <= 0.0);
        }
    }

    #[test]
    fn validation_paths() {
        assert!(BodyDrag::from_json(json!({"cdBody": [1, 1, 1], "areaM2": [0.1, 0.1, 0.1]})).is_ok());
        let e = BodyDrag::from_json(json!({"cdBody": [1, 0, 1], "areaM2": [0.1, 0.1, -1]})).unwrap_err();
        assert_eq!(e.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["aero.cdBody[1]", "aero.areaM2[2]"]);
        assert!(BodyDrag::from_json(json!({"cdBody": [1, 1, 1]})).is_err());
    }

    /// Same numbers as `bodyDragForce` in src/domain/aero.ts.
    #[test]
    fn matches_the_typescript_model_on_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/aero-cases.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let d = BodyDrag { cd_body: serde_json::from_value(c["cd"].clone()).unwrap(), area_m2: serde_json::from_value(c["area"].clone()).unwrap() };
            let q: [f64; 4] = serde_json::from_value(c["q"].clone()).unwrap();
            let v: [f64; 3] = serde_json::from_value(c["v"].clone()).unwrap();
            let x: [f64; 3] = serde_json::from_value(c["expected"].clone()).unwrap();
            let f = d.force_world(c["rho"].as_f64().unwrap(), q, Vec3::new(v[0], v[1], v[2]));
            for (a, b) in [(f.x, x[0]), (f.y, x[1]), (f.z, x[2])] {
                assert!((a - b).abs() <= 1e-12 * b.abs().max(1.0), "{c}: {f:?}");
            }
        }
    }
}
