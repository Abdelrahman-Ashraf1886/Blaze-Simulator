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

/// Free space: no ground, no obstacles (stated, never assumed).
fn free() -> serde_json::Value {
    serde_json::json!({"ground": null, "obstacles": []})
}

#[test]
fn vehicle_load_then_sim_run() {
    let mut e = Engine::start();

    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "NO_VEHICLE");

    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    assert_eq!(r["ok"], true);
    assert_eq!(r["result"]["valid"], true);
    assert_eq!(r["result"]["partCount"], 2);
    assert_eq!(r["result"]["totals"]["massKg"], 4.0);

    // Free fall for 1 s: v = −g t exactly; z within the substep bound ½ g t (dt/4).
    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 1.0}));
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
    let r2 = e2.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 1.0}));
    assert_eq!(r2["result"]["stateHash"], hash.as_str());

    // Hover: a body force of m·g along +Z holds position.
    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 0.5, "forceBodyN": [0.0, 0.0, 4.0 * 9.80665]}));
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
    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 1.0}));
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
        msg["environment"] = free();
        let r = e.call(msg);
        assert_eq!(r["error"]["code"], "INVALID_PARAMS", "{params} → {r}");
    }
    let mut incomplete = two_part_vehicle();
    incomplete["missingMass"] = serde_json::json!(["camera"]);
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": incomplete}));
    assert_eq!(r["result"]["missingMass"][0], "camera");
    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "VEHICLE_INCOMPLETE");
}

/// The longest allowed run must finish well inside the supervisor's 3 s
/// request timeout, or health pings would kill the engine mid-run.
#[test]
fn sim_run_at_the_step_limit() {
    let mut e = Engine::start();
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    let t0 = std::time::Instant::now();
    let r = e.call(serde_json::json!({"type": "sim.run", "environment": free(), "durationS": 120.0}));
    let elapsed = t0.elapsed();
    eprintln!("120 000 steps took {elapsed:?}");
    assert_eq!(r["result"]["steps"], 120_000);
    if !cfg!(debug_assertions) {
        assert!(elapsed.as_secs_f64() < 2.5, "took {elapsed:?}");
    }
}

/// A run that would block the engine past the supervisor's ping timeout stops itself
/// with RUN_TOO_LONG, and the engine keeps answering.
#[test]
fn a_long_run_with_many_contacts_stops_within_the_time_budget() {
    // The budget is 2 s in the release engine (the one the app runs); debug builds are slower
    // per step and get a larger budget, so this only checks the release build.
    if cfg!(debug_assertions) {
        return;
    }
    let mut e = Engine::start();
    // 20 boxes resting on the ground: ≈0.2 ms per step in release, so 120 s would take ≈25 s.
    let parts: Vec<serde_json::Value> = (0..20)
        .map(|i| {
            let (x, y) = ((i % 5) as f64 * 0.03 - 0.06, (i / 5) as f64 * 0.03 - 0.045);
            serde_json::json!({
                "partId": format!("p{i}"), "massKg": 0.05, "com": [x, y, 0.0],
                "inertia": [1e-5, 1e-5, 1e-5, 0.0, 0.0, 0.0],
                "pose": { "position": [x, y, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] },
                "shape": { "type": "box", "halfExtents": [0.0125, 0.0125, 0.01] }
            })
        })
        .collect();
    let totals = engine_core::vehicle::recompute_totals(
        &serde_json::from_value::<Vec<engine_core::vehicle::PartBody>>(serde_json::json!(parts)).unwrap(),
    );
    let vehicle = serde_json::json!({
        "version": 1, "parts": parts, "motors": [], "totalMassKg": totals.mass_kg,
        "com": totals.com, "inertia": totals.inertia, "missingMass": []
    });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": vehicle}));
    assert_eq!(r["result"]["valid"], true, "{r}");
    let t0 = std::time::Instant::now();
    let r = e.call(serde_json::json!({
        "type": "sim.run", "durationS": 120.0, "startPositionM": [0.0, 0.0, 0.01],
        "environment": {"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []}
    }));
    let elapsed = t0.elapsed();
    assert_eq!(r["error"]["code"], "RUN_TOO_LONG", "{r}");
    assert!(elapsed.as_secs_f64() < 2.8, "stopped after {elapsed:?}");
    // Still answering.
    assert_eq!(e.call(serde_json::json!({"type": "ping"}))["ok"], true);
}

/// Contacts through the protocol (the resting height itself is checked in
/// engine-core `environment/tests.rs`): the two-part vehicle dropped from
/// 0.5 m lands, tips onto both parts and comes to rest, with the contacts
/// reported. At the origin part a (box bottom at −20 mm) starts inside the
/// ground, which is refused; and sim.run refuses to start without the
/// ground's friction and restitution.
#[test]
fn sim_run_with_ground_reports_contacts_and_needs_the_surface_values() {
    let mut e = Engine::start();
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": two_part_vehicle()}));
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0}));
    assert_eq!(r["error"]["code"], "ENVIRONMENT_INCOMPLETE", "{r}");
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0, "environment": {"ground": {"friction": 0.5}, "obstacles": []}}));
    assert_eq!(r["error"]["code"], "ENVIRONMENT_INCOMPLETE", "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("environment.ground.restitution: not set"), "{r}");
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 1.0, "environment": {"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []}}));
    assert_eq!(r["error"]["code"], "INVALID_PARAMS", "starts inside the ground: {r}");
    let r = e.call(serde_json::json!({
        "type": "sim.run", "durationS": 2.0, "startPositionM": [0.0, 0.0, 0.5],
        "environment": {"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []}
    }));
    assert_eq!(r["ok"], true, "{r}");
    let contacts = r["result"]["contacts"].as_array().unwrap();
    assert!(!contacts.is_empty());
    assert!(contacts.iter().all(|c| c["with"] == "ground" && c["startS"].as_f64().unwrap() > 0.2), "{contacts:?}");
    assert!(contacts.iter().any(|c| c["endS"].is_null()), "still resting at the end: {contacts:?}");
    assert_eq!(r["result"]["contactsDropped"], 0);
    let v = &r["result"]["state"]["linearVelocityMps"];
    assert!((0..3).all(|i| v[i].as_f64().unwrap().abs() < 1e-5), "{v}");
}

#[test]
fn vehicle_load_accepts_propulsion_and_refuses_a_mismatch() {
    let mut e = Engine::start();
    let mut v = two_part_vehicle();
    v["motors"] = serde_json::json!([{ "partId": "m1", "position": [0.1, 0.1, 0.05], "thrustAxis": [0, 0, 1], "spin": "cw" }]);
    let motor = |id: &str| {
        serde_json::json!({ "partId": id, "kvRadPerSV": 49.22, "resistanceOhm": 0.135, "noLoadCurrentA": 0.3,
            "thrustCoefNs2": 2.294e-5, "torqueCoefNms2": 3.7e-7, "inertiaKgM2": 4e-5, "referenceDensityKgM3": 1.225 })
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
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.01, "environment": {"ground": null, "obstacles": []}}));
    assert_eq!(r["error"]["code"], "NO_VEHICLE");
}

/// 4.6 through the protocol: with propulsion loaded, `sim.run` flies the
/// throttles (motors, battery, drag) and reports each motor and the pack;
/// throttles without propulsion, drag without air density and body loads with
/// propulsion are refused.
#[test]
fn sim_run_flies_the_throttles_and_reports_motors_and_battery() {
    let mut e = Engine::start();
    let free = serde_json::json!({"ground": null, "obstacles": []});
    let mut v = two_part_vehicle();
    v["motors"] = serde_json::json!([{ "partId": "m1", "position": [-0.05, 0.0, 0.0375], "thrustAxis": [0, 0, 1], "spin": "cw" }]);
    let p = serde_json::json!({ "version": 1, "battery": { "openCircuitVoltageV": 14.8, "internalResistanceOhm": 0.012, "capacityC": 18720.0 },
        "motors": [{ "partId": "m1", "kvRadPerSV": 49.22, "resistanceOhm": 0.135, "noLoadCurrentA": 0.3,
            "thrustCoefNs2": 2.294e-5, "torqueCoefNms2": 3.7e-7, "inertiaKgM2": 4e-5, "referenceDensityKgM3": 1.225 }] });

    // Without propulsion: throttle is refused.
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v}));
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "throttle": [0.5], "airDensityKgM3": 1.225}));
    assert_eq!(r["error"]["code"], "INVALID_PARAMS", "{r}");

    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v, "propulsion": p}));
    assert_eq!(r["result"]["valid"], true, "{r}");
    let run = |e: &mut Engine| e.call(serde_json::json!({"type": "sim.run", "durationS": 0.5, "environment": free, "throttle": [0.6], "airDensityKgM3": 1.225}));
    let r = run(&mut e);
    assert_eq!(r["ok"], true, "{r}");
    let m = &r["result"]["motors"][0];
    assert_eq!(m["partId"], "m1");
    assert_eq!(m["throttle"], 0.6);
    let (rpm, thrust) = (m["rpm"].as_f64().unwrap(), m["thrustN"].as_f64().unwrap());
    // T = k_T ω², ω = rpm·2π/60.
    let w = rpm * std::f64::consts::PI / 30.0;
    assert!(rpm > 1000.0 && (thrust - 2.294e-5 * w * w).abs() < 1e-9 * thrust, "{m}");
    let b = &r["result"]["battery"];
    let (volts, amps) = (b["voltageV"].as_f64().unwrap(), b["currentA"].as_f64().unwrap());
    assert!(amps > 0.0 && (volts - (14.8 - 0.012 * amps)).abs() < 1e-9, "{b}");
    assert!(b["chargeUsedC"].as_f64().unwrap() > 0.0);
    // Deterministic, rotors included in the hash.
    assert_eq!(run(&mut e)["result"]["stateHash"], r["result"]["stateHash"]);
    // A body load with propulsion, a wrong throttle count or range: refused.
    for bad in [
        serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "forceBodyN": [0, 0, 1]}),
        serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "throttle": [0.5, 0.5], "airDensityKgM3": 1.225}),
        serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "throttle": [1.5], "airDensityKgM3": 1.225}),
    ] {
        assert_eq!(e.call(bad)["error"]["code"], "INVALID_PARAMS");
    }

    // Body drag needs the air density.
    let aero = serde_json::json!({ "cdBody": [1.1, 1.1, 1.2], "areaM2": [0.012, 0.012, 0.03] });
    e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v, "propulsion": p, "aero": aero}));
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "throttle": [0.6]}));
    assert!(r["error"]["message"].as_str().unwrap().contains("air density"), "{r}");
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "throttle": [0.6], "airDensityKgM3": 1.225}));
    assert_eq!(r["ok"], true, "{r}");
}

/// 4.7 through the protocol: the PX4 controller flies a quad (the test motor
/// of engine-core, not a catalogue part) from rest to a 0.5 m hover, and the
/// result carries its summary; bad setpoints, unknown gains and throttle plus
/// controller are refused.
#[test]
fn sim_run_with_the_controller_holds_an_altitude() {
    let mut e = Engine::start();
    let free = serde_json::json!({"ground": null, "obstacles": []});
    let a = 0.15;
    let motor = |id: &str, x: f64, y: f64, spin: &str| serde_json::json!({ "partId": id, "position": [x, y, 0.0], "thrustAxis": [0, 0, 1], "spin": spin });
    let v = serde_json::json!({
        "version": 1,
        "parts": [{ "partId": "body", "massKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0],
            "pose": { "position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] }, "shape": { "type": "box", "halfExtents": [0.05, 0.05, 0.02] } }],
        "motors": [motor("m1", a, -a, "ccw"), motor("m2", -a, a, "ccw"), motor("m3", a, a, "cw"), motor("m4", -a, -a, "cw")],
        "totalMassKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0], "missingMass": []
    });
    let m = |id: &str| serde_json::json!({ "partId": id, "kvRadPerSV": 100.0, "resistanceOhm": 0.1, "noLoadCurrentA": 0.5,
        "thrustCoefNs2": 2e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 2e-5, "referenceDensityKgM3": 1.225 });
    let p = serde_json::json!({ "version": 1, "motors": [m("m1"), m("m2"), m("m3"), m("m4")],
        "battery": { "openCircuitVoltageV": 10.0, "internalResistanceOhm": 0.01, "capacityC": 18720.0 } });
    let r = e.call(serde_json::json!({"type": "vehicle.load", "vehicle": v, "propulsion": p}));
    assert_eq!(r["result"]["valid"], true, "{r}");

    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 10.0, "environment": free, "controller": {"altitudeM": 0.5}, "airDensityKgM3": 1.225}));
    assert_eq!(r["ok"], true, "{r}");
    let z = r["result"]["state"]["comM"][2].as_f64().unwrap();
    assert!((z - 0.5).abs() < 0.01, "z = {z}");
    let c = &r["result"]["controller"];
    assert_eq!(c["saturatedSteps"].as_u64().is_some(), true, "{c}");
    assert!(c["collectiveThrust"].as_f64().unwrap() > 0.0);
    assert_eq!(r["result"]["motors"].as_array().unwrap().len(), 4);

    for (bad, why) in [
        (serde_json::json!({"altitudeM": 0.5, "attitude": [0.0, 0.0, 0.0, 2.0]}), "unit quaternion"),
        (serde_json::json!({"altitudeM": 0.5, "gains": {"MC_NOPE": 1.0}}), "unknown PX4 parameter"),
    ] {
        let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "controller": bad, "airDensityKgM3": 1.225}));
        assert!(r["error"]["message"].as_str().unwrap().contains(why), "{r}");
    }
    let r = e.call(serde_json::json!({"type": "sim.run", "durationS": 0.1, "environment": free, "controller": {}, "throttle": [0.5, 0.5, 0.5, 0.5], "airDensityKgM3": 1.225}));
    assert_eq!(r["error"]["code"], "INVALID_PARAMS", "{r}");
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
