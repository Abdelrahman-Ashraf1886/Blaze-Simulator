//! Bounded, isolated step tests on the loaded vehicle.
use crate::{
    engine::{loaded_vehicle, manual_flight_with_gains},
    protocol::{ErrorCode, Response},
    scenario_run::MAX_SCENARIO_S,
};
use crate::flight_environment;
use engine_core::{
    aero::BodyDrag,
    flight::Cutoff,
    propulsion::Propulsion,
    step_test::{self, HoverStart, Report, StepTest},
    vehicle::Vehicle,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    test: StepTest,
    config: Config,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    air_density_kg_m3: f64,
    cutoff: CutoffRequest,
    gains: Option<Map<String, Value>>,
    airmode: Option<f64>,
    #[serde(default, deserialize_with = "crate::protocol::present")]
    thrust_model_factor: Option<f64>,
    #[serde(default, deserialize_with = "crate::protocol::present")]
    wind: Option<Value>,
    #[serde(default, deserialize_with = "crate::protocol::present")]
    ground_effect: Option<Value>,
    sensors: Option<Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase", deny_unknown_fields)]
enum CutoffRequest {
    VoltageV(f64),
    ChargeMah(f64),
}

#[derive(Serialize)]
struct Output {
    #[serde(flatten)]
    report: Report,
    gains: Map<String, Value>,
}

fn bounded(test: &StepTest) -> Result<(), String> {
    // Same free-space bound as scenario_run.rs:32-38. Neither NDJSON end
    // sets a message-size limit (main.rs:17-27, supervisor.ts:205,297-306),
    // so trace samples are bounded by duration / dt, even at decimation 1.
    if test.duration_s > MAX_SCENARIO_S {
        return Err(format!("durationS exceeds the free-space limit of {MAX_SCENARIO_S} s"));
    }
    // decimationSteps is echoed in JSON and must be exact in JavaScript.
    if test.decimation_steps >= 1 << f64::MANTISSA_DIGITS {
        return Err("decimationSteps must be a safe integer".into());
    }
    test.timing()?;
    Ok(())
}

pub fn handle(
    id: u64,
    mut params: Map<String, Value>,
    vehicle: Option<&Vehicle>,
    propulsion: Option<&Propulsion>,
    aero: Option<BodyDrag>,
) -> Response {
    let bad = |message: String| Response::err(Some(id), ErrorCode::InvalidParams, message);
    let vehicle = match loaded_vehicle(id, vehicle) {
        Ok(vehicle) => vehicle,
        Err(response) => return response,
    };
    let Some(propulsion) = propulsion else {
        let config = params.get("config");
        let message = flight_environment::propulsion_required(
            config.and_then(|c| c.get("wind")), config.and_then(|c| c.get("groundEffect")), "config.",
        );
        return Response::err(Some(id), ErrorCode::NoPropulsion,
            message.unwrap_or_else(|| "stepTest.run needs propulsion, including each motor's rotor inertia (inertiaKgM2), in vehicle.load".into()));
    };
    params.remove("id");
    if params.get("config").and_then(|c| c.get("cutoff")).is_none_or(Value::is_null) {
        return Response::err(Some(id), ErrorCode::CutoffRequired,
            "config.cutoff is required: voltageV or chargeMah with a positive value");
    }
    let Params { test, config } = match serde_json::from_value(Value::Object(params)) {
        Ok(params) => params,
        Err(error) => return bad(error.to_string()),
    };
    if let Err(error) = bounded(&test) {
        return bad(error);
    }
    let sensors = match crate::protocol::parse_sensors(config.sensors, "config.sensors") {
        Ok(sensors) => sensors,
        Err(error) => return bad(error),
    };
    let cutoff = match config.cutoff {
        CutoffRequest::VoltageV(v) => Cutoff::VoltageV(v),
        CutoffRequest::ChargeMah(q) => Cutoff::ChargeMah(q),
    };
    let hover = match HoverStart::new(vehicle, propulsion, aero, config.air_density_kg_m3, cutoff) {
        Ok(hover) => hover,
        Err(error) => return bad(error),
    };
    match step_test::run_with_sensors(vehicle, test, hover, sensors, |mut flight| {
        flight_environment::configure(&mut flight, config.wind.as_ref(), config.ground_effect.as_ref(), "config.")?;
        manual_flight_with_gains(vehicle, propulsion, flight, config.gains.as_ref(), config.airmode, config.thrust_model_factor)
    }) {
        Ok((report, gains)) => Response::ok(id, Output { report, gains: gains.parameters() }),
        Err(error) => bad(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::sim::DEFAULT_DT_S;
    use serde_json::json;

    #[test]
    fn step_test_request_has_a_fixed_step_bound_and_no_timing_defaults() {
        let mut spec = json!({
            "step": { "type": "rate", "axis": "roll", "amplitudeRadps": 0.1 },
            "holdS": 0.0, "durationS": MAX_SCENARIO_S, "decimationSteps": 1
        });
        let parse = |spec: &Value| serde_json::from_value::<StepTest>(spec.clone());
        assert!(bounded(&parse(&spec).unwrap()).is_ok());
        spec["durationS"] = json!(MAX_SCENARIO_S + DEFAULT_DT_S);
        assert!(bounded(&parse(&spec).unwrap()).unwrap_err().contains("durationS"));
        spec.as_object_mut().unwrap().remove("decimationSteps");
        assert!(parse(&spec).unwrap_err().to_string().contains("decimationSteps"));
    }
}
