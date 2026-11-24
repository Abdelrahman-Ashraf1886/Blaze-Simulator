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
use crate::engine::{controlled, loaded_vehicle, manual_flight, parse_environment, setpoint, step_manual};
use crate::protocol::{present, ControllerRequest, ErrorCode, FlightLoopDiagnostic, FlightModeRequest, Response};
use engine_core::aero::BodyDrag;
use engine_core::closed_loop::{ClosedLoop, ControlDiagnostic};
use engine_core::flight::{BatteryReading, Cutoff, EndReason, Flight, MotorReading, StepLoads};
use engine_core::flight_loop::FlightLoop;
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams {
    #[serde(default)]
    environment: Option<Value>,
    #[serde(default)]
    start_position_m: Option<[f64; 3]>,
    /// ISA density at the user's altitude (`src/domain/atmosphere.ts`), kg/m³.
    #[serde(default)]
    air_density_kg_m3: Option<f64>,
    cutoff: CutoffRequest,
    /// Overrides of the PX4 v1.13.3 defaults by exact parameter name.
    #[serde(default)]
    gains: Option<Map<String, Value>>,
    #[serde(default, deserialize_with = "present")]
    controller: Option<ManualControllerParams>,
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
    setpoint: ControllerRequest,
}

/// Everything the debug panel shows for one moment of the flight (camelCase).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic<'a> {
    state: SimState,
    motors: Vec<MotorReading>,
    battery: BatteryReading,
    /// What acted on the body over the last step, by source; zero before the first step.
    loads: &'a StepLoads,
    air_density_kg_m3: f64,
    /// The 4.7 controller's last step; null until it has stepped.
    control: Option<ControlDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flight_loop: Option<FlightLoopDiagnostic>,
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
        loads: flight.loads(),
        air_density_kg_m3: s.air_density_kg_m3,
        control,
        flight_loop,
    }
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
        return bad("a flight session needs the propulsion definition (vehicle.load with propulsion)".into());
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
    let sim = match Simulation::with_environment(vehicle, SimConfig::default(), &environment, p.start_position_m.unwrap_or([0.0; 3])) {
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
    if let Err(e) = flight.set_cutoff(cutoff) {
        return bad(format!("cutoff: {e}"));
    }
    let controller = if let Some(c) = p.controller {
        match manual_flight(vehicle, propulsion, flight, p.gains.as_ref(), c.airmode, c.thrust_model_factor) {
            Ok(loop_) => SessionController::Manual { loop_: Box::new(loop_), mode: c.mode },
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
    let session = Session { sim, controller, air_density_kg_m3: rho };
    let response = Response::ok(
        id,
        json!({
            "dtS": DEFAULT_DT_S,
            "maxStepsPerRequest": MAX_SESSION_STEPS,
            "diagnostic": diagnostic(&session),
        }),
    );
    *slot = Some(session);
    response
}

pub fn step(id: u64, mut params: Map<String, Value>, slot: &mut Option<Session>) -> Response {
    let bad = |message: String| Response::err(Some(id), ErrorCode::InvalidParams, message);
    let Some(session) = slot.as_mut() else {
        return Response::err(Some(id), ErrorCode::NoSession, "start a flight session first (flight.session.start)");
    };
    params.remove("id");
    let p: StepParams = match serde_json::from_value(Value::Object(params)) {
        Ok(p) => p,
        Err(e) => return bad(e.to_string()),
    };
    if p.steps == 0 || p.steps > MAX_SESSION_STEPS {
        return bad(format!("steps must be 1..={MAX_SESSION_STEPS}"));
    }
    if p.setpoint.gains.is_some() {
        return bad("gains are set by flight.session.start, not per step".into());
    }
    if p.setpoint.airmode.is_some() || p.setpoint.thrust_model_factor.is_some() {
        return bad("airmode and thrustModelFactor are set by flight.session.start".into());
    }
    // Contact times are products `k · dt` of the step index (`Simulation::step`), so the
    // window [t0, t1) compares exactly: an event belongs to the steps run here when its
    // start or end time falls in it. A step that reaches the cut-off still advances the body.
    let first = session.sim.state().steps;
    let mut ran = 0;
    match &mut session.controller {
        SessionController::Legacy(cl) => {
            if p.setpoint.mode.is_some() {
                return bad("setpoint.mode requires controller.mode at flight.session.start".into());
            }
            let sp = match setpoint(&p.setpoint) {
                Ok(s) => s,
                Err(e) => return bad(format!("setpoint: {e}")),
            };
            while ran < p.steps && cl.flight().ended().is_none() {
                cl.step(&mut session.sim, &sp);
                ran += 1;
            }
        }
        SessionController::Manual { loop_, mode } => {
            let selected = p.setpoint.mode.unwrap_or(*mode);
            let command = match p.setpoint.flight_command(selected) {
                Ok(command) => command,
                Err(e) => return bad(format!("setpoint: {e}")),
            };
            while ran < p.steps && loop_.flight().ended().is_none() {
                if let Err(e) = step_manual(loop_, &mut session.sim, command) {
                    *slot = None;
                    return bad(e);
                }
                ran += 1;
            }
            *mode = selected;
        }
    }
    let (t0, t1) = (first as f64 * DEFAULT_DT_S, session.sim.state().steps as f64 * DEFAULT_DT_S);
    let within = |t: f64| t >= t0 && t < t1;
    let (all, contacts_dropped) = session.sim.contacts();
    let contacts: Vec<_> = all.into_iter().filter(|c| within(c.start_s) || c.end_s.is_some_and(within)).collect();
    let hash = session.sim.state_hash_with(&session.controller.flight().hash_words());
    Response::ok(
        id,
        json!({
            "stepsRun": ran,
            "diagnostic": diagnostic(session),
            "contacts": contacts,
            "contactsDropped": contacts_dropped,
            "endReason": end_reason(session),
            "stateHash": hash_hex(hash),
        }),
    )
}

pub fn end(id: u64, slot: &mut Option<Session>) -> Response {
    Response::ok(id, json!({ "ended": slot.take().is_some() }))
}
