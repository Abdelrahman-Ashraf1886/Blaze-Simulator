//! Manual flight on the propulsion and rigid-body plant. Sampling and motor
//! order follow closed_loop.rs:100-123 and controller.rs:783-787.

use crate::closed_loop::{unit_attitude, SaturationDiagnostic};
use crate::controller::{attitude_rates, Allocator, Gains, RateControl, Saturation};
use crate::flight::Flight;
use crate::flight_modes::{FlightCommand, FlightModes, ModeSetpoint};
use crate::hover_thrust::{HoverThrustEstimate, HoverThrustEstimator, HoverThrustParams, HoverThrustSample};
use crate::position_control::{PositionControl, PositionGains, PositionInput, PositionSetpoint};
use crate::sim::Simulation;
use crate::vehicle::{Quat, Vehicle};

// modules/ekf2/ekf2_params.c:53. Timestamp arithmetic stays in microseconds.
const EKF2_PREDICT_US: u64 = 10_000;
const ESTIMATE_INTERVAL_S: f64 = EKF2_PREDICT_US as f64 / 1_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlightMode {
    Rates,
    Stabilized,
    Altitude,
    Position,
}

/// The last completed step, in world Z-up coordinates. Non-finite setpoint
/// components denote inactive axes or layers (PositionSetpoint).
#[derive(Debug, Clone, Copy)]
pub struct FlightLoopSnapshot {
    pub mode: FlightMode,
    pub position_setpoint: [f64; 3],
    pub velocity_setpoint: [f64; 3],
    pub acceleration_setpoint: [f64; 3],
    pub saturation: SaturationDiagnostic,
    pub velocity_integral: [f64; 3],
    pub hover_thrust: HoverThrustEstimate,
}

pub struct FlightLoop {
    flight: Flight,
    modes: FlightModes,
    hover: HoverSampling,
    position: PositionControl,
    gains: Gains,
    rate: RateControl,
    allocator: Allocator,
    saturation: Saturation,
    velocity_feedback: Option<[f64; 3]>,
    last_step: Option<FlightLoopSnapshot>,
}

/// Samples the acceleration produced by an interval of plant steps. Both loop
/// forms consume the same gated EKF update after the last step of the interval.
pub(crate) struct HoverSampling {
    estimator: HoverThrustEstimator,
    interval_steps: u64,
    sample_time_us: u64,
    interval_start_vz: Option<f64>,
}

impl HoverSampling {
    pub(crate) fn new(hover: HoverThrustParams) -> Result<Self, String> {
        Ok(Self {
            estimator: HoverThrustEstimator::new(hover)?,
            interval_steps: 0,
            sample_time_us: 0,
            interval_start_vz: None,
        })
    }

    pub(crate) fn after_step(&mut self, sim: &Simulation, initial_vz: f64,
        vertical_thrust: f64, position: &mut PositionControl) -> Result<(), String> {
        let start_vz = *self.interval_start_vz.get_or_insert(initial_vz);
        self.interval_steps += 1;
        let dt = sim.config().dt_s;
        let steps = (ESTIMATE_INTERVAL_S / dt).round() as u64;
        let exact_interval = steps != 0 && ESTIMATE_INTERVAL_S / steps as f64 == dt;
        // FlightLoop validates exact divisibility. The legacy API also accepts
        // other fixed steps: use the first plant endpoint at or beyond 10 ms.
        let steps_per_sample = if exact_interval { steps } else { (ESTIMATE_INTERVAL_S / dt).ceil() as u64 };
        if self.interval_steps == steps_per_sample {
            let elapsed = if exact_interval { ESTIMATE_INTERVAL_S } else { self.interval_steps as f64 * dt };
            self.interval_steps = 0;
            self.sample_time_us = self.sample_time_us.saturating_add((elapsed * 1_000_000.0).round() as u64);
            let end = sim.state();
            let [vx, vy, vz] = end.linear_velocity_mps;
            self.interval_start_vz = Some(vz);
            self.estimator.step(HoverThrustSample {
                timestamp_us: self.sample_time_us,
                armed: true,
                landed: sim.touching_ground(),
                // Over the ground plane or terrain. With no ground below (free space) PX4's
                // dist_bottom gate has nothing to close it, so the vehicle is in the air.
                distance_above_ground_m: sim.height_below(end.com_m[0], end.com_m[1])
                    .map_or(f64::INFINITY, |ground| end.com_m[2] - ground),
                // EKF2.cpp:938-941 publishes the world velocity derivative.
                vertical_acceleration_up_m_s2: (vz - start_vz) / elapsed,
                vertical_thrust_up: vertical_thrust,
                vertical_velocity_up_m_s: vz,
                horizontal_speed_m_s: vx.hypot(vy),
            });
            // MulticopterPositionControl.cpp:327-334 consumes valid estimates.
            if vertical_thrust.is_finite() {
                if let Some(hover) = self.estimator.controller_update() {
                    position.update_hover_thrust(hover)?;
                }
            }
        }
        Ok(())
    }
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
            hover: HoverSampling::new(hover)?,
            modes: FlightModes::new(position, airmode)?,
            position: PositionControl::new(position)?,
            gains,
            rate: RateControl::default(),
            allocator,
            saturation: Saturation::default(),
            velocity_feedback: None,
            last_step: None,
        })
    }

    pub fn flight(&self) -> &Flight {
        &self.flight
    }

    pub fn hover_thrust_estimate(&self) -> HoverThrustEstimate {
        self.hover.estimator.estimate()
    }

    pub fn last_step(&self) -> Option<FlightLoopSnapshot> {
        self.last_step
    }

    /// Seed the vertical integral for a direct position run at steady hover,
    /// retaining the configured hover gain and estimator parameters.
    pub(crate) fn trim_direct_position(&mut self, collective: f64, dt: f64) -> Result<(), String> {
        let mut position = self.position.clone();
        let nominal = position.hover_thrust();
        position.set_hover_thrust(collective)?;
        if position.hover_thrust() != collective {
            return Err("hover collective is outside the position controller's hover-thrust range".into());
        }
        // PositionControl::update_hover_thrust (position_control.rs:487-500)
        // computes the integral that preserves thrust as hover changes.
        position.update_hover_thrust(nominal)?;
        if position.velocity_integral()[2].abs() > crate::math::STANDARD_GRAVITY {
            return Err("MPC_THR_HOVER requires more than the vertical integral limit to trim this hover".into());
        }
        // Check the position controller's thrust limits at the zero-error
        // operating point without advancing its derivative or integral state.
        let estimate = PositionInput { position: [0.0; 3], velocity: [0.0; 3], yaw: 0.0 };
        let level = PositionSetpoint { position: estimate.position, ..Default::default() };
        let trim = position.clone().step(&estimate, &level, dt)?;
        // Same floating-point comparison tolerance as flight_modes/tests.rs:6-8.
        if (trim.collective_thrust - collective).abs() > 1e-12 {
            return Err("MPC_THR_MIN/MPC_THR_MAX prevent the position controller from holding this hover".into());
        }
        self.position = position;
        Ok(())
    }

    pub fn step(&mut self, sim: &mut Simulation, command: FlightCommand) -> Result<(), String> {
        self.step_with_commands(sim, command, |_, _, _, _| {})
    }

    /// Expose the controller and allocator outputs for direct setpoint runs.
    /// The motor slice borrows the allocator's existing command buffer.
    pub(crate) fn step_with_commands(
        &mut self,
        sim: &mut Simulation,
        command: FlightCommand,
        observe: impl FnOnce([f64; 3], Option<Quat>, &[f64], SaturationDiagnostic),
    ) -> Result<(), String> {
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
        let mut setpoints = PositionSetpoint::default();
        let (mode, rates, thrust, desired_attitude) = match sp {
            ModeSetpoint::Rates {
                body_radps,
                collective,
            } => (FlightMode::Rates, body_radps, collective, None),
            ModeSetpoint::Attitude {
                attitude: desired,
                yaw_rate,
                collective,
            } => (
                FlightMode::Stabilized,
                attitude_rates(&self.gains, attitude, desired, yaw_rate),
                collective,
                Some(desired),
            ),
            ModeSetpoint::Position(sp) => {
                let out = if self.modes.using_direct_position() != modes.using_direct_position()
                    && self.velocity_feedback.is_some()
                {
                    let mut position = self.position.clone();
                    let retained = position.hover_thrust();
                    position.reset();
                    position.set_hover_thrust(retained)?;
                    let out = position.step(&estimate, &sp, dt)?;
                    self.position = position;
                    out
                } else {
                    self.position.step(&estimate, &sp, dt)?
                };
                vertical_thrust = out.thrust[2]; // PositionOutput, position_control.rs:371-378 (world Z-up).
                self.velocity_feedback = Some(out.velocity_setpoint);
                setpoints.position = sp.position;
                setpoints.velocity = out.velocity_setpoint;
                setpoints.acceleration = out.acceleration_setpoint;
                let mode = if matches!(command, FlightCommand::Altitude(_)) {
                    FlightMode::Altitude
                } else {
                    FlightMode::Position
                };
                (
                    mode,
                    attitude_rates(&self.gains, attitude, out.attitude, out.yaw_rate),
                    out.collective_thrust,
                    Some(out.attitude),
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
        self.hover.after_step(sim, estimate.velocity[2], vertical_thrust, &mut self.position)?;
        let saturation = SaturationDiagnostic {
            positive: self.saturation.positive,
            negative: self.saturation.negative,
        };
        self.last_step = Some(FlightLoopSnapshot {
            mode,
            position_setpoint: setpoints.position,
            velocity_setpoint: setpoints.velocity,
            acceleration_setpoint: setpoints.acceleration,
            saturation,
            velocity_integral: self.position.velocity_integral(),
            hover_thrust: self.hover.estimator.estimate(),
        });
        observe(rates, desired_attitude, allocation.commands, saturation);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
