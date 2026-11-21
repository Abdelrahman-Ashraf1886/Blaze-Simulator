//! Request dispatch and the sidecar's state (the loaded vehicle).

use crate::protocol::{Command, ErrorCode, HelloResult, PongResult, Request, Response, PROTOCOL_VERSION};
use engine_core::propulsion::Propulsion;
use engine_core::sim::{hash_hex, BodyInput, SimConfig, SimState, Simulation, DEFAULT_DT_S};
use engine_core::vehicle::{vec, MassTotals, Vehicle, VehicleError};
use serde::Serialize;
use std::time::Instant;

/// Upper bound on the steps of one `sim.run`. The sidecar is single-threaded,
/// so a run delays the health ping, and the supervisor kills an engine that
/// does not answer a ping within its request timeout (3 s). 120 000 steps
/// (120 s at 1 ms) took 0.88 s in a release build on the development machine
/// (≈7 µs per step; sidecar test `sim_run_at_the_step_limit`, DEVLOG 4.3).
pub const MAX_STEPS: u64 = 120_000;

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum VehicleLoadResult<'a> {
    #[serde(rename_all = "camelCase")]
    Valid {
        valid: bool,
        part_count: usize,
        motor_count: usize,
        totals: MassTotals,
        missing_mass: &'a [String],
        /// Present when the request carried a (valid) propulsion definition.
        #[serde(skip_serializing_if = "Option::is_none")]
        propulsion: Option<PropulsionSummary>,
    },
    Invalid {
        valid: bool,
        errors: Vec<VehicleError>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropulsionSummary {
    motor_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimRunResult {
    steps: u64,
    dt_s: f64,
    duration_s: f64,
    gravity_mps2: f64,
    state: SimState,
    /// 16 hex digits, see `Simulation::state_hash`.
    state_hash: String,
}

pub struct Engine {
    started: Instant,
    vehicle: Option<Vehicle>,
    /// Coefficients of the loaded vehicle's motors and battery (4.5); the
    /// flight step uses them from 4.6.
    #[allow(dead_code)]
    propulsion: Option<Propulsion>,
}

impl Engine {
    pub fn new() -> Self {
        Engine { started: Instant::now(), vehicle: None, propulsion: None }
    }

    /// Handles one request; the flag is true when the engine should exit.
    pub fn handle(&mut self, req: Request) -> (Response, bool) {
        let id = req.id;
        match req.command {
            Command::Hello => (
                Response::ok(
                    id,
                    HelloResult {
                        engine_version: engine_core::ENGINE_VERSION.to_string(),
                        protocol_version: PROTOCOL_VERSION,
                        threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
                    },
                ),
                false,
            ),
            Command::Ping => (
                Response::ok(id, PongResult { engine_uptime_us: self.started.elapsed().as_micros() as u64 }),
                false,
            ),
            Command::Shutdown => (Response::ok(id, serde_json::json!({})), true),
            Command::VehicleLoad { vehicle, propulsion } => (self.load(id, vehicle, propulsion), false),
            Command::SimRun { duration_s, dt_s, force_body_n, torque_body_nm } => {
                (self.run(id, duration_s, dt_s, force_body_n, torque_body_nm), false)
            }
        }
    }

    fn load(&mut self, id: u64, value: serde_json::Value, propulsion: Option<serde_json::Value>) -> Response {
        self.propulsion = None;
        let loaded = Vehicle::from_json(value).and_then(|v| match propulsion {
            None => Ok((v, None)),
            Some(p) => Propulsion::from_json(p, &v.definition).map(|p| (v, Some(p))),
        });
        match loaded {
            Ok((v, propulsion)) => {
                let response = Response::ok(
                    id,
                    VehicleLoadResult::Valid {
                        valid: true,
                        part_count: v.definition.parts.len(),
                        motor_count: v.definition.motors.len(),
                        totals: v.totals,
                        missing_mass: &v.definition.missing_mass,
                        propulsion: propulsion.as_ref().map(|p| PropulsionSummary { motor_count: p.motors.len() }),
                    },
                );
                self.vehicle = Some(v);
                self.propulsion = propulsion;
                response
            }
            Err(errors) => {
                self.vehicle = None;
                Response::ok(id, VehicleLoadResult::Invalid { valid: false, errors })
            }
        }
    }

    fn run(
        &self,
        id: u64,
        duration_s: f64,
        dt_s: Option<f64>,
        force: Option<[f64; 3]>,
        torque: Option<[f64; 3]>,
    ) -> Response {
        let bad = |m: String| Response::err(Some(id), ErrorCode::InvalidParams, m);
        let Some(vehicle) = &self.vehicle else {
            return Response::err(Some(id), ErrorCode::NoVehicle, "load a valid vehicle first (vehicle.load)");
        };
        let missing = &vehicle.definition.missing_mass;
        if !missing.is_empty() {
            return Response::err(
                Some(id),
                ErrorCode::VehicleIncomplete,
                format!("{} part(s) have no mass: {}", missing.len(), missing.join(", ")),
            );
        }
        let dt = dt_s.unwrap_or(DEFAULT_DT_S);
        if !(dt.is_finite() && dt > 0.0) {
            return bad(format!("dtS must be a positive number (got {dt})"));
        }
        if !(duration_s.is_finite() && duration_s > 0.0) {
            return bad(format!("durationS must be a positive number (got {duration_s})"));
        }
        let n = (duration_s / dt).round();
        if n < 1.0 || (n * dt - duration_s).abs() > 1e-9 * duration_s {
            return bad(format!("durationS ({duration_s}) must be a whole number of steps of {dt} s"));
        }
        if n > MAX_STEPS as f64 {
            return bad(format!("{n} steps exceed the limit of {MAX_STEPS} per run"));
        }
        let (f, t) = (force.unwrap_or([0.0; 3]), torque.unwrap_or([0.0; 3]));
        if !f.iter().chain(t.iter()).all(|x| x.is_finite()) {
            return bad("forceBodyN and torqueBodyNm must be finite".into());
        }
        let config = SimConfig { dt_s: dt, ..SimConfig::default() };
        let mut sim = match Simulation::new(vehicle, config) {
            Ok(s) => s,
            Err(e) => return bad(e),
        };
        let input = BodyInput { force_body_n: vec(f), torque_body_nm: vec(t) };
        let steps = n as u64;
        for _ in 0..steps {
            sim.step(&input);
        }
        Response::ok(
            id,
            SimRunResult {
                steps,
                dt_s: dt,
                duration_s: steps as f64 * dt,
                gravity_mps2: config.gravity_mps2,
                state: sim.state(),
                state_hash: hash_hex(sim.state_hash()),
            },
        )
    }
}
