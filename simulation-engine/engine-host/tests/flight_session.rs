//! Live flight session (4.8 part B) against the real sidecar: the 4.7 test quad
//! (the test motor of engine-core, not a catalogue part), 1 kg on 0.15 m arms.
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_drone-engine"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
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
const REST_Z: f64 = 0.02; // The body's half height: resting on the ground.

fn load() -> Value {
    let motor = |id: &str, x: f64, y: f64, spin: &str| json!({ "partId": id, "position": [x, y, 0.0], "thrustAxis": [0, 0, 1], "spin": spin });
    let vehicle = json!({
        "version": 1,
        "parts": [{ "partId": "body", "massKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0],
            "pose": { "position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0] }, "shape": { "type": "box", "halfExtents": [0.05, 0.05, 0.02] } }],
        "motors": [motor("m1", A, -A, "ccw"), motor("m2", -A, A, "ccw"), motor("m3", A, A, "cw"), motor("m4", -A, -A, "cw")],
        "totalMassKg": 1.0, "com": [0.0, 0.0, 0.0], "inertia": [0.01, 0.01, 0.02, 0.0, 0.0, 0.0], "missingMass": []
    });
    let m = |id: &str| json!({ "partId": id, "kvRadPerSV": 100.0, "resistanceOhm": 0.1, "noLoadCurrentA": 0.5, "thrustCoefNs2": 2e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 2e-5 });
    json!({
        "type": "vehicle.load",
        "vehicle": vehicle,
        "propulsion": { "version": 1, "motors": [m("m1"), m("m2"), m("m3"), m("m4")], "battery": { "openCircuitVoltageV": 10.0, "internalResistanceOhm": 0.01, "capacityC": 18720.0 } },
        "aero": { "cdBody": [1.0, 1.0, 1.0], "areaM2": [0.01, 0.01, 0.01] },
    })
}
fn ground() -> Value {
    json!({"ground": {"friction": 0.5, "restitution": 0.0}, "obstacles": []})
}
fn start() -> Value {
    json!({
        "type": "flight.session.start",
        "environment": ground(),
        "startPositionM": [0.0, 0.0, REST_Z],
        "airDensityKgM3": 1.225,
        "referenceDensityKgM3": 1.225,
        "cutoff": {"type": "chargeMah", "value": 1000.0},
    })
}
fn climb(rate: f64) -> Value {
    json!({"climbRateMps": rate})
}
fn step(steps: u64, setpoint: Value) -> Value {
    json!({"type": "flight.session.step", "steps": steps, "setpoint": setpoint})
}
/// The same flight as one `sim.run` in controller mode, from the ground.
fn sim_run(duration_s: f64, rate: f64) -> Value {
    json!({
        "type": "sim.run", "durationS": duration_s, "environment": ground(), "startPositionM": [0.0, 0.0, REST_Z],
        "airDensityKgM3": 1.225, "controller": climb(rate),
    })
}

#[test]
fn start_step_end() {
    let mut e = Engine::loaded();
    let started = e.ok(start());
    assert_eq!(started["dtS"], 0.001);
    assert_eq!(started["maxStepsPerRequest"], 100);
    let d = &started["diagnostic"];
    assert_eq!(d["state"]["steps"], 0);
    assert_eq!(d["control"], Value::Null, "the controller has not run yet");
    assert_eq!(d["airDensityKgM3"], 1.225);
    assert_eq!(d["motors"].as_array().unwrap().len(), 4);
    assert_eq!(d["battery"]["voltageV"], 10.0);

    let r = e.ok(step(10, climb(0.0)));
    assert_eq!(r["stepsRun"], 10);
    assert_eq!(r["endReason"], Value::Null);
    assert_eq!(r["diagnostic"]["state"]["steps"], 10); // The LAST diagnostic only.
    assert_eq!(r["diagnostic"]["state"]["timeS"].as_f64().unwrap(), 0.01);
    assert_eq!(r["stateHash"].as_str().unwrap().len(), 16);
    assert_eq!(r["contactsDropped"], 0);
    // Resting on the ground: the body touches from time 0.
    assert!(r["contacts"].as_array().unwrap().iter().any(|c| c["partId"] == "body" && c["with"] == "ground" && c["startS"] == 0.0), "{r}");
    assert_eq!(e.ok(step(5, climb(0.0)))["diagnostic"]["state"]["steps"], 15);
    assert_eq!(e.ok(json!({"type": "flight.session.end"}))["ended"], true);
    e.refused(step(1, climb(0.0)), "NO_SESSION", "flight.session.start");
    assert_eq!(e.ok(json!({"type": "flight.session.end"}))["ended"], false);
}

#[test]
fn a_new_start_replaces_the_session() {
    let mut e = Engine::loaded();
    e.ok(start());
    e.ok(step(20, climb(0.0)));
    e.ok(start());
    assert_eq!(e.ok(step(3, climb(0.0)))["diagnostic"]["state"]["steps"], 3);
}

/// Every value the debug panel shows, in camelCase, from the mainline's own quantities.
#[test]
fn the_diagnostic_has_every_debug_panel_value_and_its_torques_add_up() {
    let mut e = Engine::loaded();
    e.ok(start());
    let setpoint = json!({"climbRateMps": 2.0, "yawRateRadps": 0.5});
    e.ok(step(100, setpoint.clone()));
    let r = e.ok(step(100, setpoint));
    let d = &r["diagnostic"];
    for key in ["state", "motors", "battery", "loads", "airDensityKgM3", "control"] {
        assert!(d.get(key).is_some(), "{key} in {d}");
    }
    for key in ["steps", "timeS", "positionM", "quaternion", "comM", "linearVelocityMps", "angularVelocityRadps", "angularVelocityBodyRadps"] {
        assert!(d["state"].get(key).is_some(), "state.{key}");
    }
    let motors = d["motors"].as_array().unwrap();
    assert_eq!(motors.len(), 4);
    for m in motors {
        for key in ["partId", "throttle", "rpm", "thrustN", "dragTorqueNm"] {
            assert!(m.get(key).is_some(), "motor.{key}");
        }
        assert!(m["rpm"].as_f64().unwrap() > 0.0, "the motors spin: {m}");
    }
    for key in ["voltageV", "currentA", "chargeUsedC", "stateOfCharge"] {
        assert!(d["battery"].get(key).is_some(), "battery.{key}");
    }
    assert!(d["battery"]["chargeUsedC"].as_f64().unwrap() > 0.0);
    assert!(d["battery"]["voltageV"].as_f64().unwrap() < 10.0, "the pack sags under load");
    let c = &d["control"];
    for key in ["torqueDemand", "rateIntegral", "collectiveThrust", "saturation"] {
        assert!(c.get(key).is_some(), "control.{key}");
    }
    assert_eq!(c["saturation"]["positive"].as_array().unwrap().len(), 4);
    assert_eq!(c["saturation"]["negative"].as_array().unwrap().len(), 4);
    let l = &d["loads"];
    let v = |key: &str| -> Vec<f64> { l[key].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect() };
    let thrust: f64 = motors.iter().map(|m| m["thrustN"].as_f64().unwrap()).sum();
    assert!((v("thrustBodyN")[2] - thrust).abs() < 0.02 * thrust, "thrust {:?} vs Σ per motor {thrust}", v("thrustBodyN"));
    assert!(thrust > 1.0, "the quad climbs on ≈ its weight and more: {thrust} N");
    for k in 0..3 {
        let sum = v("armTorqueNm")[k] + v("dragReactionTorqueNm")[k] + v("spinUpReactionTorqueNm")[k] + v("rotorGyroTorqueNm")[k];
        assert!((v("totalTorqueNm")[k] - sum).abs() < 1e-9, "axis {k}: total {:?} vs sources {sum}", v("totalTorqueNm"));
    }
    assert!(v("dragBodyN").iter().all(|x| x.is_finite()));
}

#[test]
fn refusals_keep_the_sidecar_alive() {
    let mut e = Engine::start();
    e.refused(step(1, climb(0.0)), "NO_SESSION", "flight.session.start");
    e.refused(start(), "NO_VEHICLE", "vehicle.load");
    // A vehicle without propulsion cannot fly.
    let mut bare = load();
    bare.as_object_mut().unwrap().remove("propulsion");
    bare.as_object_mut().unwrap().remove("aero");
    assert_eq!(e.call(bare)["result"]["valid"], true);
    e.refused(start(), "INVALID_PARAMS", "propulsion");
    assert_eq!(e.call(load())["result"]["valid"], true);

    let mut no_cutoff = start();
    no_cutoff.as_object_mut().unwrap().remove("cutoff");
    e.refused(no_cutoff.clone(), "CUTOFF_REQUIRED", "cutoff");
    no_cutoff["cutoff"] = Value::Null;
    e.refused(no_cutoff, "CUTOFF_REQUIRED", "cutoff");
    for cutoff in [
        json!({"type": "voltageV", "value": 0.0}),
        json!({"type": "chargeMah", "value": -5.0}),
        json!({"type": "capacity", "value": 5.0}),
        json!({"type": "voltageV"}),
        json!({"type": "voltageV", "value": 9.0, "extra": 1}),
    ] {
        let mut r = start();
        r["cutoff"] = cutoff;
        e.refused(r, "INVALID_PARAMS", "");
    }
    let mut r = start();
    r.as_object_mut().unwrap().remove("referenceDensityKgM3");
    e.refused(r.clone(), "INVALID_PARAMS", "referenceDensityKgM3");
    r["referenceDensityKgM3"] = json!(-1.0);
    e.refused(r, "INVALID_PARAMS", "referenceDensityKgM3");
    let mut r = start();
    r.as_object_mut().unwrap().remove("airDensityKgM3");
    e.refused(r.clone(), "INVALID_PARAMS", "airDensityKgM3");
    r["airDensityKgM3"] = json!(0.0);
    e.refused(r, "INVALID_PARAMS", "airDensityKgM3");
    let mut r = start();
    r["environment"] = json!({"ground": {"friction": 0.5}, "obstacles": []});
    e.refused(r, "ENVIRONMENT_INCOMPLETE", "restitution");
    let mut r = start();
    r.as_object_mut().unwrap().remove("environment");
    e.refused(r, "ENVIRONMENT_INCOMPLETE", "environment");
    let mut r = start();
    r["startPositionM"] = json!([0.0, 0.0, 0.0]);
    e.refused(r, "INVALID_PARAMS", "inside");
    let mut r = start();
    r["gains"] = json!({"MC_NOPE": 1.0});
    e.refused(r, "INVALID_PARAMS", "unknown PX4 parameter");
    let mut r = start();
    r["durationS"] = json!(1.0); // A session has no duration.
    e.refused(r, "INVALID_PARAMS", "durationS");
    let mut r = start();
    r["gains"] = json!({"MC_ROLL_P": 7.0});
    e.ok(r); // Valid overrides are accepted.

    // A refused start leaves no session behind, even when one was running.
    e.ok(start());
    let mut r = start();
    r["startPositionM"] = json!([0.0, 0.0, 0.0]);
    e.refused(r, "INVALID_PARAMS", "inside");
    e.refused(step(1, climb(0.0)), "NO_SESSION", "flight.session.start");

    e.ok(start());
    for steps in [0, 101, 1_000_000] {
        e.refused(step(steps, climb(0.0)), "INVALID_PARAMS", "steps");
    }
    for (bad, why) in [
        (json!({"attitude": [0.0, 0.0, 0.0, 2.0]}), "unit quaternion"),
        (json!({"yawRateRadps": "x"}), ""),
        (json!({"altitudeM": 0.5, "extra": 1}), ""),
        (json!({"gains": {"MC_ROLL_P": 7.0}}), "gains"),
        (json!("level"), ""),
    ] {
        e.refused(step(1, bad), "INVALID_PARAMS", why);
    }
    let mut fractional = step(1, climb(0.0));
    fractional["steps"] = json!(1.5);
    e.refused(fractional, "INVALID_PARAMS", "");
    // None of the refused steps advanced the session.
    assert_eq!(e.ok(step(1, climb(0.0)))["diagnostic"]["state"]["steps"], 1);
}

#[test]
fn a_cutoff_ends_the_run_and_freezes_it() {
    let mut e = Engine::loaded();
    let mut request = start();
    request["cutoff"] = json!({"type": "chargeMah", "value": 0.001});
    e.ok(request);
    let r = e.ok(step(100, climb(2.0)));
    assert_eq!(r["endReason"], "chargeCutoff");
    let ran = r["stepsRun"].as_u64().unwrap();
    assert!(ran >= 1 && ran < 100, "{r}");
    assert_eq!(r["diagnostic"]["state"]["steps"].as_u64().unwrap(), ran);
    // An ended run stays frozen, whatever the setpoint.
    let again = e.ok(step(100, climb(2.0)));
    assert_eq!(again["stepsRun"], 0);
    assert_eq!(again["endReason"], "chargeCutoff");
    assert_eq!(again["stateHash"], r["stateHash"]);

    // A voltage cut-off: the 10 V pack sags below 9.9 V as the rotors start.
    let mut request = start();
    request["cutoff"] = json!({"type": "voltageV", "value": 9.9});
    e.ok(request);
    assert_eq!(e.ok(step(100, climb(2.0)))["endReason"], "voltageCutoff");
}

/// Merges per-request contact lists the way the renderer does: by part, object and start time.
fn merge(into: &mut BTreeMap<String, Value>, contacts: &Value) {
    for c in contacts.as_array().unwrap() {
        into.insert(format!("{}|{}|{}", c["partId"], c["with"], c["startS"]), c.clone());
    }
}

/// Runs a session in chunks of `k` steps (then the remainder) for `total` steps.
fn chunked(k: u64, total: u64, rate: f64) -> (Value, Vec<Value>, Vec<Value>) {
    let mut e = Engine::loaded();
    e.ok(start());
    let (mut merged, mut per_request, mut last) = (BTreeMap::new(), Vec::new(), Value::Null);
    let mut done = 0;
    while done < total {
        let n = k.min(total - done);
        let r = e.ok(step(n, climb(rate)));
        assert_eq!(r["stepsRun"], n);
        merge(&mut merged, &r["contacts"]);
        per_request.push(r["contacts"].clone());
        last = r;
        done += n;
    }
    (last, merged.into_values().collect(), per_request)
}

#[test]
fn chunked_stepping_matches_one_sim_run_in_controller_mode() {
    // A lift-off from the ground at 2 m/s: contact starts at 0 and ends once airborne.
    const TOTAL: u64 = 700;
    let mut reference_engine = Engine::loaded();
    let reference = reference_engine.ok(sim_run(TOTAL as f64 / 1000.0, 2.0));
    let expected = reference["stateHash"].as_str().unwrap();
    let reference_contacts = reference["contacts"].as_array().unwrap();
    assert!(reference_contacts.iter().any(|c| c["endS"].is_number()), "the quad lifts off: {reference_contacts:?}");

    for k in [1, 7, 33, 100] {
        let (last, contacts, _) = chunked(k, TOTAL, 2.0);
        assert_eq!(last["stateHash"], expected, "chunks of {k}");
        assert_eq!(&contacts, reference_contacts, "contacts, chunks of {k}");
        assert_eq!(last["diagnostic"]["state"]["positionM"], reference["state"]["positionM"], "chunks of {k}");
    }
}

#[test]
fn contacts_start_and_end_appear_in_the_request_that_has_them() {
    let (_, contacts, per_request) = chunked(50, 700, 2.0);
    let first_end = contacts.iter().filter_map(|c| c["endS"].as_f64()).fold(f64::INFINITY, f64::min);
    assert!(first_end.is_finite(), "the quad lifts off: {contacts:?}");
    assert!(per_request[0].as_array().unwrap().iter().any(|c| c["startS"] == 0.0 && c["with"] == "ground"));
    let ended_in = per_request.iter().position(|list| list.as_array().unwrap().iter().any(|c| c["endS"].as_f64() == Some(first_end))).unwrap();
    assert!(first_end >= ended_in as f64 * 0.05 && first_end < (ended_in as f64 + 1.0) * 0.05, "ended at {first_end} s in request {ended_in}");
    // A request with no contact event in its window returns none.
    assert!(per_request.iter().any(|list| list.as_array().unwrap().is_empty()));
}

/// The vehicle starts resting on the ground, the controller holds a vertical speed of 0: it takes off
/// at 2 m/s and, released, climbs no further (what the flight test page does with W and release).
#[test]
fn climb_then_release_holds_a_vertical_speed_of_zero() {
    let mut e = Engine::loaded();
    e.ok(start());
    let mut z = 0.0;
    for _ in 0..10 {
        z = e.ok(step(100, climb(2.0)))["diagnostic"]["state"]["comM"][2].as_f64().unwrap();
    }
    assert!(z > 0.5, "after 1 s of W the quad is up: {z} m");
    let mut vz = 9.0;
    for _ in 0..40 {
        vz = e.ok(step(100, climb(0.0)))["diagnostic"]["state"]["linearVelocityMps"][2].as_f64().unwrap();
    }
    assert!(vz.abs() < 0.1, "released after 4 s: {vz} m/s");
}

/// Thrust and torque scale as rho / rho_ref, so the same build must spin faster in thin air. In a hover the
/// thrust per motor is W / 4 whatever the air, so k_T' w^2 = W / 4 gives w ∝ sqrt(rho_ref / rho): flown at
/// 3000 m (ISA, 0.9093 kg/m³, USSA 1976 Table I) against sea level the speed rises by sqrt(1.225 / 0.9093)
/// = 1.1607 and the throttle rises with it, the pack draws more current, and the same density as the data's
/// changes nothing.
#[test]
fn the_same_build_hovers_faster_in_thin_air_as_rho_over_rho_ref_predicts() {
    let hover = |rho: f64| -> (f64, f64, f64) {
        let mut e = Engine::loaded();
        let mut request = start();
        request["airDensityKgM3"] = json!(rho);
        e.ok(request);
        let mut last = Value::Null;
        for _ in 0..150 {
            last = e.ok(step(100, json!({"altitudeM": 1.0})));
        }
        let d = &last["diagnostic"];
        let motors = d["motors"].as_array().unwrap();
        let mean = |key: &str| motors.iter().map(|m| m[key].as_f64().unwrap()).sum::<f64>() / 4.0;
        let z = d["state"]["comM"][2].as_f64().unwrap();
        assert!((z - 1.0).abs() < 0.02, "holds 1 m at {rho} kg/m³: {z}");
        (mean("rpm"), mean("throttle"), d["battery"]["currentA"].as_f64().unwrap())
    };
    let (rpm0, throttle0, amps0) = hover(1.225);
    let (rpm3, throttle3, amps3) = hover(0.9093);
    let predicted = (1.225f64 / 0.9093).sqrt();
    assert!((rpm3 / rpm0 - predicted).abs() < 0.005 * predicted, "speed ratio {} vs predicted {predicted}", rpm3 / rpm0);
    assert!(throttle3 > throttle0, "hover throttle rises: {throttle0} -> {throttle3}");
    assert!(amps3 > amps0, "and so does the current: {amps0} -> {amps3}");
    // Thrust per motor is the same weight share in both.
    let mut e = Engine::loaded();
    e.ok(start());
    let thrust = (0..150).map(|_| e.ok(step(100, json!({"altitudeM": 1.0})))).last().unwrap()["diagnostic"]["motors"][0]["thrustN"].as_f64().unwrap();
    assert!((thrust - 9.80665 / 4.0).abs() < 0.01 * thrust, "{thrust} N per motor");
}
