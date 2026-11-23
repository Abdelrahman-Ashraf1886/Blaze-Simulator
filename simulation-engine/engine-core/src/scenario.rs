//! Scripted acceptance runs on the mainline flight engine (Phase 4.9). SI
//! units, body FLU, quaternions xyzw.
//!
//! The plant is `ClosedLoop` (4.7: the PX4 v1.13.3 controller flying the 4.6
//! motors, battery and drag on the rapier body) built on the *modified* vehicle
//! (payload and part shifts). The controller is built from the *nominal*
//! vehicle's motor geometry and the gains in the config, and its estimate is
//! the true state (attitude, rates, CoM height and vertical speed, as in
//! `closed_loop.rs`), so it never sees the true CoM or payload.
//!
//! No IO, randomness or hidden retuning. Built-in tolerances are acceptance
//! policy (documented where used), not sourced physical parameters. Air
//! density, its reference density and the gains are given, never defaulted.
use crate::{
    aero::BodyDrag,
    closed_loop::ClosedLoop,
    controller::{Gains, Setpoint},
    environment::Environment,
    flight::{Cutoff, EndReason, Flight},
    math::STANDARD_GRAVITY as G,
    propulsion::Propulsion,
    sim::{hash_hex, SimConfig, Simulation, DEFAULT_DT_S as DT},
    vehicle::{recompute_totals, CollisionShape, PartBody, ShapePose, Vehicle},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    pub duration_s: f64,
    pub modifications: Vec<Modification>,
    pub script: Vec<Segment>,
    pub checks: Vec<Check>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Modification {
    /// Absent size uses a uniform cube with the nominal vehicle's mean squared
    /// mass radius: side²=2 trace(I)/m. This is an explicit inertia assumption.
    Payload {
        part_id: String,
        mass_kg: f64,
        position_m: [f64; 3],
        box_size_m: Option<[f64; 3]>,
    },
    /// Moves mass centre, shape, and any matching true motor thrust pose.
    /// The controller still receives the original nominal motor pose.
    ShiftPart { part_id: String, delta_m: [f64; 3] },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Attitude {
    Quaternion {
        xyzw: [f64; 4],
    },
    /// Intrinsic roll/pitch/yaw: Rz(yaw) Ry(pitch) Rx(roll), radians.
    Euler {
        roll: f64,
        pitch: f64,
        yaw: f64,
    },
}
impl Attitude {
    fn quaternion(&self) -> Result<[f64; 4], String> {
        let q = match *self {
            Self::Quaternion { xyzw } => xyzw,
            Self::Euler { roll, pitch, yaw } => {
                let (sr, cr) = (roll / 2.0).sin_cos();
                let (sp, cp) = (pitch / 2.0).sin_cos();
                let (sy, cy) = (yaw / 2.0).sin_cos();
                [
                    sr * cp * cy - cr * sp * sy,
                    cr * sp * cy + sr * cp * sy,
                    cr * cp * sy - sr * sp * cy,
                    cr * cp * cy + sr * sp * sy,
                ]
            }
        };
        if !q.iter().all(|x| x.is_finite())
            || (q.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() > 1e-9
        {
            return Err("attitude must be finite and quaternion unit length".into());
        }
        Ok(normalize(q))
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Segment {
    pub from_s: f64,
    pub attitude: Attitude,
    pub yaw_rate_radps: f64,
    pub z_m: Option<f64>,
    pub z_velocity_mps: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Check {
    Altitude {
        after_s: f64,
        tolerance_m: f64,
    },
    Attitude {
        after_s: f64,
        max_deg: f64,
    },
    NoSustainedSaturation {
        after_s: f64,
        max_duration_s: f64,
    },
    SaturationObserved {
        after_s: f64,
    },
    AttitudeLost {
        after_s: f64,
        above_deg: f64,
    },
    /// Requires every motor >= min_throttle on at least one sample; measures
    /// the maximum vertical velocity among those samples (must be <=0).
    CannotClimb {
        after_s: f64,
        min_throttle: f64,
    },
    HoverThrottle {
        after_s: f64,
        min: f64,
        max: f64,
    },
    RateTrim {
        after_s: f64,
        axis: usize,
        expected: f64,
        tolerance: f64,
    },
    /// Mean Σ weights[i]·T[i] over the vehicle's motors (`VehicleDefinition.motors`
    /// order), N.
    ThrustBalance {
        after_s: f64,
        weights: Vec<f64>,
        expected_n: f64,
        tolerance_n: f64,
    },
}
impl Check {
    fn after(&self) -> f64 {
        match self {
            Self::Altitude { after_s, .. }
            | Self::Attitude { after_s, .. }
            | Self::NoSustainedSaturation { after_s, .. }
            | Self::SaturationObserved { after_s }
            | Self::AttitudeLost { after_s, .. }
            | Self::CannotClimb { after_s, .. }
            | Self::HoverThrottle { after_s, .. }
            | Self::RateTrim { after_s, .. }
            | Self::ThrustBalance { after_s, .. } => *after_s,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub check: Check,
    /// None means the observation window (or full collective) was never reached.
    pub measured: Option<f64>,
    pub limits: [f64; 2],
    pub passed: bool,
    pub samples: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScenarioEnd {
    Duration,
    VoltageCutoff,
    ChargeCutoff,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioReport {
    pub name: String,
    pub passed: bool,
    pub checks: Vec<CheckResult>,
    pub elapsed_s: f64,
    pub max_attitude_error_deg: f64,
    pub final_altitude_error_m: Option<f64>,
    pub mean_throttle: Vec<f64>,
    pub max_throttle: Vec<f64>,
    pub first_throttle: Vec<f64>,
    pub saturated_fraction: f64,
    pub charge_used_mah: f64,
    pub end_reason: ScenarioEnd,
    /// FNV-1a hash (16 hex digits) of the rigid body plus the rotor speeds and
    /// charge used (`Simulation::state_hash_with`); not of the controller's state.
    pub final_state_hash: String,
}
fn normalize(q: [f64; 4]) -> [f64; 4] {
    let n = q.iter().map(|x| x * x).sum::<f64>().sqrt();
    q.map(|x| x / n)
}
fn angle(a: [f64; 4], b: [f64; 4]) -> f64 {
    (2.0 * a
        .iter()
        .zip(b)
        .map(|(x, y)| x * y)
        .sum::<f64>()
        .abs()
        .clamp(0.0, 1.0)
        .acos())
    .to_degrees()
}
/// Recomputes and validates all modified totals through the vehicle API.
pub fn modified_vehicle(vehicle: &Vehicle, scenario: &Scenario) -> Result<Vehicle, String> {
    let mut def = vehicle.definition.clone();
    for modification in &scenario.modifications {
        match modification {
            Modification::ShiftPart { part_id, delta_m } => {
                if !delta_m.iter().all(|x| x.is_finite()) {
                    return Err("part shift must be finite".into());
                }
                let part = def
                    .parts
                    .iter_mut()
                    .find(|p| p.part_id == *part_id)
                    .ok_or_else(|| format!("unknown part: {part_id}"))?;
                for i in 0..3 {
                    part.com[i] += delta_m[i];
                    part.pose.position[i] += delta_m[i];
                }
                if let Some(motor) = def.motors.iter_mut().find(|m| m.part_id == *part_id) {
                    for i in 0..3 {
                        motor.position[i] += delta_m[i];
                    }
                }
            }
            Modification::Payload {
                part_id,
                mass_kg,
                position_m,
                box_size_m,
            } => {
                let side = (2.0 * vehicle.totals.inertia[..3].iter().sum::<f64>()
                    / vehicle.totals.mass_kg)
                    .sqrt();
                let size = box_size_m.unwrap_or([side; 3]);
                if !mass_kg.is_finite()
                    || *mass_kg <= 0.0
                    || !size.iter().all(|x| x.is_finite() && *x > 0.0)
                    || !position_m.iter().all(|x| x.is_finite())
                {
                    return Err(
                        "payload mass/size must be finite and positive; position must be finite"
                            .into(),
                    );
                }
                let [x, y, z] = size;
                def.parts.push(PartBody {
                    part_id: part_id.clone(),
                    mass_kg: *mass_kg,
                    com: *position_m,
                    inertia: [
                        mass_kg * (y * y + z * z) / 12.0,
                        mass_kg * (x * x + z * z) / 12.0,
                        mass_kg * (x * x + y * y) / 12.0,
                        0.0,
                        0.0,
                        0.0,
                    ],
                    pose: ShapePose {
                        position: *position_m,
                        quaternion: [0.0, 0.0, 0.0, 1.0],
                    },
                    shape: CollisionShape::Box {
                        half_extents: size.map(|x| x / 2.0),
                    },
                });
            }
        }
    }
    let totals = recompute_totals(&def.parts);
    def.total_mass_kg = totals.mass_kg;
    def.com = totals.com;
    def.inertia = totals.inertia;
    Vehicle::from_definition(def).map_err(|e| format!("modified vehicle: {e:?}"))
}

impl Scenario {
    pub fn validate(&self, motor_count: usize) -> Result<(), String> {
        if !self.duration_s.is_finite()
            || self.duration_s <= 0.0
            || self.duration_s / DT > u64::MAX as f64
        {
            return Err("duration must be finite and positive, within step range".into());
        }
        if self.script.is_empty() || self.script[0].from_s != 0.0 {
            return Err("script must be nonempty and start at time zero".into());
        }
        let mut previous = -1.0;
        for s in &self.script {
            if !s.from_s.is_finite() || s.from_s <= previous || s.from_s >= self.duration_s {
                return Err("script times must increase strictly within duration".into());
            }
            previous = s.from_s;
            s.attitude.quaternion()?;
            if !s.yaw_rate_radps.is_finite()
                || !s.z_velocity_mps.is_finite()
                || s.z_m.is_some_and(|x| !x.is_finite())
            {
                return Err("setpoint must be finite".into());
            }
        }
        for c in &self.checks {
            let valid = match c {
                Check::Altitude { tolerance_m, .. } => positive(*tolerance_m),
                Check::Attitude { max_deg, .. } => positive(*max_deg) && *max_deg <= 180.0,
                Check::AttitudeLost { above_deg, .. } => positive(*above_deg) && *above_deg < 180.0,
                Check::NoSustainedSaturation { max_duration_s, .. } => positive(*max_duration_s),
                Check::SaturationObserved { .. } => true,
                Check::CannotClimb { min_throttle, .. } => {
                    min_throttle.is_finite() && *min_throttle > 0.0 && *min_throttle <= 1.0
                }
                Check::HoverThrottle { min, max, .. } => {
                    min.is_finite() && max.is_finite() && *min >= 0.0 && *max <= 1.0 && min <= max
                }
                Check::RateTrim {
                    axis,
                    expected,
                    tolerance,
                    ..
                } => *axis < 3 && expected.is_finite() && positive(*tolerance),
                Check::ThrustBalance {
                    weights,
                    expected_n,
                    tolerance_n,
                    ..
                } => {
                    weights.len() == motor_count
                        && weights.iter().all(|x| x.is_finite())
                        && expected_n.is_finite()
                        && positive(*tolerance_n)
                }
            };
            if !valid || !c.after().is_finite() || c.after() < 0.0 || c.after() >= self.duration_s {
                return Err(format!("invalid check: {c:?}"));
            }
            if matches!(c, Check::Altitude { .. }) && self.script.iter().any(|s| s.z_m.is_none()) {
                return Err("altitude checks require altitude targets in every segment".into());
            }
        }
        Ok(())
    }
}
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.0
}
#[derive(Default)]
struct Accumulator {
    n: u64,
    sum: f64,
    peak: f64,
    streak: u64,
}

/// Steps in a time span of `t` seconds at the fixed step: the nearest whole
/// number when `t/dt` is a whole number to 1e-9 (so 20 s is 20 000 steps, not
/// 20 001 by rounding of 0.001), otherwise rounded up by less than one step.
fn steps_for(t: f64) -> u64 {
    let q = t / DT;
    let r = q.round();
    (if (q - r).abs() < 1e-9 { r } else { q.ceil() }) as u64
}

/// A ground and obstacles to start in (4.4), with the body origin's start
/// position (identity attitude, at rest). Without it the run is in free space,
/// starting at the world origin.
#[derive(Debug, Clone, PartialEq)]
pub struct Ground {
    pub environment: Environment,
    pub start_m: [f64; 3],
}

/// What a scenario runs with, besides the vehicle: the controller gains, the
/// air density, an optional battery cut-off the user chose (none is assumed) and an
/// optional ground. Fixed 1 ms step; perfect estimate. Setpoint changes apply
/// at the first step starting at or after `from_s`; gains and geometry are
/// never recalibrated for modified mass properties.
#[derive(Debug, Clone)]
pub struct ScenarioConfig {
    pub gains: Gains,
    /// Density of the air the flight is in, kg/m³ (also the body drag's ρ). The
    /// density each motor's data was fitted at is the motor's own
    /// (`MotorPropulsion::reference_density_kg_m3`): none is assumed here.
    pub air_density_kg_m3: f64,
    pub cutoff: Option<Cutoff>,
    pub ground: Option<Ground>,
}

/// The propulsion scaled from each motor's reference density to the flight's
/// air density (T = k_T ω² and Q = k_Q ω² both scale as ρ/ρ_ref), as `run`
/// scales the plant, for predictions. A motor without a reference density (or an
/// invalid air density) is refused with the engine's own error, never defaulted:
/// `Flight::scale_to_air_density` is asked first.
pub fn scaled_propulsion(vehicle: &Vehicle, propulsion: &Propulsion, air_kg_m3: f64) -> Result<Propulsion, String> {
    Flight::new(vehicle, propulsion.clone(), None, None)?.scale_to_air_density(air_kg_m3)?;
    let mut p = propulsion.clone();
    for m in &mut p.motors {
        let ratio = air_kg_m3 / m.reference_density.expect("checked by scale_to_air_density");
        m.k_thrust *= ratio;
        m.k_torque *= ratio;
    }
    Ok(p)
}

/// Runs a scenario on `vehicle` (nominal) with `propulsion` (the motor and
/// battery data, each motor at its own reference density) and optional body `drag`.
pub fn run(
    vehicle: &Vehicle,
    propulsion: Propulsion,
    drag: Option<BodyDrag>,
    config: &ScenarioConfig,
    scenario: &Scenario,
) -> Result<ScenarioReport, String> {
    scenario.validate(propulsion.motors.len())?;
    config.gains.validate()?;
    let plant = modified_vehicle(vehicle, scenario)?;
    let yaw_ratio = propulsion.yaw_ratio();
    let mut flight = Flight::new(&plant, propulsion, drag, Some(config.air_density_kg_m3))?;
    flight.scale_to_air_density(config.air_density_kg_m3)?;
    if let Some(cutoff) = config.cutoff {
        flight.set_cutoff(cutoff)?;
    }
    // The controller: nominal geometry, never the plant's CoM or payload.
    let mut cl = ClosedLoop::new(vehicle, flight, yaw_ratio, config.gains)?;
    let sim_config = SimConfig::default();
    let mut sim = match &config.ground {
        Some(g) => Simulation::with_environment(&plant, sim_config, &g.environment, g.start_m)?,
        None => Simulation::new(&plant, sim_config)?,
    };
    let n = plant.definition.motors.len();
    let mut report = ScenarioReport {
        name: scenario.name.clone(),
        passed: false,
        checks: vec![],
        elapsed_s: 0.0,
        max_attitude_error_deg: 0.0,
        final_altitude_error_m: None,
        mean_throttle: vec![0.0; n],
        max_throttle: vec![0.0; n],
        first_throttle: vec![],
        saturated_fraction: 0.0,
        charge_used_mah: 0.0,
        end_reason: ScenarioEnd::Duration,
        final_state_hash: String::new(),
    };
    let mut acc: Vec<Accumulator> = scenario.checks.iter().map(|_| Accumulator::default()).collect();
    let from_step: Vec<u64> = scenario.script.iter().map(|s| steps_for(s.from_s)).collect();
    let after_step: Vec<u64> = scenario.checks.iter().map(|c| steps_for(c.after())).collect();
    let targets: Vec<[f64; 4]> = scenario.script.iter().map(|s| s.attitude.quaternion()).collect::<Result<_, _>>()?;
    let mut segment = 0;
    let mut steps = 0_u64;
    let mut altitude = 0.0;
    for k in 0..steps_for(scenario.duration_s) {
        while segment + 1 < from_step.len() && from_step[segment + 1] <= k {
            segment += 1;
        }
        let s = &scenario.script[segment];
        let target = targets[segment];
        cl.step(&mut sim, &Setpoint { attitude: target, yaw_rate: s.yaw_rate_radps, z: s.z_m, z_velocity: s.z_velocity_mps });
        steps += 1;
        let state = sim.state();
        // The controller's altitude is the CoM's (closed_loop.rs), so is the error.
        altitude = state.com_m[2];
        let error = angle(normalize(state.quaternion), target);
        let control = cl.control();
        let sat = control.saturation.positive.iter().chain(&control.saturation.negative).any(|x| *x);
        let motors = cl.flight().motors();
        report.max_attitude_error_deg = report.max_attitude_error_deg.max(error);
        report.saturated_fraction += u8::from(sat) as f64;
        if steps == 1 {
            report.first_throttle = motors.iter().map(|m| m.throttle).collect();
        }
        for (i, m) in motors.iter().enumerate() {
            report.mean_throttle[i] += m.throttle;
            report.max_throttle[i] = report.max_throttle[i].max(m.throttle);
        }
        for ((c, a), after) in scenario.checks.iter().zip(&mut acc).zip(&after_step) {
            if steps < *after {
                continue;
            }
            let value = match c {
                Check::Altitude { .. } => (altitude - s.z_m.unwrap()).abs(),
                Check::Attitude { .. } | Check::AttitudeLost { .. } => error,
                Check::NoSustainedSaturation { .. } => {
                    a.streak = if sat { a.streak + 1 } else { 0 };
                    a.streak as f64 * DT
                }
                Check::SaturationObserved { .. } => u8::from(sat) as f64,
                Check::CannotClimb { min_throttle, .. } => {
                    if motors.iter().any(|m| m.throttle + 1e-9 < *min_throttle) {
                        continue;
                    }
                    state.linear_velocity_mps[2]
                }
                Check::HoverThrottle { .. } => motors.iter().map(|m| m.throttle).sum::<f64>() / n as f64,
                Check::RateTrim { axis, .. } => control.rate_integral[*axis],
                Check::ThrustBalance { weights, .. } => weights.iter().zip(&motors).map(|(w, m)| w * m.thrust_n).sum(),
            };
            a.peak = if a.n == 0 { value } else { a.peak.max(value) };
            a.sum += value;
            a.n += 1;
        }
        if cl.flight().ended().is_some() {
            break;
        }
    }
    report.end_reason = match cl.flight().ended() {
        None => ScenarioEnd::Duration,
        Some(EndReason::VoltageCutoff) => ScenarioEnd::VoltageCutoff,
        Some(EndReason::ChargeCutoff) => ScenarioEnd::ChargeCutoff,
    };
    report.elapsed_s = sim.state().time_s;
    report.final_altitude_error_m = if steps > 0 { scenario.script[segment].z_m.map(|z| altitude - z) } else { None };
    report.charge_used_mah = cl.flight().battery().charge_used_c / 3.6;
    report.final_state_hash = hash_hex(sim.state_hash_with(&cl.flight().hash_words()));
    if steps > 0 {
        for x in &mut report.mean_throttle {
            *x /= steps as f64;
        }
        report.saturated_fraction /= steps as f64;
    }
    for (check, a) in scenario.checks.iter().zip(acc) {
        let (value, limits, strict) = match check {
            Check::Altitude { tolerance_m, .. } => (a.peak, [0.0, *tolerance_m], false),
            Check::Attitude { max_deg, .. } => (a.peak, [0.0, *max_deg], false),
            Check::AttitudeLost { above_deg, .. } => (a.peak, [*above_deg, 180.0], true),
            Check::NoSustainedSaturation { max_duration_s, .. } => (a.peak, [0.0, *max_duration_s], false),
            Check::SaturationObserved { .. } => (a.peak, [1.0, 1.0], false),
            Check::CannotClimb { .. } => (a.peak, [f64::MIN, 0.0], false),
            Check::HoverThrottle { min, max, .. } => (a.sum / a.n.max(1) as f64, [*min, *max], false),
            Check::RateTrim { expected, tolerance, .. } => {
                (a.sum / a.n.max(1) as f64, [expected - tolerance, expected + tolerance], false)
            }
            Check::ThrustBalance { expected_n, tolerance_n, .. } => {
                (a.sum / a.n.max(1) as f64, [expected_n - tolerance_n, expected_n + tolerance_n], false)
            }
        };
        report.checks.push(CheckResult {
            check: check.clone(),
            measured: (a.n > 0).then_some(value),
            limits,
            passed: a.n > 0 && value >= limits[0] && value <= limits[1] && (!strict || value > limits[0]),
            samples: a.n,
        });
    }
    report.passed = report.end_reason == ScenarioEnd::Duration && report.checks.iter().all(|c| c.passed);
    Ok(report)
}

mod builtins;
pub use builtins::*;
#[cfg(test)]
mod tests;
