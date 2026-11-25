//! Request dispatch and the sidecar's state (the loaded vehicle).

use crate::flight_environment;
use crate::protocol::{Command, ControllerRequest, ErrorCode, FlightLoopDiagnostic, HelloResult, PongResult, Request, Response, PROTOCOL_VERSION};
use engine_core::aero::BodyDrag;
use engine_core::environment::{ContactEvent, Environment};
use engine_core::closed_loop::{gains_with_overrides, ClosedLoop, ControllerSummary};
use engine_core::controller::{Gains, Setpoint};
use engine_core::flight::{BatteryReading, Flight, MotorReading};
use engine_core::flight_loop::FlightLoop;
use engine_core::flight_modes::FlightCommand;
use engine_core::hover_thrust::HoverThrustParams;
use engine_core::position_control::{self, PositionGains};
use engine_core::propulsion::Propulsion;
use engine_core::sim::{hash_hex, BodyInput, SimConfig, SimState, Simulation, DEFAULT_DT_S};
use engine_core::vehicle::{vec, MassTotals, Vehicle, VehicleError};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

/// Upper bound on the steps of one `sim.run`. The sidecar is single-threaded,
/// so a run delays the health ping, and the supervisor kills an engine that
/// does not answer a ping within its request timeout (3 s). 120 000 steps
/// (120 s at 1 ms) took 0.88 s in a release build on the development machine
/// (≈7 µs per step; sidecar test `sim_run_at_the_step_limit`, DEVLOG 4.3).
pub const MAX_STEPS: u64 = 120_000;

/// Compute time one `sim.run` may take before it is stopped with `RUN_TOO_LONG`.
/// MAX_STEPS was sized for free flight (≈7 µs per step); with ground contact a step
/// costs far more (a 20-box vehicle resting on the ground: ≈0.2 ms per step, so
/// 120 000 steps take ≈25 s; DEVLOG 4.4 follow-ups). The supervisor kills an engine
/// that does not answer its health ping within 3 s, so a run stops itself well before
/// that. Stopping depends on the machine's speed, so a stopped run returns no state:
/// a completed run stays deterministic. Debug builds (tests only; the app runs the
/// release engine) are many times slower per step, so they get a larger budget.
pub const RUN_TIME_BUDGET: Duration = if cfg!(debug_assertions) { Duration::from_secs(120) } else { Duration::from_secs(2) };

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum VehicleLoadResult<'a> {
    #[serde(rename_all = "camelCase")]
    Valid {
        valid: bool,
        part_count: usize,
        motor_count: usize,
        totals: MassTotals,
        missing_mass: &'a [String],
        /// Present when the request carried a (valid) propulsion definition.
        #[serde(skip_serializing_if = "Option::is_none")]
        propulsion: Option<PropulsionSummary>,
    },
    Invalid {
        valid: bool,
        errors: Vec<VehicleError>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropulsionSummary {
    motor_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimRunResult {
    steps: u64,
    dt_s: f64,
    duration_s: f64,
    gravity_mps2: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_z_m: Option<f64>,
    state: SimState,
    /// 16 hex digits, see `Simulation::state_hash`.
    state_hash: String,
    /// Which part touched the ground or an obstacle, and when (s).
    contacts: Vec<ContactEvent>,
    /// Events beyond `MAX_CONTACT_EVENTS`, not listed.
    contacts_dropped: u64,
    /// With propulsion (4.6): each motor at the end of the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    motors: Option<Vec<MotorReading>>,
    /// With propulsion (4.6): the pack at the end of the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    battery: Option<BatteryReading>,
    /// With the controller (4.7): saturation, integrators and collective.
    #[serde(skip_serializing_if = "Option::is_none")]
    controller: Option<ControllerSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flight_loop: Option<FlightLoopDiagnostic>,
}

/// What flies the vehicle in a run.
enum Plant {
    /// Constant body loads, no propulsion (4.3).
    Loads(BodyInput),
    /// Fixed throttles (4.6).
    Throttle(Box<Flight>, Vec<f64>),
    /// The PX4 controller (4.7).
    Controlled(Box<ClosedLoop>, Setpoint),
    Manual(Box<FlightLoop>, FlightCommand),
}

impl Plant {
    fn flight(&self) -> Option<&Flight> {
        match self {
            Plant::Loads(_) => None,
            Plant::Throttle(f, _) => Some(f),
            Plant::Controlled(c, _) => Some(c.flight()),
            Plant::Manual(c, _) => Some(c.flight()),
        }
    }
}

/// The parameters of one `sim.run` (protocol.rs).
struct RunArgs {
    duration_s: f64,
    environment: Option<serde_json::Value>,
    wind: Option<Value>,
    ground_effect: Option<Value>,
    start_position_m: Option<[f64; 3]>,
    start_clearance_m: Option<f64>,
    dt_s: Option<f64>,
    force: Option<[f64; 3]>,
    torque: Option<[f64; 3]>,
    throttle: Option<Vec<f64>>,
    rotor_speeds: Option<Vec<f64>>,
    air_density: Option<f64>,
    controller: Option<ControllerRequest>,
}


pub struct Engine {
    started: Instant,
    vehicle: Option<Vehicle>,
    /// Coefficients of the loaded vehicle's motors and battery (4.5), flown
    /// by `sim.run` (4.6, engine-core `flight.rs`).
    propulsion: Option<Propulsion>,
    /// Body drag of the loaded vehicle (4.5), applied in flight (4.6).
    aero: Option<BodyDrag>,
    /// The live flight session (4.8 part B, `flight_session.rs`), at most one.
    session: Option<crate::flight_session::Session>,
}

impl Engine {
    pub fn new() -> Self {
        Engine { started: Instant::now(), vehicle: None, propulsion: None, aero: None, session: None }
    }

    /// Handles one request; the flag is true when the engine should exit.
    pub fn handle(&mut self, req: Request, line: String) -> (Response, bool) {
        let id = req.id;
        match req.command {
            Command::Hello => (
                Response::ok(
                    id,
                    HelloResult {
                        engine_version: engine_core::ENGINE_VERSION.to_string(),
                        protocol_version: PROTOCOL_VERSION,
                        threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
                    },
                ),
                false,
            ),
            Command::Ping => (
                Response::ok(id, PongResult { engine_uptime_us: self.started.elapsed().as_micros() as u64 }),
                false,
            ),
            Command::Shutdown => (Response::ok(id, serde_json::json!({})), true),
            Command::FlightSessionStart { params } => (
                crate::flight_session::start(id, params, line, &mut self.session, self.vehicle.as_ref(), self.propulsion.as_ref(), self.aero),
                false,
            ),
            Command::FlightSessionStep { params } => (crate::flight_session::step(id, params, line, &mut self.session), false),
            Command::FlightSessionEnd => (crate::flight_session::end(id, &mut self.session), false),
            Command::FlightSessionLog { params } => (crate::flight_session::log(id, params, self.session.as_ref()), false),
            Command::ScenarioRun { params } => (crate::scenario_run::handle(id, params, self.vehicle.as_ref(), self.propulsion.as_ref(), self.aero), false),
            Command::StepTestRun { params } => (crate::step_test_run::handle(id, params, self.vehicle.as_ref(), self.propulsion.as_ref(), self.aero), false),
            Command::VehicleLoad { vehicle, propulsion, aero } => (self.load(id, vehicle, propulsion, aero), false),
            Command::SimRun {
                duration_s,
                environment,
                wind,
                ground_effect,
                start_position_m,
                start_clearance_m,
                dt_s,
                force_body_n,
                torque_body_nm,
                throttle,
                rotor_speeds_radps,
                air_density_kg_m3,
                controller,
            } => {
                let args = RunArgs {
                    duration_s,
                    environment,
                    wind,
                    ground_effect,
                    start_position_m,
                    start_clearance_m,
                    dt_s,
                    force: force_body_n,
                    torque: torque_body_nm,
                    throttle,
                    rotor_speeds: rotor_speeds_radps,
                    air_density: air_density_kg_m3,
                    controller,
                };
                (self.run(id, args), false)
            }
        }
    }

    fn load(
        &mut self,
        id: u64,
        value: serde_json::Value,
        propulsion: Option<serde_json::Value>,
        aero: Option<serde_json::Value>,
    ) -> Response {
        self.propulsion = None;
        self.aero = None;
        let loaded = Vehicle::from_json(value).and_then(|v| {
            let p = match propulsion {
                None => None,
                Some(p) => Some(Propulsion::from_json(p, &v.definition)),
            };
            let a = aero.map(BodyDrag::from_json);
            let mut errors = Vec::new();
            if let Some(Err(e)) = &p {
                errors.extend(e.iter().cloned());
            }
            if let Some(Err(e)) = &a {
                errors.extend(e.iter().cloned());
            }
            if !errors.is_empty() {
                return Err(errors);
            }
            Ok((v, p.map(Result::unwrap), a.map(Result::unwrap)))
        });
        match loaded {
            Ok((v, propulsion, aero)) => {
                let response = Response::ok(
                    id,
                    VehicleLoadResult::Valid {
                        valid: true,
                        part_count: v.definition.parts.len(),
                        motor_count: v.definition.motors.len(),
                        totals: v.totals,
                        missing_mass: &v.definition.missing_mass,
                        propulsion: propulsion.as_ref().map(|p| PropulsionSummary { motor_count: p.motors.len() }),
                    },
                );
                self.vehicle = Some(v);
                self.propulsion = propulsion;
                self.aero = aero;
                response
            }
            Err(errors) => {
                self.vehicle = None;
                Response::ok(id, VehicleLoadResult::Invalid { valid: false, errors })
            }
        }
    }

    fn run(&self, id: u64, args: RunArgs) -> Response {
        let RunArgs { duration_s, environment, wind, ground_effect, start_position_m, start_clearance_m, dt_s, force, torque, throttle, rotor_speeds, air_density, controller } = args;
        let bad = |m: String| Response::err(Some(id), ErrorCode::InvalidParams, m);
        let vehicle = match loaded_vehicle(id, self.vehicle.as_ref()) {
            Ok(v) => v,
            Err(r) => return r,
        };
        if self.propulsion.is_none() {
            if let Some(message) = flight_environment::propulsion_required(wind.as_ref(), ground_effect.as_ref(), "") {
                return bad(message);
            }
        }
        let environment = match parse_environment(id, environment) {
            Ok(e) => e,
            Err(r) => return r,
        };
        let dt = dt_s.unwrap_or(DEFAULT_DT_S);
        if !(dt.is_finite() && dt > 0.0) {
            return bad(format!("dtS must be a positive number (got {dt})"));
        }
        if !(duration_s.is_finite() && duration_s > 0.0) {
            return bad(format!("durationS must be a positive number (got {duration_s})"));
        }
        if controller.as_ref().is_some_and(|c| c.mode.is_some()) {
            // Match the exact cadence test in flight_loop.rs (EKF2_PREDICT_US).
            const INTERVAL_S: f64 = 10_000.0 / 1_000_000.0;
            let steps_per_sample = (INTERVAL_S / dt).round() as u64;
            if steps_per_sample == 0 || INTERVAL_S / steps_per_sample as f64 != dt {
                return bad("dtS must divide 10 ms when controller.mode is given".into());
            }
        }
        let n = (duration_s / dt).round();
        if n < 1.0 || (n * dt - duration_s).abs() > 1e-9 * duration_s {
            return bad(format!("durationS ({duration_s}) must be a whole number of steps of {dt} s"));
        }
        if n > MAX_STEPS as f64 {
            return bad(format!("{n} steps exceed the limit of {MAX_STEPS} per run"));
        }
        let (f, t) = (force.unwrap_or([0.0; 3]), torque.unwrap_or([0.0; 3]));
        if !f.iter().chain(t.iter()).all(|x| x.is_finite()) {
            return bad("forceBodyN and torqueBodyNm must be finite".into());
        }
        let config = SimConfig { dt_s: dt, ..SimConfig::default() };
        let mut sim = match Simulation::with_start_clearance(
            vehicle, config, &environment, start_position_m.unwrap_or([0.0; 3]), start_clearance_m,
        ) {
            Ok(s) => s,
            Err(e) => return bad(e),
        };
        let start_z_m = start_clearance_m.map(|_| sim.state().position_m[2]);
        // With propulsion the motors, battery and body drag fly the vehicle (engine-core
        // flight.rs), at fixed throttles or under the PX4 controller (closed_loop.rs).
        let mut plant = match &self.propulsion {
            Some(p) => {
                if force.is_some() || torque.is_some() {
                    return bad("forceBodyN and torqueBodyNm are for a vehicle without propulsion; give throttle or controller instead".into());
                }
                let mut fl = match Flight::new(vehicle, p.clone(), self.aero, air_density) {
                    Ok(fl) => fl,
                    Err(e) => return bad(e),
                };
                // Thrust and torque scale as rho / rho_ref,i per motor, the same as in a flight session: the air
                // density is the caller's, each motor's reference density is in the propulsion definition.
                let Some(rho) = air_density else {
                    return bad("with propulsion give the air density (airDensityKgM3): thrust and torque scale with it relative to the density of the propeller data".into());
                };
                if let Err(e) = fl.scale_to_air_density(rho) {
                    return bad(e.to_string());
                }
                if let Err(e) = flight_environment::configure(&mut fl, wind.as_ref(), ground_effect.as_ref(), "") {
                    return bad(e);
                }
                if let Some(w) = &rotor_speeds {
                    if let Err(e) = fl.set_rotor_speeds(w) {
                        return bad(format!("rotorSpeedsRadps: {e}"));
                    }
                }
                match controller {
                    Some(c) => {
                        if throttle.is_some() {
                            return bad("give either throttle or controller, not both".into());
                        }
                        if let Some(mode) = c.mode {
                            let command = match c.flight_command(mode) {
                                Ok(command) => command,
                                Err(e) => return bad(format!("controller: {e}")),
                            };
                            match manual_flight(vehicle, p, fl, c.gains.as_ref(), c.airmode, c.thrust_model_factor) {
                                Ok(loop_) => Plant::Manual(Box::new(loop_), command),
                                Err(e) => return bad(e),
                            }
                        } else {
                            match controlled(vehicle, p, fl, &c) {
                                Ok((cl, sp)) => Plant::Controlled(Box::new(cl), sp),
                                Err(e) => return bad(e),
                            }
                        }
                    }
                    None => {
                        let throttle = throttle.unwrap_or_default();
                        if !throttle.is_empty() && throttle.len() != fl.motor_count() {
                            return bad(format!("throttle: give {} values, one per motor in the vehicle's order", fl.motor_count()));
                        }
                        if !throttle.iter().all(|d| d.is_finite() && (0.0..=1.0).contains(d)) {
                            return bad("throttle values must be within 0 and 1".into());
                        }
                        Plant::Throttle(Box::new(fl), throttle)
                    }
                }
            }
            None => {
                if throttle.is_some() || rotor_speeds.is_some() || controller.is_some() {
                    return bad("throttle, rotorSpeedsRadps and controller need the propulsion definition (vehicle.load with propulsion)".into());
                }
                if self.aero.is_some() {
                    return bad("the body drag is applied in flight: load the vehicle with its propulsion definition too".into());
                }
                Plant::Loads(BodyInput { force_body_n: vec(f), torque_body_nm: vec(t) })
            }
        };
        let steps = n as u64;
        let started = Instant::now();
        for k in 0..steps {
            match &mut plant {
                Plant::Loads(input) => sim.step(input),
                Plant::Throttle(fl, throttle) => fl.step(&mut sim, throttle),
                Plant::Controlled(cl, sp) => cl.step(&mut sim, sp),
                Plant::Manual(loop_, command) => {
                    if let Err(e) = step_manual(loop_, &mut sim, *command) {
                        return bad(e);
                    }
                }
            }
            if k % 256 == 255 && started.elapsed() > RUN_TIME_BUDGET {
                return Response::err(
                    Some(id),
                    ErrorCode::RunTooLong,
                    format!(
                        "the run needs more than {} s of computing (stopped after {} of {steps} steps, {:.3} s simulated); run a shorter durationS",
                        RUN_TIME_BUDGET.as_secs_f64(),
                        k + 1,
                        (k + 1) as f64 * dt
                    ),
                );
            }
        }
        let (contacts, contacts_dropped) = sim.contacts();
        let hash_words = match &plant {
            Plant::Manual(loop_, _) => loop_.hash_words(),
            _ => plant.flight().map(Flight::hash_words).unwrap_or_default(),
        };
        Response::ok(
            id,
            SimRunResult {
                steps,
                dt_s: dt,
                duration_s: steps as f64 * dt,
                gravity_mps2: config.gravity_mps2,
                start_z_m,
                state: sim.state(),
                state_hash: hash_hex(sim.state_hash_with(&hash_words)),
                contacts,
                contacts_dropped,
                motors: plant.flight().map(Flight::motors),
                battery: plant.flight().map(Flight::battery),
                controller: match &plant {
                    Plant::Controlled(cl, _) => Some(cl.summary()),
                    _ => None,
                },
                flight_loop: match &plant {
                    Plant::Manual(loop_, _) => loop_.last_step().map(FlightLoopDiagnostic::from),
                    _ => None,
                },
            },
        )
    }
}

/// The loaded vehicle, if there is one and every part has a mass (`sim.run` and the flight session).
pub(crate) fn loaded_vehicle(id: u64, vehicle: Option<&Vehicle>) -> Result<&Vehicle, Response> {
    let Some(vehicle) = vehicle else {
        return Err(Response::err(Some(id), ErrorCode::NoVehicle, "load a valid vehicle first (vehicle.load)"));
    };
    let missing = &vehicle.definition.missing_mass;
    if !missing.is_empty() {
        return Err(Response::err(
            Some(id),
            ErrorCode::VehicleIncomplete,
            format!("{} part(s) have no mass: {}", missing.len(), missing.join(", ")),
        ));
    }
    Ok(vehicle)
}

/// The request's environment, complete (the user's friction and restitution; no defaults).
pub(crate) fn parse_environment(id: u64, environment: Option<serde_json::Value>) -> Result<Environment, Response> {
    let Some(environment) = environment else {
        return Err(Response::err(
            Some(id),
            ErrorCode::EnvironmentIncomplete,
            "environment is not set: give the ground's friction and restitution (or \"ground\": null for free space) and the obstacles",
        ));
    };
    Environment::from_json(&environment).map_err(|errors| {
        let list: Vec<String> = errors.iter().map(|e| format!("{}: {}", e.path, e.message)).collect();
        Response::err(Some(id), ErrorCode::EnvironmentIncomplete, list.join("; "))
    })
}

/// The PX4 controller around `flight`, with the request's gain overrides, and its checked setpoint.
pub(crate) fn controlled(vehicle: &Vehicle, p: &Propulsion, flight: Flight, c: &ControllerRequest) -> Result<(ClosedLoop, Setpoint), String> {
    let sp = setpoint(c).map_err(|e| format!("controller: {e}"))?;
    let (gains, factor) = closed_loop_gains(c.gains.clone(), c.thrust_model_factor)
        .map_err(|e| format!("controller: {e}"))?;
    let cl = ClosedLoop::new(vehicle, flight, p.yaw_ratio(), gains)
        .and_then(|loop_| loop_.with_thrust_model(factor))
        .map_err(|e| format!("controller: {e}"))?;
    Ok((cl, sp))
}

pub(crate) fn closed_loop_gains(
    mut overrides: Option<Map<String, Value>>,
    thrust_model_factor: Option<f64>,
) -> Result<(Gains, f64), String> {
    let parameter = overrides.as_mut().and_then(|gains| gains.remove("THR_MDL_FAC"));
    let factor = resolve_thrust_model(thrust_model_factor, parameter.as_ref())?;
    let gains = gains_with_overrides(overrides.as_ref()).map_err(|e| format!("gains: {e}"))?;
    Ok((gains, factor))
}

/// The controller setpoint of a request, checked (finite, unit attitude).
pub(crate) fn setpoint(c: &ControllerRequest) -> Result<Setpoint, String> {
    if let Some(field) = c.manual_field() {
        return Err(format!("{field} requires mode"));
    }
    let climb_rate = c.climb_rate_mps.unwrap_or_default();
    let yaw_rate = c.yaw_rate_radps.unwrap_or_default();
    let attitude = c.attitude.unwrap_or([0.0, 0.0, 0.0, 1.0]);
    // The controller asserts |q|^2 - 1 < 1e-9, so a request at exactly 1e-9 is refused here too.
    if !attitude.iter().all(|x| x.is_finite()) || (attitude.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() >= 1e-9 {
        return Err("attitude must be a unit quaternion x y z w".into());
    }
    if !c.altitude_m.is_none_or(f64::is_finite) || !climb_rate.is_finite() || !yaw_rate.is_finite() {
        return Err("altitudeM, climbRateMps and yawRateRadps must be finite".into());
    }
    Ok(Setpoint { attitude, yaw_rate, z: c.altitude_m, z_velocity: climb_rate })
}

/// Route overrides to the position and 4.7 validators by their existing parameter
/// names, then build the estimator with the position loop's resolved hover settings.
pub(crate) fn manual_flight(
    vehicle: &Vehicle,
    propulsion: &Propulsion,
    flight: Flight,
    overrides: Option<&Map<String, Value>>,
    airmode: Option<f64>,
    thrust_model_factor: Option<f64>,
) -> Result<FlightLoop, String> {
    manual_flight_with_gains(vehicle, propulsion, flight, overrides, airmode, thrust_model_factor)
        .map(|(flight_loop, _)| flight_loop)
}

pub(crate) struct ManualFlightGains {
    gains: Gains,
    position: PositionGains,
    hover: HoverThrustParams,
    airmode: u8,
    thrust_model_factor: f64,
}

impl ManualFlightGains {
    pub(crate) fn parameters(&self) -> Map<String, Value> {
        let mut parameters = Map::new();
        // For shared MPC fields, the position controller's values are the
        // effective ones, just as its validator owns those overrides below.
        for group in [json!(self.gains), json!(self.position)] {
            if let Value::Object(fields) = group {
                parameters.extend(fields.into_iter().map(|(key, value)| (key.to_ascii_uppercase(), value)));
            }
        }
        parameters.extend([
            ("HTE_HT_NOISE".into(), json!(self.hover.hte_ht_noise)),
            ("HTE_ACC_GATE".into(), json!(self.hover.hte_acc_gate)),
            ("HTE_HT_ERR_INIT".into(), json!(self.hover.hte_ht_err_init)),
            ("HTE_VXY_THR".into(), json!(self.hover.hte_vxy_thr)),
            ("HTE_VZ_THR".into(), json!(self.hover.hte_vz_thr)),
            ("HTE_THR_RANGE".into(), json!(self.hover.hte_thr_range)),
            ("MC_AIRMODE".into(), json!(self.airmode)),
            ("THR_MDL_FAC".into(), json!(self.thrust_model_factor)),
        ]);
        parameters
    }
}

pub(crate) fn manual_flight_with_gains(
    vehicle: &Vehicle,
    propulsion: &Propulsion,
    flight: Flight,
    overrides: Option<&Map<String, Value>>,
    airmode: Option<f64>,
    thrust_model_factor: Option<f64>,
) -> Result<(FlightLoop, ManualFlightGains), String> {
    let position_fields = serde_json::to_value(PositionGains::px4_v1_13_3()).map_err(|e| e.to_string())?;
    let mut position_overrides = Map::new();
    let mut rate_overrides = Map::new();
    let mut hover = HoverThrustParams::default();
    let mut mixer_airmode = None;
    for (name, value) in overrides.into_iter().flatten() {
        let numeric = || value.as_f64().ok_or_else(|| format!("{name} must be a finite number"));
        match name.as_str() {
            "MC_AIRMODE" => mixer_airmode = Some(parse_airmode("MC_AIRMODE", numeric()?)?),
            "THR_MDL_FAC" => {},
            "HTE_HT_NOISE" => hover.hte_ht_noise = numeric()?,
            "HTE_ACC_GATE" => hover.hte_acc_gate = numeric()?,
            "HTE_HT_ERR_INIT" => hover.hte_ht_err_init = numeric()?,
            "HTE_VXY_THR" => hover.hte_vxy_thr = numeric()?,
            "HTE_VZ_THR" => hover.hte_vz_thr = numeric()?,
            "HTE_THR_RANGE" => hover.hte_thr_range = numeric()?,
            _ if position_fields.get(name.to_ascii_lowercase()).is_some() => {
                position_overrides.insert(name.clone(), value.clone());
            }
            _ => {
                rate_overrides.insert(name.clone(), value.clone());
            }
        }
    }
    let airmode = airmode.map(|value| parse_airmode("airmode", value)).transpose()?;
    if let (Some(field), Some(parameter)) = (airmode, mixer_airmode) {
        if field != parameter {
            return Err("airmode and MC_AIRMODE must agree".into());
        }
    }
    let thrust_model_factor = resolve_thrust_model(thrust_model_factor, overrides.and_then(|g| g.get("THR_MDL_FAC")))?;
    let gain_error = |e| format!("controller.gains: {e}");
    let position = position_control::gains_with_overrides(Some(&position_overrides)).map_err(gain_error)?;
    let gains = gains_with_overrides(Some(&rate_overrides)).map_err(gain_error)?;
    hover.mpc_thr_hover = position.mpc_thr_hover;
    hover.mpc_use_hte = position.mpc_use_hte != 0.0;
    hover.validate().map_err(gain_error)?;
    // MC_AIRMODE default and enum: database/reference/physics.v1.json:1084-1092.
    let airmode = airmode.or(mixer_airmode).unwrap_or(0);
    let flight_loop = FlightLoop::new(vehicle, flight, propulsion.yaw_ratio(), gains, position, airmode, hover)
        .and_then(|loop_| loop_.with_thrust_model(thrust_model_factor))
        .map_err(|e| format!("controller: {e}"))?;
    Ok((flight_loop, ManualFlightGains { gains, position, hover, airmode, thrust_model_factor }))
}

/// The caller drops the run/session on any failure, including non-finite demands
/// rejected by the allocator's assertion (controller.rs, Allocator::allocate).
pub(crate) fn step_manual(loop_: &mut FlightLoop, sim: &mut Simulation, command: FlightCommand) -> Result<(), String> {
    step_manual_observed(loop_, sim, command, |_| {})
}

pub(crate) fn step_manual_observed(
    loop_: &mut FlightLoop, sim: &mut Simulation, command: FlightCommand,
    observe: impl FnOnce(engine_core::flight_loop::FlightSetpoints),
) -> Result<(), String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        loop_.step_observed(sim, command, |sp, _, _| observe(sp))
    }))
        .unwrap_or_else(|failure| {
            let message = failure.downcast_ref::<&str>().copied()
                .or_else(|| failure.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("unknown failure");
            Err(format!("flight loop failed: {message}"))
        })
}

fn parse_airmode(name: &str, value: f64) -> Result<u8, String> {
    match value {
        0.0 => Ok(0),
        1.0 => Ok(1),
        2.0 => Ok(2),
        _ => Err(format!("{name} must be 0, 1 or 2")),
    }
}

fn resolve_thrust_model(field: Option<f64>, parameter: Option<&Value>) -> Result<f64, String> {
    let parameter = parameter.map(|value| {
        value.as_f64().ok_or_else(|| "THR_MDL_FAC must be a finite number".to_owned())
    }).transpose()?;
    // THR_MDL_FAC bounds and default: database/reference/physics.v1.json:1102-1109.
    for (name, value) in [("thrustModelFactor", field), ("THR_MDL_FAC", parameter)] {
        if value.is_some_and(|v| !(0.0..=1.0).contains(&v)) {
            return Err(format!("{name} must be in [0, 1]"));
        }
    }
    if field.zip(parameter).is_some_and(|(a, b)| a != b) {
        return Err("thrustModelFactor and THR_MDL_FAC must agree".into());
    }
    Ok(field.or(parameter).unwrap_or(0.0))
}
