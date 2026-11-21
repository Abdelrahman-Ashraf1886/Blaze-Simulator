//! Engine protocol v2.
//!
//! v2 adds `vehicle.load` and `sim.run` (batch); `hello`, `ping` and
//! `shutdown` are unchanged from v1.
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
    /// Runs the loaded vehicle from rest at the origin (identity attitude)
    /// for `durationS`, with an optional constant body-frame force (through
    /// the CoM) and torque (about the CoM); returns the final state and hash.
    #[serde(rename = "sim.run", rename_all = "camelCase")]
    SimRun {
        duration_s: f64,
        #[serde(default)]
        dt_s: Option<f64>,
        #[serde(default)]
        force_body_n: Option<[f64; 3]>,
        #[serde(default)]
        torque_body_nm: Option<[f64; 3]>,
    },
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
                dt_s: None,
                force_body_n: Some([0.0, 0.0, 9.0]),
                torque_body_nm: None
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
