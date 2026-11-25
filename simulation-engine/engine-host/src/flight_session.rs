//! Live flight session (4.8 part B): the renderer drives the PX4 controller
//! flying the loaded vehicle in lockstep. `flight.session.start` builds what
//! `sim.run` builds for a controller run (same vehicle, environment, controller
//! and gain checks, shared with `engine.rs`) plus the user's battery cut-off;
//! each `flight.session.step` advances N fixed 1 ms steps with one setpoint
//! held; `flight.session.end` drops the session.
//!
//! The engine never runs on its own clock, so a session is deterministic: any
//! chunking of the same setpoint ends in the same state hash as one `sim.run`
//! in controller mode of the same duration (rotors and battery included).
use crate::engine::{controlled, loaded_vehicle, manual_flight, parse_environment, setpoint, step_manual, step_manual_observed};
use crate::flight_environment;
use crate::telemetry::{ControllerKind, SampleEverySteps, Samples, Sampling};
use crate::protocol::{parse_sensors, present, ControllerRequest, ErrorCode, FlightLoopDiagnostic, FlightModeRequest, Response};
use engine_core::aero::BodyDrag;
use engine_core::auto_modes::ReturnParams;
use engine_core::closed_loop::{ClosedLoop, ControlDiagnostic};
use engine_core::flight::{BatteryReading, Cutoff, EndReason, Flight, MotorReading, RotorGroundEffect, StepLoads};
use engine_core::flight_loop::FlightLoop;
use engine_core::flight_modes::FlightCommand;
use engine_core::propulsion::Propulsion;
use engine_core::sim::{hash_hex, SimConfig, SimState, Simulation, DEFAULT_DT_S};
use engine_core::vehicle::Vehicle;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Most steps one `flight.session.step` may advance. A contact step costs up to
/// ≈0.2 ms (DEVLOG 4.4), so a full request stays far below the supervisor's 3 s
/// request timeout, and the renderer steps at most one frame's worth at a time.
pub const MAX_SESSION_STEPS: u64 = 100;

pub struct Session {
    sim: Simulation,
    controller: SessionController,
    air_density_kg_m3: f64,
    // Preserve decimal tokens exactly. Re-encoding parsed f64s may change the
    // next parse and therefore the replay hash. The line reader splits off LF.
    start_request: String,
    step_requests: Vec<String>,
    sampling: Option<Sampling>,
}

enum SessionController {
    Legacy(Box<ClosedLoop>),
    Manual { loop_: Box<FlightLoop>, mode: FlightModeRequest },
}

impl SessionController {
    fn flight(&self) -> &Flight {
        match self {
            Self::Legacy(cl) => cl.flight(),
            Self::Manual { loop_, .. } => loop_.flight(),
        }
    }

    fn hash_words(&self) -> Vec<u64> {
        match self {
            Self::Legacy(cl) => cl.flight().hash_words(),
            Self::Manual { loop_, .. } => loop_.hash_words(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams {
    #[serde(default)]
    environment: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    wind: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    ground_effect: Option<Value>,
    #[serde(default)]
    start_position_m: Option<[f64; 3]>,
    #[serde(default, deserialize_with = "present")]
    start_clearance_m: Option<f64>,
    /// ISA density at the user's altitude (`src/domain/atmosphere.ts`), kg/m³.
    #[serde(default)]
    air_density_kg_m3: Option<f64>,
    cutoff: CutoffRequest,
    /// Overrides of the PX4 v1.13.3 defaults by exact parameter name.
    #[serde(default)]
    gains: Option<Map<String, Value>>,
    #[serde(default, deserialize_with = "present")]
    controller: Option<ManualControllerParams>,
    #[serde(default, deserialize_with = "present")]
    sample_every_steps: Option<SampleEverySteps>,
    sensors: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManualControllerParams {
    mode: FlightModeRequest,
    #[serde(default, deserialize_with = "present")]
    airmode: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    thrust_model_factor: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase", deny_unknown_fields)]
enum CutoffRequest {
    VoltageV(f64),
    ChargeMah(f64),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StepParams {
    steps: u64,
    /// The held setpoint, with an optional mode change for FlightLoop sessions.
    setpoint: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum AutoSetpoint {
    /// Height in metres above the starting CoM along world +Z.
    Takeoff {
        #[serde(default, deserialize_with = "present")]
        altitude_m: Option<f64>,
    },
    Hold {},
    Land {},
    Return {},
}

impl AutoSetpoint {
    fn flight_command(self) -> Result<FlightCommand, String> {
        match self {
            Self::Takeoff { altitude_m } => {
                if altitude_m.is_some_and(|height| !height.is_finite() || height <= 0.0) {
                    return Err("setpoint.command.altitudeM must be finite and positive".into());
                }
                Ok(FlightCommand::Takeoff { altitude_m })
            }
            Self::Hold {} => Ok(FlightCommand::Hold),
            Self::Land {} => Ok(FlightCommand::Land),
            Self::Return {} => Ok(FlightCommand::Return),
        }
    }
}

/// Everything the debug panel shows for one moment of the flight (camelCase).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic<'a> {
    state: SimState,
    motors: Vec<MotorReading>,
    battery: BatteryReading,
    /// What acted on the body over the last step, by source; zero before the first step.
    loads: DiagnosticLoads<'a>,
    air_density_kg_m3: f64,
    /// The 4.7 controller's last step; null until it has stepped.
    control: Option<ControlDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flight_loop: Option<FlightLoopDiagnostic>,
}

/// The protocol adds the environmental fields to the core's legacy load serialization.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLoads<'a> {
    #[serde(flatten)]
    loads: &'a StepLoads,
    wind_com_world_mps: [f64; 3],
    ground_effect_added_thrust_n: f64,
    ground_effect_status: &'a [RotorGroundEffect],
    wind_above_range: bool,
    wind_invalid: bool,
}

impl<'a> From<&'a StepLoads> for DiagnosticLoads<'a> {
    fn from(loads: &'a StepLoads) -> Self {
        Self {
            loads,
            wind_com_world_mps: loads.wind_com_world_mps,
            ground_effect_added_thrust_n: loads.ground_effect_added_thrust_n,
            ground_effect_status: &loads.ground_effect_status,
            wind_above_range: loads.wind_above_range,
            wind_invalid: loads.wind_invalid,
        }
    }
}

fn diagnostic(s: &Session) -> Diagnostic<'_> {
    let state = s.sim.state();
    let flight = s.controller.flight();
    let (control, flight_loop) = match &s.controller {
        SessionController::Legacy(cl) => ((state.steps > 0).then(|| cl.control()), None),
        SessionController::Manual { loop_, .. } => (None, loop_.last_step().map(FlightLoopDiagnostic::from)),
    };
    Diagnostic {
        state,
        motors: flight.motors(),
        battery: flight.battery(),
        loads: flight.loads().into(),
        air_density_kg_m3: s.air_density_kg_m3,
        control,
        flight_loop,
    }
}

fn loads_are_finite(loads: &StepLoads) -> bool {
    [
        loads.thrust_body_n, loads.drag_body_n, loads.arm_torque_nm, loads.drag_reaction_torque_nm,
        loads.spin_up_reaction_torque_nm, loads.rotor_gyro_torque_nm, loads.total_torque_nm,
        loads.wind_com_world_mps,
    ].into_iter().flatten().chain([loads.ground_effect_added_thrust_n]).all(f64::is_finite)
}

fn no_session(id: u64) -> Response {
    Response::err(Some(id), ErrorCode::NoSession, "start a flight session first (flight.session.start)")
}

fn end_reason(s: &Session) -> Option<&'static str> {
    s.controller.flight().ended().map(|r| match r {
        EndReason::VoltageCutoff => "voltageCutoff",
        EndReason::ChargeCutoff => "chargeCutoff",
    })
}

/// Replaces any previous session; a refused start leaves none.
pub fn start(
    id: u64,
    mut params: Map<String, Value>,
    line: String,
    slot: &mut Option<Session>,
    vehicle: Option<&Vehicle>,
    propulsion: Option<&Propulsion>,
    aero: Option<BodyDrag>,
) -> Response {
    *slot = None;
    let bad = |message: String| Response::err(Some(id), ErrorCode::InvalidParams, message);
    let vehicle = match loaded_vehicle(id, vehicle) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(propulsion) = propulsion else {
        return bad(flight_environment::propulsion_required(params.get("wind"), params.get("groundEffect"), "")
            .unwrap_or_else(|| "a flight session needs the propulsion definition (vehicle.load with propulsion)".into()));
    };
    if params.get("cutoff").is_none_or(Value::is_null) {
        return Response::err(
            Some(id),
            ErrorCode::CutoffRequired,
            "cutoff is required: voltageV or chargeMah, with an explicit positive value",
        );
    }
    // Flattened command parameters also contain the envelope fields.
    params.remove("id");
    let p: StartParams = match serde_json::from_value(Value::Object(params)) {
        Ok(p) => p,
        Err(e) => return bad(e.to_string()),
    };
    let environment = match parse_environment(id, p.environment) {
        Ok(e) => e,
        Err(r) => return r,
    };
    let Some(rho) = p.air_density_kg_m3.filter(|r| r.is_finite() && *r > 0.0) else {
        return bad("airDensityKgM3 must be a positive number (ISA at the user's altitude)".into());
    };
    let sim = match Simulation::with_start_clearance(
        vehicle, SimConfig::default(), &environment, p.start_position_m.unwrap_or([0.0; 3]), p.start_clearance_m,
    ) {
        Ok(s) => s,
        Err(e) => return bad(e),
    };
    let mut flight = match Flight::new(vehicle, propulsion.clone(), aero, Some(rho)) {
        Ok(f) => f,
        Err(e) => return bad(e),
    };
    let cutoff = match p.cutoff {
        CutoffRequest::VoltageV(v) => Cutoff::VoltageV(v),
        CutoffRequest::ChargeMah(q) => Cutoff::ChargeMah(q),
    };
    if let Err(e) = flight.scale_to_air_density(rho) {
        return bad(e.to_string());
    }
    if let Err(e) = flight_environment::configure(&mut flight, p.wind.as_ref(), p.ground_effect.as_ref(), "") {
        return bad(e);
    }
    if let Err(e) = flight.set_cutoff(cutoff) {
        return bad(format!("cutoff: {e}"));
    }
    let controller = if let Some(c) = p.controller {
        let mut gains = p.gains.unwrap_or_default();
        let return_params = match ReturnParams::take_overrides(&mut gains) {
            Ok(params) => params,
            Err(e) => return bad(format!("controller.gains: {e}")),
        };
        match manual_flight(vehicle, propulsion, flight, Some(&gains), c.airmode, c.thrust_model_factor) {
            Ok(loop_) => SessionController::Manual { loop_: Box::new(loop_.with_return_params(return_params)), mode: c.mode },
            Err(e) => return bad(e),
        }
    } else {
        // The setpoint of this request is only level; every step brings its own.
        let c = ControllerRequest { gains: p.gains, ..ControllerRequest::default() };
        match controlled(vehicle, propulsion, flight, &c) {
            Ok((cl, _)) => SessionController::Legacy(Box::new(cl)),
            Err(e) => return bad(e),
        }
    };
    let sensors = match parse_sensors(p.sensors, "sensors") {
        Ok(sensors) => sensors,
        Err(e) => return bad(e),
    };
    let kind = match &controller {
        SessionController::Legacy(_) => ControllerKind::AttitudeHold,
        SessionController::Manual { .. } => ControllerKind::FlightLoop,
    };
    let sampling = Sampling::new(p.sample_every_steps, sensors, vehicle, propulsion, kind);
    let mut session = Session {
        sim, controller, air_density_kg_m3: rho, start_request: line, step_requests: Vec::new(), sampling,
    };
    let result = json!({
        "dtS": DEFAULT_DT_S,
        "maxStepsPerRequest": MAX_SESSION_STEPS,
        "diagnostic": diagnostic(&session),
    });
    let mut samples = Samples::default();
    if let Some(sampling) = &mut session.sampling {
        match &session.controller {
            SessionController::Legacy(cl) => sampling.attitude(&mut samples, &session.sim, cl, None),
            SessionController::Manual { loop_, .. } => sampling.flight_loop(&mut samples, &session.sim, loop_, None),
        }
    }
    let response = if let Some(sampling) = session.sampling.as_ref().filter(|s| s.recording()) {
        sampled_result(id, result, Some(sampling.channels()), samples)
    } else {
        Response::ok(id, result)
    };
    *slot = Some(session);
    response
}

pub fn step(id: u64, mut params: Map<String, Value>, line: String, slot: &mut Option<Session>) -> Response {
    let bad = |message: String| Response::err(Some(id), ErrorCode::InvalidParams, message);
    let Some(session) = slot.as_mut() else {
        return no_session(id);
    };
    params.remove("id");
    let mut p: StepParams = match serde_json::from_value(Value::Object(params)) {
        Ok(p) => p,
        Err(e) => return bad(e.to_string()),
    };
    if p.steps == 0 || p.steps > MAX_SESSION_STEPS {
        return bad(format!("steps must be 1..={MAX_SESSION_STEPS}"));
    }
    let auto_command = match p.setpoint.remove("command") {
        Some(command) => {
            if matches!(session.controller, SessionController::Legacy(_)) {
                return bad("setpoint.command (takeoff, hold, land or return) requires a FlightLoop session (controller.mode at flight.session.start)".into());
            }
            if !p.setpoint.is_empty() {
                return bad("setpoint.command must be the only field in setpoint".into());
            }
            match serde_json::from_value::<AutoSetpoint>(command) {
                Ok(command) => match command.flight_command() {
                    Ok(command) => Some(command),
                    Err(e) => return bad(e),
                },
                Err(e) => return bad(format!("setpoint.command: {e}")),
            }
        }
        None => None,
    };
    let input: ControllerRequest = match serde_json::from_value(Value::Object(p.setpoint)) {
        Ok(input) => input,
        Err(e) => return bad(format!("setpoint: {e}")),
    };
    if input.gains.is_some() {
        return bad("gains are set by flight.session.start, not per step".into());
    }
    if input.airmode.is_some() || input.thrust_model_factor.is_some() {
        return bad("airmode and thrustModelFactor are set by flight.session.start".into());
    }
    // Contact times are products `k · dt` of the step index (`Simulation::step`), so the
    // window [t0, t1) compares exactly: an event belongs to the steps run here when its
    // start or end time falls in it. A step that reaches the cut-off still advances the body.
    let first = session.sim.state().steps;
    let mut samples = Samples::default();
    let ran = match &mut session.controller {
        SessionController::Legacy(cl) => {
            if input.mode.is_some() {
                return bad("setpoint.mode requires controller.mode at flight.session.start".into());
            }
            let sp = match setpoint(&input) {
                Ok(s) => s,
                Err(e) => return bad(format!("setpoint: {e}")),
            };
            if let Some(sampling) = &mut session.sampling {
                advance(&mut session.sim, cl.as_mut(), p.steps, ClosedLoop::flight, |cl, sim| {
                    let mut inputs = None;
                    cl.step_with_rate_feedback(sim, &sp, sampling.rate_feedback(), |rates| inputs = Some((sp, rates)));
                    sampling.attitude(&mut samples, sim, cl, inputs);
                    Ok(())
                })
            } else {
                advance(&mut session.sim, cl.as_mut(), p.steps, ClosedLoop::flight, |cl, sim| {
                    cl.step(sim, &sp);
                    Ok(())
                })
            }
        }
        SessionController::Manual { loop_, mode } => {
            let selected = input.mode.unwrap_or(*mode);
            let command = match auto_command {
                Some(command) => command,
                None => match input.flight_command(selected) {
                    Ok(command) => command,
                    Err(e) => return bad(format!("setpoint: {e}")),
                },
            };
            let ran = if let Some(sampling) = &mut session.sampling {
                advance(&mut session.sim, loop_.as_mut(), p.steps, FlightLoop::flight, |loop_, sim| {
                    let mut inputs = None;
                    step_manual_observed(loop_, sim, command, sampling.rate_feedback(), |sp| inputs = Some((command, sp)))?;
                    sampling.flight_loop(&mut samples, sim, loop_, inputs);
                    Ok(())
                })
            } else {
                advance(&mut session.sim, loop_.as_mut(), p.steps, FlightLoop::flight, |loop_, sim| {
                    step_manual(loop_, sim, command)
                })
            };
            *mode = selected;
            ran
        }
    };
    let ran = match ran {
        Ok(ran) => ran,
        Err(e) => {
            *slot = None;
            return bad(e);
        }
    };
    if !loads_are_finite(session.controller.flight().loads()) {
        *slot = None;
        return bad("flight session produced non-finite step loads".into());
    }
    session.step_requests.push(line);
    let (t0, t1) = (first as f64 * DEFAULT_DT_S, session.sim.state().steps as f64 * DEFAULT_DT_S);
    let within = |t: f64| t >= t0 && t < t1;
    let (all, contacts_dropped) = session.sim.contacts();
    let contacts: Vec<_> = all.into_iter().filter(|c| within(c.start_s) || c.end_s.is_some_and(within)).collect();
    let hash = session.sim.state_hash_with(&session.controller.hash_words());
    let hash = session.sampling.as_ref().map_or(hash, |sampling| sampling.extend_hash(hash));
    let result = json!({
        "stepsRun": ran,
        "diagnostic": diagnostic(session),
        "contacts": contacts,
        "contactsDropped": contacts_dropped,
        "endReason": end_reason(session),
        "stateHash": hash_hex(hash),
    });
    if session.sampling.as_ref().is_some_and(Sampling::recording) {
        sampled_result(id, result, None, samples)
    } else {
        Response::ok(id, result)
    }
}

fn sampled_result(id: u64, result: Value, channels: Option<&[String]>, samples: Samples) -> Response {
    #[derive(Serialize)]
    struct SampledResult<'a> {
        #[serde(flatten)]
        result: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        channels: Option<&'a [String]>,
        samples: Samples,
    }
    Response::serialized_ok(id, SampledResult { result, channels, samples })
}

fn advance<C>(
    sim: &mut Simulation, controller: &mut C, steps: u64, flight: impl Fn(&C) -> &Flight,
    mut step: impl FnMut(&mut C, &mut Simulation) -> Result<(), String>,
) -> Result<u64, String> {
    let mut ran = 0;
    while ran < steps && flight(controller).ended().is_none() {
        step(controller, sim)?;
        ran += 1;
    }
    Ok(ran)
}

pub fn log(id: u64, mut params: Map<String, Value>, session: Option<&Session>) -> Response {
    params.remove("id");
    if let Some(field) = params.keys().next() {
        return Response::err(Some(id), ErrorCode::InvalidParams, format!("flight.session.log: unknown field {field}"));
    }
    let Some(session) = session else { return no_session(id) };
    Response::session_log(id, &session.start_request, &session.step_requests)
}

pub fn end(id: u64, slot: &mut Option<Session>) -> Response {
    Response::ok(id, json!({ "ended": slot.take().is_some() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::ground_effect::InvalidInput;

    #[test]
    fn loads_keep_status_without_serializing_a_rejected_number() {
        let mut loads = StepLoads::default();
        assert_eq!(json!(DiagnosticLoads::from(&loads))["groundEffectStatus"], json!([]));
        loads.ground_effect_status.push(RotorGroundEffect::InvalidInput(InvalidInput::HubHeight(f64::NAN)));
        assert_eq!(json!(DiagnosticLoads::from(&loads))["groundEffectStatus"], json!([{ "type": "invalidInput", "reason": "hubHeight" }]));
        assert!(loads_are_finite(&loads));
        loads.ground_effect_added_thrust_n = f64::INFINITY;
        assert!(!loads_are_finite(&loads));
    }
}
