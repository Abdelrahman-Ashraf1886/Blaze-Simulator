//! Takeoff, hold, land, and multicopter return to the run start.
//! PX4 v1.13.3 FlightTaskAuto.cpp:118-287,806-857 and
//! motion_planning/PositionSmoothing.cpp:129-145,286-326.
//! The vertical trajectory reuses the port of VelocitySmoothing in flight_modes.
//! Return uses a scalar horizontal trajectory on a straight track. See
//! PositionSmoothing.cpp:107-126,235-251,286-325.

use crate::flight_modes::{FlightCommand, VelocitySmoothing};
use crate::position_control::{PositionGains, PositionInput, PositionSetpoint};
use crate::takeoff::{TakeoffState, MICROS_PER_SECOND};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::f64::consts::{PI, TAU};
use std::sync::OnceLock;

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
    Return,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReturnState {
    Climb,
    Return,
    Descend,
    Loiter,
    Land,
    Landed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AutoCommand {
    Takeoff(f64),
    Hold,
    Land,
    Return,
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
            FlightCommand::Return => Some(Self::Return),
            _ => None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ReturnParams {
    return_alt: f64,
    descend_alt: f64,
    land_delay: f64,
    min_dist: f64,
    cone_angle: f64,
    xy_radius: f64,
    z_radius: f64,
    yaw_tolerance: f64,
    cruise_speed: f64,
}

#[derive(Deserialize)]
struct ReferenceParameter {
    key: String,
    value: f64,
    min: Option<f64>,
    max: Option<f64>,
}

fn return_reference(key: &str) -> Result<&'static ReferenceParameter, String> {
    static PARAMETERS: OnceLock<Vec<ReferenceParameter>> = OnceLock::new();
    PARAMETERS.get_or_init(|| {
        let data: Value = serde_json::from_str(include_str!("../../../database/reference/physics.v1.json"))
            .expect("physics reference JSON");
        let set = data["sets"].as_array().expect("physics reference sets")
            .iter().find(|set| set["id"] == "returnPx4").expect("returnPx4 reference set");
        serde_json::from_value(set["values"].clone()).expect("returnPx4 reference values")
    }).iter().find(|p| p.key == key).ok_or_else(|| format!("missing PX4 reference for {key}"))
}

impl ReturnParams {
    /// Consume the exact return and navigation names before the session gain parser runs.
    pub fn take_overrides(gains: &mut Map<String, Value>) -> Result<Self, String> {
        let mut get = |key| {
            let parameter = return_reference(key)?;
            let Some(value) = gains.remove(key) else { return Ok(parameter.value) };
            let value = value.as_f64().filter(|v| v.is_finite())
                .ok_or_else(|| format!("{key} must be a finite number"))?;
            if parameter.min.is_some_and(|min| value < min) || parameter.max.is_some_and(|max| value > max) {
                return Err(format!("{key} outside documented bounds ({:?}..{:?})", parameter.min, parameter.max));
            }
            Ok(value)
        };
        let params = Self {
            return_alt: get("RTL_RETURN_ALT")?,
            descend_alt: get("RTL_DESCEND_ALT")?,
            land_delay: get("RTL_LAND_DELAY")?,
            min_dist: get("RTL_MIN_DIST")?,
            cone_angle: get("RTL_CONE_ANG")?,
            xy_radius: get("NAV_ACC_RAD")?,
            z_radius: get("NAV_MC_ALT_RAD")?,
            yaw_tolerance: get("MIS_YAW_ERR")?.to_radians(),
            cruise_speed: get("MPC_XY_CRUISE")?,
        };
        // rtl_params.c:138,176 are INT32 parameters. Heading mode 0 is fixed.
        if params.cone_angle.fract() != 0.0 {
            return Err("RTL_CONE_ANG must be an integer".into());
        }
        if get("RTL_HDG_MD")? != return_reference("RTL_HDG_MD")?.value {
            return Err("RTL_HDG_MD must be 0 for return to start".into());
        }
        Ok(params)
    }
}

impl Default for ReturnParams {
    fn default() -> Self {
        Self::take_overrides(&mut Map::new()).expect("valid PX4 RTL defaults")
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Home {
    pub(crate) position: [f64; 3],
    pub(crate) yaw: f64,
}

pub(crate) struct AutoStep<'a> {
    pub(crate) estimate: &'a PositionInput,
    pub(crate) takeoff: TakeoffState,
    pub(crate) landed: bool,
    pub(crate) now_us: u64,
    pub(crate) ramp_s: f64,
    pub(crate) dt: f64,
}

#[derive(Clone, Debug)]
pub(crate) enum AutoFlight {
    Vertical(VerticalFlight),
    Return(ReturnFlight),
}

impl AutoFlight {
    pub(crate) fn new(command: AutoCommand, estimate: &PositionInput, home: Home,
        landed: bool, params: ReturnParams) -> Result<Self, String> {
        if command == AutoCommand::Return {
            return Ok(Self::Return(ReturnFlight::new(estimate, home, landed, params)));
        }
        Ok(Self::Vertical(VerticalFlight::new(command, estimate, home.position[2])?))
    }

    pub(crate) fn accepts(&self, command: AutoCommand) -> bool {
        match self {
            Self::Vertical(active) => active.accepts(command),
            Self::Return(_) => command == AutoCommand::Return,
        }
    }

    pub(crate) fn mode(&self) -> AutoMode {
        match self {
            Self::Vertical(active) => active.mode,
            Self::Return(_) => AutoMode::Return,
        }
    }

    pub(crate) fn return_state(&self, landed: bool) -> Option<ReturnState> {
        let Self::Return(active) = self else { return None };
        Some(if landed && active.state == ReturnState::Land { ReturnState::Landed } else { active.state })
    }

    pub(crate) fn wants_takeoff(&self, estimate: &PositionInput, origin_z: f64, g: &PositionGains, ramp_s: f64) -> bool {
        match self {
            Self::Vertical(active) => active.wants_takeoff(estimate, origin_z, g, ramp_s),
            Self::Return(_) => false,
        }
    }

    pub(crate) fn setpoint(&mut self, input: AutoStep<'_>, origin_z: f64, g: &PositionGains) -> PositionSetpoint {
        match self {
            Self::Vertical(active) => active.setpoint(input.estimate, input.takeoff, origin_z, g, input.ramp_s, input.dt),
            Self::Return(active) => active.setpoint(input, g),
        }
    }

    pub(crate) fn hash_words(&self, words: &mut Vec<u64>) {
        match self {
            Self::Vertical(active) => active.hash_words(words),
            Self::Return(active) => active.hash_words(words),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct VerticalFlight {
    command: AutoCommand,
    mode: AutoMode,
    target: [f64; 3],
    yaw: f64,
    vertical: VelocitySmoothing,
    arriving: bool,
}

impl VerticalFlight {
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
            AutoCommand::Return => unreachable!("return uses a separate trajectory"),
        };
        Ok(Self {
            command,
            mode,
            target,
            yaw: state.yaw,
            vertical: VelocitySmoothing::at(state.position[2], state.velocity[2]),
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
            self.vertical = VelocitySmoothing::at(state.position[2], 0.0);
            self.arriving = false;
        }
        let previous_error = self.target[2] - self.vertical.x;
        self.vertical.advance(dt);
        let (velocity, acceleration_limit) = if self.mode == AutoMode::Land {
            landing_target(&mut sp, height, g)
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
            AutoCommand::Return => unreachable!("return uses a separate hash"),
        };
        words.extend([command, height, self.mode as u64, self.yaw.to_bits(), self.arriving as u64]);
        words.extend(self.target.map(f64::to_bits));
        words.extend(self.vertical.hash_words());
    }
}

fn landing_target(sp: &mut PositionSetpoint, height: f64, g: &PositionGains) -> (f64, f64) {
    sp.position[2] = f64::NAN;
    (-landing_speed(height, g), g.mpc_acc_down_max)
}

// rtl.cpp:51,608.
const DELAY_SIGMA: f32 = 0.01;

#[derive(Clone, Debug)]
pub(crate) struct ReturnFlight {
    state: ReturnState,
    home: Home,
    params: ReturnParams,
    return_altitude: f64,
    target: [f64; 3],
    yaw: f64,
    climb_yaw: f64,
    activated: bool,
    position_reached_us: Option<u64>,
    yaw_reached: bool,
    vertical: VelocitySmoothing,
    horizontal: Option<ReturnTrack>,
}

impl ReturnFlight {
    fn new(estimate: &PositionInput, home: Home, landed: bool, params: ReturnParams) -> Self {
        let [dx, dy] = difference_xy(home.position, estimate.position);
        let return_altitude = return_altitude(estimate.position[2], home.position[2], dx.hypot(dy), params, params.xy_radius);
        let mut active = Self {
            state: ReturnState::Landed,
            home,
            params,
            return_altitude,
            target: estimate.position,
            yaw: estimate.yaw,
            climb_yaw: estimate.yaw,
            activated: false,
            position_reached_us: None,
            yaw_reached: false,
            vertical: VelocitySmoothing::at(estimate.position[2], estimate.velocity[2]),
            horizontal: None,
        };
        // rtl.cpp:274-293 compares against the full return height even inside the cone.
        if !landed {
            let initial = if estimate.position[2] < home.position[2] + params.return_alt {
                ReturnState::Climb
            } else {
                ReturnState::Return
            };
            active.enter(initial, estimate);
        }
        active
    }

    fn enter(&mut self, state: ReturnState, estimate: &PositionInput) {
        self.state = state;
        self.position_reached_us = None;
        self.yaw_reached = false;
        self.target = match state {
            ReturnState::Climb => [estimate.position[0], estimate.position[1], self.return_altitude],
            ReturnState::Return => {
                self.horizontal = ReturnTrack::new(estimate, self.home.position);
                [self.home.position[0], self.home.position[1], self.return_altitude]
            }
            ReturnState::Descend | ReturnState::Loiter => {
                let altitude = (self.home.position[2] + self.params.descend_alt)
                    .min(estimate.position[2]).min(self.return_altitude);
                [self.home.position[0], self.home.position[1], altitude]
            }
            ReturnState::Land => self.home.position,
            ReturnState::Landed => {
                self.horizontal = None;
                estimate.position
            }
        };
    }

    fn desired_yaw(&self, estimate: &PositionInput) -> f64 {
        match self.state {
            ReturnState::Climb => self.climb_yaw,
            ReturnState::Return => {
                let [dx, dy] = difference_xy(self.home.position, estimate.position);
                if dx.hypot(dy) > self.params.min_dist { dy.atan2(dx) } else { self.home.yaw }
            }
            _ => self.home.yaw,
        }
    }

    fn advance_state(&mut self, estimate: &PositionInput, landed: bool, now_us: u64) {
        use ReturnState::*;
        match self.state {
            Landed => return,
            Land => {
                if landed {
                    self.enter(Landed, estimate);
                }
                return;
            }
            Loiter if self.params.land_delay <= 0.0 => return,
            _ => {}
        }

        // mission_block.cpp:271-280,336-397 latches position before checking yaw
        // and measures the loiter delay from position acceptance.
        let [dx, dy] = difference_xy(self.target, estimate.position);
        if dx.hypot(dy) <= self.params.xy_radius
            && (self.target[2] - estimate.position[2]).abs() <= self.params.z_radius
        {
            self.position_reached_us.get_or_insert(now_us);
        }
        let Some(reached) = self.position_reached_us else { return };
        self.yaw_reached |= wrap_yaw(self.desired_yaw(estimate) - estimate.yaw).abs() < self.params.yaw_tolerance;
        if !self.yaw_reached {
            return;
        }
        let next = match self.state {
            Climb => Return,
            Return if (self.params.land_delay as f32).abs() > DELAY_SIGMA => Descend,
            Return => Land,
            Descend => Loiter,
            Loiter if now_us - reached >= (self.params.land_delay * MICROS_PER_SECOND as f64) as u64 => Land,
            _ => return,
        };
        self.enter(next, estimate);
    }

    fn setpoint(&mut self, input: AutoStep<'_>, g: &PositionGains) -> PositionSetpoint {
        // rtl.cpp:301-309 publishes the first item before testing acceptance.
        if self.activated {
            self.advance_state(input.estimate, input.landed, input.now_us);
        }
        self.activated = true;
        let mut sp = PositionSetpoint { position: self.target, yaw: self.yaw, ..Default::default() };
        if self.state == ReturnState::Landed {
            return sp;
        }

        // FlightTaskAuto.cpp:289-305. Use the shortest rotation in world Z-up.
        let max_change = 45.0_f64.to_radians() * input.dt; // physics.v1.json, takeoffLandPx4.MPC_YAWRAUTO_MAX
        let error = wrap_yaw(self.desired_yaw(input.estimate) - self.yaw);
        self.yaw = wrap_yaw(self.yaw + error.clamp(-max_change, max_change));
        sp.yaw = self.yaw;
        if let Some(track) = &mut self.horizontal {
            track.setpoint(&mut sp, self.home.position, self.params.cruise_speed.min(g.mpc_xy_vel_max), g, input.dt);
        }

        self.vertical.advance(input.dt);
        let (velocity, acceleration_limit) = if self.state == ReturnState::Land {
            landing_target(&mut sp, input.estimate.position[2] - self.home.position[2], g)
        } else {
            let remaining = self.target[2] - self.vertical.x;
            sp.position[2] = self.vertical.x;
            let (speed, acceleration) = if remaining < 0.0 {
                (MPC_Z_V_AUTO_DN.min(g.mpc_z_vel_max_dn), g.mpc_acc_down_max)
            } else {
                (MPC_Z_V_AUTO_UP.min(g.mpc_z_vel_max_up), g.mpc_acc_up_max)
            };
            let speed = stopping_speed(remaining.abs(), acceleration, g.mpc_jerk_auto).min(speed);
            (speed.copysign(remaining), acceleration)
        };
        sp.velocity[2] = self.vertical.v;
        sp.acceleration[2] = self.vertical.a;
        self.vertical.plan(velocity, g.mpc_jerk_auto, acceleration_limit);
        sp
    }

    fn hash_words(&self, words: &mut Vec<u64>) {
        words.extend([3, self.state as u64, self.home.yaw.to_bits(), self.return_altitude.to_bits(),
            self.yaw.to_bits(), self.climb_yaw.to_bits(), self.activated as u64,
            self.yaw_reached as u64, self.position_reached_us.is_some() as u64,
            self.position_reached_us.unwrap_or_default()]);
        words.extend(self.home.position.map(f64::to_bits));
        words.extend(self.target.map(f64::to_bits));
        words.extend([self.params.return_alt, self.params.descend_alt, self.params.land_delay,
            self.params.min_dist, self.params.cone_angle, self.params.xy_radius, self.params.z_radius,
            self.params.yaw_tolerance, self.params.cruise_speed].map(f64::to_bits));
        words.extend(self.vertical.hash_words());
        words.push(self.horizontal.is_some() as u64);
        if let Some(track) = &self.horizontal {
            words.extend(track.direction.map(f64::to_bits));
            words.extend(track.motion.hash_words());
        }
    }
}

// rtl.cpp:683-717. Local XY distance replaces the global geodesic distance.
fn return_altitude(current: f64, home: f64, distance: f64, p: ReturnParams, radius: f64) -> f64 {
    let above_home = if distance <= radius {
        2.0 * distance
    } else {
        let requested = if p.cone_angle > 0.0 && distance <= p.min_dist {
            p.return_alt.min(distance / p.cone_angle.clamp(1.0, 89.0).to_radians().tan())
        } else {
            p.return_alt
        };
        requested.max(2.0 * radius)
    };
    (home + above_home).max(current)
}

#[derive(Clone, Debug)]
struct ReturnTrack {
    direction: [f64; 2],
    motion: VelocitySmoothing,
}

impl ReturnTrack {
    fn new(estimate: &PositionInput, home: [f64; 3]) -> Option<Self> {
        let [dx, dy] = difference_xy(home, estimate.position);
        let distance = dx.hypot(dy);
        if distance == 0.0 {
            return None;
        }
        let direction = [dx / distance, dy / distance];
        let velocity = estimate.velocity[0] * direction[0] + estimate.velocity[1] * direction[1];
        Some(Self { direction, motion: VelocitySmoothing::at(-distance, velocity) })
    }

    fn setpoint(&mut self, sp: &mut PositionSetpoint, home: [f64; 3], cruise: f64, g: &PositionGains, dt: f64) {
        // The endpoint is scalar position 0. Port the single-waypoint speed
        // constraint from TrajectoryConstraints.hpp:70-98 and TrajMath.hpp:61-70.
        let accel = g.mpc_acc_hor;
        let jerk = g.mpc_jerk_auto;
        let b = 4.0 * accel * accel / jerk;
        let remaining = -self.motion.x;
        let speed = (0.5 * ((b * b + 8.0 * accel * remaining.abs()).sqrt() - b)).min(cruise);
        self.motion.advance(dt);
        for (axis, (origin, direction)) in home.into_iter().zip(self.direction).enumerate() {
            sp.position[axis] = origin + direction * self.motion.x;
            sp.velocity[axis] = direction * self.motion.v;
            sp.acceleration[axis] = direction * self.motion.a;
        }
        self.motion.plan(speed.copysign(remaining), jerk, accel);
    }
}

fn difference_xy(target: [f64; 3], position: [f64; 3]) -> [f64; 2] {
    [target[0] - position[0], target[1] - position[1]]
}

fn wrap_yaw(yaw: f64) -> f64 {
    (yaw + PI).rem_euclid(TAU) - PI
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
