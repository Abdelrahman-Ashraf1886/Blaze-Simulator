// Copyright (c) 2013-2020 PX4 Development Team.
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
//! Manual multicopter tasks, PX4-Autopilot tag v1.13.3. Parameter defaults and
//! limits come from PositionGains (the px4Position and px4 reference sets).
//! All outputs use engine world Z-up/body FLU coordinates. Positive forward,
//! right and clockwise sticks have PX4 manual_control_setpoint x, y, r signs.
//! Throttle here is centered at zero, with +1 full up and -1 full down.
//!
//! Source paths below are relative to the tag. FlightTask* and Utility/* are
//! under src/modules/flight_mode_manager/tasks. The airborne simulation has
//! exact estimates and no terrain, takeoff ramp, or estimator resets.

use crate::math::STANDARD_GRAVITY as G;
use crate::position_control::{PositionGains, PositionInput, PositionSetpoint};
use crate::vehicle::Quat;
use rapier3d_f64::glamx::DVec2 as Xy;
use rapier3d_f64::math::{Rotation, Vector};
use std::f64::consts::{PI, TAU};

const EPS: f64 = f32::EPSILON as f64;

#[derive(Clone, Copy, Debug, Default)]
pub struct Sticks {
    pub forward: f64,
    pub right: f64,
    pub yaw_right: f64,
    pub throttle: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum FlightCommand {
    /// FLU body rates (rad/s) and normalized positive collective. D7's
    /// direct rate input, MulticopterRateControl.cpp:200-208.
    Rates {
        body_radps: [f64; 3],
        collective: f64,
    },
    Stabilized(Sticks),
    Altitude(Sticks),
    Position(Sticks),
}

#[derive(Clone, Copy, Debug)]
pub enum ModeSetpoint {
    Rates {
        body_radps: [f64; 3],
        collective: f64,
    },
    Attitude {
        attitude: Quat,
        yaw_rate: f64,
        collective: f64,
    },
    Position(PositionSetpoint),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Rates,
    Stabilized,
    Altitude,
    Velocity,
    Acceleration,
}

/// Functions.hpp:84-89,125-139 (src/lib/mathlib/math), Utility/Sticks.cpp:53-65.
fn shaped(x: f64, expo: f64, dead_zone: f64) -> f64 {
    let dz = dead_zone.min(0.99);
    let linear = x.signum() * (x.abs() - dz).max(0.0) / (1.0 - dz);
    (1.0 - expo) * linear + expo * linear.powi(3)
}

// src/lib/mathlib/math/filter/AlphaFilter.hpp:67-74,109-123.
// Fixed cadence and constant tuning, so an ineligible denominator keeps the initial zero alpha.
fn alpha(dt: f64, tau: f64) -> f64 {
    if dt + tau > EPS {
        dt / (dt + tau)
    } else {
        0.0
    }
}

// Utility/Sticks.cpp:93-107, in the engine's forward/left plane.
fn heading_frame(v: Xy, heading: f64) -> Xy {
    Xy::from_angle(heading).rotate(v)
}

// lib/matrix/matrix/Vector.hpp:119-128.
fn unit_or_zero(v: Xy) -> Xy {
    if v.length() > 1e-5 {
        v / v.length()
    } else {
        Xy::ZERO
    }
}

// src/lib/slew_rate/SlewRate.hpp:78-86.
fn slew(current: f64, target: f64, change: f64) -> f64 {
    current + (target - current).clamp(-change, change)
}

#[derive(Clone, Debug)]
pub struct FlightModes {
    gains: PositionGains,
    airmode: u8,
    active: Option<Mode>,
    yaw: Option<f64>,
    reset_manual_yaw: bool,
    yaw_filtered: f64,
    yaw_slew: f64,
    tilt_input: Xy,
    height_lock: Option<f64>,
    xy_lock: Option<Xy>,
    acceleration_xy: AccelerationXy,
    smooth_z: SmoothZ,
    previous: PositionSetpoint,
}

impl FlightModes {
    pub fn new(gains: PositionGains, airmode: u8) -> Result<Self, String> {
        gains.validate()?;
        if gains.mpc_pos_mode != 0.0 && gains.mpc_pos_mode != 4.0 {
            return Err("manual position supports MPC_POS_MODE 0 and 4".into());
        }
        if gains.mpc_alt_mode != 0.0 {
            return Err("manual altitude requires MPC_ALT_MODE 0".into());
        }
        if airmode > 2 {
            return Err("MC_AIRMODE must be 0, 1 or 2".into());
        }
        Ok(Self {
            gains,
            airmode,
            active: None,
            yaw: None,
            reset_manual_yaw: true,
            yaw_filtered: 0.0,
            yaw_slew: 0.0,
            tilt_input: Xy::ZERO,
            height_lock: None,
            xy_lock: None,
            acceleration_xy: AccelerationXy::default(),
            smooth_z: SmoothZ::default(),
            previous: PositionSetpoint::default(),
        })
    }

    /// Advance one fixed sample. Feedback is the preceding position controller
    /// velocity setpoint (FlightTask/FlightTask.cpp:169-185). On ground contact
    /// the hold modes use stabilized sticks until airborne (plan's stand-in).
    pub fn step(
        &mut self,
        command: FlightCommand,
        state: &PositionInput,
        feedback: Option<[f64; 3]>,
        ground_contact: bool,
        dt: f64,
    ) -> Result<ModeSetpoint, String> {
        if !dt.is_finite()
            || dt <= 0.0
            || !state.yaw.is_finite()
            || !state
                .position
                .iter()
                .chain(&state.velocity)
                .all(|v| v.is_finite())
        {
            return Err("manual modes require a finite estimate and positive finite dt".into());
        }
        let (mode, sticks) = match command {
            FlightCommand::Rates {
                body_radps,
                collective,
            } => {
                if !body_radps.iter().all(|v| v.is_finite()) || !(0.0..=1.0).contains(&collective) {
                    return Err("rates require finite body rates and collective in [0, 1]".into());
                }
                self.active = Some(Mode::Rates);
                self.previous = PositionSetpoint::default();
                return Ok(ModeSetpoint::Rates {
                    body_radps,
                    collective,
                });
            }
            FlightCommand::Stabilized(s) => (Mode::Stabilized, s),
            FlightCommand::Altitude(s) | FlightCommand::Position(s) if ground_contact => {
                (Mode::Stabilized, s)
            }
            FlightCommand::Altitude(s) => (Mode::Altitude, s),
            FlightCommand::Position(s) if self.gains.mpc_pos_mode == 0.0 => (Mode::Velocity, s),
            FlightCommand::Position(s) => (Mode::Acceleration, s),
        };
        if ![
            sticks.forward,
            sticks.right,
            sticks.yaw_right,
            sticks.throttle,
        ]
        .iter()
        .all(|v| (-1.0..=1.0).contains(v))
        {
            return Err("manual stick axes must be finite and in [-1, 1]".into());
        }
        if self.active != Some(mode) {
            self.activate(mode, state);
        }
        if mode == Mode::Stabilized {
            self.previous = PositionSetpoint::default();
            return Ok(self.stabilized(sticks, state.yaw, ground_contact, dt));
        }
        let sp = self.position_task(mode, sticks, state, feedback, dt);
        self.previous = sp;
        Ok(ModeSetpoint::Position(sp))
    }

    fn activate(&mut self, mode: Mode, s: &PositionInput) {
        self.active = Some(mode);
        self.yaw = None;
        self.reset_manual_yaw = true;
        self.yaw_filtered = 0.0;
        self.yaw_slew = 0.0;
        self.tilt_input = Xy::ZERO;
        // ManualAltitude/FlightTaskManualAltitude.cpp:63-75;
        // ManualPosition/FlightTaskManualPosition.cpp:59-70.
        self.height_lock = Some(s.position[2]);
        self.xy_lock = (mode == Mode::Velocity).then(|| xy(s.position));
        if mode == Mode::Acceleration {
            // ManualAcceleration/FlightTaskManualAcceleration.cpp:46-63;
            // ManualAltitudeSmoothVel/FlightTaskManualAltitudeSmoothVel.cpp:44-61.
            let prev = &self.previous;
            self.acceleration_xy = AccelerationXy {
                velocity: finite_xy(prev.velocity).unwrap_or(xy(s.velocity)),
                slew: finite_xy(prev.acceleration).unwrap_or(Xy::ZERO),
                ..Default::default()
            };
            self.smooth_z = SmoothZ {
                x: finite_or(prev.position[2], s.position[2]),
                v: finite_or(prev.velocity[2], s.velocity[2]),
                a: finite_or(prev.acceleration[2], 0.0),
                ..Default::default()
            };
        }
    }

    // src/modules/mc_att_control/mc_att_control_main.cpp:103-171,210-221,327-330,358-360.
    fn stabilized(
        &mut self,
        s: Sticks,
        measured_yaw: f64,
        grounded: bool,
        dt: f64,
    ) -> ModeSetpoint {
        let g = &self.gains;
        let throttle = (s.throttle + 1.0) * 0.5;
        let mut yaw = self.yaw.unwrap_or(measured_yaw);
        let mut yaw_rate = 0.0;
        if self.reset_manual_yaw {
            yaw = measured_yaw;
        } else if throttle > 0.05 || self.airmode == 2 {
            yaw_rate = -s.yaw_right * g.mpc_man_y_max.to_radians();
            yaw = (yaw + yaw_rate * dt + PI).rem_euclid(TAU) - PI;
        }
        self.yaw = Some(yaw);
        self.reset_manual_yaw = grounded;
        let max_tilt = g.mpc_man_tilt_max.to_radians();
        let target = Xy::new(s.right, s.forward) * max_tilt;
        self.tilt_input = self.tilt_input.lerp(target, alpha(dt, g.mc_man_tilt_tau));
        let tilt = self.tilt_input.clamp_length_max(max_tilt);
        // Rz(heading) * tilt keeps the axis-angle's own diagonal yaw.
        let q = Rotation::from_rotation_z(yaw)
            * Rotation::from_scaled_axis(Vector::new(tilt.x, tilt.y, 0.0));
        let min = if grounded { 0.0 } else { g.mpc_manthr_min };
        // math/Functions.hpp:152-166,180-191 (gradual3).
        let collective = if g.mpc_thr_curve == 1.0 {
            min + throttle * (g.mpc_thr_max - min)
        } else if s.throttle < 0.0 {
            min + 2.0 * throttle * (g.mpc_thr_hover - min)
        } else {
            g.mpc_thr_hover + s.throttle * (g.mpc_thr_max - g.mpc_thr_hover)
        };
        ModeSetpoint::Attitude {
            attitude: [q.x, q.y, q.z, q.w],
            yaw_rate,
            collective,
        }
    }

    fn position_task(
        &mut self,
        mode: Mode,
        s: Sticks,
        state: &PositionInput,
        feedback: Option<[f64; 3]>,
        dt: f64,
    ) -> PositionSetpoint {
        let g = &self.gains;
        let mut sp = PositionSetpoint::default();
        let raw = Xy::new(s.forward, -s.right);
        let stick_xy = Xy::new(
            shaped(raw.x, g.mpc_xy_man_expo, g.mpc_hold_dz),
            shaped(raw.y, g.mpc_xy_man_expo, g.mpc_hold_dz),
        )
        .clamp_length_max(1.0);
        let stick_z = shaped(s.throttle, g.mpc_z_man_expo, g.mpc_hold_dz);
        let vz = stick_z
            * if s.throttle < 0.0 {
                g.mpc_z_vel_max_dn
            } else {
                g.mpc_z_vel_max_up
            };
        // FlightTask.cpp:188-200 uses local height without a range sensor or home.
        // FlightTaskManualAltitude.cpp:274-285,361 limits the shaped command
        // before ManualAltitudeSmoothVel updates its trajectory.
        let height = state.position[2];
        let gradual = |low: f64, high: f64| {
            // lib/mathlib/math/Functions.hpp:152-165, including coincident altitudes.
            if height <= g.mpc_land_alt2 {
                low
            } else if height > g.mpc_land_alt1 {
                high
            } else {
                low + (high - low) * ((height - g.mpc_land_alt2) / (g.mpc_land_alt1 - g.mpc_land_alt2))
            }
        };
        let vz = vz.clamp(
            -gradual(g.mpc_land_speed, g.mpc_z_vel_max_dn),
            gradual(g.mpc_tko_speed, g.mpc_z_vel_max_up),
        );
        let yaw_target =
            shaped(-s.yaw_right, g.mpc_yaw_expo, g.mpc_hold_dz) * g.mpc_man_y_max.to_radians();

        // ManualPosition:73-108 scales XY with the previous heading lock before
        // ManualAltitude:338-361 updates it. The other tasks rotate afterwards.
        let previous_heading = self.yaw.unwrap_or(state.yaw);
        // ManualAltitude:95-124,176-205,288-328; Utility/StickYaw.cpp:42-71;
        // ManualAcceleration:66-76 runs StickYaw after its base task.
        self.yaw_filtered +=
            dt / (g.mpc_man_y_tau + dt).max(0.001) * (yaw_target - self.yaw_filtered);
        self.yaw = if self.yaw_filtered.abs() > 0.001 {
            None
        } else {
            self.yaw.or(Some(state.yaw))
        };
        sp.yaw_rate = self.yaw_filtered;
        if mode == Mode::Acceleration {
            self.yaw_slew = slew(self.yaw_slew, yaw_target, TAU * dt);
            sp.yaw_rate = self.yaw_slew;
            self.yaw = if self.yaw_slew.abs() > EPS {
                None
            } else {
                self.yaw.or(Some(state.yaw))
            };
        }
        sp.yaw = self.yaw.unwrap_or(f64::NAN);
        let heading = self.yaw.unwrap_or(state.yaw);
        if mode == Mode::Acceleration {
            // FlightTaskManualAltitudeSmoothVel.cpp:74-110.
            self.smooth_z.step(
                vz,
                state.position[2],
                feedback.map(|v| v[2]),
                g,
                dt,
                &mut sp,
            );
            let stick = heading_frame(stick_xy, heading);
            self.acceleration_xy.step(stick, g, dt);
            let moving = self.acceleration_xy.velocity.length_squared() > EPS;
            if moving && self.xy_lock.take().is_some() {
                if let Some(v) = feedback.and_then(finite_xy) {
                    self.acceleration_xy.velocity = v;
                }
            } else if !moving {
                self.xy_lock.get_or_insert(xy(state.position));
            }
            sp.velocity[..2].copy_from_slice(&self.acceleration_xy.velocity.to_array());
            sp.acceleration[..2].copy_from_slice(&self.acceleration_xy.acceleration.to_array());
        } else {
            if stick_z.abs() > EPS {
                self.height_lock = None;
            } else if g.mpc_hold_max_z < EPS || state.velocity[2].abs() < g.mpc_hold_max_z {
                self.height_lock.get_or_insert(state.position[2]);
            }
            sp.position[2] = self.height_lock.unwrap_or(f64::NAN);
            sp.velocity[2] = vz;
            if mode == Mode::Velocity {
                let v = heading_frame(stick_xy * g.mpc_vel_manual, previous_heading);
                sp.velocity[..2].copy_from_slice(&v.to_array());
                // FlightTaskManualPosition.cpp:110-142.
                if v.length() >= EPS {
                    self.xy_lock = None;
                } else if g.mpc_hold_max_xy < EPS || xy(state.velocity).length() < g.mpc_hold_max_xy
                {
                    self.xy_lock.get_or_insert(xy(state.position));
                }
            } else {
                // Altitude uses the raw XY sticks, FlightTaskManualAltitude.cpp:347-358.
                self.tilt_input = self.tilt_input.lerp(raw, alpha(dt, g.mc_man_tilt_tau));
                let acc = heading_frame(self.tilt_input, heading).clamp_length_max(1.0)
                    * (G * g.mpc_man_tilt_max.to_radians().tan());
                sp.acceleration[..2].copy_from_slice(&acc.to_array());
            }
        }
        if let Some(lock) = self.xy_lock {
            sp.position[..2].copy_from_slice(&lock.to_array());
        }
        sp
    }
}

fn xy(v: [f64; 3]) -> Xy {
    Xy::new(v[0], v[1])
}
fn finite_xy(v: [f64; 3]) -> Option<Xy> {
    Some(xy(v)).filter(|p| p.is_finite())
}
fn finite_or(v: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

#[derive(Clone, Debug)]
struct AccelerationXy {
    velocity: Xy,
    acceleration: Xy,
    slew: Xy,
    brake_boost: f64,
}

impl Default for AccelerationXy {
    fn default() -> Self {
        Self {
            velocity: Xy::ZERO,
            acceleration: Xy::ZERO,
            slew: Xy::ZERO,
            brake_boost: 1.0,
        }
    }
}

impl AccelerationXy {
    // Utility/StickAccelerationXY.cpp:45-71,73-115,117-148,150-184.
    fn step(&mut self, stick: Xy, g: &PositionGains, dt: f64) {
        let scale = 2.0 * g.mpc_acc_hor;
        let target = stick * scale;
        let limit = unit_or_zero(target - self.acceleration).abs() * (g.mpc_jerk_max * dt);
        self.slew += (target - self.slew).clamp(-limit, limit);
        let boost = if stick.length_squared() < EPS {
            2.0_f64.max(g.mpc_vel_manual.sqrt())
        } else {
            1.0
        };
        self.brake_boost += alpha(dt, 0.8) * (boost - self.brake_boost);
        let speed = self.velocity.length();
        // math/Functions.hpp:205-217 (sqrt_linear for nonnegative speed).
        let drag_speed = if speed < 1.0 { speed.sqrt() } else { speed };
        let mut drag = unit_or_zero(self.velocity)
            * (drag_speed * self.brake_boost * scale / g.mpc_vel_manual);
        if self.slew.length_squared() < EPS
            && self.velocity.length_squared() < drag.length_squared() * dt * dt
        {
            self.velocity = Xy::ZERO;
            drag = Xy::ZERO;
        }
        self.acceleration =
            (self.slew - drag).clamp_length_max(G * g.mpc_tiltmax_air.to_radians().tan());
        self.velocity += self.acceleration * dt;
    }
}

// ManualVelocitySmoothingZ.cpp:52-76,91-119 and .hpp:75-94 provide the
// locked position and trajectory velocity/acceleration to manual mode 4.
// Durations are planned at the END of each sample for evaluation on the next.
#[derive(Clone, Default, Debug)]
struct SmoothZ {
    x: f64,
    v: f64,
    a: f64,
    locked: bool,
    jerk: f64,
    durations: [f64; 3],
}

impl SmoothZ {
    // src/lib/motion_planning/ManualVelocitySmoothingZ.cpp:39-119 and
    // ManualVelocitySmoothingZ.hpp:75-94. World Z-up, so positive target is up.
    fn step(
        &mut self,
        target: f64,
        position: f64,
        feedback: Option<f64>,
        g: &PositionGains,
        dt: f64,
        sp: &mut PositionSetpoint,
    ) {
        self.advance(dt);
        let lock = self.v.abs() < 0.1 && self.a.abs() < 0.2 && target.abs() <= EPS;
        if lock {
            sp.position[2] = self.x;
        } else {
            if self.locked {
                // ManualVelocitySmoothingZ.cpp:110-114 copies the feedback on unlock.
                // PX4 would copy a missing (NaN) feedback too and poison the trajectory;
                // ours keeps its own velocity then. FlightLoop always has feedback here.
                self.v = feedback.filter(|v| v.is_finite()).unwrap_or(self.v);
            }
            self.x = position;
        }
        self.locked = lock;
        sp.velocity[2] = self.v;
        sp.acceleration[2] = self.a;
        let a_max = if target > 0.0 {
            g.mpc_acc_up_max
        } else {
            g.mpc_acc_down_max
        };
        self.plan(target, g.mpc_jerk_max, a_max);
    }

    // VelocitySmoothing.cpp:58-102,138-149,157-223. Choose the direction
    // relative to the velocity after removing the current acceleration.
    fn plan(&mut self, target: f64, j_max: f64, a_max: f64) {
        let dv = target - self.v;
        let braking_dv = if self.a.abs() > EPS {
            self.a * self.a.abs() / (2.0 * j_max)
        } else {
            0.0
        };
        let direction = dv - braking_dv;
        let direction = if direction == 0.0 { self.a } else { direction };
        if direction == 0.0 {
            self.jerk = 0.0;
            self.durations = [0.0; 3];
            return;
        }
        let j = j_max.copysign(direction);
        self.jerk = j;
        let discriminant = 2.0 * self.a * self.a + 4.0 * j * dv;
        let mut t1 = 0.0;
        if discriminant >= 0.0 {
            let root = 0.5 * discriminant.sqrt();
            for signed_root in [root, -root] {
                let t = (signed_root - self.a) / j;
                if t >= 0.0 && self.a / j + t >= 0.0 {
                    t1 = t;
                    break;
                }
            }
            let peak = (self.a + j * t1).clamp(-a_max, a_max);
            t1 = ((peak - self.a) / j).max(0.0);
        }
        let t3 = (self.a / j + t1).max(0.0);
        let peak = self.a + j * t1;
        let ramp_dv = (self.a + peak) * 0.5 * t1 + peak * t3 - 0.5 * j * t3 * t3;
        let t2 = if peak.abs() > EPS {
            ((dv - ramp_dv) / peak).max(0.0)
        } else {
            0.0
        };
        self.durations = [t1, t2, t3];
    }

    // VelocitySmoothing.cpp:225-264. Integrate the three constant-jerk pieces,
    // then cruise at the terminal velocity for any remaining part of dt.
    fn advance(&mut self, dt: f64) {
        let mut left = dt;
        for (duration, jerk) in self.durations.into_iter().zip([self.jerk, 0.0, -self.jerk]) {
            let t = duration.min(left);
            self.x += t * (self.v + t * (self.a / 2.0 + t * jerk / 6.0));
            self.v += t * (self.a + jerk * t / 2.0);
            self.a += t * jerk;
            left -= t;
        }
        if left > 0.0 {
            self.a = 0.0;
            self.x += self.v * left;
        }
    }
}

#[cfg(test)]
mod tests;
