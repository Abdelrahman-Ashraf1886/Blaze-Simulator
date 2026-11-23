// Copyright (c) 2012, 2013-2016, 2018-2019 PX4 Development Team.
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
//! PX4 v1.13.3 PositionControl and ControlMath, read from raw.githubusercontent.com
//! at tag v1.13.3 on 2026-11-23 (exact source, not a later PX4 version).
//!
//! Source manifest (paths relative to PX4-Autopilot):
//! - src/modules/mc_pos_control/PositionControl/PositionControl.cpp:
//!   setVelocityGains 47-52, setVelocityLimits 54-59, setThrustLimits 61-66,
//!   setHorizontalThrustMargin 68-71, setState/setInputSetpoint 88-103,
//!   update 105-122, _positionControl 124-138, _velocityControl 140-195,
//!   _accelerationControl 197-208, _inputValid 210-236, getters 238-256.
//! - src/modules/mc_pos_control/PositionControl/ControlMath.cpp:
//!   thrustToAttitude 47-51, limitTilt 53-68, bodyzToAttitude 70-120,
//!   constrainXY 122-184 (verified end), addIfNotNan 234-246,
//!   addIfNotNanVector3f 248-253, setZeroIfNanVector3f 255-259.
//! - src/modules/mc_pos_control/PositionControl/PositionControl.hpp:
//!   setHoverThrust (clamp 0.1..0.9), resetIntegral, member defaults.
//! - src/modules/mc_pos_control/MulticopterPositionControl.cpp:
//!   gains/margin 164-169, velocity derivatives and their reset on an invalid
//!   estimate 265-294, airborne tilt/thrust/velocity limits 437-453.
//! - src/lib/controllib/BlockDerivative.cpp 48-68 (`reset` is
//!   BlockDerivative.hpp:90); src/lib/controllib/BlockLowPass.cpp 48-57
//!   (state starts NaN, BlockLowPass.hpp:79).
//! - Parameter bounds/defaults: mc_pos_control_params.c (field citations below),
//!   and src/modules/mc_att_control/mc_att_control_params.c 149-160.
//!
//! Boundary: world Z-up/body FLU -> NED/FRD is C=diag(1,-1,-1).
//! Position, velocity, acceleration and world thrust map [x,-y,-z]; yaw and
//! yaw rate negate. Core equations run in NED. Output rotation is C R C,
//! so quaternion [x,y,z,w] -> [x,-y,-z,w]. Positive collective is |thrust|,
//! the negative of PX4 body thrust-z, suitable for RateControl/Allocator.
//! The existing Controller::step still owns its vertical loop (D13); use
//! attitude_rates + RateControl + Allocator to consume this complete output.
//!
//! Deliberate scope: airborne limits, no takeoff ramp/landed logic,
//! trajectories or aggregate parameter rewrites. The hover thrust is a runtime
//! state (initialised from MPC_THR_HOVER) with PX4's `updateHoverThrust`, so the
//! estimator of 5.10 can drive it; the estimator itself is not here.
//! All px4Position reference parameters are retained for subsequent manual
//! tasks; only position/velocity gains, velocity/tilt/thrust limits and VELD_LP
//! affect this loop. MPC_ACC_* / MPC_JERK_* belong to setpoint generation:
//! PositionControl itself has no acceleration clamp beyond tilt and thrust.
//! Unlike 4.7, velocity D uses PX4's filtered derivative (equal when D=0).
//!
//! Not ported from the module (airborne only, perfect state): the tilt-limit
//! slew rate (L55, L437) and the MPC_TILTMAX_LND phase (L435-437), the takeoff
//! speed ramp and ground-contact reset (L418-432, L439-441), the blend of the
//! position derivative into the vertical velocity when only vz is commanded
//! (L456-467), and the module's parameter clamps MPC_TILTMAX_LND <=
//! MPC_TILTMAX_AIR (L153-163) and MPC_XY_CRUISE <= MPC_XY_VEL_MAX (L172).
//! MPC_TILTMAX_AIR is bounded at 89 degrees by its documented maximum, equal to
//! the module's safe-tilt clamp (L142-143).
//!
//! Deviations from PX4, all deliberate:
//! - f64 replaces PX4 f32; the original FLT_EPSILON thresholds are retained.
//! - Invalid input/output returns Err transactionally, instead of bool/panic.
//! - Infinities are rejected explicitly (NaN remains the unset marker).
//! - `acos` input is clamped to [-1, 1] for f64 unit-vector round-off.
//! - Logging-only Euler fields of `bodyzToAttitude` are omitted.
//!
//! PX4 behaviours kept on purpose, so results match PX4 rather than an idealised
//! controller: `limitTilt` replaces the tilt direction by +x when the horizontal
//! part of the unit vector is shorter than sqrt(FLT_EPSILON) = 3.45e-4 (an
//! acceleration under about 3.4e-3 m/s^2, so a small negative x command is applied
//! as a small positive one; ControlMath.cpp:63-65); the vertical anti-windup
//! reads the thrust before the horizontal margin is applied (L151-155); and
//! `updateHoverThrust` uses the unclamped new value in the integrator step but
//! the clamped one as the new hover thrust (L82-84, hpp setHoverThrust).
//! Source BSD-3-Clause notice is retained above.

use crate::math::STANDARD_GRAVITY as G;
use crate::vehicle::Quat;
use rapier3d_f64::math::{Matrix, Rotation, Vector};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Source-unit PX4 parameters (angles in degrees; yaw rates in degrees/s).
/// Manual/landing/aggregate fields are stored, validated, and reserved as above.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PositionGains {
    /// `MPC_THR_CURVE`: `mc_pos_control_params.c:108`; bounds 0.0 .. unbounded.
    pub mpc_thr_curve: f64,
    /// `MPC_THR_XY_MARG`: `mc_pos_control_params.c:123`; bounds 0.0 .. 0.5.
    pub mpc_thr_xy_marg: f64,
    /// `MPC_MANTHR_MIN`: `mc_pos_control_params.c:152`; bounds 0.0 .. 1.0.
    pub mpc_manthr_min: f64,
    /// `MPC_XY_P`: `mc_pos_control_params.c:270`; bounds 0.0 .. 2.0.
    pub mpc_xy_p: f64,
    /// `MPC_XY_VEL_P_ACC`: `mc_pos_control_params.c:282`; bounds 1.2 .. 5.0.
    pub mpc_xy_vel_p_acc: f64,
    /// `MPC_XY_VEL_I_ACC`: `mc_pos_control_params.c:295`; bounds 0.0 .. 60.0.
    pub mpc_xy_vel_i_acc: f64,
    /// `MPC_XY_VEL_D_ACC`: `mc_pos_control_params.c:307`; bounds 0.1 .. 2.0.
    pub mpc_xy_vel_d_acc: f64,
    /// `MPC_VEL_MANUAL`: `mc_pos_control_params.c:364`; bounds 3.0 .. 20.0.
    pub mpc_vel_manual: f64,
    /// `MPC_XY_VEL_MAX`: `mc_pos_control_params.c:379`; bounds 0.0 .. 20.0.
    pub mpc_xy_vel_max: f64,
    /// `MPC_TILTMAX_AIR`: `mc_pos_control_params.c:392`; bounds 20.0 .. 89.0.
    pub mpc_tiltmax_air: f64,
    /// `MPC_TILTMAX_LND`: `mc_pos_control_params.c:405`; bounds 10.0 .. 89.0.
    pub mpc_tiltmax_lnd: f64,
    /// `MPC_MAN_TILT_MAX`: `mc_pos_control_params.c:462`; bounds 0.0 .. 90.0.
    pub mpc_man_tilt_max: f64,
    /// `MPC_MAN_Y_MAX`: `mc_pos_control_params.c:473`; bounds 0.0 .. 400.0.
    pub mpc_man_y_max: f64,
    /// `MPC_MAN_Y_TAU`: `mc_pos_control_params.c:486`; bounds 0.0 .. 5.0.
    pub mpc_man_y_tau: f64,
    /// `MPC_HOLD_DZ`: `mc_pos_control_params.c:496`; bounds 0.0 .. 1.0.
    pub mpc_hold_dz: f64,
    /// `MPC_HOLD_MAX_XY`: `mc_pos_control_params.c:507`; bounds 0.0 .. 3.0.
    pub mpc_hold_max_xy: f64,
    /// `MPC_HOLD_MAX_Z`: `mc_pos_control_params.c:518`; bounds 0.0 .. 3.0.
    pub mpc_hold_max_z: f64,
    /// `MPC_VELD_LP`: `mc_pos_control_params.c:529`; bounds 0.0 .. 10.0.
    pub mpc_veld_lp: f64,
    /// `MPC_ACC_HOR_MAX`: `mc_pos_control_params.c:546`; bounds 2.0 .. 15.0.
    pub mpc_acc_hor_max: f64,
    /// `MPC_ACC_HOR`: `mc_pos_control_params.c:561`; bounds 2.0 .. 15.0.
    pub mpc_acc_hor: f64,
    /// `MPC_ACC_UP_MAX`: `mc_pos_control_params.c:573`; bounds 2.0 .. 15.0.
    pub mpc_acc_up_max: f64,
    /// `MPC_ACC_DOWN_MAX`: `mc_pos_control_params.c:585`; bounds 2.0 .. 15.0.
    pub mpc_acc_down_max: f64,
    /// `MPC_JERK_MAX`: `mc_pos_control_params.c:605`; bounds 0.5 .. 500.0.
    pub mpc_jerk_max: f64,
    /// `MPC_JERK_AUTO`: `mc_pos_control_params.c:621`; bounds 1.0 .. 80.0.
    pub mpc_jerk_auto: f64,
    /// `MPC_ALT_MODE`: `mc_pos_control_params.c:643`; bounds 0.0 .. 2.0.
    pub mpc_alt_mode: f64,
    /// `MPC_XY_MAN_EXPO`: `mc_pos_control_params.c:659`; bounds 0.0 .. 1.0.
    pub mpc_xy_man_expo: f64,
    /// `MPC_Z_MAN_EXPO`: `mc_pos_control_params.c:675`; bounds 0.0 .. 1.0.
    pub mpc_z_man_expo: f64,
    /// `MPC_YAW_EXPO`: `mc_pos_control_params.c:691`; bounds 0.0 .. 1.0.
    pub mpc_yaw_expo: f64,
    /// `MPC_POS_MODE`: `mc_pos_control_params.c:781`; bounds 0.0 .. unbounded.
    pub mpc_pos_mode: f64,
    /// `MPC_XY_VEL_ALL`: `mc_pos_control_params.c:846`; bounds -20.0 .. 20.0.
    pub mpc_xy_vel_all: f64,
    /// `MPC_Z_VEL_ALL`: `mc_pos_control_params.c:861`; bounds -3.0 .. 8.0.
    pub mpc_z_vel_all: f64,
    /// `MC_MAN_TILT_TAU`: `mc_att_control_params.c:160`; bounds 0.0 .. 2.0.
    pub mc_man_tilt_tau: f64,
    /// `MPC_LAND_ALT1`: `mc_pos_control_params.c:721`; bounds 0.0 .. 122.0.
    pub mpc_land_alt1: f64,
    /// `MPC_LAND_ALT2`: `mc_pos_control_params.c:736`; bounds 0.0 .. 122.0.
    pub mpc_land_alt2: f64,
    /// `MPC_LAND_SPEED`: `mc_pos_control_params.c:415`; bounds 0.6 .. unbounded.
    pub mpc_land_speed: f64,
    /// `MPC_TKO_SPEED`: `mc_pos_control_params.c:451`; bounds 1.0 .. 5.0.
    pub mpc_tko_speed: f64,
    /// `MPC_Z_P`: `mc_pos_control_params.c:162`; bounds 0.0 .. 1.5.
    pub mpc_z_p: f64,
    /// `MPC_Z_VEL_P_ACC`: `mc_pos_control_params.c:174`; bounds 2.0 .. 15.0.
    pub mpc_z_vel_p_acc: f64,
    /// `MPC_Z_VEL_I_ACC`: `mc_pos_control_params.c:188`; bounds 0.2 .. 3.0.
    pub mpc_z_vel_i_acc: f64,
    /// `MPC_Z_VEL_D_ACC`: `mc_pos_control_params.c:200`; bounds 0.0 .. 2.0.
    pub mpc_z_vel_d_acc: f64,
    /// `MPC_THR_HOVER`: `mc_pos_control_params.c:75`; bounds 0.1 .. 0.8.
    pub mpc_thr_hover: f64,
    /// `MPC_USE_HTE`: `mc_pos_control_params.c:86`; bounds 0.0 .. unbounded.
    pub mpc_use_hte: f64,
    /// `MPC_THR_MIN`: `mc_pos_control_params.c:54`; bounds 0.05 .. 1.0.
    pub mpc_thr_min: f64,
    /// `MPC_THR_MAX`: `mc_pos_control_params.c:137`; bounds 0.0 .. 1.0.
    pub mpc_thr_max: f64,
    /// `MPC_Z_VEL_MAX_UP`: `mc_pos_control_params.c:230`; bounds 0.5 .. 8.0.
    pub mpc_z_vel_max_up: f64,
    /// `MPC_Z_VEL_MAX_DN`: `mc_pos_control_params.c:260`; bounds 0.5 .. 4.0.
    pub mpc_z_vel_max_dn: f64,
}
impl PositionGains {
    pub fn px4_v1_13_3() -> Self {
        Self {
            mpc_thr_curve: 0.0,
            mpc_thr_xy_marg: 0.3,
            mpc_manthr_min: 0.08,
            mpc_xy_p: 0.95,
            mpc_xy_vel_p_acc: 1.8,
            mpc_xy_vel_i_acc: 0.4,
            mpc_xy_vel_d_acc: 0.2,
            mpc_vel_manual: 10.0,
            mpc_xy_vel_max: 12.0,
            mpc_tiltmax_air: 45.0,
            mpc_tiltmax_lnd: 12.0,
            mpc_man_tilt_max: 35.0,
            mpc_man_y_max: 150.0,
            mpc_man_y_tau: 0.08,
            mpc_hold_dz: 0.1,
            mpc_hold_max_xy: 0.8,
            mpc_hold_max_z: 0.6,
            mpc_veld_lp: 5.0,
            mpc_acc_hor_max: 5.0,
            mpc_acc_hor: 3.0,
            mpc_acc_up_max: 4.0,
            mpc_acc_down_max: 3.0,
            mpc_jerk_max: 8.0,
            mpc_jerk_auto: 4.0,
            mpc_alt_mode: 0.0,
            mpc_xy_man_expo: 0.6,
            mpc_z_man_expo: 0.6,
            mpc_yaw_expo: 0.6,
            mpc_pos_mode: 4.0,
            mpc_xy_vel_all: -10.0,
            mpc_z_vel_all: -3.0,
            mc_man_tilt_tau: 0.0,
            mpc_land_alt1: 10.0,
            mpc_land_alt2: 5.0,
            mpc_land_speed: 0.7,
            mpc_tko_speed: 1.5,
            mpc_z_p: 1.0,
            mpc_z_vel_p_acc: 4.0,
            mpc_z_vel_i_acc: 2.0,
            mpc_z_vel_d_acc: 0.0,
            mpc_thr_hover: 0.5,
            mpc_use_hte: 1.0,
            mpc_thr_min: 0.12,
            mpc_thr_max: 1.0,
            mpc_z_vel_max_up: 3.0,
            mpc_z_vel_max_dn: 1.0,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        check("MPC_THR_CURVE", self.mpc_thr_curve, 0.0, None)?;
        check("MPC_THR_XY_MARG", self.mpc_thr_xy_marg, 0.0, Some(0.5))?;
        check("MPC_MANTHR_MIN", self.mpc_manthr_min, 0.0, Some(1.0))?;
        check("MPC_XY_P", self.mpc_xy_p, 0.0, Some(2.0))?;
        check("MPC_XY_VEL_P_ACC", self.mpc_xy_vel_p_acc, 1.2, Some(5.0))?;
        check("MPC_XY_VEL_I_ACC", self.mpc_xy_vel_i_acc, 0.0, Some(60.0))?;
        check("MPC_XY_VEL_D_ACC", self.mpc_xy_vel_d_acc, 0.1, Some(2.0))?;
        check("MPC_VEL_MANUAL", self.mpc_vel_manual, 3.0, Some(20.0))?;
        check("MPC_XY_VEL_MAX", self.mpc_xy_vel_max, 0.0, Some(20.0))?;
        check("MPC_TILTMAX_AIR", self.mpc_tiltmax_air, 20.0, Some(89.0))?;
        check("MPC_TILTMAX_LND", self.mpc_tiltmax_lnd, 10.0, Some(89.0))?;
        check("MPC_MAN_TILT_MAX", self.mpc_man_tilt_max, 0.0, Some(90.0))?;
        check("MPC_MAN_Y_MAX", self.mpc_man_y_max, 0.0, Some(400.0))?;
        check("MPC_MAN_Y_TAU", self.mpc_man_y_tau, 0.0, Some(5.0))?;
        check("MPC_HOLD_DZ", self.mpc_hold_dz, 0.0, Some(1.0))?;
        check("MPC_HOLD_MAX_XY", self.mpc_hold_max_xy, 0.0, Some(3.0))?;
        check("MPC_HOLD_MAX_Z", self.mpc_hold_max_z, 0.0, Some(3.0))?;
        check("MPC_VELD_LP", self.mpc_veld_lp, 0.0, Some(10.0))?;
        check("MPC_ACC_HOR_MAX", self.mpc_acc_hor_max, 2.0, Some(15.0))?;
        check("MPC_ACC_HOR", self.mpc_acc_hor, 2.0, Some(15.0))?;
        check("MPC_ACC_UP_MAX", self.mpc_acc_up_max, 2.0, Some(15.0))?;
        check("MPC_ACC_DOWN_MAX", self.mpc_acc_down_max, 2.0, Some(15.0))?;
        check("MPC_JERK_MAX", self.mpc_jerk_max, 0.5, Some(500.0))?;
        check("MPC_JERK_AUTO", self.mpc_jerk_auto, 1.0, Some(80.0))?;
        check("MPC_ALT_MODE", self.mpc_alt_mode, 0.0, Some(2.0))?;
        check("MPC_XY_MAN_EXPO", self.mpc_xy_man_expo, 0.0, Some(1.0))?;
        check("MPC_Z_MAN_EXPO", self.mpc_z_man_expo, 0.0, Some(1.0))?;
        check("MPC_YAW_EXPO", self.mpc_yaw_expo, 0.0, Some(1.0))?;
        check("MPC_POS_MODE", self.mpc_pos_mode, 0.0, None)?;
        check("MPC_XY_VEL_ALL", self.mpc_xy_vel_all, -20.0, Some(20.0))?;
        check("MPC_Z_VEL_ALL", self.mpc_z_vel_all, -3.0, Some(8.0))?;
        check("MC_MAN_TILT_TAU", self.mc_man_tilt_tau, 0.0, Some(2.0))?;
        check("MPC_LAND_ALT1", self.mpc_land_alt1, 0.0, Some(122.0))?;
        check("MPC_LAND_ALT2", self.mpc_land_alt2, 0.0, Some(122.0))?;
        check("MPC_LAND_SPEED", self.mpc_land_speed, 0.6, None)?;
        check("MPC_TKO_SPEED", self.mpc_tko_speed, 1.0, Some(5.0))?;
        check("MPC_Z_P", self.mpc_z_p, 0.0, Some(1.5))?;
        check("MPC_Z_VEL_P_ACC", self.mpc_z_vel_p_acc, 2.0, Some(15.0))?;
        check("MPC_Z_VEL_I_ACC", self.mpc_z_vel_i_acc, 0.2, Some(3.0))?;
        check("MPC_Z_VEL_D_ACC", self.mpc_z_vel_d_acc, 0.0, Some(2.0))?;
        check("MPC_THR_HOVER", self.mpc_thr_hover, 0.1, Some(0.8))?;
        check("MPC_USE_HTE", self.mpc_use_hte, 0.0, None)?;
        check("MPC_THR_MIN", self.mpc_thr_min, 0.05, Some(1.0))?;
        check("MPC_THR_MAX", self.mpc_thr_max, 0.0, Some(1.0))?;
        check("MPC_Z_VEL_MAX_UP", self.mpc_z_vel_max_up, 0.5, Some(8.0))?;
        check("MPC_Z_VEL_MAX_DN", self.mpc_z_vel_max_dn, 0.5, Some(4.0))?;
        // The plan's relation (D11), not a PX4 range. A margin above MPC_THR_MAX
        // is not refused here: PX4 yields a NaN thrust there and rejects the
        // setpoint, and `step` returns Err in the same case.
        if !(self.mpc_thr_min <= self.mpc_thr_hover && self.mpc_thr_hover <= self.mpc_thr_max) {
            return Err("require MPC_THR_MIN <= MPC_THR_HOVER <= MPC_THR_MAX".into());
        }
        Ok(())
    }
}
fn check(name: &str, value: f64, min: f64, max: Option<f64>) -> Result<(), String> {
    if !value.is_finite() || value < min || max.is_some_and(|m| value > m) {
        return Err(format!("{name} outside documented bounds ({min}..{max:?})"));
    }
    Ok(())
}

/// Exact uppercase PX4 names; unknown names, non-numbers and invalid ranges fail.
pub fn gains_with_overrides(
    overrides: Option<&Map<String, Value>>,
) -> Result<PositionGains, String> {
    let mut value =
        serde_json::to_value(PositionGains::px4_v1_13_3()).map_err(|e| e.to_string())?;
    let fields = value.as_object_mut().expect("PositionGains is an object");
    if let Some(overrides) = overrides {
        for (name, v) in overrides {
            let key = name.to_ascii_lowercase();
            if name != &name.to_ascii_uppercase() || !fields.contains_key(&key) {
                return Err(format!("unknown PX4 parameter {name}"));
            }
            if !v.as_f64().is_some_and(f64::is_finite) {
                return Err(format!("{name} must be a finite number"));
            }
            fields.insert(key, v.clone());
        }
    }
    let gains: PositionGains = serde_json::from_value(value).map_err(|e| e.to_string())?;
    gains.validate()?;
    Ok(gains)
}

/// CoM estimates in engine world coordinates; NaN marks unavailable components.
#[derive(Debug, Clone, Copy)]
pub struct PositionInput {
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    /// World +Z heading, radians. Used when setpoint yaw is NaN.
    pub yaw: f64,
}
/// Each axis needs at least one finite setpoint. XY entries must come in pairs
/// at each layer. NaN disables a layer; acceleration is feedforward when a
/// higher layer is active, or direct acceleration when position/velocity are NaN.
#[derive(Debug, Clone, Copy)]
pub struct PositionSetpoint {
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub acceleration: [f64; 3],
    pub yaw: f64,
    pub yaw_rate: f64,
}
impl Default for PositionSetpoint {
    fn default() -> Self {
        Self {
            position: [f64::NAN; 3],
            velocity: [f64::NAN; 3],
            acceleration: [f64::NAN; 3],
            yaw: f64::NAN,
            yaw_rate: f64::NAN,
        }
    }
}
/// Full outer-loop result, in engine world/FLU coordinates, quaternion x,y,z,w.
#[derive(Debug, Clone, Copy)]
pub struct PositionOutput {
    pub attitude: Quat,
    pub collective_thrust: f64,
    pub yaw_rate: f64,
    pub velocity_setpoint: [f64; 3],
    pub acceleration_setpoint: [f64; 3],
    pub thrust: [f64; 3],
}

/// `control::BlockDerivative` (BlockDerivative.cpp:48-68) feeding
/// `control::BlockLowPass` (BlockLowPass.cpp:48-57). The low-pass state starts
/// NaN (BlockLowPass.hpp:79) and takes the first input it sees. `reset` clears
/// only the initialised flag (BlockDerivative.hpp:90): the low-pass state is
/// kept, so the first sample after a reset returns 0 and the next one continues
/// from the old state decayed by (1 - alpha), exactly as PX4 does.
#[derive(Debug, Clone, Copy)]
struct Derivative {
    initialized: bool,
    previous: f64,
    state: f64,
}
impl Default for Derivative {
    fn default() -> Self {
        Self {
            initialized: false,
            previous: 0.0,
            state: f64::NAN,
        }
    }
}
impl Derivative {
    fn low_pass(&mut self, input: f64, dt: f64, cutoff: f64) {
        if !self.state.is_finite() {
            self.state = input;
        }
        let b = 2.0 * std::f64::consts::PI * cutoff * dt;
        let alpha = b / (1.0 + b);
        self.state = alpha * input + (1.0 - alpha) * self.state;
    }
    fn update(&mut self, input: f64, dt: f64, cutoff: f64) -> f64 {
        let output = if self.initialized {
            self.low_pass((input - self.previous) / dt, dt, cutoff);
            self.state
        } else {
            self.low_pass(0.0, dt, cutoff);
            self.initialized = true;
            0.0
        };
        self.previous = input;
        output
    }
    fn reset(&mut self) {
        self.initialized = false;
    }
}

/// PX4 `PositionControl` plus the velocity-derivative blocks the module owns.
/// All state is in NED, as in PX4; the public API is in engine coordinates.
#[derive(Debug, Clone)]
pub struct PositionControl {
    gains: PositionGains,
    integral: [f64; 3], // NED acceleration integral, not bounded horizontally.
    derivative: [Derivative; 3],
    /// `_hover_thrust`: starts at MPC_THR_HOVER, changed by 5.10's estimator.
    hover_thrust: f64,
    /// `_acc_sp(2)` from the last update (NED), read by `updateHoverThrust`.
    acc_sp_z: f64,
}
impl PositionControl {
    pub fn new(gains: PositionGains) -> Result<Self, String> {
        gains.validate()?;
        Ok(Self {
            gains,
            integral: [0.0; 3],
            derivative: [Derivative::default(); 3],
            hover_thrust: gains.mpc_thr_hover,
            acc_sp_z: 0.0,
        })
    }
    pub fn gains(&self) -> &PositionGains {
        &self.gains
    }
    /// Validation is atomic; existing integral/filter state is preserved. The
    /// runtime hover thrust follows MPC_THR_HOVER only when that value changes.
    pub fn set_gains(&mut self, gains: PositionGains) -> Result<(), String> {
        gains.validate()?;
        if gains.mpc_thr_hover != self.gains.mpc_thr_hover {
            self.hover_thrust = gains.mpc_thr_hover;
        }
        self.gains = gains;
        Ok(())
    }
    /// PX4 `resetIntegral` (PositionControl.hpp): zero the velocity integral only.
    pub fn reset_integral(&mut self) {
        self.integral = [0.0; 3];
    }
    /// Back to the freshly constructed state: integral, derivative filters,
    /// last acceleration setpoint and hover thrust (from MPC_THR_HOVER).
    pub fn reset(&mut self) {
        self.integral = [0.0; 3];
        self.derivative = [Derivative::default(); 3];
        self.hover_thrust = self.gains.mpc_thr_hover;
        self.acc_sp_z = 0.0;
    }
    /// Current hover thrust used by the acceleration-to-thrust map.
    pub fn hover_thrust(&self) -> f64 {
        self.hover_thrust
    }
    /// PX4 `setHoverThrust`: constrained to [0.1, 0.9] (PositionControl.hpp).
    pub fn set_hover_thrust(&mut self, hover_thrust: f64) -> Result<(), String> {
        if !hover_thrust.is_finite() {
            return Err("hover thrust must be finite".into());
        }
        self.hover_thrust = hover_thrust.clamp(0.1, 0.9);
        Ok(())
    }
    /// PX4 `updateHoverThrust` (PositionControl.cpp:73-86). Changes the hover
    /// thrust and moves the vertical integrator so the thrust commanded for the
    /// last acceleration setpoint does not jump: with a = the last `_acc_sp(2)`,
    /// h the old and h' the new hover thrust, a' = (a - g) h / h' + g and the
    /// integrator gains a' - a, so a' h'/g - h' = a h/g - h. A value not above
    /// FLT_EPSILON is ignored, as in PX4.
    pub fn update_hover_thrust(&mut self, hover_thrust_new: f64) -> Result<(), String> {
        if !hover_thrust_new.is_finite() {
            return Err("hover thrust must be finite".into());
        }
        if hover_thrust_new > f32::EPSILON as f64 {
            self.integral[2] +=
                (self.acc_sp_z - G) * self.hover_thrust / hover_thrust_new + G - self.acc_sp_z;
            self.set_hover_thrust(hover_thrust_new)?;
        }
        Ok(())
    }
    /// Acceleration integral in engine Z-up coordinates.
    pub fn velocity_integral(&self) -> [f64; 3] {
        convert(self.integral)
    }

    /// Fixed cadence (normally 1 ms). No allocation on success; errors leave
    /// state unchanged. NaN estimates are accepted only where not required.
    pub fn step(
        &mut self,
        input: &PositionInput,
        sp: &PositionSetpoint,
        dt: f64,
    ) -> Result<PositionOutput, String> {
        let mut next = self.clone();
        let out = next.update(input, sp, dt)?;
        *self = next;
        Ok(out)
    }
    fn update(
        &mut self,
        input: &PositionInput,
        sp: &PositionSetpoint,
        dt: f64,
    ) -> Result<PositionOutput, String> {
        if !dt.is_finite() || dt <= 0.0 {
            return Err("dt must be finite and positive".into());
        }
        if input
            .position
            .iter()
            .chain(&input.velocity)
            .chain(&sp.position)
            .chain(&sp.velocity)
            .chain(&sp.acceleration)
            .chain([&input.yaw, &sp.yaw, &sp.yaw_rate])
            .any(|v| v.is_infinite())
        {
            return Err("infinite input (use NaN to disable)".into());
        }
        let g = self.gains;
        let pos = convert(input.position);
        let vel = convert(input.velocity);
        let psp = convert(sp.position);
        let mut vsp = convert(sp.velocity);
        let mut acc = convert(sp.acceleration);
        // MulticopterPositionControl.cpp:265-294: the x and y derivatives run
        // only when vx and vy are both valid and are reset together otherwise;
        // z runs on its own. An invalid velocity gives a NaN derivative.
        let xy_valid = vel[0].is_finite() && vel[1].is_finite();
        let derivative: [f64; 3] = std::array::from_fn(|i| {
            let valid = if i < 2 { xy_valid } else { vel[2].is_finite() };
            if valid {
                self.derivative[i].update(vel[i], dt, g.mpc_veld_lp)
            } else {
                self.derivative[i].reset();
                f64::NAN
            }
        });
        // _inputValid:210-236, including the original layer-specific estimates.
        for layer in [psp, vsp, acc] {
            if layer[0].is_finite() != layer[1].is_finite() {
                return Err("XY setpoints must come in pairs".into());
            }
        }
        for i in 0..3 {
            if !(psp[i].is_finite() || vsp[i].is_finite() || acc[i].is_finite())
                || (psp[i].is_finite() && !pos[i].is_finite())
                || (vsp[i].is_finite() && !(vel[i].is_finite() && derivative[i].is_finite()))
            {
                return Err(format!("invalid setpoint/estimate on axis {i}"));
            }
        }
        let yaw = if sp.yaw.is_finite() {
            -sp.yaw
        } else {
            -input.yaw
        };
        if !yaw.is_finite() {
            return Err("yaw estimate required when yaw setpoint is NaN".into());
        }
        let yaw_rate_ned = if sp.yaw_rate.is_finite() {
            -sp.yaw_rate
        } else {
            0.0
        };
        // _positionControl:124-138.
        let mut position_velocity = [0.0; 3];
        for i in 0..3 {
            let p = if i < 2 { g.mpc_xy_p } else { g.mpc_z_p };
            let term = (psp[i] - pos[i]) * p;
            vsp[i] = add_if_not_nan(vsp[i], term);
            position_velocity[i] = add_if_not_nan(term, 0.0);
        }
        let xy = constrain_xy(
            [position_velocity[0], position_velocity[1]],
            [vsp[0] - position_velocity[0], vsp[1] - position_velocity[1]],
            g.mpc_xy_vel_max,
        );
        vsp[0] = xy[0];
        vsp[1] = xy[1];
        vsp[2] = vsp[2].clamp(-g.mpc_z_vel_max_up, g.mpc_z_vel_max_dn);
        // _velocityControl:140-149.
        let mut error = std::array::from_fn::<_, 3, _>(|i| vsp[i] - vel[i]);
        for i in 0..3 {
            let (p, d) = if i < 2 {
                (g.mpc_xy_vel_p_acc, g.mpc_xy_vel_d_acc)
            } else {
                (g.mpc_z_vel_p_acc, g.mpc_z_vel_d_acc)
            };
            acc[i] = add_if_not_nan(acc[i], p * error[i] + self.integral[i] - d * derivative[i]);
        }
        if !acc.iter().all(|a| a.is_finite()) {
            return Err("nonfinite output acceleration".into());
        }
        self.acc_sp_z = acc[2]; // `_acc_sp(2)`, read by update_hover_thrust.
        let hover = self.hover_thrust;
        let mut thrust = acceleration_control(acc, &g, hover);
        let min = g.mpc_thr_min.max(1e-3); // setThrustLimits:64
                                           // Vertical anti-windup BEFORE margin saturation, exactly PX4:151-155.
        if (thrust[2] >= -min && error[2] >= 0.0)
            || (thrust[2] <= -g.mpc_thr_max && error[2] <= 0.0)
        {
            error[2] = 0.0;
        }
        // Vertical priority with a horizontal margin, L157-167. math::max(a, b)
        // is (a > b) ? a : b, so a NaN bound (margin above MPC_THR_MAX) gives a
        // NaN thrust, which the finite check below turns into Err, as PX4's
        // `valid` flag does.
        let horizontal = thrust[0].hypot(thrust[1]);
        let allocated = horizontal.min(g.mpc_thr_xy_marg);
        let max2 = g.mpc_thr_max * g.mpc_thr_max;
        let z_floor = -(max2 - allocated * allocated).sqrt();
        thrust[2] = if thrust[2] > z_floor {
            thrust[2]
        } else {
            z_floor
        };
        // Horizontal thrust left after the vertical priority, L169-180.
        let max_xy_squared = max2 - thrust[2] * thrust[2];
        let max_xy = if max_xy_squared > 0.0 {
            max_xy_squared.sqrt()
        } else {
            0.0
        };
        if horizontal > max_xy {
            thrust[0] = thrust[0] / horizontal * max_xy;
            thrust[1] = thrust[1] / horizontal * max_xy;
        }
        // Tracking anti-windup, L182-186: gain 2 / P_vel,x, with the thrust
        // converted back to an acceleration through the hover thrust.
        for i in 0..2 {
            error[i] -= 2.0 / g.mpc_xy_vel_p_acc * (acc[i] - thrust[i] * (G / hover));
        }
        for (i, e) in error.into_iter().enumerate() {
            let ki = if i < 2 {
                g.mpc_xy_vel_i_acc
            } else {
                g.mpc_z_vel_i_acc
            };
            self.integral[i] += add_if_not_nan(e, 0.0) * ki * dt;
        }
        self.integral[2] = self.integral[2].clamp(-G, G);
        if !thrust.iter().chain(&self.integral).all(|v| v.is_finite()) {
            return Err("nonfinite thrust/integral".into());
        }
        let q = bodyz_to_attitude_ned(-Vector::from_array(thrust), yaw);
        Ok(PositionOutput {
            attitude: [q.x, -q.y, -q.z, q.w],
            collective_thrust: Vector::from_array(thrust).length(),
            yaw_rate: -yaw_rate_ned,
            velocity_setpoint: convert(vsp),
            acceleration_setpoint: convert(acc),
            thrust: convert(thrust),
        })
    }
}
fn convert(v: [f64; 3]) -> [f64; 3] {
    [v[0], -v[1], -v[2]]
}
// ControlMath.cpp:234-259, scalar implementation reused per axis.
fn add_if_not_nan(value: f64, addition: f64) -> f64 {
    if value.is_finite() && addition.is_finite() {
        value + addition
    } else if !value.is_finite() {
        addition
    } else {
        value
    }
}
// PositionControl._accelerationControl, PositionControl.cpp:197-208, in NED.
// Body z is the unit vector of (-a_x, -a_y, g), tilt-limited about world down
// (0, 0, 1); the collective is a_z * h / g - h (negative: thrust points up),
// divided by body_z . (0, 0, 1) and at most -MPC_THR_MIN (at least 1e-3).
fn acceleration_control(acc: [f64; 3], g: &PositionGains, hover: f64) -> [f64; 3] {
    let body_z = limit_tilt(
        Vector::new(-acc[0], -acc[1], G).normalize(),
        Vector::Z,
        g.mpc_tiltmax_air.to_radians(),
    );
    let collective = ((acc[2] * (hover / G) - hover) / body_z.z).min(-g.mpc_thr_min.max(1e-3));
    (body_z * collective).to_array()
}

/// ControlMath::constrainXY (122-184): v0 has priority over feedforward v1.
/// Input/output share any orthonormal XY frame; max is a nonnegative magnitude.
pub fn constrain_xy(v0: [f64; 2], v1: [f64; 2], max: f64) -> [f64; 2] {
    let a = Vector::new(v0[0], v0[1], 0.0);
    let b = Vector::new(v1[0], v1[1], 0.0);
    if (a + b).length() <= max {
        return [a.x + b.x, a.y + b.y];
    }
    if a.length() >= max {
        let result = a.normalize() * max;
        return [result.x, result.y];
    }
    if (b - a).length().abs() < 0.001 {
        let result = a.normalize() * max;
        return [result.x, result.y];
    }
    if a.length() < 0.001 {
        let result = b.normalize() * max;
        return [result.x, result.y];
    }
    let u = b.normalize();
    let m = u.dot(a);
    let result = a + u * (-m + (m * m - (a.dot(a) - max * max)).sqrt());
    [result.x, result.y]
}
/// ControlMath::limitTilt (53-68), unit vectors in a common frame, radians.
pub fn limit_tilt(body_unit: Vector, world_unit: Vector, max_angle: f64) -> Vector {
    let dot = body_unit.dot(world_unit);
    let angle = dot.clamp(-1.0, 1.0).acos().min(max_angle);
    let mut rejection = body_unit - dot * world_unit;
    if rejection.length_squared() < f32::EPSILON as f64 {
        rejection.x = 1.0;
    }
    angle.cos() * world_unit + angle.sin() * rejection.normalize()
}
// ControlMath::bodyzToAttitude (70-120), NED body DOWN direction. Logging-only
// Euler angles are omitted; the quaternion is the control output.
fn bodyz_to_attitude_ned(mut z: Vector, yaw: f64) -> Rotation {
    if z.length_squared() < f32::EPSILON as f64 {
        z.z = 1.0;
    }
    z = z.normalize();
    let y_c = Vector::new(-yaw.sin(), yaw.cos(), 0.0);
    let mut x = y_c.cross(z);
    if z.z < 0.0 {
        x = -x;
    }
    if z.z.abs() < 1e-6 {
        x = Vector::Z;
    }
    x = x.normalize();
    let y = z.cross(x);
    Rotation::from_mat3(&Matrix::from_cols(x, y, z)).normalize()
}
/// ControlMath::bodyzToAttitude, engine body UP direction in Z-up world.
/// Yaw is about engine world +Z. Zero direction uses level attitude.
pub fn bodyz_to_attitude(body_z: [f64; 3], yaw: f64) -> Quat {
    let q = bodyz_to_attitude_ned(-Vector::from_array(convert(body_z)), -yaw);
    [q.x, -q.y, -q.z, q.w]
}
/// ControlMath::thrustToAttitude (47-51), engine world thrust, positive collective.
pub fn thrust_to_attitude(thrust: [f64; 3], yaw: f64) -> (Quat, f64) {
    (
        bodyz_to_attitude(thrust, yaw),
        Vector::from_array(thrust).length(),
    )
}

#[cfg(test)]
mod tests;
