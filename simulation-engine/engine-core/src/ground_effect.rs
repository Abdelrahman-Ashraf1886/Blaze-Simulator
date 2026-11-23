//! Single-rotor ground effect (Phase 6.2 model; 6.3 applies it in the flight step).
//!
//! G = T_g / T_∞, the thrust of one rotor near the ground over its thrust away
//! from it at the same shaft power. Interaction between rotors is **not**
//! modelled (plan D7), so for a multirotor the sign of the error is unknown.
//! Pure functions, no state: there is nothing to hash.
//!
//! # Source and equations
//!
//! I. C. Cheeseman and W. E. Bennett, "The Effect of the Ground on a Helicopter
//! Rotor in Forward Flight", ARC R&M 3021 (September 1955),
//! <https://naca.central.cranfield.ac.uk/handle/1826.2/3590>. Page numbers are
//! the printed ones; equations checked on the page images.
//!
//! - Section 2.1 (pp. 1-2): the rotor is a source of strength A·v/4π and the
//!   ground its image, 2Z away. The image induces δv = A·v/(16πZ²) = v·R²/(16Z²)
//!   at the rotor, against the inflow. At constant power T·v is constant (eq. 1),
//!   with v_g = v − δv, so eq. 2 (zero airspeed):
//!   T_g/T_∞ = 1 / (1 − R²/(16Z²)).
//! - Section 2.2 (p. 2): the flow leaves at θ = atan(V_i/v_i) from the rotor axis
//!   and the source becomes directional, (strength)·cos²α. Equating its flow over
//!   a sphere to k·A·u gives δu = 3k·A·u·cos²(θ + i)/(16πZ²) (eq. 3). With k = 1/3
//!   (chosen there to match eq. 2 at V = 0) and the disc incidence i neglected,
//!   cos²θ = 1/(1 + (V_i/v_i)²), so eq. 4:
//!   T_g/T_∞ = 1 / (1 − (1/16)(R/Z)² / (1 + (V_i/v_i)²)).
//! - Symbols (pp. 6-7): Z is the height of the rotor hub above the ground, V the
//!   aircraft speed, V_i = V√σ with σ the relative air density, and v_i = v√σ
//!   likewise (the list prints it without its subscript). Both are equivalent
//!   speeds, so √σ cancels: V_i/v_i = V/v. This module uses **true** airspeed and
//!   **true** induced velocity at the actual air density; a √σ on only one of them
//!   would be wrong.
//!
//! # The induced velocity v_i
//!
//! The report does not print an expression for v_i. It says the inflow follows
//! "either from momentum theory" or from an empirical curve (section 3, p. 3;
//! repeated on p. 4 for what is printed there as V_i/v_t). It separates v_i from
//! the hover value v_T = √(T/(2πρ₀R²)) (p. 7) and writes the inflow as η·v_T, η
//! "depending on forward speed" (p. 3). So forward speed does change v_i.
//!
//! Momentum theory here: H. Glauert, "A General Theory of the Autogyro", ARC R&M
//! 1111 (November 1926), p. 563, eq. 11, read on the page image,
//! <https://naca.central.cranfield.ac.uk/handle/1826.2/1434>:
//! v = T / (2πR²ρV'), V' the resultant of V and v. With the disc incidence
//! neglected, as in eq. 4 above, V'² = V² + v². Writing
//! v_h² = T/(2πρR²) (the hover value; v_T in true speed), s = (V/v_h)² and
//! w = (v/v_h)², that is w² + s·w = 1 (our algebra), whose positive root,
//! rationalised so that it loses no digits at large s, is
//! w = 2 / (s + √(s² + 4)),  v = v_h·√w.
//! It gives v = v_h at V = 0 and v → T/(2πR²ρV) at high speed, Glauert's two limits.
//!
//! The report's own Fig. 4 was not drawn with this expression: read off the scan,
//! its curves need v_i/v_T ≈ 1.2 to 1.3, 1.0 and 0.6 at V_i/v_T = 0.5, 1 and 2,
//! where momentum theory gives 0.94, 0.79 and 0.49; presumably they use its Ref. 3
//! (A. L. Oliver, C.P. 122), which we have not read. A constant v_i = v_T is
//! excluded by the same figure (its V_i/v_T = 2 curve). The effect is therefore
//! lost slightly faster with speed here than in Fig. 4 (at V = v_T, Z/R = 1: 1.024
//! against about 1.033). The report's flight tests initially fall off faster than
//! its theory too (p. 5).
//!
//! # Assumptions (ours unless a source is given)
//!
//! 1. v_i is the induced velocity **out of** ground effect, at T_∞ = k_T·ω².
//! 2. Uniform induced velocity over the disc (both sources), disc area πR² with R
//!    the propeller radius (no tip loss, no hub cut-out).
//! 3. Disc incidence and tilt are neglected (the report; the plan), so V is the
//!    horizontal airspeed, Z the vertical height, and climb or descent speed does
//!    not enter.
//! 4. Below Z/R = 0.5 the **height** is held at 0.5 and `below_tested_range` is set.
//!    The limit is the lower end of the single-rotor test of P. J. Sanchez-Cuevas,
//!    G. Heredia and A. Ollero, ROBOT 2017, <https://zenodo.org/record/2621464>
//!    (p. 5: a measured ratio of about 1.2 at Z/R of about 0.5). The hold is ours.
//!    It acts on Z/R only: the airspeed still reduces the ratio, because eq. 4's
//!    airspeed factor does not contain Z, and a held height is then an ordinary
//!    point of the same equation. The report gives no limit, only "for very small
//!    values of Z/R large errors are introduced" (p. 2).
//! 5. No upper height: eq. 4 tends to 1 by itself.
//! 6. G ≥ 1 always. Measurements collected in R. T. N. Chen, NASA TM 102219 (1989),
//!    p. 64-17, <https://ntrs.nasa.gov/citations/19900006622>, show an adverse
//!    ground effect above V/v_h ≈ 1 (at Z/R = 0.88); eq. 4 cannot give that.
//!
//! # Degenerate cases
//!
//! | Input | Result |
//! |---|---|
//! | thrust ≤ 0 (stopped, or reversed) | ratio 1, flag not set: there is no wake towards the ground, so neither source applies and no height is held. G·T is continuous there, because T → 0 |
//! | airspeed 0 | eq. 2 exactly, at any positive thrust |
//! | Z ≤ 0, or Z/R below 0.5 (so also eq. 2's pole at Z = R/4) | held at 0.5, flag set |
//! | Z/R exactly 0.5 | not held: it is inside the tested range |
//! | very large Z or V | 1 |
//! | non-finite input, R ≤ 0, ρ ≤ 0, airspeed < 0 | `InvalidInput`, never a silent 1 |
//!
//! Together: 1 ≤ G ≤ 4/3 for every accepted input.

use std::f64::consts::PI;

/// Z/R below which the height is held (assumption 4).
pub const MIN_HEIGHT_RATIO: f64 = 0.5;

/// One rotor at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RotorInput {
    /// Vertical height of the propeller hub above the ground or terrain, m. May be negative.
    pub hub_height_m: f64,
    /// Propeller radius, m, > 0.
    pub radius_m: f64,
    /// Magnitude of the hub's horizontal velocity through the air, m/s, ≥ 0. True airspeed.
    pub horizontal_airspeed_m_s: f64,
    /// Thrust out of ground effect, k_T ω², N, at `air_density_kg_m3`.
    pub thrust_n: f64,
    /// Actual air density, kg/m³, > 0.
    pub air_density_kg_m3: f64,
}

/// The thrust ratio of one rotor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroundEffect {
    /// T_g / T_∞, in [1, 4/3].
    pub ratio: f64,
    /// The height is below the tested range and Z/R = 0.5 was used instead.
    pub below_tested_range: bool,
}

/// Why an input was refused, with the value given.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InvalidInput {
    HubHeight(f64),
    Radius(f64),
    Airspeed(f64),
    Thrust(f64),
    AirDensity(f64),
}

impl std::fmt::Display for InvalidInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HubHeight(x) => write!(f, "the hub height must be a finite number (got {x})"),
            Self::Radius(x) => write!(f, "the rotor radius must be a positive number (got {x})"),
            Self::Airspeed(x) => write!(f, "the horizontal airspeed must be a finite number ≥ 0 (got {x})"),
            Self::Thrust(x) => write!(f, "the thrust must be a finite number (got {x})"),
            Self::AirDensity(x) => write!(f, "the air density must be a positive number (got {x})"),
        }
    }
}

impl std::error::Error for InvalidInput {}

/// G for one rotor (eq. 4; eq. 2 at zero airspeed). See the module header.
pub fn thrust_ratio(rotor: &RotorInput) -> Result<GroundEffect, InvalidInput> {
    let RotorInput { hub_height_m: z, radius_m: r, horizontal_airspeed_m_s: v, thrust_n: t, air_density_kg_m3: rho } = *rotor;
    if !z.is_finite() {
        return Err(InvalidInput::HubHeight(z));
    }
    if !(r.is_finite() && r > 0.0) {
        return Err(InvalidInput::Radius(r));
    }
    if !(v.is_finite() && v >= 0.0) {
        return Err(InvalidInput::Airspeed(v));
    }
    if !t.is_finite() {
        return Err(InvalidInput::Thrust(t));
    }
    if !(rho.is_finite() && rho > 0.0) {
        return Err(InvalidInput::AirDensity(rho));
    }

    if t <= 0.0 {
        return Ok(GroundEffect { ratio: 1.0, below_tested_range: false });
    }

    let height_ratio = z / r;
    let below_tested_range = height_ratio < MIN_HEIGHT_RATIO;
    let h = if below_tested_range { MIN_HEIGHT_RATIO } else { height_ratio };
    // The branch keeps 0/0 out when v_i underflows to 0; with v > 0 that gives ∞, i.e. G = 1.
    let speed_ratio = if v == 0.0 { 0.0 } else { v / induced_velocity(t, r, rho, v) };
    let ratio = 1.0 / (1.0 - 1.0 / (16.0 * h * h) / (1.0 + speed_ratio * speed_ratio));
    Ok(GroundEffect { ratio, below_tested_range })
}

/// Glauert's induced velocity with the disc edge-on to `v` (module header), m/s.
/// Needs t, r, rho > 0 and v ≥ 0.
fn induced_velocity(t: f64, r: f64, rho: f64, v: f64) -> f64 {
    let hover = (t / (2.0 * PI * rho * r * r)).sqrt();
    let q = v / hover;
    let s = q * q;
    hover * (2.0 / (s + (s * s + 4.0).sqrt())).sqrt()
}

#[cfg(test)]
mod tests;
