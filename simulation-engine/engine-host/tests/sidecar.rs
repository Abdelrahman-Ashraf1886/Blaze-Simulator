//! Spawns the real `drone-engine` binary and exercises the protocol end to end.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn send(stdin: &mut impl Write, out: &mut impl BufRead, line: &str) -> Value {
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
    let mut buf = String::new();
    out.read_line(&mut buf).unwrap();
    serde_json::from_str(&buf).unwrap()
}

#[test]
fn hello_ping_bad_input_and_shutdown() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_drone-engine"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("engine binary should start");
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());

    let hello = send(&mut stdin, &mut out, r#"{"id":1,"type":"hello"}"#);
    assert_eq!(hello["ok"], true);
    assert_eq!(hello["result"]["protocolVersion"], 1);
    assert!(hello["result"]["threads"].as_u64().unwrap() >= 1);

    let pong = send(&mut stdin, &mut out, r#"{"id":2,"type":"ping"}"#);
    assert_eq!(pong["id"], 2);
    assert!(pong["result"]["engineUptimeUs"].is_u64());

    // A bad line must not kill the engine.
    let bad = send(&mut stdin, &mut out, "garbage");
    assert_eq!(bad["ok"], false);
    let again = send(&mut stdin, &mut out, r#"{"id":3,"type":"ping"}"#);
    assert_eq!(again["ok"], true);

    let bye = send(&mut stdin, &mut out, r#"{"id":4,"type":"shutdown"}"#);
    assert_eq!(bye["ok"], true);
    let status = child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn exits_cleanly_when_stdin_closes() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_drone-engine"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}
