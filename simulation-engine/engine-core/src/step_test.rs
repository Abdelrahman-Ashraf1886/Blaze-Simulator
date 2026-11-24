//! Perfect-state hover step tests on the manual flight controller.
use crate::{
    aero::BodyDrag,
    flight::{Cutoff, EndReason, Flight},
    flight_loop::FlightLoop,
    flight_modes::FlightCommand,
    math::STANDARD_GRAVITY,
    position_control::PositionSetpoint,
    propulsion::Propulsion,
    scenario::{predicted_hover_throttle, scaled_propulsion},
    sim::{hash_hex, SimConfig, SimState, Simulation, DEFAULT_DT_S},
    trace::{Sample, Signal, Trace},
    vehicle::Vehicle,
};
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RotationAxis {
    Roll,
    Pitch,
    Yaw,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HorizontalAxis {
    X,
    Y,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Step {
    Rate { axis: RotationAxis, amplitude_radps: f64 },
    Attitude { axis: RotationAxis, amplitude_rad: f64 },
    Altitude { amplitude_m: f64 },
    Position { axis: HorizontalAxis, amplitude_m: f64 },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepTest {
    pub step: Step,
    /// Time from the start of the run to the command change.
    pub hold_s: f64,
    /// Total run time, including the hold.
    pub duration_s: f64,
    pub decimation_steps: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepTestEnd {
    Duration,
    VoltageCutoff,
    ChargeCutoff,
    NonFinite,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub trace: Trace,
    pub step_time_s: f64,
    pub elapsed_s: f64,
    pub hover_collective_01: f64,
    /// Body torque at the equal-collective start (CoM offset, unequal motors). Not zero means
    /// the controller first has to trim it, so the hold must be long enough for that.
    pub start_imbalance_nm: [f64; 3],
    pub end_reason: StepTestEnd,
    pub error: Option<String>,
    pub state_hash: String,
}

// Same fixed-step quantization as scenario.rs:378-385.
fn steps_for(t: f64) -> u64 {
    let q = t / DEFAULT_DT_S;
    let nearest = q.round();
    (if (q - nearest).abs() < 1e-9 { nearest } else { q.ceil() }) as u64
}

impl StepTest {
    pub fn timing(&self) -> Result<(u64, u64), String> {
        if !(self.duration_s.is_finite() && self.duration_s > 0.0
            && self.duration_s / DEFAULT_DT_S < u64::MAX as f64)
        {
            return Err("durationS must be positive, finite and fit in whole simulation steps".into());
        }
        if !(self.hold_s.is_finite() && (0.0..self.duration_s).contains(&self.hold_s)) {
            return Err("holdS must be finite and in [0, durationS)".into());
        }
        if self.decimation_steps == 0 {
            return Err("decimationSteps must be a positive whole number".into());
        }
        let hold = steps_for(self.hold_s);
        let duration = steps_for(self.duration_s);
        if hold >= duration {
            return Err("holdS and durationS must leave at least one step after the hold".into());
        }
        match self.step {
            Step::Rate { amplitude_radps, .. } if !amplitude_radps.is_finite() =>
                Err("amplitudeRadps must be finite".into()),
            Step::Attitude { amplitude_rad, .. } if amplitude_rad.abs() > std::f64::consts::PI || !amplitude_rad.is_finite() =>
                Err("amplitudeRad must be in [-pi, pi], the principal quaternion rotation".into()),
            Step::Altitude { amplitude_m } | Step::Position { amplitude_m, .. } if !amplitude_m.is_finite() =>
                Err("amplitudeM must be finite".into()),
            _ => Ok((hold, duration)),
        }
    }
}

pub struct HoverStart {
    flight: Flight,
    collective: f64,
    imbalance_nm: [f64; 3],
}

impl HoverStart {
    pub fn new(
        vehicle: &Vehicle,
        propulsion: &Propulsion,
        drag: Option<BodyDrag>,
        air_density_kg_m3: f64,
        cutoff: Cutoff,
    ) -> Result<Self, String> {
        // Inertia is required by the plant (propulsion.rs:229-233) and the
        // tuning plan (phase-5-flight-control.md:404-406).
        for (motor, model) in propulsion.definition.motors.iter().zip(&propulsion.motors) {
            if !(model.j.is_finite() && model.j > 0.0) {
                return Err(format!("motor {:?} needs positive rotor inertia (inertiaKgM2)", motor.part_id));
            }
        }
        let scaled = scaled_propulsion(vehicle, propulsion, air_density_kg_m3)?;
        let collective = predicted_hover_throttle(vehicle, &scaled, vehicle.totals.mass_kg)?;

        // Same bus-voltage solve as scenario/builtins.rs:23-50. Recover the
        // individual equilibrium speeds from the shared loaded pack voltage.
        let (mut lo, mut hi) = (0.0, scaled.battery.open_circuit_voltage_v);
        for _ in 0..80 {
            let voltage = (lo + hi) / 2.0;
            let current = scaled.motors.iter().map(|m| {
                let duty = m.effective_duty(collective);
                let omega = m.steady_omega(duty * voltage, 0.0);
                duty * m.motor_current(omega, duty * voltage).max(0.0)
            }).sum::<f64>();
            if voltage + scaled.battery.internal_resistance_ohm * current > scaled.battery.open_circuit_voltage_v {
                hi = voltage;
            } else {
                lo = voltage;
            }
        }
        let speeds: Vec<_> = vehicle.definition.motors.iter().map(|motor| {
            let i = scaled.definition.motors.iter().position(|m| m.part_id == motor.part_id)
                .expect("validated propulsion covers every vehicle motor");
            let model = &scaled.motors[i];
            model.steady_omega(model.effective_duty(collective) * (lo + hi) / 2.0, 0.0)
        }).collect();
        let mut flight = Flight::new(vehicle, propulsion.clone(), drag, Some(air_density_kg_m3))?;
        flight.scale_to_air_density(air_density_kg_m3)?;
        flight.set_cutoff(cutoff)?;
        flight.set_rotor_speeds(&speeds)?;
        let weight = vehicle.totals.mass_kg * STANDARD_GRAVITY;
        let loads = flight.rotor_loads(rapier3d_f64::math::Vector::ZERO);
        // Only the lift must match the weight. A real build's CoM is never exactly centred:
        // its torque is reported, and trimmed by the controller during the hold.
        if !((loads.force_body_n[2] / weight - 1.0).abs() <= 1e-9) {
            return Err("the vehicle has no level hover at equal collective".into());
        }
        Ok(Self { flight, collective, imbalance_nm: loads.torque_body_nm.to_array() })
    }
}

fn command(step: Step, stepped: bool, position_m: [f64; 3], collective: f64) -> (FlightCommand, f64) {
    let target = |amplitude| if stepped { amplitude } else { 0.0 };
    match step {
        Step::Rate { axis, amplitude_radps } => {
            let setpoint = target(amplitude_radps);
            let mut body_radps = [0.0; 3];
            body_radps[axis as usize] = setpoint;
            (FlightCommand::Rates { body_radps, collective }, setpoint)
        }
        Step::Attitude { axis, amplitude_rad } => {
            let setpoint = target(amplitude_rad);
            // Pure-axis case of the scenario Euler quaternion (scenario.rs:79-88).
            let (sin, cos) = (setpoint / 2.0).sin_cos();
            let mut attitude = [0.0, 0.0, 0.0, cos];
            attitude[axis as usize] = sin;
            (FlightCommand::AttitudeSetpoint { attitude, yaw_rate: 0.0, collective }, setpoint)
        }
        Step::Altitude { amplitude_m } | Step::Position { amplitude_m, .. } => {
            let setpoint = target(amplitude_m);
            let mut position = position_m;
            position[position_axis(step)] += setpoint;
            (FlightCommand::PositionSetpoint(PositionSetpoint { position, yaw: 0.0, ..Default::default() }), setpoint)
        }
    }
}

fn position_axis(step: Step) -> usize {
    match step {
        Step::Position { axis, .. } => axis as usize,
        _ => 2,
    }
}

fn signal(step: Step, setpoint: f64, state: &SimState, origin: [f64; 3]) -> Signal {
    match step {
        Step::Rate { axis, .. } => Signal::Rate {
            setpoint_radps: setpoint,
            measured_radps: state.angular_velocity_body_radps[axis as usize],
        },
        Step::Attitude { axis, .. } => {
            let [x, y, z, w] = state.quaternion;
            let norm = x.hypot(y).hypot(z);
            let component = state.quaternion[axis as usize];
            // Project the principal rotation vector onto the commanded axis.
            let measured_rad = if norm == 0.0 { 0.0 } else {
                2.0 * norm.atan2(w.abs()) * (component / norm) * w.signum()
            };
            Signal::Attitude { setpoint_rad: setpoint, measured_rad }
        }
        Step::Altitude { .. } | Step::Position { .. } => {
            let axis = position_axis(step);
            Signal::Position { setpoint_m: setpoint, measured_m: state.com_m[axis] - origin[axis] }
        }
    }
}

fn finite_state(state: SimState, flight: &Flight) -> bool {
    let loads = flight.loads();
    state.quaternion.iter()
        .chain(&state.position_m)
        .chain(&state.com_m)
        .chain(&state.linear_velocity_mps)
        .chain(&state.angular_velocity_body_radps)
        .chain(&loads.thrust_body_n)
        .chain(&loads.total_torque_nm)
        .all(|x| x.is_finite())
}

/// A free-space run starts with the frame at the origin, as in scenario.rs:448-452.
/// Position amplitudes and measurements are relative to the initial CoM.
pub fn run<G>(
    vehicle: &Vehicle,
    spec: StepTest,
    hover: HoverStart,
    controller: impl FnOnce(Flight) -> Result<(FlightLoop, G), String>,
) -> Result<(Report, G), String> {
    let (hold, duration) = spec.timing()?;
    let mut sim = Simulation::new(vehicle, SimConfig::default())?;
    let (mut flight_loop, gains) = controller(hover.flight)?;
    let mut trace = Trace::new(duration, spec.decimation_steps, flight_loop.flight().motor_count())?;
    if matches!(spec.step, Step::Altitude { .. } | Step::Position { .. }) {
        flight_loop.trim_direct_position(hover.collective, DEFAULT_DT_S)?;
    }
    let mut state = sim.state();
    let origin = state.com_m;
    let baseline = command(spec.step, false, origin, hover.collective);
    let target = command(spec.step, true, origin, hover.collective);
    let (mut end_reason, mut error) = (StepTestEnd::Duration, None);
    for k in 0..duration {
        let (command, setpoint) = if k < hold { baseline } else { target };
        // The allocator/physics can assert on invalid numerical demands.
        // Keep the completed trace if the same failure would end manual flight.
        let result = catch_unwind(AssertUnwindSafe(|| {
            flight_loop.step_with_commands(&mut sim, command, |rates, attitude, motors, saturation| {
                if trace.wants(k) {
                    trace.record(k, Sample {
                        time_s: state.time_s,
                        signal: signal(spec.step, setpoint, &state, origin),
                        commanded_body_rates_radps: rates,
                        commanded_attitude_xyzw: attitude,
                        saturation,
                    }, motors);
                }
            })
        }));
        state = sim.state();
        if !finite_state(state, flight_loop.flight()) {
            end_reason = StepTestEnd::NonFinite;
            break;
        }
        match result {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                end_reason = StepTestEnd::Error;
                error = Some(message);
                break;
            }
            Err(payload) => {
                end_reason = StepTestEnd::Error;
                let message = payload.downcast_ref::<&str>().copied()
                    .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
                error = Some(message.unwrap_or("unknown flight loop failure").into());
                break;
            }
        }
        if let Some(cutoff) = flight_loop.flight().ended() {
            end_reason = match cutoff {
                EndReason::VoltageCutoff => StepTestEnd::VoltageCutoff,
                EndReason::ChargeCutoff => StepTestEnd::ChargeCutoff,
            };
            break;
        }
    }
    let words = flight_loop.flight().hash_words();
    if words.iter().any(|&word| !f64::from_bits(word).is_finite()) {
        end_reason = StepTestEnd::NonFinite;
    }
    Ok((Report {
        trace,
        step_time_s: hold as f64 * DEFAULT_DT_S,
        elapsed_s: state.time_s,
        hover_collective_01: hover.collective,
        start_imbalance_nm: hover.imbalance_nm,
        end_reason,
        error,
        state_hash: hash_hex(sim.state_hash_with(&words)),
    }, gains))
}

#[cfg(test)]
mod tests;
