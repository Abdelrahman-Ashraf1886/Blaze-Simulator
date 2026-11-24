//! PX4 v1.13.3 multicopter takeoff state machine and climb-speed ramp.
//!
//! The ramp limits signed Z-up velocity. PX4's `speed_up` is already up-positive,
//! so the ramp inputs and outputs keep their signs. PX4 applies the negative
//! of this limit as the lower bound on the NED velocity setpoint.
//! See MulticopterPositionControl.cpp:439-442 and PositionControl.cpp:137.

use crate::math::STANDARD_GRAVITY as G; // PX4 src/lib/geo/geo.h:54

pub(crate) const MICROS_PER_SECOND: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TakeoffParams {
    /// Seconds from arming to spool-up completion.
    pub mpc_spoolup_time: f64,
    /// Seconds from ramp entry to the desired climb speed.
    pub mpc_tko_ramp_t: f64,
    pub mpc_z_vel_p_acc: f64,
}

impl Default for TakeoffParams {
    fn default() -> Self {
        // PX4 src/modules/mc_pos_control/mc_pos_control_params.c:174,764,797.
        Self {
            mpc_spoolup_time: 1.0,
            mpc_tko_ramp_t: 3.0,
            mpc_z_vel_p_acc: 4.0,
        }
    }
}

impl TakeoffParams {
    pub fn validate(&self) -> Result<(), String> {
        // PX4 src/modules/mc_pos_control/mc_pos_control_params.c:169-170,760-761,792-793.
        for (name, value, bounds) in [
            ("MPC_SPOOLUP_TIME", self.mpc_spoolup_time, 0.0..=10.0),
            ("MPC_TKO_RAMP_T", self.mpc_tko_ramp_t, 0.0..=5.0),
            ("MPC_Z_VEL_P_ACC", self.mpc_z_vel_p_acc, 2.0..=15.0),
        ] {
            if !bounds.contains(&value) {
                return Err(format!("{name} must be in {bounds:?}"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeoffState {
    Disarmed,
    SpoolUp,
    ReadyForTakeoff,
    RampUp,
    Flight,
}

#[derive(Debug, Clone)]
pub struct Takeoff {
    params: TakeoffParams,
    state: TakeoffState,
    spoolup: RisingHysteresis,
    // None until update_ramp first runs after entering RampUp. A zero-length
    // ramp still needs that call before the next state update can see it finish.
    ramp_elapsed_us: Option<u64>,
}

impl Takeoff {
    pub fn new(params: TakeoffParams) -> Result<Self, String> {
        params.validate()?;
        Ok(Self {
            params,
            state: TakeoffState::Disarmed,
            spoolup: RisingHysteresis::new(false),
            ramp_elapsed_us: None,
        })
    }

    pub fn state(&self) -> TakeoffState {
        self.state
    }

    /// Velocity limit that yields zero thrust at zero measured velocity.
    /// Takeoff.cpp:42-46 uses `-g/P`: negative Z-up means a downward limit
    /// (equivalently `+g/P` in NED). Keep the PX4 gain floor in this formula.
    pub fn generate_initial_ramp_value(velocity_p_gain: f64) -> f64 {
        -G / velocity_p_gain.max(0.01)
    }

    /// Takeoff.cpp:48-110. Pass the hysteretic landed flag, the controller's
    /// takeoff request and bypass flag, and the monotonic simulation clock.
    /// Call before `update_ramp` each controller step (MulticopterPositionControl.cpp:406-440).
    pub fn update_state(
        &mut self,
        armed: bool,
        landed: bool,
        want_takeoff: bool,
        skip_takeoff: bool,
        now_us: u64,
    ) -> TakeoffState {
        let delay_us = (self.params.mpc_spoolup_time * MICROS_PER_SECOND as f64) as u64;
        self.spoolup.update(armed, now_us, delay_us);

        // Each test sees the state produced by the previous arm of the PX4 switch.
        if self.state == TakeoffState::Disarmed && armed {
            self.state = TakeoffState::SpoolUp;
        }
        if self.state == TakeoffState::SpoolUp && self.spoolup.state() {
            self.state = TakeoffState::ReadyForTakeoff;
        }
        if self.state == TakeoffState::ReadyForTakeoff && want_takeoff {
            self.state = TakeoffState::RampUp;
            self.ramp_elapsed_us = None;
        }
        if self.state == TakeoffState::RampUp
            && self.ramp_elapsed_us.is_some_and(|us| us as f64 >= self.ramp_duration_us())
        {
            self.state = TakeoffState::Flight;
        }
        if self.state == TakeoffState::Flight && landed {
            self.state = TakeoffState::ReadyForTakeoff;
        }
        if armed && skip_takeoff {
            self.state = TakeoffState::Flight;
        }
        if !armed {
            self.state = TakeoffState::Disarmed;
        }
        self.state
    }

    /// Takeoff.cpp:112-134. The caller supplies the selected climb-speed limit
    /// in m/s, positive up. The limit returned before/during ramp-up can be
    /// negative (downward). Elapsed time accumulates in whole microseconds.
    pub fn update_ramp(&mut self, dt_us: u64, desired_speed_up_m_s: f64) -> f64 {
        let initial = Self::generate_initial_ramp_value(self.params.mpc_z_vel_p_acc);
        match self.state {
            TakeoffState::Disarmed | TakeoffState::SpoolUp | TakeoffState::ReadyForTakeoff => initial,
            TakeoffState::RampUp => {
                let duration_us = self.ramp_duration_us();
                let elapsed_us = self.ramp_elapsed_us.unwrap_or(0)
                    .saturating_add(dt_us)
                    .min(duration_us.ceil() as u64);
                self.ramp_elapsed_us = Some(elapsed_us);
                if (elapsed_us as f64) < duration_us {
                    let progress = elapsed_us as f64 / duration_us;
                    initial + progress * (desired_speed_up_m_s - initial)
                } else {
                    desired_speed_up_m_s
                }
            }
            TakeoffState::Flight => desired_speed_up_m_s,
        }
    }

    fn ramp_duration_us(&self) -> f64 {
        self.params.mpc_tko_ramp_t * MICROS_PER_SECOND as f64
    }

    pub fn hash_words(&self) -> [u64; 9] {
        let [spooled_up, requested, requested_at_us] = self.spoolup.hash_words();
        [
            self.params.mpc_spoolup_time.to_bits(),
            self.params.mpc_tko_ramp_t.to_bits(),
            self.params.mpc_z_vel_p_acc.to_bits(),
            self.state as u64,
            spooled_up,
            requested,
            requested_at_us,
            self.ramp_elapsed_us.is_some() as u64,
            self.ramp_elapsed_us.unwrap_or(0),
        ]
    }
}

/// PX4 src/lib/hysteresis/hysteresis.cpp:57-90 and hysteresis.h:52-76,
/// specialised to the zero true-to-false delay used by both modules.
#[derive(Debug, Clone)]
pub(crate) struct RisingHysteresis {
    state: bool,
    requested: bool,
    requested_at_us: u64,
}

impl RisingHysteresis {
    pub(crate) fn new(state: bool) -> Self {
        Self { state, requested: state, requested_at_us: 0 }
    }

    pub(crate) fn state(&self) -> bool {
        self.state
    }

    pub(crate) fn update(&mut self, requested: bool, now_us: u64, rise_delay_us: u64) {
        if self.requested != requested {
            self.requested = requested;
            if requested != self.state {
                self.requested_at_us = now_us;
            }
        }

        if !requested || now_us.wrapping_sub(self.requested_at_us) >= rise_delay_us {
            self.state = requested;
        }
    }

    pub(crate) fn hash_words(&self) -> [u64; 3] {
        [self.state as u64, self.requested as u64, self.requested_at_us]
    }
}

#[cfg(test)]
mod tests;
