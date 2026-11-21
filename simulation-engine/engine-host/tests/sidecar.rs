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
    assert_eq!(hello["result"]["protocolVersion"], 2);
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

struct Engine {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    out: BufReader<std::process::ChildStdout>,
    next: u64,
}

impl Engine {
    fn start() -> Engine {
        let mut child = Command::new(env!("CARGO_BIN_EXE_drone-engine"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        Engine { child, stdin, out, next: 1 }
    }

    fn call(&mut self, mut msg: Value) -> Value {
        msg["id"] = self.next.into();
        self.next += 1;
        send(&mut self.stdin, &mut self.out, &msg.to_string())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The two-part vehicle worked by hand in engine-core's vehicle tests.
fn two_part_vehicle() -> Value {
    serde_json::json!({
        "version": 1,
        "parts": [
            { "partId": "a", "massKg": 1.0, "com": [0.1, 0.0, 0.0],
              "inertia": [0.001, 0.002, 0.003, 0.0, 0.0, 0.0],
              "pose": { "position": [0.1, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] },
              "shape": { "type": "box", "halfExtents": [0.05, 0.03, 0.02] } },
            { "partId": "b", "massKg": 3.0, "com": [-0.1, 0.0, 0.05],
              "inertia": [0.004, 0.005, 0.006, 0.0, 0.0, 0.0],
              "pose": { "position": [-0.1, 0.0, 0.05], "quaternion": [0.0, 0.0, 0.0, 1.0] },
              "shape": { "type": "cylinder", "radius": 0.02, "halfHeight": 0.04 } }
        ],
        "motors": [],
        "totalMassKg": 4.0,
        "com": [-0.05, 0.0, 0.0375],
        "inertia": [0.006875, 0.038875, 0.039, 0.0, 0.0075, 0.0],
        "missingMass": []
    })
}

#[test]
fn vehicle_load_then_sim_run() {
    let mut e = Engine::start();

    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "NO_VEHICLE");

    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    assert_eq!(r["ok"], true);
    assert_eq!(r["result"]["valid"], true);
    assert_eq!(r["result"]["partCount"], 2);
    assert_eq!(r["result"]["totals"]["massKg"], 4.0);

    // Free fall for 1 s: v = −g t exactly; z within the substep bound ½ g t (dt/4).
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r["ok"], true, "{r}");
    let res = &r["result"];
    assert_eq!(res["steps"], 1000);
    let vz = res["state"]["linearVelocityMps"][2].as_f64().unwrap();
    assert!((vz + 9.80665).abs() < 1e-12, "{vz}");
    let dz = res["state"]["comM"][2].as_f64().unwrap() - 0.0375;
    assert!((dz + 0.5 * 9.80665).abs() <= 0.5 * 9.80665 * 0.25e-3 * (1.0 + 1e-9), "{dz}");
    let hash = res["stateHash"].as_str().unwrap().to_string();
    assert_eq!(hash.len(), 16);

    // Same run in a second engine process: bit-identical.
    let mut e2 = Engine::start();
    e2.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    let r2 = e2.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r2["result"]["stateHash"], hash.as_str());

    // Hover: a body force of m·g along +Z holds position.
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.5, "forceBodyN": [0.0, 0.0, 4.0 * 9.80665]}));
    assert!(r["result"]["state"]["linearVelocityMps"][2].as_f64().unwrap().abs() < 1e-12);
}

#[test]
fn invalid_vehicle_lists_errors_and_clears_the_loaded_one() {
    let mut e = Engine::start();
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    let mut bad = two_part_vehicle();
    bad["totalMassKg"] = 4.1.into();
    bad["parts"][0]["massKg"] = (-1.0).into();
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": bad}));
    assert_eq!(r["ok"], true);
    assert_eq!(r["result"]["valid"], false);
    let errors = r["result"]["errors"].as_array().unwrap();
    assert!(errors.iter().any(|e| e["path"] == "parts[0].massKg"), "{errors:?}");
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "NO_VEHICLE");
}

#[test]
fn sim_run_rejects_bad_params_and_incomplete_vehicles() {
    let mut e = Engine::start();
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    for params in [
        serde_json::json!({"durationS": -1.0}),
        serde_json::json!({"durationS": 1.0, "dtS": 0.0}),
        serde_json::json!({"durationS": 1.0005}),
        serde_json::json!({"durationS": 121.0}),
    ] {
        let mut msg = params.clone();
        msg["type"] = "sim.run".into();
        let r = e.call(msg);
        assert_eq!(r["error"]["code"], "INVALID_PARAMS", "{params} → {r}");
    }
    let mut incomplete = two_part_vehicle();
    incomplete["missingMass"] = serde_json::json!(["camera"]);
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": incomplete}));
    assert_eq!(r["result"]["missingMass"][0], "camera");
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "VEHICLE_INCOMPLETE");
}

/// The longest allowed run must finish well inside the supervisor's 3 s
/// request timeout, or health pings would kill the engine mid-run.
#[test]
fn sim_run_at_the_step_limit() {
    let mut e = Engine::start();
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    let t0 = std::time::Instant::now();
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 120.0}));
    let elapsed = t0.elapsed();
    eprintln!("120 000 steps took {elapsed:?}");
    assert_eq!(r["result"]["steps"], 120_000);
    if !cfg!(debug_assertions) {
        assert!(elapsed.as_secs_f64() < 2.5, "took {elapsed:?}");
    }
}

#[test]
fn vehicle_load_accepts_propulsion_and_refuses_a_mismatch() {
    let mut e = Engine::start();
    let mut v = two_part_vehicle();
    v["motors"] = serde_json::json!([{ "partId": "m1", "position": [0.1, 0.1, 0.05], "thrustAxis": [0, 0, 1], "spin": "cw" }]);
    let motor = |id: &str| {
        serde_json::json!({ "partId": id, "kvRadPerSV": 49.22, "resistanceOhm": 0.135, "noLoadCurrentA": 0.3,
            "thrustCoefNs2": 2.294e-5, "torqueCoefNms2": 3.7e-7, "inertiaKgM2": 4e-5 })
    };
    let battery = serde_json::json!({ "openCircuitVoltageV": 14.8, "internalResistanceOhm": 0.012, "capacityC": 18720.0 });

    // Without propulsion the result has no propulsion field (protocol unchanged for 4.3 callers).
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v}));
    assert_eq!(r["result"]["valid"], true);
    assert!(r["result"].get("propulsion").is_none(), "{r}");

    let p = serde_json::json!({ "version": 1, "motors": [motor("m1")], "battery": battery });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v, "propulsion": p}));
    assert_eq!(r["result"]["valid"], true, "{r}");
    assert_eq!(r["result"]["propulsion"]["motorCount"], 1);

    // A motor the vehicle does not have: refused, and the loaded vehicle is cleared.
    let p = serde_json::json!({ "version": 1, "motors": [motor("m9")], "battery": battery });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v, "propulsion": p}));
    assert_eq!(r["result"]["valid"], false);
    let paths: Vec<&str> = r["result"]["errors"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["propulsion.motors[0].partId", "propulsion.motors"]);
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.01}));
    assert_eq!(r["error"]["code"], "NO_VEHICLE");
}

#[test]
fn vehicle_load_accepts_aero_and_lists_its_errors() {
    let mut e = Engine::start();
    let aero = serde_json::json!({ "cdBody": [1.1, 1.1, 1.2], "areaM2": [0.012, 0.012, 0.03] });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle(), "aero": aero}));
    assert_eq!(r["result"]["valid"], true, "{r}");
    let bad = serde_json::json!({ "cdBody": [1.1, 0.0, 1.2], "areaM2": [0.012, 0.012, 0.03] });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle(), "aero": bad}));
    assert_eq!(r["result"]["valid"], false);
    assert_eq!(r["result"]["errors"][0]["path"], "aero.cdBody[1]");
}
