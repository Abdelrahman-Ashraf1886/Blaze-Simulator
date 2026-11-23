// Copyright (c) 2016-2019, 2020-2022 PX4 Development Team.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
// 1. Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright
// notice, this list of conditions and the following disclaimer in
// the documentation and/or other materials provided with the
// distribution.
// 3. Neither the name PX4 nor the names of its contributors may be
// used to endorse or promote products derived from this software
// without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
// FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
// COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
// INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
// BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
// OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
// AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
// LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
// ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

//! PX4 v1.13.3 hover thrust estimation for synchronous simulation samples.
//! EKF and module citations below are relative to `src/modules/mc_hover_thrust_estimator/`.
//! In `MulticopterHoverThrustEstimator.cpp:173-182` PX4 negates NED world
//! acceleration and thrust-z before fusion. In engine-core, upward acceleration
//! and upward thrust already have positive Z. Pass the world Z projection of the
//! normalized collective thrust setpoint, including when the vehicle tilts.
//! Pass net world Z acceleration, which is zero at hover and negative in free
//! fall. Gravity contributes `-g` to the observation model. The estimated hover
//! thrust is a positive normalized magnitude.
//! Vertical velocity reverses sign from NED to Z-up and enters as a magnitude.
//! Horizontal speed and height above ground are magnitudes in both frames.

use crate::math::STANDARD_GRAVITY as G; // PX4 src/lib/geo/geo.h:54

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoverThrustParams {
    /// Normalized thrust/s. hover_thrust_estimator_params.c:50-55.
    pub hte_ht_noise: f64,
    /// Innovation gate, standard deviations. hover_thrust_estimator_params.c:64-69.
    pub hte_acc_gate: f64,
    /// Initial hover thrust standard deviation. hover_thrust_estimator_params.c:78-83.
    pub hte_ht_err_init: f64,
    /// Horizontal speed threshold, m/s. hover_thrust_estimator_params.c:94-99.
    pub hte_vxy_thr: f64,
    /// Vertical speed threshold, m/s. hover_thrust_estimator_params.c:110-115.
    pub hte_vz_thr: f64,
    /// Permitted deviation from nominal. hover_thrust_estimator_params.c:127-132.
    pub hte_thr_range: f64,
    /// Initial and fixed hover thrust. src/modules/mc_pos_control/mc_pos_control_params.c:69-75.
    pub mpc_thr_hover: f64,
    /// Select valid estimates for control. Same file, lines 78-86.
    pub mpc_use_hte: bool,
}

impl Default for HoverThrustParams {
    fn default() -> Self {
        Self {
            hte_ht_noise: 0.0036,
            hte_acc_gate: 3.0,
            hte_ht_err_init: 0.1,
            hte_vxy_thr: 10.0,
            hte_vz_thr: 2.0,
            hte_thr_range: 0.2,
            mpc_thr_hover: 0.5,
            mpc_use_hte: true,
        }
    }
}

impl HoverThrustParams {
    /// Inclusive parameter bounds from the field citations above.
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, min, max) in [
            ("HTE_HT_NOISE", self.hte_ht_noise, 0.0001, 1.0),
            ("HTE_ACC_GATE", self.hte_acc_gate, 1.0, 10.0),
            ("HTE_HT_ERR_INIT", self.hte_ht_err_init, 0.0, 1.0),
            ("HTE_VXY_THR", self.hte_vxy_thr, 1.0, 20.0),
            ("HTE_VZ_THR", self.hte_vz_thr, 1.0, 10.0),
            ("HTE_THR_RANGE", self.hte_thr_range, 0.01, 0.4),
            ("MPC_THR_HOVER", self.mpc_thr_hover, 0.1, 0.8),
        ] {
            if !(min..=max).contains(&value) {
                return Err(format!("{name} must be in [{min}, {max}]"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HoverThrustSample {
    /// Simulation time of a synchronous position and thrust setpoint sample.
    /// Time is measured from simulation start and must be monotonic.
    pub timestamp_us: u64,
    pub armed: bool,
    /// Ground contact supplied by the simulation.
    pub landed: bool,
    pub distance_above_ground_m: f64,
    pub vertical_acceleration_up_m_s2: f64,
    pub vertical_thrust_up: f64,
    pub vertical_velocity_up_m_s: f64,
    /// Magnitude of the world XY velocity, m/s.
    pub horizontal_speed_m_s: f64,
}

/// Current filter state (MulticopterHoverThrustEstimator.cpp:222-230).
/// The snapshot always contains the filter state. PX4 also publishes a
/// separate NaN status on invalidation (MulticopterHoverThrustEstimator.cpp:198-210,237-250).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoverThrustEstimate {
    pub hover_thrust: f64,
    /// Squared normalized thrust.
    pub variance: f64,
    pub valid: bool,
}

#[derive(Debug, Clone)]
pub struct HoverThrustEstimator {
    params: HoverThrustParams,
    state: HoverThrustEstimate,
    accel_variance: f64,
    residual_lpf: f64,
    signed_ratio_lpf: f64,
    last_timestamp_us: u64,
    in_air: bool,
    valid_since_us: Option<u64>,
}

// zero_order_hover_thrust_ekf.hpp:76,104
const INITIAL_ACCEL_VARIANCE: f64 = 5.0;

impl HoverThrustEstimator {
    pub fn new(params: HoverThrustParams) -> Result<Self, String> {
        params.validate()?;
        // MulticopterHoverThrustEstimator.cpp:50-52,70-75;
        // MulticopterHoverThrustEstimator.hpp:108-116; zero_order_hover_thrust_ekf.hpp:81-84,112-113.
        Ok(Self {
            params,
            state: HoverThrustEstimate {
                hover_thrust: params.mpc_thr_hover,
                variance: params.hte_ht_err_init.powi(2),
                valid: false,
            },
            accel_variance: INITIAL_ACCEL_VARIANCE,
            residual_lpf: 0.0,
            signed_ratio_lpf: 0.0,
            last_timestamp_us: 0,
            in_air: false,
            valid_since_us: None,
        })
    }

    /// MulticopterHoverThrustEstimator.cpp:77-94. Changing the initial error
    /// reseeds the covariance in flight. The nominal thrust takes effect on reset.
    pub fn set_params(&mut self, params: HoverThrustParams) -> Result<(), String> {
        params.validate()?;
        if (params.hte_ht_err_init - self.params.hte_ht_err_init).abs() > f32::EPSILON as f64 {
            self.state.variance = params.hte_ht_err_init.powi(2);
        }
        self.params = params;
        Ok(())
    }

    pub fn estimate(&self) -> HoverThrustEstimate {
        self.state
    }

    /// Optional estimate for a controller initialized with MPC_THR_HOVER.
    /// MulticopterPositionControl.cpp:229-232,327-334 in src/modules/mc_pos_control.
    /// MPC_USE_HTE selects consumption; the EKF continues estimating in either setting.
    pub fn controller_update(&self) -> Option<f64> {
        (self.params.mpc_use_hte && self.state.valid).then_some(self.state.hover_thrust)
    }

    pub fn step(&mut self, sample: HoverThrustSample) -> HoverThrustEstimate {
        // MulticopterHoverThrustEstimator.cpp:104-114,123-134,154-167.
        if sample.landed {
            self.in_air = false;
        } else if sample.distance_above_ground_m > 1.0 {
            self.in_air = true;
        }
        let dt_us = sample.timestamp_us.saturating_sub(self.last_timestamp_us);
        self.last_timestamp_us = sample.timestamp_us;
        if !(sample.armed
            && self.in_air
            && dt_us > 1_000
            && dt_us < 1_000_000
            && sample.vertical_acceleration_up_m_s2.is_finite())
        {
            // MulticopterHoverThrustEstimator.cpp:198-211,70-75. Armed on the
            // ground freezes the filter. Disarming resets exactly these three values.
            self.invalidate();
            if !sample.armed {
                self.state.hover_thrust = self.params.mpc_thr_hover;
                self.state.variance = self.params.hte_ht_err_init.powi(2);
                self.accel_variance = INITIAL_ACCEL_VARIANCE;
            }
            return self.state;
        }

        let dt = dt_us as f64 * 1e-6;
        // zero_order_hover_thrust_ekf.cpp:44-50; .hpp:82. Constant-state prediction.
        let process_increment = (self.params.hte_ht_noise * dt).powi(2);
        self.state.variance += process_increment;
        if sample.vertical_thrust_up.is_finite() {
            // MulticopterHoverThrustEstimator.cpp:172-192; zero_order_hover_thrust_ekf.hpp:83.
            let speed_excess = (sample.vertical_velocity_up_m_s.abs() - self.params.hte_vz_thr)
                .max(sample.horizontal_speed_m_s - self.params.hte_vxy_thr);
            let scale = (1.0 + speed_excess).max(1.0);
            let ratio = self.fuse(sample, dt, process_increment, scale);
            if self.state.variance < 0.001
                && ratio.is_some_and(|ratio| self.state.valid || ratio < 1.0)
            {
                // MulticopterHoverThrustEstimator.cpp:50,184-192,198-210.
                // The transition from invalid to valid is delayed by two seconds.
                let since = self.valid_since_us.get_or_insert(sample.timestamp_us);
                self.state.valid = sample.timestamp_us - *since >= 2_000_000;
            } else {
                self.invalidate();
            }
        }
        self.state
    }

    fn invalidate(&mut self) {
        self.state.valid = false;
        self.valid_since_us = None;
    }

    /// zero_order_hover_thrust_ekf.cpp:52-81,84-139. Positive-up observation
    /// a = g*T/h - g and its (negative for positive thrust) derivative d(a)/dh.
    fn fuse(
        &mut self,
        sample: HoverThrustSample,
        dt: f64,
        process_increment: f64,
        scale: f64,
    ) -> Option<f64> {
        let thrust_g = G * sample.vertical_thrust_up;
        let acceleration = sample.vertical_acceleration_up_m_s2;
        let hover = self.state.hover_thrust;
        let h = -thrust_g / hover.powi(2);
        let prior = self.state.variance;
        let r = self.accel_variance * scale.powi(2);
        let s = (h * prior * h + r).max(r);
        let innovation = acceleration - (thrust_g / hover - G);
        let ratio = innovation.powi(2) / (self.params.hte_acc_gate.powi(2) * s);
        if !ratio.is_finite() {
            return None;
        }
        let mut residual = innovation;
        if ratio < 1.0 {
            let k = prior * h / s;
            // MulticopterHoverThrustEstimator.cpp:90-93.
            let lower = (self.params.mpc_thr_hover - self.params.hte_thr_range).clamp(0.0, 0.8);
            let upper = (self.params.mpc_thr_hover + self.params.hte_thr_range).clamp(0.2, 0.9);
            let posterior = (hover + k * innovation).clamp(lower, upper);
            residual = acceleration - (thrust_g / posterior - G);
            // The allowed lower bound can be zero. Reject an undefined model
            // evaluation before it can contaminate subsequent samples.
            if !residual.is_finite() {
                return None;
            }
            self.state.hover_thrust = posterior;
            self.state.variance = ((1.0 - k * h) * prior).clamp(1e-10, 1.0);
        } else if self.signed_ratio_lpf.abs() > 0.2 {
            self.state.variance += 1e3 * process_increment;
        }
        // zero_order_hover_thrust_ekf.cpp:142-156, .hpp:112-113,137-138.
        // Learn from the post-update residual using the pre-update Jacobian
        // and post-update covariance, including on rejected observations.
        let alpha = dt / (1.0 + dt);
        self.residual_lpf = (1.0 - alpha) * self.residual_lpf + alpha * residual;
        let signed_ratio = innovation.signum() * ratio.min(1.0);
        self.signed_ratio_lpf = (1.0 - alpha) * self.signed_ratio_lpf + alpha * signed_ratio;
        let noise_alpha = dt / (2.0 + dt);
        let unbiased = residual - self.residual_lpf;
        self.accel_variance = ((1.0 - noise_alpha) * self.accel_variance
            + noise_alpha * (unbiased.powi(2) + h * self.state.variance * h))
            .clamp(1.0, 400.0);
        Some(ratio)
    }
}

#[cfg(test)]
mod tests;
