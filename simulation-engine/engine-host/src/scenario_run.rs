//! `scenario.run` (4.9 part B): runs one of engine-core's scripted scenarios
//! (`engine_core::scenario`) on the loaded vehicle, in lockstep with nothing: one
//! request, one finished report.
//!
//! The scenario is a built-in (name plus its parameters, built for this vehicle by
//! engine-core) or a full `Scenario` JSON. The config gives what a scenario does not
//! own: the air density (from the flight conditions), the battery cut-off (the user's
//! entry; no default), optional gain overrides, and optionally a ground and the start
//! position. Nothing here validates a scenario: `Scenario::validate`,
//! `modified_vehicle`, `Gains::validate`, `Flight::scale_to_air_density` and the
//! builders do, and their messages are returned as they are, under the codes below.
//!
//! Bound: a scenario runs for at most `MAX_SCENARIO_S` seconds (a single-threaded
//! engine answers no health ping while it runs, and the supervisor kills an engine that
//! stays silent for 3 s); with a ground (contact steps cost far more) at most
//! `MAX_SCENARIO_WITH_GROUND_S`.
use crate::engine::{closed_loop_gains, loaded_vehicle, manual_flight_with_gains};
use crate::flight_environment;
use crate::protocol::{parse_sensors, present, ErrorCode, Response};
use crate::telemetry::{ControllerKind, SampleEverySteps, Samples, Sampling};
use engine_core::aero::BodyDrag;
use engine_core::environment::Environment;
use engine_core::flight::{Cutoff, Flight, ScaleToAirDensityError};
use engine_core::propulsion::Propulsion;
use engine_core::scenario::{
    balanced_hover, com_offset, com_offset_beyond_authority, modified_vehicle, overweight_payload, payload, run_with_flight_config, Ground, Scenario,
    position_hold_scenario, run_flight_script, run_flight_script_observed, run_observed, takeoff_hold_land_scenario, FlightAcceptance,
    ScenarioConfig, ScenarioReport, SETTLE_S,
};
use engine_core::sim::{hash_hex, SimConfig, Simulation};
use engine_core::vehicle::Vehicle;
use engine_core::wind::Wind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Longest scenario, s of simulated time: 60 000 steps of 1 ms. Free-space steps cost
/// about 7 µs (DEVLOG 4.3): a 60 s scenario of the 4.7 test quad took 0.41 s in a release
/// build on the development machine (a 20 s built-in 0.14 s), well inside the supervisor's 3 s.
pub const MAX_SCENARIO_S: f64 = 60.0;
/// Longest scenario started on a ground, s: a step with contacts costs up to ≈0.2 ms
/// (DEVLOG 4.4), so 10 000 steps stay near 2 s (the test quad on a box ground: 10 s in 0.25 s).
pub const MAX_SCENARIO_WITH_GROUND_S: f64 = 10.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunParams {
    scenario: ScenarioRequest,
    config: ConfigRequest,
}

/// A built-in with its parameters, or a full scenario.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum ScenarioRequest {
    Builtin {
        name: Builtin,
        /// `payload` only: the mass added at the nominal CoM, kg (the user's entry).
        #[serde(default)]
        mass_kg: Option<f64>,
        /// `com_offset` only: the CoM's displacement along +x, m (the user's entry).
        #[serde(default)]
        offset_m: Option<f64>,
    },
    /// Parsed in `build`, so a malformed one is INVALID_SCENARIO like an invalid one.
    Custom {
        scenario: Value,
    },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Builtin {
    BalancedHover,
    Payload,
    OverweightPayload,
    ComOffset,
    ComOffsetBeyondAuthority,
    WindHold,
    Gust,
    TakeoffHoldLand,
    Terrain,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigRequest {
    /// Density of the air flown in (ISA at the user's altitude), kg/m³.
    #[serde(default)]
    air_density_kg_m3: Option<f64>,
    /// The user's cut-off: required.
    #[serde(default)]
    cutoff: Option<CutoffRequest>,
    /// Overrides of the PX4 v1.13.3 defaults by exact parameter name.
    #[serde(default)]
    gains: Option<Map<String, Value>>,
    #[serde(default, deserialize_with = "present")]
    thrust_model_factor: Option<f64>,
    /// Ground and obstacles (needs `startPositionM`); absent = free space from the origin.
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
    #[serde(default, deserialize_with = "present")]
    sample_every_steps: Option<SampleEverySteps>,
    sensors: Option<Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase", deny_unknown_fields)]
enum CutoffRequest {
    VoltageV(f64),
    ChargeMah(f64),
}

pub fn handle(
    id: u64,
    mut params: Map<String, Value>,
    vehicle: Option<&Vehicle>,
    propulsion: Option<&Propulsion>,
    aero: Option<BodyDrag>,
) -> Response {
    let bad = |message: String| Response::err(Some(id), ErrorCode::InvalidParams, message);
    let invalid_scenario = |message: String| Response::err(Some(id), ErrorCode::InvalidScenario, message);
    let vehicle = match loaded_vehicle(id, vehicle) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(propulsion) = propulsion else {
        let config = params.get("config");
        let message = flight_environment::propulsion_required(
            config.and_then(|c| c.get("wind")), config.and_then(|c| c.get("groundEffect")), "config.",
        );
        return Response::err(
            Some(id),
            ErrorCode::NoPropulsion,
            message.unwrap_or_else(|| "a scenario needs the propulsion definition (vehicle.load with propulsion)".into()),
        );
    };
    // Flattened command parameters also contain the envelope field.
    params.remove("id");
    // The cut-off is the user's choice, and a missing one is its own refusal, before anything else is read.
    if params.get("config").and_then(|c| c.get("cutoff")).is_none_or(Value::is_null) {
        return Response::err(
            Some(id),
            ErrorCode::CutoffRequired,
            "cutoff is required: voltageV or chargeMah, with an explicit positive value (config.cutoff)",
        );
    }
    let mut p: RunParams = match serde_json::from_value(Value::Object(params)) {
        Ok(p) => p,
        Err(e) => return bad(e.to_string()),
    };
    let Some(rho) = p.config.air_density_kg_m3.filter(|r| r.is_finite() && *r > 0.0) else {
        return bad("config.airDensityKgM3 must be a positive number (ISA at the user's altitude)".into());
    };
    let sensors = match parse_sensors(p.config.sensors.take(), "config.sensors") {
        Ok(sensors) => sensors,
        Err(e) => return bad(e),
    };
    let cutoff = match p.config.cutoff {
        Some(CutoffRequest::VoltageV(v)) => Cutoff::VoltageV(v),
        Some(CutoffRequest::ChargeMah(q)) => Cutoff::ChargeMah(q),
        None => unreachable!("checked above"),
    };
    // Each motor's data is at its own reference density; the engine's scaling refuses a motor without one.
    let mut flight = match Flight::new(vehicle, propulsion.clone(), aero, Some(rho)) {
        Ok(f) => f,
        Err(e) => return bad(e),
    };
    if let Err(e) = flight.scale_to_air_density(rho) {
        let code = match e {
            ScaleToAirDensityError::MissingReferenceDensity { .. } => ErrorCode::ReferenceDensityRequired,
            ScaleToAirDensityError::InvalidDensity(_) => ErrorCode::InvalidParams,
        };
        return Response::err(Some(id), code, e.to_string());
    }
    match flight_script(&p.scenario) {
        Ok(Some((scenario, builtin))) => {
            let context = FlightRun { vehicle, propulsion, aero, rho };
            let mut samples = Samples::default();
            let mut sampling = Sampling::new(p.config.sample_every_steps, sensors, vehicle, propulsion, ControllerKind::FlightLoop);
            let observer = sampling.as_mut().map(|sampling| (sampling, &mut samples));
            return match context.run(&p.config, cutoff, flight, &scenario, builtin, observer) {
                Ok(report) => result(id, &scenario, report, sampling.as_ref(), samples),
                Err(e) => invalid_scenario(e),
            };
        }
        Ok(None) => {}
        Err(e) => return invalid_scenario(e),
    }
    let (gains, thrust_model_factor) = match closed_loop_gains(p.config.gains, p.config.thrust_model_factor) {
        Ok(resolved) => resolved,
        Err(e) => return bad(format!("config.{e}")),
    };
    if p.config.start_clearance_m.is_some() && p.config.environment.is_none() {
        return bad("config.startClearanceM requires config.environment with a ground plane or terrain".into());
    }
    let ground = match (p.config.environment, p.config.start_position_m) {
        (None, None) => None,
        (None, Some(_)) => return bad("config.startPositionM is for a ground: give config.environment too".into()),
        (Some(_), None) => return bad("config.environment needs config.startPositionM (the body origin's start; no default)".into()),
        (Some(e), Some(start_m)) => match Environment::from_json(&e) {
            Ok(environment) => Some(Ground { environment, start_m }),
            Err(errors) => {
                let list: Vec<String> = errors.iter().map(|e| format!("config.{}: {}", e.path, e.message)).collect();
                return Response::err(Some(id), ErrorCode::EnvironmentIncomplete, list.join("; "));
            }
        },
    };
    let mut config = ScenarioConfig { gains, thrust_model_factor, air_density_kg_m3: rho, cutoff: Some(cutoff), ground };
    let scenario = match build(&p.scenario, vehicle, propulsion, &config) {
        Ok(s) => s,
        Err(e) => return invalid_scenario(e),
    };
    // The engine's own checks, so a refused scenario has its own code; `run` repeats them.
    let plant = match scenario.validate(propulsion.motors.len()).and_then(|()| modified_vehicle(vehicle, &scenario)) {
        Ok(plant) => plant,
        Err(e) => return invalid_scenario(e),
    };
    let limit = if config.ground.is_some() { MAX_SCENARIO_WITH_GROUND_S } else { MAX_SCENARIO_S };
    if scenario.duration_s > limit {
        return invalid_scenario(format!(
            "the scenario runs {} s; the limit is {limit} s{}",
            scenario.duration_s,
            if config.ground.is_some() { " with a ground" } else { "" }
        ));
    }
    if let (Some(ground), Some(clearance)) = (&mut config.ground, p.config.start_clearance_m) {
        // Scenario modifications can move collision parts or add a payload.
        match Simulation::with_start_clearance(&plant, SimConfig::default(), &ground.environment, ground.start_m, Some(clearance)) {
            Ok(sim) => ground.start_m = sim.state().position_m,
            Err(e) => return bad(format!("config.{e}")),
        }
    }
    let configure = |flight: &mut Flight| {
        flight_environment::configure(flight, p.config.wind.as_ref(), p.config.ground_effect.as_ref(), "config.")
    };
    let mut samples = Samples::default();
    let mut sampling = Sampling::new(p.config.sample_every_steps, sensors, vehicle, propulsion, ControllerKind::AttitudeHold);
    let report = if let Some(sampling) = &mut sampling {
        run_observed(vehicle, propulsion.clone(), aero, &config, &scenario, configure, |sim, cl, input| {
            sampling.attitude(&mut samples, sim, cl, input);
        })
    } else {
        run_with_flight_config(vehicle, propulsion.clone(), aero, &config, &scenario, configure)
    };
    match report {
        Ok(report) => result(id, &scenario, report, sampling.as_ref(), samples),
        Err(e) => bad(e),
    }
}

fn result(id: u64, scenario: &Scenario, mut report: ScenarioReport, sampling: Option<&Sampling>, samples: Samples) -> Response {
    if let Some(sampling) = sampling {
        let hash = u64::from_str_radix(&report.final_state_hash, 16).expect("scenario returned a u64 hex hash");
        report.final_state_hash = hash_hex(sampling.extend_hash(hash));
    }
    if let Some(sampling) = sampling.filter(|s| s.recording()) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SampledResult<'a> {
            scenario: &'a Scenario,
            report: &'a ScenarioReport,
            state_hash: &'a str,
            channels: &'a [String],
            samples: Samples,
        }
        return Response::serialized_ok(id, SampledResult {
            scenario, report: &report, state_hash: &report.final_state_hash, channels: sampling.channels(), samples,
        });
    }
    Response::ok(id, json!({
        "scenario": scenario, "report": report, "stateHash": report.final_state_hash,
    }))
}

fn flight_script(request: &ScenarioRequest) -> Result<Option<(Scenario, Option<Builtin>)>, String> {
    let ScenarioRequest::Builtin { name, mass_kg, offset_m } = request else {
        if let ScenarioRequest::Custom { scenario } = request {
            if scenario.get("flightScript").is_some_and(|s| !s.is_null()) {
                let script = serde_json::from_value(scenario.clone()).map_err(|e| format!("scenario: {e}"))?;
                return Ok(Some((script, None)));
            }
        }
        return Ok(None);
    };
    let scenario = match name {
        // Two settling windows from 6.7 (engine-core/src/scenario/flight_script.rs).
        Builtin::WindHold => position_hold_scenario("wind_hold", 2.0 * SETTLE_S),
        Builtin::Gust => position_hold_scenario("gust", MAX_SCENARIO_S),
        Builtin::TakeoffHoldLand => takeoff_hold_land_scenario("takeoff_hold_land"),
        Builtin::Terrain => takeoff_hold_land_scenario("terrain"),
        _ => return Ok(None),
    };
    if mass_kg.is_some() || offset_m.is_some() {
        return Err(format!("{} takes its inputs from the build and environment, not massKg or offsetM", scenario.name));
    }
    Ok(Some((scenario, Some(*name))))
}

struct FlightRun<'a> {
    vehicle: &'a Vehicle,
    propulsion: &'a Propulsion,
    aero: Option<BodyDrag>,
    rho: f64,
}

const NEEDS_PLANE: &str = "Enter the ground plane's friction and restitution in Workshop > Environment (and select no terrain) to run this scenario";

impl FlightRun<'_> {
    fn run(
        self, config: &ConfigRequest, cutoff: Cutoff, mut flight: Flight,
        scenario: &Scenario, builtin: Option<Builtin>, observer: Option<(&mut Sampling, &mut Samples)>,
    ) -> Result<ScenarioReport, String> {
        let FlightRun { vehicle, propulsion, aero, rho } = self;
        let plant = modified_vehicle(vehicle, scenario)?;
        let mut sim = Self::simulation(config, &plant, scenario.duration_s, builtin)?;
        // Flight commands also support custom scenarios with modified mass and geometry.
        // Keep the nominal controller geometry as on the ClosedLoop path.
        if !scenario.modifications.is_empty() {
            flight = Flight::new(&plant, propulsion.clone(), aero, Some(rho))?;
            flight.scale_to_air_density(rho)?;
        }
        let mut acceptance = FlightAcceptance::None;
        let mut mean_wind = None;
        if matches!(builtin, Some(Builtin::WindHold | Builtin::Gust)) {
            let saved = config.wind.as_ref().filter(|wind| !wind.is_null())
                .ok_or("Save wind in Flight setup to run this scenario")?;
            let wind = Wind::from_json(saved).map_err(|e| format!("config.wind: {e}"))?;
            let mut mean = saved.clone();
            mean["gust"] = Value::Null;
            let mean_model = Wind::from_json(&mean).map_err(|e| format!("config.wind: {e}"))?;
            mean_wind = Some(mean);
            acceptance = match builtin {
                Some(Builtin::WindHold) => {
                    if saved["mean"].is_null() {
                        return Err("Wind hold requires saved mean wind in Flight setup".into());
                    }
                    FlightAcceptance::WindHold { wind: mean_model, drag: aero, air_density_kg_m3: rho, mass_kg: plant.totals.mass_kg }
                }
                _ => {
                    let gust = &saved["gust"];
                    let start_s = gust["startS"].as_f64().ok_or("Save a gust in Flight setup to run this scenario")?;
                    let length_m = gust["lengthM"].as_f64().ok_or("Save a gust length in Flight setup")?;
                    if start_s >= scenario.duration_s - SETTLE_S {
                        return Err("The saved gust starts after the scenario's post-hold window".into());
                    }
                    FlightAcceptance::Gust { wind, start_s, length_m }
                }
            };
        }
        flight_environment::configure(&mut flight, mean_wind.as_ref().or(config.wind.as_ref()), config.ground_effect.as_ref(), "config.")?;
        flight.set_cutoff(cutoff)?;
        let (mut controller, gains) = manual_flight_with_gains(
            vehicle, propulsion, flight, config.gains.as_ref(), None, config.thrust_model_factor,
        )?;
        if matches!(builtin, Some(Builtin::TakeoffHoldLand | Builtin::Terrain)) {
            let land_speed_mps = gains.parameters()["MPC_LAND_SPEED"].as_f64().ok_or("MPC_LAND_SPEED is unavailable")?;
            acceptance = FlightAcceptance::TakeoffLand { land_speed_mps };
        }
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some((sampling, samples)) = observer {
                run_flight_script_observed(&mut sim, &mut controller, scenario, acceptance, |sim, loop_, input| {
                    sampling.flight_loop(samples, sim, loop_, input);
                })
            } else {
                run_flight_script(&mut sim, &mut controller, scenario, acceptance)
            }
        })).unwrap_or_else(|_| Err("FlightLoop failed while stepping the scenario".into()))
    }

    fn simulation(
        config: &ConfigRequest, plant: &Vehicle, duration: f64, builtin: Option<Builtin>,
    ) -> Result<Simulation, String> {
        let sim = SimConfig::default();
        let plane = matches!(builtin, Some(Builtin::TakeoffHoldLand));
        let terrain = matches!(builtin, Some(Builtin::Terrain));
        let free = matches!(builtin, Some(Builtin::WindHold | Builtin::Gust));
        let limit = if config.environment.is_some() && !terrain && !plane { MAX_SCENARIO_WITH_GROUND_S } else { MAX_SCENARIO_S };
        if duration > limit { return Err(format!("the scenario runs {duration} s; the limit is {limit} s")); }
        match (&config.environment, config.start_position_m, config.start_clearance_m) {
            (None, _, _) if plane => Err(NEEDS_PLANE.into()),
            (None, None, None) if !terrain => Simulation::new(plant, sim),
            (None, _, _) if terrain => Err("Save a terrain grid in Workshop > Environment to run this scenario".into()),
            (None, _, _) => Err("config.startPositionM and config.startClearanceM require config.environment".into()),
            (Some(_), _, _) if free => Err("Wind hold and gust scenarios start in free space".into()),
            (Some(value), start, clearance) => {
                let environment = Environment::from_json(value).map_err(|errors| {
                    errors.iter().map(|e| format!("config.{}: {}", e.path, e.message)).collect::<Vec<_>>().join("; ")
                })?;
                if terrain && environment.terrain.is_none() {
                    return Err("Save a terrain grid in Workshop > Environment to run this scenario".into());
                }
                if plane && environment.ground.is_none() {
                    return Err(NEEDS_PLANE.into());
                }
                if terrain && clearance.is_none() {
                    return Err("Terrain requires config.startClearanceM".into());
                }
                let start = start.ok_or("config.environment needs config.startPositionM")?;
                Simulation::with_start_clearance(plant, sim, &environment, start, clearance)
            }
        }
    }
}

/// The scenario to run: a built-in built for this vehicle, or the given one. The builders'
/// refusals (a CoM off the thrust centre, a weight beyond the thrust, ...) are returned as they are.
fn build(request: &ScenarioRequest, v: &Vehicle, p: &Propulsion, config: &ScenarioConfig) -> Result<Scenario, String> {
    match request {
        ScenarioRequest::Custom { scenario } => serde_json::from_value(scenario.clone()).map_err(|e| format!("scenario: {e}")),
        ScenarioRequest::Builtin { name, mass_kg, offset_m } => {
            let only = |given: bool, param: &str, builtin: &str| {
                if given {
                    Err(format!("{param} is not a parameter of {builtin}"))
                } else {
                    Ok(())
                }
            };
            match name {
                Builtin::BalancedHover => {
                    only(mass_kg.is_some(), "massKg", "balanced_hover")?;
                    only(offset_m.is_some(), "offsetM", "balanced_hover")?;
                    balanced_hover(v, p, config)
                }
                Builtin::Payload => {
                    only(offset_m.is_some(), "offsetM", "payload")?;
                    payload(v, p, config, mass_kg.ok_or("payload needs massKg: the mass added at the CoM, kg")?)
                }
                Builtin::OverweightPayload => {
                    only(mass_kg.is_some(), "massKg", "overweight_payload (its mass is derived from the build)")?;
                    only(offset_m.is_some(), "offsetM", "overweight_payload")?;
                    overweight_payload(v, p, config)
                }
                Builtin::ComOffset => {
                    only(mass_kg.is_some(), "massKg", "com_offset")?;
                    com_offset(v, p, config, offset_m.ok_or("com_offset needs offsetM: the CoM's displacement along +x, m")?)
                }
                Builtin::ComOffsetBeyondAuthority => {
                    only(mass_kg.is_some(), "massKg", "com_offset_beyond_authority")?;
                    only(offset_m.is_some(), "offsetM", "com_offset_beyond_authority (its offset is derived from the build)")?;
                    com_offset_beyond_authority(v, p, config)
                }
                _ => unreachable!("FlightLoop built-ins dispatched above"),
            }
        }
    }
}
