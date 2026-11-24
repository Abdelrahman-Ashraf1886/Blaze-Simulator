//! PX4 v1.13.3 multicopter land detection on simulation state.
//!
//! With no range sensor, PX4 skips the close-to-ground check and uses the
//! ordinary hysteresis delays (LandDetector.cpp:122-142 and
//! MulticopterLandDetector.cpp:232-245). The four detection levels do not
//! consume the ground-effect output or its takeoff-state input (:327-332).
//! Position-control enable and acceleration setpoints are also outside these
//! predicates (:149-325). Freefall consumes measured specific force.

use crate::takeoff::{RisingHysteresis, MICROS_PER_SECOND};

// PX4 src/modules/land_detector/MulticopterLandDetector.h:84,87.
const FREEFALL_TRIGGER_TIME_US: u64 = 300_000;
const LAND_DETECTOR_LAND_PHASE_TIME_US: u64 = 2 * MICROS_PER_SECOND;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LandDetectorParams {
    /// Seconds across all three consecutive landing stages.
    pub lndmc_trig_time: f64,
    pub lndmc_z_vel_max: f64,
    pub lndmc_xy_vel_max: f64,
    pub lndmc_rot_max: f64, // deg/s
    pub mpc_land_speed: f64,
    /// The detector reads this even without range sensing.
    pub mpc_land_crwl: f64,
    pub mpc_thr_min: f64,
    pub mpc_manthr_min: f64,
    pub mpc_thr_hover: f64,
    pub mpc_use_hte: bool,
}

impl Default for LandDetectorParams {
    fn default() -> Self {
        Self {
            // PX4 src/modules/land_detector/land_detector_params_mc.c:48,60,72,84.
            lndmc_trig_time: 1.0,
            lndmc_z_vel_max: 0.5,
            lndmc_xy_vel_max: 1.5,
            lndmc_rot_max: 20.0,
            // PX4 src/modules/mc_pos_control/mc_pos_control_params.c:54,75,86,152,415,425.
            mpc_land_speed: 0.7,
            mpc_land_crwl: 0.3,
            mpc_thr_min: 0.12,
            mpc_manthr_min: 0.08,
            mpc_thr_hover: 0.5,
            mpc_use_hte: true,
        }
    }
}

impl LandDetectorParams {
    pub fn validate(&self) -> Result<(), String> {
        // PX4 land_detector_params_mc.c:42-43 and mc_pos_control_params.c:48-49,69-70,146-147,411,421.
        for (name, value, bounds) in [
            ("LNDMC_TRIG_TIME", self.lndmc_trig_time, 0.1..=10.0),
            ("MPC_THR_MIN", self.mpc_thr_min, 0.05..=1.0),
            ("MPC_MANTHR_MIN", self.mpc_manthr_min, 0.0..=1.0),
            ("MPC_THR_HOVER", self.mpc_thr_hover, 0.1..=0.8),
        ] {
            if !bounds.contains(&value) {
                return Err(format!("{name} must be in {bounds:?}"));
            }
        }
        for (name, value, min) in [
            ("MPC_LAND_SPEED", self.mpc_land_speed, 0.6),
            ("MPC_LAND_CRWL", self.mpc_land_crwl, 0.3),
        ] {
            if !value.is_finite() || value < min {
                return Err(format!("{name} must be finite and at least {min}"));
            }
        }
        // PX4 land_detector_params_mc.c:50-84 gives no numeric bounds for these.
        for (name, value) in [
            ("LNDMC_Z_VEL_MAX", self.lndmc_z_vel_max),
            ("LNDMC_XY_VEL_MAX", self.lndmc_xy_vel_max),
            ("LNDMC_ROT_MAX", self.lndmc_rot_max),
        ] {
            if !value.is_finite() {
                return Err(format!("{name} must be finite"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HoverThrustUpdate {
    pub timestamp_us: u64,
    pub hover_thrust: f64,
}

/// Supply current true state and controller data in place of PX4 topics.
/// All timestamps use the same monotonic simulation clock.
#[derive(Debug, Clone, Copy)]
pub struct LandDetectorInput {
    pub now_us: u64,
    /// Run arming state, used by all three landing levels.
    pub armed: bool,
    /// Timestamp shared by both velocities (PX4 vehicle_local_position).
    pub local_position_timestamp_us: u64,
    /// Valid true vertical velocity, positive up. The movement check uses its
    /// magnitude, so changing from NED does not change the threshold.
    pub vertical_velocity_up_m_s: Option<f64>,
    /// Valid true horizontal velocity. Ground contact uses its magnitude.
    pub horizontal_velocity_m_s: Option<[f64; 2]>,
    /// True body angular velocity. Maybe-landed uses roll and pitch only.
    pub body_rates_rad_s: [f64; 3],
    /// True body specific force for freefall, including support force at rest.
    /// Derive it as kinematic acceleration minus gravity, in body coordinates.
    pub specific_force_body_m_s2: [f64; 3],
    /// Normalized positive collective command (actuator_controls_0 throttle).
    /// Ground contact and maybe-landed compare it to the configured minimum
    /// throttles and the current hover thrust.
    pub collective_thrust: f64,
    /// Supply only newly published valid estimates. The detector retains the
    /// last valid update and starts from MPC_THR_HOVER.
    pub hover_thrust_estimate_update: Option<HoverThrustUpdate>,
    /// Controller flag selecting commanded-descent and minimum-throttle checks.
    pub climb_rate_control_enabled: bool,
    /// Newly published trajectory vertical velocity setpoint, positive up.
    /// Use None when there is no new setpoint, Some(NaN) when a new setpoint
    /// has no vertical velocity. PX4's down-positive descent comparison becomes
    /// an up-positive comparison against the negative of the crawl threshold.
    pub vertical_velocity_setpoint_up_m_s_update: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LandState {
    pub freefall: bool,
    pub ground_contact: bool,
    pub maybe_landed: bool,
    pub landed: bool,
}

#[derive(Debug, Clone)]
pub struct LandDetector {
    params: LandDetectorParams,
    freefall: RisingHysteresis,
    ground_contact: RisingHysteresis,
    maybe_landed: RisingHysteresis,
    landed: RisingHysteresis,
    hover_thrust: f64,
    hover_thrust_estimate_last_valid_us: u64,
    hover_thrust_estimate_valid: bool,
    in_descend: bool,
    min_thrust_start_us: u64,
    landed_time_us: u64,
}

impl LandDetector {
    pub fn new(params: LandDetectorParams) -> Result<Self, String> {
        params.validate()?;
        // PX4 LandDetector.h:144-147 and MulticopterLandDetector.h:118-131.
        Ok(Self {
            params,
            freefall: RisingHysteresis::new(false),
            ground_contact: RisingHysteresis::new(true),
            maybe_landed: RisingHysteresis::new(true),
            landed: RisingHysteresis::new(true),
            hover_thrust: params.mpc_thr_hover,
            hover_thrust_estimate_last_valid_us: 0,
            hover_thrust_estimate_valid: false,
            in_descend: false,
            min_thrust_start_us: 0,
            landed_time_us: 0,
        })
    }

    pub fn state(&self) -> LandState {
        LandState {
            freefall: self.freefall.state(),
            ground_contact: self.ground_contact.state(),
            maybe_landed: self.maybe_landed.state(),
            landed: self.landed.state(),
        }
    }

    /// LandDetector.cpp:136-147. Each check can see the preceding levels
    /// updated in the same tick. A failed predicate clears its level immediately.
    pub fn step(&mut self, input: LandDetectorInput) -> LandState {
        let now_us = input.now_us;
        // MulticopterLandDetector.cpp:100-109.
        if self.params.mpc_use_hte {
            if let Some(update) = input.hover_thrust_estimate_update {
                self.hover_thrust = update.hover_thrust;
                self.hover_thrust_estimate_last_valid_us = update.timestamp_us;
            }
        }

        // MulticopterLandDetector.cpp:346-349 truncates the fractional microseconds.
        let delay_us = (self.params.lndmc_trig_time * MICROS_PER_SECOND as f64 / 3.0) as u64;
        let [x, y, z] = input.specific_force_body_m_s2;
        // MulticopterLandDetector.cpp:149-152.
        let is_freefall = (x * x + y * y + z * z).sqrt() < 2.0;
        self.freefall.update(is_freefall, now_us, FREEFALL_TRIGGER_TIME_US);

        // MulticopterLandDetector.cpp:159,164,184,299.
        let position_fresh = now_us.wrapping_sub(input.local_position_timestamp_us) < MICROS_PER_SECOND;
        let vertical_velocity = input.vertical_velocity_up_m_s.filter(|_| position_fresh);
        let horizontal_velocity = input.horizontal_velocity_m_s.filter(|_| position_fresh);
        let ground_contact = self.check_ground_contact(&input, vertical_velocity, horizontal_velocity);
        self.ground_contact.update(ground_contact, now_us, delay_us);
        let maybe_landed = self.check_maybe_landed(&input, vertical_velocity.is_some());
        self.maybe_landed.update(maybe_landed, now_us, delay_us);

        // MulticopterLandDetector.cpp:307-324. The time is latched when
        // maybe-landed first becomes true, before the final landed delay.
        if !self.maybe_landed.state() {
            self.landed_time_us = 0;
        } else if self.landed_time_us == 0 {
            self.landed_time_us = now_us;
        }
        self.landed.update(!input.armed || self.maybe_landed.state(), now_us, delay_us);
        self.state()
    }

    // MulticopterLandDetector.cpp:155-245.
    fn check_ground_contact(
        &mut self,
        input: &LandDetectorInput,
        vertical_velocity: Option<f64>,
        horizontal_velocity: Option<[f64; 2]>,
    ) -> bool {
        let crawl_speed_threshold = 0.9 * self.params.mpc_land_crwl.max(0.1);
        // The firmware clamps the effective parameter to MPC_LAND_SPEED (:125-130).
        let z_vel_max = self.params.lndmc_z_vel_max.min(self.params.mpc_land_speed);
        let max_climb_rate = if self.in_land_phase(input.now_us) {
            z_vel_max * 2.5
        } else {
            z_vel_max.min(crawl_speed_threshold * 0.5)
        };
        let vertical_movement = vertical_velocity.is_none_or(|vz| vz.abs() > max_climb_rate);
        let horizontal_movement = horizontal_velocity.is_some_and(|[vx, vy]| {
            vx * vx + vy * vy > self.params.lndmc_xy_vel_max.powi(2)
        });

        let estimate_fresh = input.now_us.wrapping_sub(self.hover_thrust_estimate_last_valid_us)
            < MICROS_PER_SECOND;
        if !self.in_descend || estimate_fresh {
            self.hover_thrust_estimate_valid = estimate_fresh;
        }
        let hover_fraction = if self.hover_thrust_estimate_valid { 0.6 } else { 0.3 };
        let low_throttle = self.params.mpc_thr_min
            + (self.hover_thrust - self.params.mpc_thr_min) * hover_fraction;
        let mut ground_contact = input.collective_thrust <= low_throttle;

        if input.climb_rate_control_enabled {
            if let Some(vz_up) = input.vertical_velocity_setpoint_up_m_s_update {
                self.in_descend = vz_up.is_finite() && vz_up <= -crawl_speed_threshold;
            }
            if !self.maybe_landed.state() && !self.landed.state() {
                ground_contact &= self.in_descend;
            }
        } else {
            self.in_descend = false;
        }

        !input.armed || (ground_contact && !horizontal_movement && !vertical_movement)
    }

    // MulticopterLandDetector.cpp:248-304.
    fn check_maybe_landed(&mut self, input: &LandDetectorInput, vertical_velocity_valid: bool) -> bool {
        if !input.armed {
            return true;
        }

        let min_throttle = if input.climb_rate_control_enabled {
            self.params.mpc_thr_min + (self.hover_thrust - self.params.mpc_thr_min) * 0.1
        } else {
            self.params.mpc_manthr_min + 0.01
        };
        if input.collective_thrust <= min_throttle {
            if self.min_thrust_start_us == 0 {
                self.min_thrust_start_us = input.now_us;
            }
        } else {
            self.min_thrust_start_us = 0;
            return false;
        }

        let land_threshold_factor = if self.in_land_phase(input.now_us) { 2.5 } else { 1.0 };
        let max_rotation = self.params.lndmc_rot_max.to_radians() * land_threshold_factor;
        let [roll, pitch, _] = input.body_rates_rad_s;
        if self.freefall.state() || (roll * roll + pitch * pitch).sqrt() > max_rotation {
            return false;
        }
        if vertical_velocity_valid {
            self.ground_contact.state()
        } else {
            self.min_thrust_start_us != 0
                && input.now_us.wrapping_sub(self.min_thrust_start_us) > 8 * MICROS_PER_SECOND
        }
    }

    fn in_land_phase(&self, now_us: u64) -> bool {
        // PX4 compares against the zero-initialized timestamp even at boot.
        now_us.wrapping_sub(self.landed_time_us) < LAND_DETECTOR_LAND_PHASE_TIME_US
    }

    pub fn hash_words(&self) -> [u64; 28] {
        let [freefall, freefall_requested, freefall_since] = self.freefall.hash_words();
        let [contact, contact_requested, contact_since] = self.ground_contact.hash_words();
        let [maybe, maybe_requested, maybe_since] = self.maybe_landed.hash_words();
        let [landed, landed_requested, landed_since] = self.landed.hash_words();
        [
            self.params.lndmc_trig_time.to_bits(),
            self.params.lndmc_z_vel_max.to_bits(),
            self.params.lndmc_xy_vel_max.to_bits(),
            self.params.lndmc_rot_max.to_bits(),
            self.params.mpc_land_speed.to_bits(),
            self.params.mpc_land_crwl.to_bits(),
            self.params.mpc_thr_min.to_bits(),
            self.params.mpc_manthr_min.to_bits(),
            self.params.mpc_thr_hover.to_bits(),
            self.params.mpc_use_hte as u64,
            freefall, freefall_requested, freefall_since,
            contact, contact_requested, contact_since,
            maybe, maybe_requested, maybe_since,
            landed, landed_requested, landed_since,
            self.hover_thrust.to_bits(),
            self.hover_thrust_estimate_last_valid_us,
            self.hover_thrust_estimate_valid as u64,
            self.in_descend as u64,
            self.min_thrust_start_us,
            self.landed_time_us,
        ]
    }
}

#[cfg(test)]
mod tests;
