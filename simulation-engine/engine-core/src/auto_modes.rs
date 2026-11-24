//! Straight vertical takeoff and landing with a fixed XY and yaw target.
//! PX4 v1.13.3 FlightTaskAuto.cpp:118-287,806-857 and
//! motion_planning/PositionSmoothing.cpp:129-145,286-326.
//! The vertical trajectory reuses the port of VelocitySmoothing in flight_modes.
//! Multi-waypoint turns, XY trajectory smoothing, time stretching and axis
//! synchronization are outside this straight-path implementation.

use crate::flight_modes::{FlightCommand, SmoothZ};
use crate::position_control::{PositionGains, PositionInput, PositionSetpoint};
use crate::takeoff::TakeoffState;

// phase-6-flight-environment.md:233-234 and database/reference/physics.v1.json:1332-1340
// record navigator/mission_params.c:58.
const MIS_TAKEOFF_ALT: f64 = 2.5;
// mc_pos_control_params.c:215,245 and FlightTaskAuto.cpp:204.
const MPC_Z_V_AUTO_UP: f64 = 3.0;
const MPC_Z_V_AUTO_DN: f64 = 1.0;
const TAKEOFF_REQUEST_SPEED: f64 = 0.3;
const EPS: f64 = f32::EPSILON as f64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoMode {
    Takeoff,
    Hold,
    Land,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AutoCommand {
    Takeoff(f64),
    Hold,
    Land,
}

impl AutoCommand {
    pub(crate) fn from_flight(command: FlightCommand) -> Result<Option<Self>, String> {
        Ok(match command {
            FlightCommand::Takeoff { altitude_m } => {
                let height = altitude_m.unwrap_or(MIS_TAKEOFF_ALT);
                if !height.is_finite() || height <= 0.0 {
                    return Err("takeoff height above the run start must be finite and positive".into());
                }
                Some(Self::Takeoff(height))
            }
            FlightCommand::Hold => Some(Self::Hold),
            FlightCommand::Land => Some(Self::Land),
            _ => None,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AutoFlight {
    command: AutoCommand,
    pub(crate) mode: AutoMode,
    target: [f64; 3],
    yaw: f64,
    vertical: SmoothZ,
    arriving: bool,
}

impl AutoFlight {
    pub(crate) fn new(command: AutoCommand, state: &PositionInput, origin_z: f64) -> Result<Self, String> {
        let mut target = state.position;
        let mode = match command {
            AutoCommand::Takeoff(height) => {
                target[2] = origin_z + height;
                if !target[2].is_finite() {
                    return Err("takeoff target altitude must be finite".into());
                }
                AutoMode::Takeoff
            }
            AutoCommand::Hold => AutoMode::Hold,
            AutoCommand::Land => AutoMode::Land,
        };
        Ok(Self {
            command,
            mode,
            target,
            yaw: state.yaw,
            vertical: SmoothZ::at(state.position[2], state.velocity[2]),
            arriving: false,
        })
    }

    pub(crate) fn accepts(&self, command: AutoCommand) -> bool {
        self.command == command || (self.mode == AutoMode::Hold && command == AutoCommand::Hold)
    }

    pub(crate) fn wants_takeoff(&self, state: &PositionInput, origin_z: f64, g: &PositionGains, ramp_s: f64) -> bool {
        self.mode == AutoMode::Takeoff
            && self.target_speed(state.position[2], state.position[2] - origin_z, g, ramp_s).0
                > TAKEOFF_REQUEST_SPEED
    }

    pub(crate) fn setpoint(&mut self, state: &PositionInput, takeoff: TakeoffState, origin_z: f64,
        g: &PositionGains, ramp_s: f64, dt: f64) -> PositionSetpoint {
        let height = state.position[2] - origin_z;
        let mut sp = PositionSetpoint { position: self.target, yaw: self.yaw, ..Default::default() };
        if self.mode == AutoMode::Hold {
            return sp;
        }

        if !matches!(takeoff, TakeoffState::RampUp | TakeoffState::Flight) {
            // FlightTaskAuto.cpp:89-95 reactivates tracking from the current
            // position. Seed the simulator's parked trajectory at rest.
            self.vertical = SmoothZ::at(state.position[2], 0.0);
            self.arriving = false;
        }
        let previous_error = self.target[2] - self.vertical.x;
        self.vertical.advance(dt);
        let (velocity, acceleration_limit) = if self.mode == AutoMode::Land {
            sp.position[2] = f64::NAN;
            (-landing_speed(height, g), g.mpc_acc_down_max)
        } else {
            if takeoff != TakeoffState::Flight && height < g.mpc_land_alt1 {
                // FlightTaskAuto.cpp:841-848 anchors the trajectory altitude during takeoff.
                self.vertical.x = state.position[2];
            }
            let remaining = self.target[2] - self.vertical.x;
            if takeoff == TakeoffState::Flight {
                // Stop at the waypoint after reaching it, even if the sampled
                // trajectory crossed it between ticks. Keep the velocity and
                // acceleration continuous while braking to the hold.
                self.arriving |= remaining.abs() <= EPS || previous_error * remaining < 0.0;
                if self.arriving && self.vertical.v.abs() <= EPS && self.vertical.a.abs() <= EPS {
                    self.mode = AutoMode::Hold;
                    return sp;
                }
            }
            if self.arriving {
                (0.0, g.mpc_acc_down_max)
            } else {
                sp.position[2] = self.vertical.x;
                self.target_speed(self.vertical.x, height, g, ramp_s)
            }
        };
        sp.velocity[2] = self.vertical.v;
        sp.acceleration[2] = self.vertical.a;
        self.vertical.plan(velocity, g.mpc_jerk_auto, acceleration_limit);
        sp
    }

    fn target_speed(&self, z: f64, height: f64, g: &PositionGains, ramp_s: f64) -> (f64, f64) {
        let distance = self.target[2] - z;
        let (max_speed, max_accel) = if distance < 0.0 {
            // FlightTaskAuto.cpp:854-856. Land has its own descent profile.
            (MPC_Z_V_AUTO_DN.min(g.mpc_z_vel_max_dn), g.mpc_acc_down_max)
        } else if height < g.mpc_land_alt1 {
            // FlightTaskAuto.cpp:833-855 and MulticopterPositionControl.cpp:235.
            (g.mpc_tko_speed.min(g.mpc_z_vel_max_up), g.mpc_acc_up_max.min(g.mpc_tko_speed / ramp_s))
        } else {
            (MPC_Z_V_AUTO_UP.min(g.mpc_z_vel_max_up), g.mpc_acc_up_max)
        };
        let speed = stopping_speed(distance.abs(), max_accel, g.mpc_jerk_auto).min(max_speed);
        (speed.copysign(distance), max_accel)
    }

    pub(crate) fn hash_words(&self, words: &mut Vec<u64>) {
        let (command, height) = match self.command {
            AutoCommand::Takeoff(height) => (0, height.to_bits()),
            AutoCommand::Hold => (1, 0),
            AutoCommand::Land => (2, 0),
        };
        words.extend([command, height, self.mode as u64, self.yaw.to_bits(), self.arriving as u64]);
        words.extend(self.target.map(f64::to_bits));
        words.extend(self.vertical.hash_words());
    }
}

// Straight-path specialization of the stopping-speed calculation called by
// PositionSmoothing.cpp:138-145. From zero acceleration, symmetrical jerk
// ramps give d = v*sqrt(v/j) (triangular) or d = v*(v/a + a/j)/2 (trapezoidal).
fn stopping_speed(distance: f64, accel: f64, jerk: f64) -> f64 {
    let accel_time = accel / jerk;
    if distance <= accel * accel_time * accel_time {
        (distance * jerk.sqrt()).powf(2.0 / 3.0)
    } else {
        let half_ramp_speed = accel * accel_time / 2.0;
        (half_ramp_speed * half_ramp_speed + 2.0 * accel * distance).sqrt() - half_ramp_speed
    }
}

// FlightTaskAuto.cpp:232-245 and FlightTask.cpp:188-200. World Z-up: this is
// the positive descent-speed magnitude at height above the run start.
fn landing_speed(height: f64, g: &PositionGains) -> f64 {
    if height <= g.mpc_land_alt2 {
        g.mpc_land_speed
    } else if height > g.mpc_land_alt1 {
        g.mpc_z_vel_max_dn
    } else {
        let fraction = (height - g.mpc_land_alt2) / (g.mpc_land_alt1 - g.mpc_land_alt2);
        g.mpc_land_speed + (g.mpc_z_vel_max_dn - g.mpc_land_speed) * fraction
    }
}

#[cfg(test)]
mod tests;
