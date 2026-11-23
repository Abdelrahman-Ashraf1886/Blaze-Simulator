//! Manual flight on the propulsion and rigid-body plant. Sampling and motor
//! order follow closed_loop.rs:100-123 and controller.rs:783-787.

use crate::closed_loop::unit_attitude;
use crate::controller::{attitude_rates, Allocator, Gains, RateControl, Saturation};
use crate::flight::Flight;
use crate::flight_modes::{FlightCommand, FlightModes, ModeSetpoint};
use crate::hover_thrust::{HoverThrustEstimate, HoverThrustEstimator, HoverThrustParams, HoverThrustSample};
use crate::position_control::{PositionControl, PositionGains, PositionInput};
use crate::sim::Simulation;
use crate::vehicle::Vehicle;

// modules/ekf2/ekf2_params.c:53. Timestamp arithmetic stays in microseconds.
const EKF2_PREDICT_US: u64 = 10_000;
const ESTIMATE_INTERVAL_S: f64 = EKF2_PREDICT_US as f64 / 1_000_000.0;

pub struct FlightLoop {
    flight: Flight,
    modes: FlightModes,
    estimator: HoverThrustEstimator,
    interval_steps: u64,
    sample_time_us: u64,
    interval_start_vz: Option<f64>,
    position: PositionControl,
    gains: Gains,
    rate: RateControl,
    allocator: Allocator,
    saturation: Saturation,
    velocity_feedback: Option<[f64; 3]>,
}

impl FlightLoop {
    pub fn new(
        vehicle: &Vehicle,
        flight: Flight,
        yaw_ratio: f64,
        gains: Gains,
        position: PositionGains,
        airmode: u8,
        hover: HoverThrustParams,
    ) -> Result<Self, String> {
        gains.validate()?;
        if hover.mpc_thr_hover != position.mpc_thr_hover || hover.mpc_use_hte != (position.mpc_use_hte != 0.0) {
            return Err("position and estimator must share MPC_THR_HOVER and MPC_USE_HTE".into());
        }
        let mut allocator = Allocator::new(&vehicle.definition.motors, yaw_ratio)?;
        allocator.set_airmode(airmode)?;
        Ok(Self {
            flight,
            estimator: HoverThrustEstimator::new(hover)?,
            interval_steps: 0,
            sample_time_us: 0,
            interval_start_vz: None,
            modes: FlightModes::new(position, airmode)?,
            position: PositionControl::new(position)?,
            gains,
            rate: RateControl::default(),
            allocator,
            saturation: Saturation::default(),
            velocity_feedback: None,
        })
    }

    pub fn flight(&self) -> &Flight {
        &self.flight
    }

    pub fn hover_thrust_estimate(&self) -> HoverThrustEstimate {
        self.estimator.estimate()
    }

    pub fn step(&mut self, sim: &mut Simulation, command: FlightCommand) -> Result<(), String> {
        if self.flight.ended().is_some() {
            return Ok(());
        }
        let state = sim.state();
        let attitude = unit_attitude(state.quaternion);
        let [x, y, z, w] = attitude;
        // Heading of the body X axis projected onto the engine's world XY plane.
        let estimate = PositionInput {
            position: state.com_m,
            velocity: state.linear_velocity_mps,
            yaw: (2.0 * (w * z + x * y)).atan2(1.0 - 2.0 * (y * y + z * z)),
        };
        let dt = sim.config().dt_s;
        let steps_per_sample = (ESTIMATE_INTERVAL_S / dt).round() as u64;
        if steps_per_sample == 0 || ESTIMATE_INTERVAL_S / steps_per_sample as f64 != dt {
            return Err("flight loop dt must divide EKF2_PREDICT_US (10000 us)".into());
        }
        let grounded = sim.touching_ground();
        // MulticopterHoverThrustEstimator.cpp:165-182 predicts without a
        // measurement when no local position setpoint is published.
        let mut vertical_thrust = f64::NAN;
        let mut modes = self.modes.clone();
        let sp = modes.step(command, &estimate, self.velocity_feedback, grounded, dt)?;
        let (rates, thrust) = match sp {
            ModeSetpoint::Rates {
                body_radps,
                collective,
            } => (body_radps, collective),
            ModeSetpoint::Attitude {
                attitude: desired,
                yaw_rate,
                collective,
            } => (
                attitude_rates(&self.gains, attitude, desired, yaw_rate),
                collective,
            ),
            ModeSetpoint::Position(sp) => {
                let out = self.position.step(&estimate, &sp, dt)?;
                vertical_thrust = out.thrust[2]; // PositionOutput, position_control.rs:371-378 (world Z-up).
                self.velocity_feedback = Some(out.velocity_setpoint);
                (
                    attitude_rates(&self.gains, attitude, out.attitude, out.yaw_rate),
                    out.collective_thrust,
                )
            }
        };
        if !matches!(sp, ModeSetpoint::Position(_)) && self.velocity_feedback.take().is_some() {
            // MulticopterPositionControl.cpp:511-515 retains hover thrust on mode exit.
            // Its explicit reset at :413-419 belongs to the takeoff ramp.
            let retained = self.position.hover_thrust();
            self.position.reset();
            self.position.set_hover_thrust(retained)?;
        }
        self.modes = modes;
        let torque = self.rate.update(
            &self.gains,
            state.angular_velocity_body_radps,
            rates,
            self.saturation,
            dt,
        );
        let allocation = self
            .allocator
            .allocate([torque[0], torque[1], torque[2], thrust]);
        self.saturation = allocation.saturation;
        self.flight.step(sim, allocation.commands);
        let start_vz = *self.interval_start_vz.get_or_insert(estimate.velocity[2]);
        self.interval_steps += 1;
        if self.interval_steps == steps_per_sample {
            self.interval_steps = 0;
            self.sample_time_us += EKF2_PREDICT_US;
            let end = sim.state();
            let [vx, vy, vz] = end.linear_velocity_mps;
            self.interval_start_vz = Some(vz);
            self.estimator.step(HoverThrustSample {
                timestamp_us: self.sample_time_us,
                armed: true,
                landed: sim.touching_ground(),
                distance_above_ground_m: end.com_m[2],
                // EKF2.cpp:938-941 publishes the world velocity derivative.
                vertical_acceleration_up_m_s2: (vz - start_vz) / ESTIMATE_INTERVAL_S,
                vertical_thrust_up: vertical_thrust,
                vertical_velocity_up_m_s: vz,
                horizontal_speed_m_s: vx.hypot(vy),
            });
            // MulticopterPositionControl.cpp:327-334 consumes valid estimates.
            if vertical_thrust.is_finite() {
                if let Some(hover) = self.estimator.controller_update() {
                    self.position.update_hover_thrust(hover)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
