// Compile the same modules as simulation-engine/engine-host/src/main.rs:3–9.
#[path = "../../simulation-engine/engine-host/src/engine.rs"]
mod engine;
#[path = "../../simulation-engine/engine-host/src/flight_session.rs"]
mod flight_session;
#[path = "../../simulation-engine/engine-host/src/flight_environment.rs"]
mod flight_environment;
#[path = "../../simulation-engine/engine-host/src/protocol.rs"]
mod protocol;
#[path = "../../simulation-engine/engine-host/src/scenario_run.rs"]
mod scenario_run;
#[path = "../../simulation-engine/engine-host/src/step_test_run.rs"]
mod step_test_run;
#[path = "../../simulation-engine/engine-host/src/telemetry.rs"]
mod telemetry;

use serde_json::{json, Value};
use std::{fs, time::{Duration, Instant}};

fn checked(line: &str) -> Value {
    let value: Value = serde_json::from_str(line).expect("engine response JSON");
    assert_eq!(value["ok"], true, "engine request refused: {line}");
    value
}

fn main() {
    let path = std::env::args_os().nth(1).expect("pass the extracted flight requests");
    let input = fs::read_to_string(path).expect("read extracted flight requests");
    let mut lines = input.lines();
    let mut engine = engine::Engine::new();
    for _ in 0..2 { // vehicle.load and flight.session.start; see telemetry/verify.ts:108–124.
        let line = lines.next().expect("flight setup");
        let request = protocol::parse_request(line).expect("parse flight setup");
        checked(&engine.handle(request, line.to_owned()).0.into_line());
    }
    let mut handle = Duration::ZERO;
    let mut total = Duration::ZERO;
    let mut steps = 0;
    let mut requests = 0;
    let mut final_state_hash = Value::Null;
    for line in lines {
        let start = Instant::now();
        let request = protocol::parse_request(line).expect("parse flight step");
        let response = engine.handle(request, line.to_owned()).0;
        handle += start.elapsed();
        let reply = response.into_line();
        total += start.elapsed();

        let result = &checked(&reply)["result"];
        steps += result["stepsRun"].as_u64().expect("stepsRun");
        final_state_hash = result["stateHash"].clone();
        requests += 1;
    }
    println!("{}", json!({
        "handleNs": handle.as_nanos(), "totalNs": total.as_nanos(),
        "steps": steps, "requests": requests, "finalStateHash": final_state_hash,
    }));
}
