//! Pure deterministic PX4 v1.13.3-style controller; no true CoM or inertia input.
//!
//! Algorithm references:
//! <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/AttitudeControl/AttitudeControl.cpp>,
//! <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/RateControl/RateControl.cpp>,
//! <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_pos_control/PositionControl/PositionControl.cpp>.
//! FRD -> FLU is diag(1,-1,-1): pitch/yaw rates, errors and torques negate,
//! roll is unchanged. NED -> Z-up uses the same rotation: z/vz negate.
//! Quaternion vectors map (x,y,z)->(x,-y,-z), scalar w is unchanged.
//! Rotation-equivariant attitude/rate equations are evaluated directly in FLU.
//! Collective here is positive UP, the negative of PX4 NED thrust-z.
//! CW/CCW are viewed from above the rotor: CW reaction is along +thrust axis.
//!
//! The caller supplies attitude and velocity estimates. PositionControl owns
//! the vertical PID and filtered velocity derivative. ClosedLoop supplies its
//! hover estimate after stepping the plant. ACRO limits apply to rate mode.

#[cfg(test)]
use crate::math::STANDARD_GRAVITY as G;
use crate::position_control::{PositionControl, VerticalGains};
use crate::vehicle::{MotorBody, Quat, Spin};
use rapier3d_f64::math::{Rotation, Vector};
use serde::{Deserialize, Serialize};

/// Editable source-unit parameters (rate limits in degrees/s).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Gains {
    /// `MC_ROLL_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L53>.
    pub mc_roll_p: f64,
    /// `MC_PITCH_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L66>.
    pub mc_pitch_p: f64,
    /// `MC_YAW_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L79>.
    pub mc_yaw_p: f64,
    /// `MC_YAW_WEIGHT`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L97>.
    pub mc_yaw_weight: f64,
    /// `MC_ROLLRATE_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L116>.
    pub mc_rollrate_max: f64,
    /// `MC_PITCHRATE_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L135>.
    pub mc_pitchrate_max: f64,
    /// `MC_YAWRATE_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_att_control/mc_att_control_params.c#L147>.
    pub mc_yawrate_max: f64,
    /// `MC_ROLLRATE_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L53>.
    pub mc_rollrate_p: f64,
    /// `MC_ROLLRATE_I`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L65>.
    pub mc_rollrate_i: f64,
    /// `MC_RR_INT_LIM`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L77>.
    pub mc_rr_int_lim: f64,
    /// `MC_ROLLRATE_D`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L90>.
    pub mc_rollrate_d: f64,
    /// `MC_ROLLRATE_FF`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L101>.
    pub mc_rollrate_ff: f64,
    /// `MC_ROLLRATE_K`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L121>.
    pub mc_rollrate_k: f64,
    /// `MC_PITCHRATE_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L134>.
    pub mc_pitchrate_p: f64,
    /// `MC_PITCHRATE_I`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L146>.
    pub mc_pitchrate_i: f64,
    /// `MC_PR_INT_LIM`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L158>.
    pub mc_pr_int_lim: f64,
    /// `MC_PITCHRATE_D`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L170>.
    pub mc_pitchrate_d: f64,
    /// `MC_PITCHRATE_FF`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L181>.
    pub mc_pitchrate_ff: f64,
    /// `MC_PITCHRATE_K`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L201>.
    pub mc_pitchrate_k: f64,
    /// `MC_YAWRATE_P`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L214>.
    pub mc_yawrate_p: f64,
    /// `MC_YAWRATE_I`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L226>.
    pub mc_yawrate_i: f64,
    /// `MC_YR_INT_LIM`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L238>.
    pub mc_yr_int_lim: f64,
    /// `MC_YAWRATE_D`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L250>.
    pub mc_yawrate_d: f64,
    /// `MC_YAWRATE_FF`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L262>.
    pub mc_yawrate_ff: f64,
    /// `MC_YAWRATE_K`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L282>.
    pub mc_yawrate_k: f64,
    /// `MC_ACRO_R_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L296>.
    pub mc_acro_r_max: f64,
    /// `MC_ACRO_P_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L310>.
    pub mc_acro_p_max: f64,
    /// `MC_ACRO_Y_MAX`: <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/mc_rate_control/mc_rate_control_params.c#L324>.
    pub mc_acro_y_max: f64,
    #[serde(flatten)]
    pub vertical: VerticalGains,
}
impl std::ops::Deref for Gains {
    type Target = VerticalGains;
    fn deref(&self) -> &VerticalGains { &self.vertical }
}
impl std::ops::DerefMut for Gains {
    fn deref_mut(&mut self) -> &mut VerticalGains { &mut self.vertical }
}
impl Gains {
    pub fn px4_v1_13_3() -> Self {
        Self {
            mc_roll_p: 6.5,
            mc_pitch_p: 6.5,
            mc_yaw_p: 2.8,
            mc_yaw_weight: 0.4,
            mc_rollrate_max: 220.0,
            mc_pitchrate_max: 220.0,
            mc_yawrate_max: 200.0,
            mc_rollrate_p: 0.15,
            mc_rollrate_i: 0.2,
            mc_rr_int_lim: 0.3,
            mc_rollrate_d: 0.003,
            mc_rollrate_ff: 0.0,
            mc_rollrate_k: 1.0,
            mc_pitchrate_p: 0.15,
            mc_pitchrate_i: 0.2,
            mc_pr_int_lim: 0.3,
            mc_pitchrate_d: 0.003,
            mc_pitchrate_ff: 0.0,
            mc_pitchrate_k: 1.0,
            mc_yawrate_p: 0.2,
            mc_yawrate_i: 0.1,
            mc_yr_int_lim: 0.3,
            mc_yawrate_d: 0.0,
            mc_yawrate_ff: 0.0,
            mc_yawrate_k: 1.0,
            mc_acro_r_max: 720.0,
            mc_acro_p_max: 720.0,
            mc_acro_y_max: 540.0,
            vertical: VerticalGains::px4_v1_13_3(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if !self.mc_roll_p.is_finite() || self.mc_roll_p < 0.0 {
            return Err("MC_ROLL_P must be finite and nonnegative".into());
        }
        if !self.mc_pitch_p.is_finite() || self.mc_pitch_p < 0.0 {
            return Err("MC_PITCH_P must be finite and nonnegative".into());
        }
        if !self.mc_yaw_p.is_finite() || self.mc_yaw_p < 0.0 {
            return Err("MC_YAW_P must be finite and nonnegative".into());
        }
        if !self.mc_yaw_weight.is_finite() || self.mc_yaw_weight < 0.0 {
            return Err("MC_YAW_WEIGHT must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_max.is_finite() || self.mc_rollrate_max < 0.0 {
            return Err("MC_ROLLRATE_MAX must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_max.is_finite() || self.mc_pitchrate_max < 0.0 {
            return Err("MC_PITCHRATE_MAX must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_max.is_finite() || self.mc_yawrate_max < 0.0 {
            return Err("MC_YAWRATE_MAX must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_p.is_finite() || self.mc_rollrate_p < 0.0 {
            return Err("MC_ROLLRATE_P must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_i.is_finite() || self.mc_rollrate_i < 0.0 {
            return Err("MC_ROLLRATE_I must be finite and nonnegative".into());
        }
        if !self.mc_rr_int_lim.is_finite() || self.mc_rr_int_lim < 0.0 {
            return Err("MC_RR_INT_LIM must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_d.is_finite() || self.mc_rollrate_d < 0.0 {
            return Err("MC_ROLLRATE_D must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_ff.is_finite() || self.mc_rollrate_ff < 0.0 {
            return Err("MC_ROLLRATE_FF must be finite and nonnegative".into());
        }
        if !self.mc_rollrate_k.is_finite() || self.mc_rollrate_k < 0.0 {
            return Err("MC_ROLLRATE_K must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_p.is_finite() || self.mc_pitchrate_p < 0.0 {
            return Err("MC_PITCHRATE_P must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_i.is_finite() || self.mc_pitchrate_i < 0.0 {
            return Err("MC_PITCHRATE_I must be finite and nonnegative".into());
        }
        if !self.mc_pr_int_lim.is_finite() || self.mc_pr_int_lim < 0.0 {
            return Err("MC_PR_INT_LIM must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_d.is_finite() || self.mc_pitchrate_d < 0.0 {
            return Err("MC_PITCHRATE_D must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_ff.is_finite() || self.mc_pitchrate_ff < 0.0 {
            return Err("MC_PITCHRATE_FF must be finite and nonnegative".into());
        }
        if !self.mc_pitchrate_k.is_finite() || self.mc_pitchrate_k < 0.0 {
            return Err("MC_PITCHRATE_K must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_p.is_finite() || self.mc_yawrate_p < 0.0 {
            return Err("MC_YAWRATE_P must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_i.is_finite() || self.mc_yawrate_i < 0.0 {
            return Err("MC_YAWRATE_I must be finite and nonnegative".into());
        }
        if !self.mc_yr_int_lim.is_finite() || self.mc_yr_int_lim < 0.0 {
            return Err("MC_YR_INT_LIM must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_d.is_finite() || self.mc_yawrate_d < 0.0 {
            return Err("MC_YAWRATE_D must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_ff.is_finite() || self.mc_yawrate_ff < 0.0 {
            return Err("MC_YAWRATE_FF must be finite and nonnegative".into());
        }
        if !self.mc_yawrate_k.is_finite() || self.mc_yawrate_k < 0.0 {
            return Err("MC_YAWRATE_K must be finite and nonnegative".into());
        }
        if !self.mc_acro_r_max.is_finite() || self.mc_acro_r_max < 0.0 {
            return Err("MC_ACRO_R_MAX must be finite and nonnegative".into());
        }
        if !self.mc_acro_p_max.is_finite() || self.mc_acro_p_max < 0.0 {
            return Err("MC_ACRO_P_MAX must be finite and nonnegative".into());
        }
        if !self.mc_acro_y_max.is_finite() || self.mc_acro_y_max < 0.0 {
            return Err("MC_ACRO_Y_MAX must be finite and nonnegative".into());
        }
        if !self.mpc_z_p.is_finite() || self.mpc_z_p < 0.0 {
            return Err("MPC_Z_P must be finite and nonnegative".into());
        }
        if !self.mpc_z_vel_p_acc.is_finite() || self.mpc_z_vel_p_acc < 0.0 {
            return Err("MPC_Z_VEL_P_ACC must be finite and nonnegative".into());
        }
        if !self.mpc_z_vel_i_acc.is_finite() || self.mpc_z_vel_i_acc < 0.0 {
            return Err("MPC_Z_VEL_I_ACC must be finite and nonnegative".into());
        }
        if !self.mpc_z_vel_d_acc.is_finite() || self.mpc_z_vel_d_acc < 0.0 {
            return Err("MPC_Z_VEL_D_ACC must be finite and nonnegative".into());
        }
        if !self.mpc_thr_hover.is_finite() || self.mpc_thr_hover < 0.0 {
            return Err("MPC_THR_HOVER must be finite and nonnegative".into());
        }
        if !self.mpc_use_hte.is_finite() || self.mpc_use_hte < 0.0 {
            return Err("MPC_USE_HTE must be finite and nonnegative".into());
        }
        if !self.mpc_thr_min.is_finite() || self.mpc_thr_min < 0.0 {
            return Err("MPC_THR_MIN must be finite and nonnegative".into());
        }
        if !self.mpc_thr_max.is_finite() || self.mpc_thr_max < 0.0 {
            return Err("MPC_THR_MAX must be finite and nonnegative".into());
        }
        if !self.mpc_z_vel_max_up.is_finite() || self.mpc_z_vel_max_up < 0.0 {
            return Err("MPC_Z_VEL_MAX_UP must be finite and nonnegative".into());
        }
        if !self.mpc_z_vel_max_dn.is_finite() || self.mpc_z_vel_max_dn < 0.0 {
            return Err("MPC_Z_VEL_MAX_DN must be finite and nonnegative".into());
        }
        if self.mc_yaw_weight > 1.0
            || self.mpc_thr_hover <= 0.0
            || self.mpc_thr_min > self.mpc_thr_hover
            || self.mpc_thr_hover > self.mpc_thr_max
            || self.mpc_thr_max > 1.0
        {
            return Err(
                "require yaw weight <= 1 and 0 <= min <= hover <= max <= 1, hover > 0".into(),
            );
        }
        Ok(())
    }
}
fn q(a: Quat) -> Rotation {
    Rotation::from_xyzw(a[0], a[1], a[2], a[3]).normalize()
}
fn canonical(a: Rotation) -> Rotation {
    // Tie break at exactly 180 degrees also makes q and -q identical.
    let first = [a.w, a.x, a.y, a.z]
        .into_iter()
        .find(|x| *x != 0.0)
        .unwrap_or(1.0);
    if first < 0.0 {
        -a
    } else {
        a
    }
}
/// PX4 reduced-attitude yaw weighting (including yaw P compensation).
/// yaw_rate is feedforward about world +Z, rad/s. Quaternions x,y,z,w.
pub fn attitude_rates(g: &Gains, attitude: Quat, desired: Quat, yaw_rate: f64) -> [f64; 3] {
    let (current, target) = (q(attitude), q(desired));
    let (z, zd) = (current * Vector::Z, target * Vector::Z);
    let cross = z.cross(zd);
    let dot = z.dot(zd).clamp(-1.0, 1.0);
    let reduced = if dot < -1.0 + 1e-10 {
        target
    } else {
        Rotation::from_xyzw(cross.x, cross.y, cross.z, 1.0 + dot).normalize() * current
    };
    let mix = canonical(reduced.inverse() * target);
    let weighted =
        reduced * Rotation::from_rotation_z(2.0 * g.mc_yaw_weight * mix.z.clamp(-1.0, 1.0).asin());
    let error = canonical(current.inverse() * weighted);
    let yp = if g.mc_yaw_weight > 1e-4 {
        g.mc_yaw_p / g.mc_yaw_weight
    } else {
        g.mc_yaw_p
    };
    let ff = current.inverse() * Vector::Z * yaw_rate;
    let raw = [
        2.0 * g.mc_roll_p * error.x + ff.x,
        2.0 * g.mc_pitch_p * error.y + ff.y,
        2.0 * yp * error.z + ff.z,
    ];
    let limits = [g.mc_rollrate_max, g.mc_pitchrate_max, g.mc_yawrate_max];
    std::array::from_fn(|i| raw[i].clamp(-limits[i].to_radians(), limits[i].to_radians()))
}
/// Directional unachievable demand in roll/pitch/yaw/collective order.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Saturation {
    pub positive: [bool; 4],
    pub negative: [bool; 4],
}
impl Saturation {
    pub fn any(&self) -> bool {
        self.positive.into_iter().chain(self.negative).any(|x| x)
    }
    pub(crate) fn blocks(&self, axis: usize, error: f64) -> bool {
        (self.positive[axis] && error > 0.0) || (self.negative[axis] && error < 0.0)
    }
}
/// PID state in normalized torque units. K scales P/I/D, not FF (PX4).
#[derive(Debug, Default, Clone)]
pub struct RateControl {
    integral: [f64; 3],
    previous: Option<[f64; 3]>,
}
impl RateControl {
    pub fn integral(&self) -> [f64; 3] {
        self.integral
    }
    /// Valid finite measurements and positive finite dt required. D is on
    /// measurement (zero on first sample). Feedback is previous-step saturation;
    /// integration may unwind but cannot drive farther into a saturated axis.
    pub fn update(
        &mut self,
        g: &Gains,
        measured: [f64; 3],
        desired: [f64; 3],
        sat: Saturation,
        dt: f64,
    ) -> [f64; 3] {
        assert!(dt.is_finite() && dt > 0.0);
        let p = [g.mc_rollrate_p, g.mc_pitchrate_p, g.mc_yawrate_p];
        let i = [g.mc_rollrate_i, g.mc_pitchrate_i, g.mc_yawrate_i];
        let d = [g.mc_rollrate_d, g.mc_pitchrate_d, g.mc_yawrate_d];
        let k = [g.mc_rollrate_k, g.mc_pitchrate_k, g.mc_yawrate_k];
        let ff = [g.mc_rollrate_ff, g.mc_pitchrate_ff, g.mc_yawrate_ff];
        let lim = [g.mc_rr_int_lim, g.mc_pr_int_lim, g.mc_yr_int_lim];
        let out = std::array::from_fn(|a| {
            let error = desired[a] - measured[a];
            let deriv = self
                .previous
                .map_or(0.0, |prev| (measured[a] - prev[a]) / dt);
            let torque =
                k[a] * (p[a] * error - d[a] * deriv) + self.integral[a] + ff[a] * desired[a];
            if !sat.blocks(a, error) {
                // PX4's nonlinear I reduction: zero at 400 deg/s error.
                let factor = (1.0 - (error / 400.0_f64.to_radians()).powi(2)).max(0.0);
                self.integral[a] =
                    (self.integral[a] + factor * k[a] * i[a] * error * dt).clamp(-lim[a], lim[a]);
            }
            torque
        });
        self.previous = Some(measured);
        out
    }
}
// Allocation algorithms below port PX4 v1.13.3 under its BSD-3-Clause license.
/****************************************************************************
 *
 *   Copyright (c) 2019 PX4 Development Team. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in
 *    the documentation and/or other materials provided with the
 *    distribution.
 * 3. Neither the name PX4 nor the names of its contributors may be
 *    used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
 * FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 * BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
 * OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
 * AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
 * ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 ****************************************************************************/

/// Geometry-only allocator: B columns are [roll,pitch,yaw,up]. Raw torque
/// is r cross axis + spin_sign * yaw_ratio * axis, about the FRAME ORIGIN.
/// Raw B is inverted first, then mix columns use PX4 normalization: shared
/// roll/pitch norm, maximum yaw, mean absolute thrust. B rows receive the same
/// scales so achieved demand uses the normalized control units.
/// See PX4 v1.13.3 `ControlAllocationPseudoInverse.cpp`:
/// `updatePseudoInverse`, `updateControlAllocationMatrixScale`,
/// `normalizeControlAllocationMatrix` (lines 57-169).
/// <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/control_allocator/ControlAllocation/ControlAllocationPseudoInverse.cpp#L57-L169>.
/// No mass, inertia, max thrust or true CoM is used in this normalization.
#[derive(Debug, Clone)]
pub struct Allocator {
    effectiveness: Vec<[f64; 4]>,
    inverse: Vec<[f64; 4]>,
    commands: Vec<f64>,
    airmode: u8,
}
#[derive(Debug)]
pub struct Allocation<'a> {
    pub commands: &'a [f64],
    pub achieved: [f64; 4],
    pub saturation: Saturation,
}
impl Allocator {
    pub fn new(motors: &[MotorBody], yaw_ratio: f64) -> Result<Self, String> {
        if !yaw_ratio.is_finite() || yaw_ratio < 0.0 {
            return Err("k_Q/k_T must be finite and nonnegative".into());
        }
        let mut b = Vec::with_capacity(motors.len());
        for motor in motors {
            if !motor
                .position
                .iter()
                .chain(&motor.thrust_axis)
                .all(|x| x.is_finite())
            {
                return Err("motor geometry must be finite".into());
            }
            let r = Vector::from_array(motor.position);
            let axis = Vector::from_array(motor.thrust_axis);
            if (axis.length_squared() - 1.0).abs() > 1e-9 {
                return Err("motor thrust axis must be unit length".into());
            }
            let sign = match motor.spin {
                Spin::Cw => 1.0,
                Spin::Ccw => -1.0,
            };
            let torque = r.cross(axis) + axis * (sign * yaw_ratio);
            b.push([torque.x, torque.y, torque.z, axis.z]);
        }
        // Full-row-rank Moore-Penrose inverse B+ = B^T (B B^T)^-1.
        // Partial-pivot Gauss-Jordan, relative threshold on raw Gram.
        let mut aug = [[0.0; 8]; 4];
        for (r, row) in aug.iter_mut().enumerate() {
            for c in 0..4 {
                row[c] = b.iter().map(|v| v[r] * v[c]).sum();
            }
            row[4 + r] = 1.0;
        }
        let norm = aug
            .iter()
            .flat_map(|r| &r[..4])
            .fold(0.0_f64, |a, b| a.max(b.abs()));
        for c in 0..4 {
            let pivot = (c..4)
                .max_by(|a, b| aug[*a][c].abs().total_cmp(&aug[*b][c].abs()))
                .unwrap();
            if norm == 0.0 || aug[pivot][c].abs() < 1e-12 * norm {
                return Err("rank-deficient or ill-conditioned effectiveness: need rank 4".into());
            }
            aug.swap(c, pivot);
            let divisor = aug[c][c];
            for x in &mut aug[c] {
                *x /= divisor;
            }
            let pr = aug[c];
            for (r, row) in aug.iter_mut().enumerate() {
                if r != c {
                    let factor = row[c];
                    for k in 0..8 {
                        row[k] -= factor * pr[k];
                    }
                }
            }
        }
        let mut inverse: Vec<[f64; 4]> = b
            .iter()
            .map(|v| std::array::from_fn(|c| (0..4).map(|r| v[r] * aug[r][4 + c]).sum()))
            .collect();
        // PX4 uses FLT_EPSILON even though this controller computes in f64.
        let epsilon = f32::EPSILON as f64;
        let norm_scale = |axis: usize| {
            let count = inverse.iter().filter(|v| v[axis].abs() > 1e-3).count();
            if count > 0 {
                (inverse.iter().map(|v| v[axis] * v[axis]).sum::<f64>() / (count as f64 / 2.0))
                    .sqrt()
            } else {
                1.0
            }
        };
        let rp_scale = norm_scale(0).max(norm_scale(1));
        let thrust_count = inverse.iter().filter(|v| v[3].abs() > epsilon).count();
        let scales = [
            rp_scale,
            rp_scale,
            inverse
                .iter()
                .map(|v| v[2])
                .fold(f64::NEG_INFINITY, f64::max),
            if thrust_count > 0 {
                inverse.iter().map(|v| v[3].abs()).sum::<f64>() / thrust_count as f64
            } else {
                1.0
            },
        ];
        for axis in 0..4 {
            if scales[axis] > epsilon {
                for (raw, mix) in b.iter_mut().zip(&mut inverse) {
                    raw[axis] *= scales[axis];
                    mix[axis] /= scales[axis];
                }
            }
            for mix in &mut inverse {
                if mix[axis].abs() < 1e-3 {
                    mix[axis] = 0.0;
                }
            }
        }
        Ok(Self {
            effectiveness: b,
            inverse,
            commands: vec![0.0; motors.len()],
            airmode: 0,
        })
    }
    /// MC_AIRMODE: 0 disabled (default), 1 roll/pitch, 2 roll/pitch/yaw.
    /// Reject invalid settings without changing the current mode.
    pub fn set_airmode(&mut self, airmode: u8) -> Result<(), String> {
        if airmode > 2 {
            return Err("MC_AIRMODE must be 0, 1 or 2".into());
        }
        self.airmode = airmode;
        Ok(())
    }
    /// Columns of normalized B.
    pub fn effectiveness(&self) -> &[[f64; 4]] {
        &self.effectiveness
    }
    /// Rows of B+.
    pub fn pseudo_inverse(&self) -> &[[f64; 4]] {
        &self.inverse
    }
    /// PX4 v1.13.3 `ControlAllocationSequentialDesaturation.cpp`: mode selection
    /// by `MC_AIRMODE` (52-64), `mixAirmodeRP` (122-143), `mixAirmodeRPY`
    /// (146-171), `mixAirmodeDisabled` (174-204), `mixYaw` (207-228).
    /// <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/control_allocator/ControlAllocation/ControlAllocationSequentialDesaturation.cpp#L52-L228>.
    /// Trim is zero for this geometry-only motor API. Final output clips to [0,1].
    /// Achieved vs demand retains directional rate/vertical anti-windup feedback.
    /// Signs: axis 3 (up thrust) is negated inside the desaturation vector because
    /// PX4's `THRUST_Z` is negative (NED); this keeps the `increase_only` guard
    /// (`gain < 0`, line 73) meaning "never raise thrust". Axes 0-2 are unchanged
    /// by a vector sign flip (gain and vector flip together).
    pub fn allocate(&mut self, demand: [f64; 4]) -> Allocation<'_> {
        assert!(demand.iter().all(|x| x.is_finite()));
        if self.airmode == 2 {
            // PX4 v1.13.3 mixAirmodeRPY, lines 146-171: full mix,
            // shift collective both ways, then sacrifice yaw before roll/pitch.
            for (u, v) in self.commands.iter_mut().zip(&self.inverse) {
                *u = v[0] * demand[0]
                    + v[1] * demand[1]
                    + v[2] * demand[2]
                    + v[3] * demand[3];
            }
            self.desaturate_actuators(3, 1.0, false);
            self.desaturate_actuators(2, 1.0, false);
        } else {
            for (u, v) in self.commands.iter_mut().zip(&self.inverse) {
                *u = v[0] * demand[0] + v[1] * demand[1] + v[3] * demand[3];
            }
            if self.airmode == 1 {
                // mixAirmodeRP, lines 122-143: collective may rise for RP.
                self.desaturate_actuators(3, 1.0, false);
            } else {
                // Preserve Phase 4.7's operation order exactly.
                self.desaturate_actuators(3, 1.0, true);
                self.desaturate_actuators(0, 1.0, false);
                self.desaturate_actuators(1, 1.0, false);
            }
            for (u, v) in self.commands.iter_mut().zip(&self.inverse) {
                *u += v[2] * demand[2];
            }
            self.desaturate_actuators(2, 1.15, false);
            self.desaturate_actuators(3, 1.0, true);
        }
        for u in &mut self.commands {
            *u = u.clamp(0.0, 1.0);
        }
        let achieved: [f64; 4] = std::array::from_fn(|r| {
            self.commands
                .iter()
                .zip(&self.effectiveness)
                .map(|(u, v)| u * v[r])
                .sum()
        });
        let mut saturation = Saturation::default();
        for r in 0..4 {
            // Roundoff tolerance in normalized units prevents flag chatter.
            saturation.positive[r] = demand[r] - achieved[r] > 1e-9;
            saturation.negative[r] = achieved[r] - demand[r] > 1e-9;
        }
        Allocation {
            commands: &self.commands,
            achieved,
            saturation,
        }
    }
    /// PX4 `ControlAllocationSequentialDesaturation.cpp::computeDesaturationGain`
    /// (88-119). Skip |vector| < FLT_EPSILON; sum the extreme violating gains.
    fn compute_desaturation_gain(&self, axis: usize, upper: f64) -> f64 {
        let (mut k_min, mut k_max) = (0.0_f64, 0.0_f64);
        for (u, mix) in self.commands.iter().zip(&self.inverse) {
            // PX4 thrust-z is negative (NED/FRD). Keep that vector sign here
            // so increase_only retains PX4's gain<0 guard while reducing UP thrust.
            let v = if axis == 3 { -mix[axis] } else { mix[axis] };
            if v.abs() < f32::EPSILON as f64 {
                continue;
            }
            for bound in [0.0, upper] {
                if (bound == 0.0 && *u < bound) || (bound == upper && *u > bound) {
                    let k = (bound - u) / v;
                    k_min = k_min.min(k);
                    k_max = k_max.max(k);
                }
            }
        }
        k_min + k_max
    }
    /// PX4 `ControlAllocationSequentialDesaturation.cpp::desaturateActuators`
    /// (67-86): apply gain, recompute, then apply half the new gain.
    fn desaturate_actuators(&mut self, axis: usize, upper: f64, increase_only: bool) {
        let mut gain = self.compute_desaturation_gain(axis, upper);
        if increase_only && gain < 0.0 {
            return;
        }
        for pass in 0..2 {
            if pass == 1 {
                gain = 0.5 * self.compute_desaturation_gain(axis, upper);
            }
            for (u, mix) in self.commands.iter_mut().zip(&self.inverse) {
                let v = if axis == 3 { -mix[axis] } else { mix[axis] };
                *u += gain * v;
            }
        }
    }
}
/// Filtered estimated state, unit x,y,z,w quaternion body -> world.
#[derive(Debug, Clone, Copy)]
pub struct ControllerInput {
    pub attitude: Quat,
    pub body_rates: [f64; 3],
    pub z: f64,
    pub z_velocity: f64,
}
/// None z selects velocity hold. Positive vertical values are UP;
/// positive yaw_rate is CCW about world +Z. attitude is independent of altitude.
#[derive(Debug, Clone, Copy)]
pub struct Setpoint {
    pub attitude: Quat,
    pub yaw_rate: f64,
    pub z: Option<f64>,
    pub z_velocity: f64,
}
/// Borrowed motor buffer: step does not allocate.
#[derive(Debug)]
pub struct ControllerOutput<'a> {
    pub(crate) vertical_thrust: f64,
    pub motor_commands: &'a [f64],
    pub rate_setpoint: [f64; 3],
    pub torque_demand: [f64; 3],
    pub collective_thrust: f64,
    pub achieved: [f64; 4],
    pub saturation: Saturation,
}
pub struct Controller {
    gains: Gains,
    allocator: Allocator,
    rate: RateControl,
    saturation: Saturation,
    pub(crate) position: PositionControl,
}
impl Controller {
    pub fn new(motors: &[MotorBody], yaw_ratio: f64, gains: Gains) -> Result<Self, String> {
        gains.validate()?;
        Ok(Self {
            gains,
            allocator: Allocator::new(motors, yaw_ratio)?,
            rate: RateControl::default(),
            saturation: Saturation::default(),
            position: PositionControl::for_vertical(gains.vertical),
        })
    }
    pub fn gains(&self) -> &Gains {
        &self.gains
    }
    /// Retuning resets trim and differentiation history.
    pub fn set_gains(&mut self, gains: Gains) -> Result<(), String> {
        gains.validate()?;
        self.gains = gains;
        self.reset();
        Ok(())
    }
    pub fn rate_integral(&self) -> [f64; 3] {
        self.rate.integral()
    }
    pub fn reset(&mut self) {
        self.rate = RateControl::default();
        self.saturation = Saturation::default();
        self.position = PositionControl::for_vertical(self.gains.vertical);
    }
    /// Caller steps at a fixed cadence, normally 1 ms. Panics on invalid dt,
    /// nonfinite state/setpoint or nonunit quaternions. Validate estimator health
    /// before calling. No heap allocation on the valid step path.
    pub fn step(&mut self, est: &ControllerInput, sp: &Setpoint, dt: f64) -> ControllerOutput<'_> {
        assert!(dt.is_finite() && dt > 0.0);
        assert!(est
            .attitude
            .iter()
            .chain(&sp.attitude)
            .chain(&est.body_rates)
            .chain([&est.z, &est.z_velocity, &sp.yaw_rate, &sp.z_velocity])
            .all(|x| x.is_finite()));
        assert!(sp.z.is_none_or(f64::is_finite));
        for a in [est.attitude, sp.attitude] {
            assert!((a.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() < 1e-9);
        }
        let g = &self.gains;
        let rates = attitude_rates(g, est.attitude, sp.attitude, sp.yaw_rate);
        let torque = self
            .rate
            .update(g, est.body_rates, rates, self.saturation, dt);
        let cosine = (q(sp.attitude) * Vector::Z).z;
        let thrust = self.position.step_vertical(est, sp, cosine, self.saturation, dt);
        let a = self
            .allocator
            .allocate([torque[0], torque[1], torque[2], thrust]);
        self.saturation = a.saturation;
        ControllerOutput {
            vertical_thrust: thrust * cosine,
            motor_commands: a.commands,
            rate_setpoint: rates,
            torque_demand: torque,
            collective_thrust: thrust,
            achieved: a.achieved,
            saturation: a.saturation,
        }
    }
}
#[cfg(test)]
mod tests;
