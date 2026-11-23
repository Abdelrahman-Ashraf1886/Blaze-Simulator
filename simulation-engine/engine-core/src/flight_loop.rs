//! Manual flight on the propulsion and rigid-body plant. Sampling and motor
//! order follow closed_loop.rs:100-123 and controller.rs:783-787.

use crate::closed_loop::unit_attitude;
use crate::controller::{attitude_rates, Allocator, Gains, RateControl, Saturation};
use crate::flight::Flight;
use crate::flight_modes::{FlightCommand, FlightModes, ModeSetpoint};
use crate::position_control::{PositionControl, PositionGains, PositionInput};
use crate::sim::Simulation;
use crate::vehicle::Vehicle;

pub struct FlightLoop {
    flight: Flight,
    modes: FlightModes,
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
    ) -> Result<Self, String> {
        gains.validate()?;
        let mut allocator = Allocator::new(&vehicle.definition.motors, yaw_ratio)?;
        allocator.set_airmode(airmode)?;
        Ok(Self {
            flight,
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
        // environment.rs:258-265,372-384: the bounded log can omit open contacts.
        let (contacts, dropped) = sim.contacts();
        let grounded = contacts
            .iter()
            .any(|c| c.end_s.is_none() && c.with == "ground");
        if dropped > 0 && !grounded && !matches!(command, FlightCommand::Rates { .. }) {
            return Err("contact log truncated; ground contact is unknown".into());
        }
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
                // 5.10 will feed validated estimates to update_hover_thrust here.
                // Until then PositionControl uses MPC_THR_HOVER (position_control.rs:440-447).
                let out = self.position.step(&estimate, &sp, dt)?;
                self.velocity_feedback = Some(out.velocity_setpoint);
                (
                    attitude_rates(&self.gains, attitude, out.attitude, out.yaw_rate),
                    out.collective_thrust,
                )
            }
        };
        if !matches!(sp, ModeSetpoint::Position(_)) && self.velocity_feedback.take().is_some() {
            self.position.reset();
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
        Ok(())
    }
}

#[cfg(test)]
mod tests;
