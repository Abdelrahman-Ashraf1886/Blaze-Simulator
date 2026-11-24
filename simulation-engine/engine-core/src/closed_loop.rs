//! The controller flying the vehicle (Phase 4.7): `controller.rs` (PX4
//! v1.13.3 attitude, rate and allocation) and the PositionControl vertical loop in the loop with
//! `flight.rs` (motors, battery, body drag) and `sim.rs` (rigid body).
//!
//! Each fixed step:
//! 1. The controller reads the true state without sensor noise or delay:
//!    attitude, body rates, and the CoM's height and vertical velocity.
//! 2. `Controller::step` gives one normalised command per motor in [0, 1].
//! 3. The commands are the motors' throttles (linear: PX4's thrust-curve
//!    factor is zero).
//! 4. `Flight::step` applies them, then the shared hover estimator samples the plant.
//!
//! As on a real flight controller, the allocation uses the nominal motor
//! geometry about the frame origin and never the true CoM or inertia: a CoM
//! offset is trimmed by the rate integrators, using thrust headroom, and too
//! large an offset saturates the motors and the attitude is lost.
//! The yaw ratio k_Q/k_T for the allocation is the mean over the motors of the
//! fitted coefficients.

use crate::controller::{Controller, ControllerInput, Gains, Saturation, Setpoint};
use crate::flight::Flight;
use crate::flight_loop::HoverSampling;
use crate::hover_thrust::HoverThrustParams;
use crate::sim::Simulation;
use crate::vehicle::Vehicle;
use serde::Serialize;
use serde_json::{Map, Value};

/// What the controller did over a run, for the result and the debug panel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerSummary {
    /// Steps on which some demand could not be met (an actuator at a bound).
    pub saturated_steps: u64,
    /// Rate integrators at the end (normalised torque; PX4 MC_*_INT_LIM bounds them).
    pub rate_integral: [f64; 3],
    /// Last collective thrust command (normalised, 0…1).
    pub collective_thrust: f64,
}

/// Which demands the allocation could not meet on the last step, in
/// roll/pitch/yaw/collective order (`controller::Saturation`, serializable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaturationDiagnostic {
    pub positive: [bool; 4],
    pub negative: [bool; 4],
}

/// The controller's last step, for the debug panel (4.8).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlDiagnostic {
    /// Normalised roll, pitch and yaw torque demand of the rate loop.
    pub torque_demand: [f64; 3],
    pub rate_integral: [f64; 3],
    /// Collective thrust command, normalised 0…1.
    pub collective_thrust: f64,
    pub saturation: SaturationDiagnostic,
}

pub struct ClosedLoop {
    flight: Flight,
    controller: Controller,
    hover: HoverSampling,
    commands: Vec<f64>,
    saturated_steps: u64,
    collective: f64,
    torque_demand: [f64; 3],
    saturation: Saturation,
}

/// The attitude as the controller's estimate: unit length. `Controller::step`
/// asserts a unit quaternion within 1e-9 and a panic would end the sidecar, but
/// the quaternion rapier integrates is only unit to rounding, so it is
/// normalised here.
pub fn unit_attitude(q: [f64; 4]) -> [f64; 4] {
    let norm = q.iter().map(|x| x * x).sum::<f64>().sqrt();
    q.map(|x| x / norm)
}

impl ClosedLoop {
    pub fn new(vehicle: &Vehicle, flight: Flight, yaw_ratio: f64, gains: Gains) -> Result<ClosedLoop, String> {
        let controller = Controller::new(&vehicle.definition.motors, yaw_ratio, gains)?;
        let n = vehicle.definition.motors.len();
        Ok(ClosedLoop {
            flight,
            controller,
            hover: HoverSampling::new(HoverThrustParams {
                mpc_thr_hover: gains.mpc_thr_hover,
                mpc_use_hte: gains.mpc_use_hte != 0.0,
                ..HoverThrustParams::default()
            })?,
            commands: vec![0.0; n],
            saturated_steps: 0,
            collective: 0.0,
            torque_demand: [0.0; 3],
            saturation: Saturation::default(),
        })
    }

    pub fn flight(&self) -> &Flight {
        &self.flight
    }

    /// One fixed step. After the flight's battery cut-off was reached nothing steps.
    pub fn step(&mut self, sim: &mut Simulation, sp: &Setpoint) {
        if self.flight.ended().is_some() {
            return;
        }
        let s = sim.state();
        let est = ControllerInput {
            attitude: unit_attitude(s.quaternion),
            body_rates: s.angular_velocity_body_radps,
            z: s.com_m[2],
            z_velocity: s.linear_velocity_mps[2],
        };
        let out = self.controller.step(&est, sp, sim.config().dt_s);
        if out.saturation != Saturation::default() {
            self.saturated_steps += 1;
        }
        self.collective = out.collective_thrust;
        self.torque_demand = out.torque_demand;
        self.saturation = out.saturation;
        self.commands.copy_from_slice(out.motor_commands);
        let vertical_thrust = out.vertical_thrust;
        self.flight.step(sim, &self.commands);
        self.hover.after_step(sim, est.z_velocity, vertical_thrust, &mut self.controller.position)
            .expect("valid hover estimate from the shared estimator");
    }

    /// The last step: torque demand, integrators, collective and saturation.
    pub fn control(&self) -> ControlDiagnostic {
        ControlDiagnostic {
            torque_demand: self.torque_demand,
            rate_integral: self.controller.rate_integral(),
            collective_thrust: self.collective,
            saturation: SaturationDiagnostic { positive: self.saturation.positive, negative: self.saturation.negative },
        }
    }

    pub fn summary(&self) -> ControllerSummary {
        ControllerSummary {
            saturated_steps: self.saturated_steps,
            rate_integral: self.controller.rate_integral(),
            collective_thrust: self.collective,
        }
    }
}

/// PX4 v1.13.3 defaults with the given overrides, keyed by the exact PX4
/// parameter names (e.g. `{"MC_ROLL_P": 7.0}`), validated. An unknown name or
/// a non-number is refused.
pub fn gains_with_overrides(overrides: Option<&Map<String, Value>>) -> Result<Gains, String> {
    let mut g = serde_json::to_value(Gains::px4_v1_13_3()).map_err(|e| e.to_string())?;
    if let Some(o) = overrides {
        let fields = g.as_object_mut().expect("Gains serialises as an object");
        for (name, value) in o {
            let key = name.to_ascii_lowercase();
            if !fields.contains_key(&key) || name != &name.to_ascii_uppercase() {
                return Err(format!("unknown PX4 parameter \"{name}\" (give the exact upper-case name)"));
            }
            if !value.as_f64().is_some_and(f64::is_finite) {
                return Err(format!("{name} must be a finite number"));
            }
            fields.insert(key, value.clone());
        }
    }
    let gains: Gains = serde_json::from_value(g).map_err(|e| e.to_string())?;
    gains.validate()?;
    Ok(gains)
}

#[cfg(test)]
mod tests;
