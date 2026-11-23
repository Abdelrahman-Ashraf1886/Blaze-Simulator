//! Engine protocol v2.
//!
//! v2 adds `vehicle.load` and `sim.run` (batch); `hello`, `ping` and
//! `shutdown` are unchanged from v1. 4.4 makes `sim.run` take a required
//! `environment` (ground and obstacles, with the user's friction and
//! restitution) and an optional `startPositionM`, and report `contacts`.
//!
//! Transport: newline-delimited JSON (one message per line, UTF-8) on the
//! engine's stdin (requests) and stdout (responses). stderr is free-form log
//! output and is never parsed.
//!
//! Request:  `{"id": <u64>, "type": "<command>", ...params}`
//! Response: `{"id": <u64>, "ok": true,  "result": {...}}`
//!       or  `{"id": <u64|null>, "ok": false, "error": {"code": "...", "message": "..."}}`
//!
//! The TypeScript mirror of these types lives in `electron/main/engine/protocol.ts`;
//! both must change together and bump `PROTOCOL_VERSION` on breaking changes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Hello,
    Ping,
    Shutdown,
    /// Live flight (4.8 part B), validated in flight_session: start replaces any
    /// session, step advances N fixed steps with the setpoint held, end drops it.
    #[serde(rename = "flight.session.start")]
    FlightSessionStart {
        #[serde(flatten)]
        params: serde_json::Map<String, Value>,
    },
    #[serde(rename = "flight.session.step")]
    FlightSessionStep {
        #[serde(flatten)]
        params: serde_json::Map<String, Value>,
    },
    #[serde(rename = "flight.session.end")]
    FlightSessionEnd,
    /// A scripted scenario on the loaded vehicle (4.9 part B), validated in scenario_run.
    #[serde(rename = "scenario.run")]
    ScenarioRun {
        #[serde(flatten)]
        params: serde_json::Map<String, Value>,
    },
    /// Validates a `VehicleDefinition` and, if valid, makes it the vehicle
    /// that `sim.run` simulates. An invalid one clears the loaded vehicle.
    /// `propulsion` (optional, additive in 4.5) carries the per-motor
    /// coefficients and the battery (`engine_core::propulsion`); it is validated
    /// against the vehicle's motors.
    #[serde(rename = "vehicle.load")]
    VehicleLoad {
        vehicle: Value,
        #[serde(default)]
        propulsion: Option<Value>,
        /// Optional body drag (`engine_core::aero`, additive in 4.5).
        #[serde(default)]
        aero: Option<Value>,
    },
    /// Runs the loaded vehicle from rest (identity attitude, body origin at
    /// `startPositionM`, default the world origin) for `durationS`, with an
    /// optional constant body-frame force (through the CoM) and torque (about
    /// the CoM), in `environment`; returns the final state, the hash and the
    /// contacts. `environment` is required: `{"ground": null, "obstacles": []}`
    /// is free space; a ground or obstacle must carry its friction and
    /// restitution (engine-core `environment.rs`).
    #[serde(rename = "sim.run", rename_all = "camelCase")]
    SimRun {
        duration_s: f64,
        #[serde(default)]
        environment: Option<Value>,
        #[serde(default)]
        start_position_m: Option<[f64; 3]>,
        #[serde(default)]
        dt_s: Option<f64>,
        #[serde(default)]
        force_body_n: Option<[f64; 3]>,
        #[serde(default)]
        torque_body_nm: Option<[f64; 3]>,
        /// With propulsion loaded (4.6): throttle per motor in [0, 1], in the
        /// order of the vehicle's motors, held over the run; absent = motors off.
        #[serde(default)]
        throttle: Option<Vec<f64>>,
        /// Rotor speeds at the start, rad/s (vehicle motor order); absent = at rest.
        #[serde(default)]
        rotor_speeds_radps: Option<Vec<f64>>,
        /// Air density for the body drag, kg/m³ (ISA at the user's altitude,
        /// computed by the app); required when the vehicle has body drag.
        #[serde(default)]
        air_density_kg_m3: Option<f64>,
        /// With propulsion (4.7): the PX4 controller flies the vehicle to this
        /// setpoint instead of fixed throttles (engine-core `closed_loop.rs`).
        #[serde(default)]
        controller: Option<ControllerRequest>,
    },
}

/// The controller's setpoint and gain overrides for `sim.run`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerRequest {
    /// CoM height to hold, m (world z); absent or null = hold `climbRateMps`.
    #[serde(default)]
    pub altitude_m: Option<f64>,
    /// Vertical velocity setpoint (or feed-forward with an altitude), m/s, up positive.
    #[serde(default)]
    pub climb_rate_mps: f64,
    /// Attitude setpoint, unit quaternion x y z w (body → world); absent = level.
    #[serde(default)]
    pub attitude: Option<[f64; 4]>,
    /// Yaw-rate feed-forward about world +z, rad/s (CCW positive).
    #[serde(default)]
    pub yaw_rate_radps: f64,
    /// Overrides of the PX4 v1.13.3 defaults by exact parameter name, e.g. {"MC_ROLL_P": 7}.
    #[serde(default)]
    pub gains: Option<serde_json::Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub engine_version: String,
    pub protocol_version: u32,
    pub threads: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PongResult {
    /// Microseconds since the engine process started (monotonic).
    pub engine_uptime_us: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidJson,
    InvalidRequest,
    /// Parameters parsed but are out of range (e.g. a negative duration).
    InvalidParams,
    /// `sim.run` before a valid `vehicle.load`.
    NoVehicle,
    /// The loaded vehicle lists parts without a mass; it cannot fly.
    VehicleIncomplete,
    /// `sim.run` without a complete environment (ground and obstacle friction
    /// and restitution are the user's inputs; there are no defaults).
    EnvironmentIncomplete,
    /// `sim.run` needed more compute time than the engine allows one request
    /// (it would stop answering health pings); no state is returned.
    RunTooLong,
    /// `flight.session.start` without a battery cut-off (the user's choice; no default).
    CutoffRequired,
    /// `flight.session.step` before `flight.session.start`.
    NoSession,
    /// `scenario.run` on a vehicle loaded without propulsion.
    NoPropulsion,
    /// `scenario.run` with a motor whose propeller data has no reference density (none is assumed).
    ReferenceDensityRequired,
    /// `scenario.run` with a scenario the engine refuses (invalid, too long, or not buildable for this vehicle).
    InvalidScenario,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok { id: u64, ok: bool, result: Value },
    Err { id: Option<u64>, ok: bool, error: ErrorBody },
}

impl Response {
    pub fn ok(id: u64, result: impl Serialize) -> Self {
        let result = serde_json::to_value(result).expect("result types always serialize");
        Response::Ok { id, ok: true, result }
    }

    pub fn err(id: Option<u64>, code: ErrorCode, message: impl Into<String>) -> Self {
        Response::Err { id, ok: false, error: ErrorBody { code, message: message.into() } }
    }

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("responses always serialize")
    }
}

/// Parse one input line. On failure returns a ready-to-send error response,
/// echoing the request id when it could be recovered.
pub fn parse_request(line: &str) -> Result<Request, Response> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| Response::err(None, ErrorCode::InvalidJson, e.to_string()))?;
    let id = value.get("id").and_then(Value::as_u64);
    serde_json::from_value(value)
        .map_err(|e| Response::err(id, ErrorCode::InvalidRequest, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_known_commands() {
        assert_eq!(
            parse_request(r#"{"id":1,"type":"hello"}"#).unwrap(),
            Request { id: 1, command: Command::Hello }
        );
        assert_eq!(parse_request(r#"{"id":2,"type":"ping"}"#).unwrap().command, Command::Ping);
        assert_eq!(
            parse_request(r#"{"id":3,"type":"shutdown"}"#).unwrap().command,
            Command::Shutdown
        );
        assert_eq!(
            parse_request(r#"{"id":4,"type":"sim.run","durationS":1.5,"forceBodyN":[0,0,9]}"#)
                .unwrap()
                .command,
            Command::SimRun {
                duration_s: 1.5,
                environment: None,
                start_position_m: None,
                dt_s: None,
                force_body_n: Some([0.0, 0.0, 9.0]),
                torque_body_nm: None,
                throttle: None,
                rotor_speeds_radps: None,
                air_density_kg_m3: None,
                controller: None
            }
        );
        assert!(matches!(
            parse_request(r#"{"id":5,"type":"vehicle.load","vehicle":{}}"#).unwrap().command,
            Command::VehicleLoad { propulsion: None, .. }
        ));
        assert!(matches!(
            parse_request(r#"{"id":6,"type":"vehicle.load","vehicle":{},"propulsion":{}}"#).unwrap().command,
            Command::VehicleLoad { propulsion: Some(_), .. }
        ));
    }

    #[test]
    fn malformed_json_is_invalid_json_without_id() {
        let err = parse_request("{not json").unwrap_err();
        let v: Value = serde_json::from_str(&err.to_line()).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], json!("INVALID_JSON"));
    }

    #[test]
    fn unknown_command_echoes_id() {
        let err = parse_request(r#"{"id":7,"type":"fly"}"#).unwrap_err();
        let v: Value = serde_json::from_str(&err.to_line()).unwrap();
        assert_eq!(v["id"], json!(7));
        assert_eq!(v["error"]["code"], json!("INVALID_REQUEST"));
    }

    #[test]
    fn missing_id_is_invalid_request() {
        let err = parse_request(r#"{"type":"ping"}"#).unwrap_err();
        let v: Value = serde_json::from_str(&err.to_line()).unwrap();
        assert_eq!(v["error"]["code"], json!("INVALID_REQUEST"));
    }

    #[test]
    fn ok_response_shape() {
        let r = Response::ok(
            5,
            HelloResult { engine_version: "0.1.0".into(), protocol_version: 1, threads: 4 },
        );
        let v: Value = serde_json::from_str(&r.to_line()).unwrap();
        assert_eq!(
            v,
            json!({"id":5,"ok":true,"result":{"engineVersion":"0.1.0","protocolVersion":1,"threads":4}})
        );
    }
}
