//! `scenario.run` (4.9 part B) against the real sidecar: the 4.7 test quad (the test motor of
//! engine-core, not a catalogue part), 1 kg on 0.15 m arms: the vehicle of engine-core's own scenario
//! tests (`scenario/tests.rs`), so each built-in gives here the verdict it gives there.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Engine {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
impl Engine {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_drone-engine")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        Self { input: child.stdin.take().unwrap(), output: BufReader::new(child.stdout.take().unwrap()), child, next: 1 }
    }
    fn call(&mut self, mut request: Value) -> Value {
        request["id"] = json!(self.next);
        self.next += 1;
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn ok(&mut self, request: Value) -> Value {
        let r = self.call(request);
        assert_eq!(r["ok"], true, "{r}");
        r["result"].clone()
    }
    fn loaded() -> Self {
        let mut e = Engine::start();
        let r = e.call(load());
        assert_eq!(r["result"]["valid"], true, "{r}");
        e
    }
    fn refused(&mut self, request: Value, code: &str, mentions: &str) {
        let r = self.call(request.clone());
        assert_eq!(r["error"]["code"], code, "{request} -> {r}");
        let message = r["error"]["message"].as_str().unwrap();
        assert!(message.contains(mentions), "{message:?} should mention {mentions:?}");
        assert_eq!(self.call(json!({"type": "ping"}))["ok"], true, "the sidecar survives");
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

const A: f64 = 0.15;

fn load() -> Value {
    let motor = |id: &str, x: f64, y: f64, spin: &str| json!({ "partId": id, "position": [x, y, 0.0], "thrustAxis": [0, 0, 1], "spin": spin });
    let vehicle = json!({
        "version": 1,
        "parts": [{ "partId": "body", "massKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0],
            "pose": { "position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] }, "shape": { "type": "box", "halfExtents": [0.05, 0.05, 0.02] } }],
        "motors": [motor("m1", A, -A, "ccw"), motor("m2", -A, A, "ccw"), motor("m3", A, A, "cw"), motor("m4", -A, -A, "cw")],
        "totalMassKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0], "missingMass": []
    });
    let m = |id: &str| json!({ "partId": id, "kvRadPerSV": 100.0, "resistanceOhm": 0.1, "noLoadCurrentA": 0.5, "thrustCoefNs2": 2e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 2e-5, "referenceDensityKgM3": 1.225 });
    json!({
        "type": "vehicle.load",
        "vehicle": vehicle,
        "propulsion": { "version": 1, "motors": [m("m1"), m("m2"), m("m3"), m("m4")], "battery": { "openCircuitVoltageV": 10.0, "internalResistanceOhm": 0.01, "capacityC": 18720.0 } },
        "aero": { "cdBody": [1.0, 1.0, 1.0], "areaM2": [0.01, 0.01, 0.01] },
    })
}

fn config() -> Value {
    json!({ "airDensityKgM3": 1.225, "cutoff": { "type": "chargeMah", "value": 1000.0 } })
}
fn builtin(name: &str, extra: Value) -> Value {
    let mut scenario = json!({ "type": "builtin", "name": name });
    for (k, v) in extra.as_object().unwrap() {
        scenario[k] = v.clone();
    }
    run(scenario)
}
fn run(scenario: Value) -> Value {
    json!({ "type": "scenario.run", "scenario": scenario, "config": config() })
}
/// A hold-level custom scenario, no checks.
fn custom(duration_s: f64) -> Value {
    json!({
        "type": "custom",
        "scenario": {
            "name": "custom", "durationS": duration_s, "modifications": [],
            "script": [{ "fromS": 0.0, "attitude": { "type": "euler", "roll": 0.0, "pitch": 0.0, "yaw": 0.0 }, "yawRateRadps": 0.0, "zM": null, "zVelocityMps": 0.0 }],
            "checks": []
        }
    })
}

fn check<'a>(result: &'a Value, kind: &str) -> &'a Value {
    result["report"]["checks"].as_array().unwrap().iter().find(|c| c["check"]["type"] == kind).unwrap_or_else(|| panic!("no {kind} check in {result}"))
}

/// Every built-in through the host gives the verdict it gives in engine-core's own test
/// (`builtins_match_their_predictions`): all five pass, on the run's duration.
#[test]
fn every_builtin_gives_its_engine_core_verdict() {
    let mut e = Engine::loaded();
    let cases = [
        ("balanced_hover", json!({}), 20.0),
        ("payload", json!({ "massKg": 0.5 }), 20.0),
        ("com_offset", json!({ "offsetM": 0.02 }), 20.0),
        ("overweight_payload", json!({}), 20.0),
        ("com_offset_beyond_authority", json!({}), 5.0),
    ];
    let mut results = Vec::new();
    for (name, params, elapsed) in cases {
        let r = e.ok(builtin(name, params));
        let report = &r["report"];
        assert_eq!(report["name"], name);
        assert_eq!(report["passed"], true, "{name}: {}", report["checks"]);
        assert_eq!(report["endReason"], "duration", "{name}");
        assert_eq!(report["elapsedS"], elapsed, "{name}");
        assert_eq!(r["scenario"]["name"], name, "the resolved scenario comes back");
        assert_eq!(r["stateHash"], report["finalStateHash"]);
        assert_eq!(r["stateHash"].as_str().unwrap().len(), 16);
        for c in report["checks"].as_array().unwrap() {
            assert_eq!(c["passed"], true, "{name}: {c}");
            assert!(c["measured"].is_number() && c["limits"].as_array().unwrap().len() == 2 && c["samples"].as_u64().unwrap() > 0, "{name}: {c}");
        }
        results.push(r);
    }
    // The independent hand numbers of engine-core's test: Σ x_i T_i / A = 2 W d / (2A) = 1.3076 N (budget 0.02 N).
    let balance = check(&results[2], "thrustBalance");
    assert!((balance["measured"].as_f64().unwrap() - 1.3076).abs() < 0.02, "{balance}");
    // Heavier payload, higher throttle than the bare vehicle.
    let mean = |r: &Value| r["report"]["meanThrottle"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).sum::<f64>() / 4.0;
    assert!(mean(&results[1]) > mean(&results[0]));
    // Beyond authority the motors saturate and the attitude is lost.
    assert!(results[4]["report"]["saturatedFraction"].as_f64().unwrap() > 0.0);
    assert_eq!(check(&results[4], "attitudeLost")["passed"], true);
    // The scenario's derived values come back: the payload's mass and the overweight one's derived mass.
    assert_eq!(results[1]["scenario"]["modifications"][0]["type"], "payload");
    assert_eq!(results[1]["scenario"]["modifications"][0]["massKg"], 0.5);
    assert!(results[3]["scenario"]["modifications"][0]["massKg"].as_f64().unwrap() > 1.0);
}

/// The same request twice gives the same report to the bit, in one engine and in another.
#[test]
fn the_same_request_twice_gives_the_same_hash() {
    let request = || builtin("com_offset", json!({ "offsetM": 0.02 }));
    let mut e = Engine::loaded();
    let first = e.ok(request());
    let second = e.ok(request());
    assert_eq!(first["stateHash"], second["stateHash"]);
    assert_eq!(first, second);
    let third = Engine::loaded().ok(request());
    assert_eq!(first, third);
    // A different scenario ends in another state.
    assert_ne!(e.ok(builtin("balanced_hover", json!({})))["stateHash"], first["stateHash"]);
    // A scenario run leaves the loaded vehicle as it was: a second kind of run still works.
    e.ok(json!({ "type": "sim.run", "durationS": 0.1, "environment": {"ground": null, "obstacles": []}, "airDensityKgM3": 1.225, "throttle": [0.5, 0.5, 0.5, 0.5] }));
}

/// A battery cut-off ends the run before its duration; the report says so and does not pass.
#[test]
fn a_cutoff_ends_the_scenario_early() {
    let mut e = Engine::loaded();
    let mut request = builtin("balanced_hover", json!({}));
    request["config"]["cutoff"] = json!({ "type": "chargeMah", "value": 0.5 });
    let r = e.ok(request);
    assert_eq!(r["report"]["endReason"], "chargeCutoff");
    assert_eq!(r["report"]["passed"], false);
    assert!(r["report"]["elapsedS"].as_f64().unwrap() < 20.0);
    // The window of every check was never reached (or the check failed): nothing measured is reported as null.
    assert!(r["report"]["checks"].as_array().unwrap().iter().any(|c| c["measured"].is_null() && c["passed"] == false), "{r}");
}

/// Gain overrides are the engine's own; a ground and start position run a custom scenario.
#[test]
fn gains_and_a_ground_are_accepted() {
    let mut e = Engine::loaded();
    let mut request = builtin("balanced_hover", json!({}));
    request["config"]["gains"] = json!({ "MC_ROLL_P": 7.0 });
    let r = e.ok(request);
    assert_eq!(r["report"]["name"], "balanced_hover");
    let mut ground = run(custom(0.5));
    ground["config"]["environment"] = json!({"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []});
    ground["config"]["startPositionM"] = json!([0.0, 0.0, 0.02]);
    let r = e.ok(ground);
    assert_eq!(r["report"]["elapsedS"], 0.5);
    // Free space is the default.
    assert_eq!(e.ok(run(custom(0.5)))["report"]["elapsedS"], 0.5);
}

#[test]
fn refusals_have_their_own_codes_and_keep_the_sidecar_alive() {
    let mut e = Engine::start();
    e.refused(builtin("balanced_hover", json!({})), "NO_VEHICLE", "vehicle.load");
    // A vehicle without propulsion cannot fly a scenario.
    let mut bare = load();
    bare.as_object_mut().unwrap().remove("propulsion");
    bare.as_object_mut().unwrap().remove("aero");
    assert_eq!(e.call(bare)["result"]["valid"], true);
    e.refused(builtin("balanced_hover", json!({})), "NO_PROPULSION", "propulsion");

    assert_eq!(e.call(load())["result"]["valid"], true);
    // The cut-off is the user's: absent, null and invalid are each refused.
    let mut r = builtin("balanced_hover", json!({}));
    r["config"].as_object_mut().unwrap().remove("cutoff");
    e.refused(r.clone(), "CUTOFF_REQUIRED", "cutoff");
    r["config"]["cutoff"] = Value::Null;
    e.refused(r.clone(), "CUTOFF_REQUIRED", "cutoff");
    for cutoff in [json!({"type": "voltageV", "value": 0.0}), json!({"type": "chargeMah", "value": -5.0}), json!({"type": "capacity", "value": 5.0}), json!({"type": "voltageV"})] {
        r["config"]["cutoff"] = cutoff;
        e.refused(r.clone(), "INVALID_PARAMS", "");
    }
    // The air density: required, positive.
    let mut r = builtin("balanced_hover", json!({}));
    r["config"].as_object_mut().unwrap().remove("airDensityKgM3");
    e.refused(r.clone(), "INVALID_PARAMS", "airDensityKgM3");
    r["config"]["airDensityKgM3"] = json!(0.0);
    e.refused(r, "INVALID_PARAMS", "airDensityKgM3");
    // No config at all, and unknown fields.
    e.refused(json!({"type": "scenario.run", "scenario": {"type": "builtin", "name": "balanced_hover"}}), "CUTOFF_REQUIRED", "cutoff");
    let mut r = builtin("balanced_hover", json!({}));
    r["durationS"] = json!(1.0);
    e.refused(r, "INVALID_PARAMS", "durationS");
    let mut r = builtin("balanced_hover", json!({}));
    r["config"]["gains"] = json!({"MC_NOPE": 1.0});
    e.refused(r, "INVALID_PARAMS", "unknown PX4 parameter");
    // A ground needs its start (no default), a start needs a ground, and a ground its friction and restitution.
    let mut r = run(custom(0.1));
    r["config"]["environment"] = json!({"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []});
    e.refused(r.clone(), "INVALID_PARAMS", "startPositionM");
    r["config"]["startPositionM"] = json!([0.0, 0.0, 0.02]);
    r["config"]["environment"] = json!({"ground": {"friction": 0.5}, "obstacles": []});
    e.refused(r, "ENVIRONMENT_INCOMPLETE", "restitution");
    let mut r = run(custom(0.1));
    r["config"]["startPositionM"] = json!([0.0, 0.0, 0.02]);
    e.refused(r, "INVALID_PARAMS", "environment");

    // A motor without its reference density: refused, naming the motor.
    let mut no_reference = load();
    for m in no_reference["propulsion"]["motors"].as_array_mut().unwrap() {
        m.as_object_mut().unwrap().remove("referenceDensityKgM3");
    }
    assert_eq!(e.call(no_reference)["result"]["valid"], true, "a definition without it still loads");
    e.refused(builtin("balanced_hover", json!({})), "REFERENCE_DENSITY_REQUIRED", "reference density");
    e.refused(run(custom(0.1)), "REFERENCE_DENSITY_REQUIRED", "m1");
    assert_eq!(e.call(load())["result"]["valid"], true);

    // Invalid scenarios, each with the engine's own message.
    e.refused(builtin("payload", json!({})), "INVALID_SCENARIO", "massKg");
    e.refused(builtin("payload", json!({"massKg": -1.0})), "INVALID_SCENARIO", "payload mass");
    e.refused(builtin("com_offset", json!({})), "INVALID_SCENARIO", "offsetM");
    e.refused(builtin("balanced_hover", json!({"massKg": 1.0})), "INVALID_SCENARIO", "massKg");
    e.refused(builtin("overweight_payload", json!({"massKg": 1.0})), "INVALID_SCENARIO", "massKg");
    e.refused(builtin("com_offset", json!({"massKg": 1.0, "offsetM": 0.02})), "INVALID_SCENARIO", "massKg");
    e.refused(builtin("com_offset", json!({"offsetM": 5.0})), "INVALID_SCENARIO", "negative rotor thrust");
    e.refused(builtin("not_a_scenario", json!({})), "INVALID_PARAMS", "not_a_scenario");
    let mut c = custom(0.0);
    e.refused(run(c.clone()), "INVALID_SCENARIO", "duration");
    c["scenario"]["durationS"] = json!(1.0);
    c["scenario"]["checks"] = json!([{ "type": "altitude", "afterS": 0.5, "toleranceM": 0.1 }]);
    e.refused(run(c.clone()), "INVALID_SCENARIO", "altitude");
    c["scenario"]["checks"] = json!([{ "type": "thrustBalance", "afterS": 0.5, "weights": [1.0], "expectedN": 0.0, "toleranceN": 1.0 }]);
    e.refused(run(c.clone()), "INVALID_SCENARIO", "invalid check");
    c["scenario"]["checks"] = json!([]);
    c["scenario"]["modifications"] = json!([{ "type": "shiftPart", "partId": "nope", "deltaM": [0.0, 0.0, 0.0] }]);
    e.refused(run(c.clone()), "INVALID_SCENARIO", "unknown part");
    c["scenario"]["modifications"] = json!([]);
    c["scenario"]["extra"] = json!(1);
    e.refused(run(c), "INVALID_SCENARIO", "extra");
    e.refused(run(json!({"type": "custom", "scenario": "hover"})), "INVALID_SCENARIO", "scenario");
    // The duration is bounded: 60 s free, 10 s on a ground.
    e.ok(run(custom(60.0)));
    e.refused(run(custom(60.001)), "INVALID_SCENARIO", "limit is 60");
    let mut r = run(custom(10.001));
    r["config"]["environment"] = json!({"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []});
    r["config"]["startPositionM"] = json!([0.0, 0.0, 0.02]);
    e.refused(r, "INVALID_SCENARIO", "limit is 10");

    // After all of it the engine still flies a scenario.
    assert_eq!(e.ok(builtin("balanced_hover", json!({})))["report"]["passed"], true);
}
