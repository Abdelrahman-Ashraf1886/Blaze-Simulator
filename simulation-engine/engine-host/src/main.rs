//! `drone-engine` sidecar entry point. See `protocol.rs` for the wire format.

mod protocol;

use protocol::{parse_request, Command, HelloResult, PongResult, Response, PROTOCOL_VERSION};
use std::io::{self, BufRead, Write};
use std::time::Instant;

fn main() {
    let started = Instant::now();
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
            Ok(req) => match req.command {
                Command::Hello => (
                    Response::ok(
                        req.id,
                        HelloResult {
                            engine_version: engine_core::ENGINE_VERSION.to_string(),
                            protocol_version: PROTOCOL_VERSION,
                            threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
                        },
                    ),
                    false,
                ),
                Command::Ping => (
                    Response::ok(
                        req.id,
                        PongResult { engine_uptime_us: started.elapsed().as_micros() as u64 },
                    ),
                    false,
                ),
                Command::Shutdown => (Response::ok(req.id, serde_json::json!({})), true),
            },
        };
        if writeln!(stdout, "{}", response.to_line()).and_then(|_| stdout.flush()).is_err() {
            break; // host closed the pipe
        }
        if stop {
            break;
        }
    }
    eprintln!("drone-engine exiting");
}
