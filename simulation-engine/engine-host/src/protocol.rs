//! Engine protocol v1.
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

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Hello,
    Ping,
    Shutdown,
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
