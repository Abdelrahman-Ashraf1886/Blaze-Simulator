//! `drone-engine` sidecar entry point. See `protocol.rs` for the wire format.

mod engine;
mod flight_session;
mod flight_environment;
mod protocol;
mod scenario_run;
mod step_test_run;

use protocol::{parse_request, PROTOCOL_VERSION};
use std::io::{self, BufRead, Write};

fn main() {
    let mut engine = engine::Engine::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    eprintln!("drone-engine {} started (protocol v{PROTOCOL_VERSION})", engine_core::ENGINE_VERSION);

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (response, stop) = match parse_request(&line) {
            Err(error) => (error, false),
            Ok(req) => engine.handle(req, line),
        };
        if writeln!(stdout, "{}", response.into_line()).and_then(|_| stdout.flush()).is_err() {
            break; // host closed the pipe
        }
        if stop {
            break;
        }
    }
    eprintln!("drone-engine exiting");
}
