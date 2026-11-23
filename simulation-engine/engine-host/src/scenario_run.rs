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
use crate::engine::loaded_vehicle;
use crate::protocol::{ErrorCode, Response};
use engine_core::aero::BodyDrag;
use engine_core::closed_loop::gains_with_overrides;
use engine_core::environment::Environment;
use engine_core::flight::{Cutoff, Flight};
use engine_core::propulsion::Propulsion;
use engine_core::scenario::{
    balanced_hover, com_offset, com_offset_beyond_authority, modified_vehicle, overweight_payload, payload, run, Ground, Scenario,
    ScenarioConfig,
};
use engine_core::vehicle::Vehicle;
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Longest scenario, s of simulated time: 60 000 steps of 1 ms. Free-space steps cost
/// about 7 µs (DEVLOG 4.3), so this stays well inside the supervisor's 3 s; the longest
/// built-in is 20 s.
pub const MAX_SCENARIO_S: f64 = 60.0;
/// Longest scenario started on a ground, s: a step with contacts costs up to ≈0.2 ms
/// (DEVLOG 4.4), so 10 000 steps stay near 2 s.
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
    /// Ground and obstacles (needs `startPositionM`); absent = free space from the origin.
    #[serde(default)]
    environment: Option<Value>,
    #[serde(default)]
    start_position_m: Option<[f64; 3]>,
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
        return Response::err(
            Some(id),
            ErrorCode::NoPropulsion,
            "a scenario needs the propulsion definition (vehicle.load with propulsion)",
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
    let p: RunParams = match serde_json::from_value(Value::Object(params)) {
        Ok(p) => p,
        Err(e) => return bad(e.to_string()),
    };
    let Some(rho) = p.config.air_density_kg_m3.filter(|r| r.is_finite() && *r > 0.0) else {
        return bad("config.airDensityKgM3 must be a positive number (ISA at the user's altitude)".into());
    };
    let cutoff = match p.config.cutoff {
        Some(CutoffRequest::VoltageV(v)) => Cutoff::VoltageV(v),
        Some(CutoffRequest::ChargeMah(q)) => Cutoff::ChargeMah(q),
        None => unreachable!("checked above"),
    };
    // Each motor's data is at its own reference density; the engine's scaling refuses a motor without one.
    let scaling = Flight::new(vehicle, propulsion.clone(), aero, Some(rho)).and_then(|mut f| {
        f.scale_to_air_density(rho)?;
        Ok(f)
    });
    if let Err(e) = scaling {
        let code = if e.contains("reference density") { ErrorCode::ReferenceDensityRequired } else { ErrorCode::InvalidParams };
        return Response::err(Some(id), code, e);
    }
    let gains = match gains_with_overrides(p.config.gains.as_ref()) {
        Ok(g) => g,
        Err(e) => return bad(format!("config.gains: {e}")),
    };
    let ground = match (p.config.environment, p.config.start_position_m) {
        (None, None) => None,
        (None, Some(_)) => return bad("config.startPositionM is for a ground: give config.environment too".into()),
        (Some(_), None) => return bad("config.environment needs config.startPositionM (the body origin's start; no default)".into()),
        (Some(e), Some(start_m)) => match Environment::from_json(&e) {
            Ok(environment) => Some(Ground { environment, start_m }),
            Err(errors) => {
                let list: Vec<String> = errors.iter().map(|e| format!("{}: {}", e.path, e.message)).collect();
                return Response::err(Some(id), ErrorCode::EnvironmentIncomplete, list.join("; "));
            }
        },
    };
    let config = ScenarioConfig { gains, air_density_kg_m3: rho, cutoff: Some(cutoff), ground };
    let scenario = match build(&p.scenario, vehicle, propulsion, &config) {
        Ok(s) => s,
        Err(e) => return invalid_scenario(e),
    };
    // The engine's own checks, so a refused scenario has its own code; `run` repeats them.
    if let Err(e) = scenario.validate(propulsion.motors.len()).and_then(|()| modified_vehicle(vehicle, &scenario).map(|_| ())) {
        return invalid_scenario(e);
    }
    let limit = if config.ground.is_some() { MAX_SCENARIO_WITH_GROUND_S } else { MAX_SCENARIO_S };
    if scenario.duration_s > limit {
        return invalid_scenario(format!(
            "the scenario runs {} s; the limit is {limit} s{}",
            scenario.duration_s,
            if config.ground.is_some() { " with a ground" } else { "" }
        ));
    }
    match run(vehicle, propulsion.clone(), aero, &config, &scenario) {
        Ok(report) => Response::ok(
            id,
            json!({
                "scenario": scenario,
                "report": report,
                "stateHash": report.final_state_hash,
            }),
        ),
        Err(e) => bad(e),
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
            }
        }
    }
}
