//! Request dispatch and the sidecar's state (the loaded vehicle).

use crate::protocol::{Command, ErrorCode, HelloResult, PongResult, Request, Response, PROTOCOL_VERSION};
use engine_core::environment::{ContactEvent, Environment};
use engine_core::sim::{hash_hex, BodyInput, SimConfig, SimState, Simulation, DEFAULT_DT_S};
use engine_core::vehicle::{vec, MassTotals, Vehicle, VehicleError};
use serde::Serialize;
use std::time::{Duration, Instant};

/// Upper bound on the steps of one `sim.run`. The sidecar is single-threaded,
/// so a run delays the health ping, and the supervisor kills an engine that
/// does not answer a ping within its request timeout (3 s). 120 000 steps
/// (120 s at 1 ms) took 0.88 s in a release build on the development machine
/// (≈7 µs per step; sidecar test `sim_run_at_the_step_limit`, DEVLOG 4.3).
pub const MAX_STEPS: u64 = 120_000;

/// Compute time one `sim.run` may take before it is stopped with `RUN_TOO_LONG`.
/// MAX_STEPS was sized for free flight (≈7 µs per step); with ground contact a step
/// costs far more (a 20-box vehicle resting on the ground: ≈0.2 ms per step, so
/// 120 000 steps take ≈25 s; DEVLOG 4.4 follow-ups). The supervisor kills an engine
/// that does not answer its health ping within 3 s, so a run stops itself well before
/// that. Stopping depends on the machine's speed, so a stopped run returns no state:
/// a completed run stays deterministic.
pub const RUN_TIME_BUDGET: Duration = Duration::from_secs(2);

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
    },
    Invalid {
        valid: bool,
        errors: Vec<VehicleError>,
    },
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
    /// Which part touched the ground or an obstacle, and when (s).
    contacts: Vec<ContactEvent>,
    /// Events beyond `MAX_CONTACT_EVENTS`, not listed.
    contacts_dropped: u64,
}


pub struct Engine {
    started: Instant,
    vehicle: Option<Vehicle>,
}

impl Engine {
    pub fn new() -> Self {
        Engine { started: Instant::now(), vehicle: None }
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
            Command::VehicleLoad { vehicle } => (self.load(id, vehicle), false),
            Command::SimRun { duration_s, environment, start_position_m, dt_s, force_body_n, torque_body_nm } => {
                (self.run(id, duration_s, environment, start_position_m, dt_s, force_body_n, torque_body_nm), false)
            }
        }
    }

    fn load(&mut self, id: u64, value: serde_json::Value) -> Response {
        match Vehicle::from_json(value) {
            Ok(v) => {
                let response = Response::ok(
                    id,
                    VehicleLoadResult::Valid {
                        valid: true,
                        part_count: v.definition.parts.len(),
                        motor_count: v.definition.motors.len(),
                        totals: v.totals,
                        missing_mass: &v.definition.missing_mass,
                    },
                );
                self.vehicle = Some(v);
                response
            }
            Err(errors) => {
                self.vehicle = None;
                Response::ok(id, VehicleLoadResult::Invalid { valid: false, errors })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        id: u64,
        duration_s: f64,
        environment: Option<serde_json::Value>,
        start_position_m: Option<[f64; 3]>,
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
        let Some(environment) = environment else {
            return Response::err(
                Some(id),
                ErrorCode::EnvironmentIncomplete,
                "environment is not set: give the ground's friction and restitution (or \"ground\": null for free space) and the obstacles",
            );
        };
        let environment = match Environment::from_json(&environment) {
            Ok(e) => e,
            Err(errors) => {
                let list: Vec<String> = errors.iter().map(|e| format!("{}: {}", e.path, e.message)).collect();
                return Response::err(Some(id), ErrorCode::EnvironmentIncomplete, list.join("; "));
            }
        };
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
        let mut sim = match Simulation::with_environment(vehicle, config, &environment, start_position_m.unwrap_or([0.0; 3])) {
            Ok(s) => s,
            Err(e) => return bad(e),
        };
        let input = BodyInput { force_body_n: vec(f), torque_body_nm: vec(t) };
        let steps = n as u64;
        let started = Instant::now();
        for k in 0..steps {
            sim.step(&input);
            if k % 256 == 255 && started.elapsed() > RUN_TIME_BUDGET {
                return Response::err(
                    Some(id),
                    ErrorCode::RunTooLong,
                    format!(
                        "the run needs more than {} s of computing (stopped after {} of {steps} steps, {:.3} s simulated); run a shorter durationS",
                        RUN_TIME_BUDGET.as_secs_f64(),
                        k + 1,
                        (k + 1) as f64 * dt
                    ),
                );
            }
        }
        let (contacts, contacts_dropped) = sim.contacts();
        Response::ok(
            id,
            SimRunResult {
                steps,
                dt_s: dt,
                duration_s: steps as f64 * dt,
                gravity_mps2: config.gravity_mps2,
                state: sim.state(),
                state_hash: hash_hex(sim.state_hash()),
                contacts,
                contacts_dropped,
            },
        )
    }
}
