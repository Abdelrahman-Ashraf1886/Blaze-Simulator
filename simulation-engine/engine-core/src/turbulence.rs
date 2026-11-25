//! Low-altitude Dryden, MIL-F-8785C form. The 10–1000 ft range for the
//! lengths was read in the standard (phase-6-flight-environment.md:143).
//! The spectra, intensity and length formulas below use the secondary
//! MathWorks source (plan:153–168); the filters come from those spectra.
//! Compute h and L in feet, with 1 ft = 0.3048 m (wind.rs), then convert
//! L back to metres. W20 and sigma can both be in m/s. W20 is the shear
//! input at 20 ft or the constant mean speed.
//!
//! Freeze the parameters over each step and let r = ds/L, with
//! ds = |v - w_mean| dt (plan:178–181). Per unit r, the longitudinal
//! state satisfies dX = -X dr + sqrt(2) dB with unit Brownian variance.
//! Hence F = exp(-r), Q = 1 - exp(-2r), and the output is sigma X.
//! For each transverse axis use A = [[-2,-1],[1,0]], B = [2,0]^T and
//! C = [sqrt(3),1]/2. Then C(sI-A)^(-1)B = (1 + sqrt(3)s)/(1+s)^2.
//! A + I squares to zero, so F = exp(-r) [[1-r,-r],[r,1+r]].
//! A + A^T + BB^T = 0, so the stationary covariance is I and the exact
//! innovation covariance is Q = integral(exp(tA) BB^T exp(tA)^T, 0..r)
//! = I - FF^T. The output sigma C X has variance sigma². This uses the
//! continuous white-noise covariance directly in place of Madden's
//! zero-order hold on the noise input. At r=0, F=I and Q=0.

use rapier3d_f64::na::ComplexField;
use std::f64::consts::TAU;

use crate::wind::METRES_PER_FOOT;

pub(crate) const MIN_HEIGHT_M: f64 = 10.0 * METRES_PER_FOOT;
pub(crate) const MAX_HEIGHT_M: f64 = 1000.0 * METRES_PER_FOOT;

#[derive(Clone, Copy)]
pub(crate) struct Parameters {
    length_m: [f64; 3],
    sigma_mps: [f64; 3],
    pub(crate) below_range: bool,
    pub(crate) above_range: bool,
}

impl Parameters {
    pub(crate) fn at_height(height_m: f64, w20_mps: f64) -> Self {
        let h_ft = height_m.clamp(MIN_HEIGHT_M, MAX_HEIGHT_M) / METRES_PER_FOOT;
        let scale = 0.177 + 0.000823 * h_ft;
        let horizontal_length_m = h_ft / ComplexField::powf(scale, 1.2) * METRES_PER_FOOT;
        let vertical_sigma = 0.1 * w20_mps;
        let horizontal_sigma = vertical_sigma / ComplexField::powf(scale, 0.4);
        Self {
            length_m: [horizontal_length_m, horizontal_length_m, h_ft * METRES_PER_FOOT],
            sigma_mps: [horizontal_sigma, horizontal_sigma, vertical_sigma],
            below_range: height_m < MIN_HEIGHT_M,
            above_range: height_m > MAX_HEIGHT_M,
        }
    }
}

/// SplitMix64, Steele, Lea and Flood, "Fast Splittable Pseudorandom Number
/// Generators" (2014), fixed-increment variant by Sebastiano Vigna.
/// Constants and transition from https://prng.di.unimi.it/splitmix64.c.
#[derive(Debug, Clone, Copy, PartialEq)]
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let z = (self.0 ^ (self.0 >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        let z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn open_unit(&mut self) -> f64 {
        // Midpoints of the 2^52 equal bins, exactly representable and in (0, 1).
        ((self.next() >> 12) as f64 + 0.5) / (1_u64 << 52) as f64
    }

    fn normals(&mut self) -> [f64; 5] {
        // Box and Muller (1958), "A Note on the Generation of Random Normal
        // Deviates". Draw three pairs every time and discard the sixth value.
        // Rapier's enhanced-determinism enables Simba's libm_force for the
        // ComplexField f64 methods (engine-core/Cargo.toml:13).
        let mut pair = || {
            let radius = ComplexField::sqrt(-2.0 * ComplexField::ln(self.open_unit()));
            let (sin, cos) = ComplexField::sin_cos(TAU * self.open_unit());
            [radius * cos, radius * sin]
        };
        let [u, vx] = pair();
        let [vy, wx] = pair();
        let [wy, _] = pair();
        [u, vx, vy, wx, wy]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DrydenState {
    rng: SplitMix64,
    u: f64,
    v: [f64; 2],
    w: [f64; 2],
}

impl DrydenState {
    pub(crate) fn new(seed: u64) -> Self {
        let mut rng = SplitMix64(seed);
        let [u, vx, vy, wx, wy] = rng.normals();
        Self { rng, u, v: [vx, vy], w: [wx, wy] }
    }

    pub(crate) fn velocity(self, parameters: Parameters) -> [f64; 3] {
        let project = |[x, y]: [f64; 2]| (ComplexField::sqrt(3.0_f64) * x + y) / 2.0;
        let [su, sv, sw] = parameters.sigma_mps;
        [su * self.u, sv * project(self.v), sw * project(self.w)]
    }

    pub(crate) fn advance(&mut self, step: Option<(f64, Parameters)>) {
        let noise = self.rng.normals();
        let Some((ds_m, parameters)) = step else { return };
        if ds_m == 0.0 {
            return;
        }
        let [lu, lv, lw] = parameters.length_m;
        let [u, vx, vy, wx, wy] = noise;
        let r = ds_m / lu;
        self.u = ComplexField::exp(-r) * self.u + ComplexField::sqrt(-ComplexField::exp_m1(-2.0 * r)) * u;
        self.v = transverse(ds_m / lv, self.v, [vx, vy]);
        self.w = transverse(ds_m / lw, self.w, [wx, wy]);
    }

    pub(crate) fn hash_words(self) -> [u64; 6] {
        let [vx, vy] = self.v;
        let [wx, wy] = self.w;
        [self.rng.0, self.u.to_bits(), vx.to_bits(), vy.to_bits(), wx.to_bits(), wy.to_bits()]
    }
}

fn transverse(r: f64, [x, y]: [f64; 2], [nx, ny]: [f64; 2]) -> [f64; 2] {
    if r == 0.0 {
        return [x, y];
    }
    let decay = ComplexField::exp(-r);
    let lag = r * decay;
    let one_minus_decay_squared = -ComplexField::exp_m1(-2.0 * r);
    // Cholesky of Q. For 2r <= 1 scale out the powers of r and expand the
    // integral Qyy = 4 integral(t² exp(-2t), 0..r) to avoid cancellation.
    let (lxx, lyx, lyy) = if 2.0 * r <= 1.0 {
        let decay_squared = decay * decay;
        let root = ComplexField::sqrt(r);
        let xx = ComplexField::sqrt(one_minus_decay_squared / r + 2.0 * (1.0 - r) * decay_squared);
        let yx = 2.0 * decay_squared / xx;
        let yy = ComplexField::sqrt(integrated_exp(-2.0 * r) - yx * yx);
        (root * xx, r * root * yx, r * root * yy)
    } else {
        let xx = ComplexField::sqrt(one_minus_decay_squared + 2.0 * lag * (decay - lag));
        let yx = 2.0 * lag * lag / xx;
        let yy = ComplexField::sqrt(one_minus_decay_squared - 2.0 * lag * (decay + lag) - yx * yx);
        (xx, yx, yy)
    };
    [(decay - lag) * x - lag * y + lxx * nx,
        lag * x + (decay + lag) * y + lyx * nx + lyy * ny]
}

fn integrated_exp(z: f64) -> f64 {
    // 4 sum(z^k / (k! (k + 3)), k=0..), alternating for -1 <= z <= 0.
    let mut sum = 4.0 / 3.0;
    let mut term = 4.0;
    let mut k = 0.0;
    loop {
        k += 1.0;
        term *= z / k;
        let next = sum + term / (k + 3.0);
        if next == sum {
            return sum;
        }
        sum = next;
    }
}

#[cfg(test)]
mod tests;
