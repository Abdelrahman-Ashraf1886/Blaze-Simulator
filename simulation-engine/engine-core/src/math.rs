//! Foundational math types.
//!
//! Conventions (fixed for the whole engine):
//! - SI units everywhere (m, s, kg, N, rad).
//! - World frame is right-handed and Z-up: +X forward, +Y left, +Z up.
//!   Gravity is (0, 0, -g). (Conversion to NED for a future PX4 bridge is
//!   done at that boundary, not inside the engine.)
//! - `f64` for all state to keep long integrations numerically stable.

use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

/// Standard gravity, m/s² (CGPM 1901 conventional value).
pub const STANDARD_GRAVITY: f64 = 9.806_65;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    /// Unit vector, or `None` for a (near-)zero vector.
    pub fn normalized(self) -> Option<Vec3> {
        let n = self.norm();
        (n > f64::EPSILON).then(|| self / n)
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) {
        *self = *self + o;
    }
}
impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl SubAssign for Vec3 {
    fn sub_assign(&mut self, o: Vec3) {
        *self = *self - o;
    }
}
impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}
impl Div<f64> for Vec3 {
    type Output = Vec3;
    fn div(self, s: f64) -> Vec3 {
        Vec3::new(self.x / s, self.y / s, self.z / s)
    }
}
impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_follows_right_hand_rule() {
        let x = Vec3::new(1.0, 0.0, 0.0);
        let y = Vec3::new(0.0, 1.0, 0.0);
        assert_eq!(x.cross(y), Vec3::new(0.0, 0.0, 1.0));
        assert_eq!(y.cross(x), Vec3::new(0.0, 0.0, -1.0));
    }

    #[test]
    fn dot_and_norm() {
        let v = Vec3::new(3.0, 4.0, 12.0);
        assert_eq!(v.dot(v), 169.0);
        assert_eq!(v.norm(), 13.0);
    }

    #[test]
    fn normalized_handles_zero() {
        assert!(Vec3::ZERO.normalized().is_none());
        let n = Vec3::new(0.0, 0.0, 5.0).normalized().unwrap();
        assert_eq!(n, Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn arithmetic_ops() {
        let mut a = Vec3::new(1.0, 2.0, 3.0);
        a += Vec3::new(1.0, 1.0, 1.0);
        a -= Vec3::new(0.5, 0.5, 0.5);
        assert_eq!(a * 2.0, Vec3::new(3.0, 5.0, 7.0));
        assert_eq!(-a, Vec3::new(-1.5, -2.5, -3.5));
    }
}
