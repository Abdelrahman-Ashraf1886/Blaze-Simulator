//! FlightLoop scripts retain the fixed-step plant and report envelope of ClosedLoop.
use super::{steps_for, Scenario, ScenarioEnd, ScenarioReport, G};
use crate::{
    aero::{rotate, BodyDrag}, auto_modes::AutoMode, flight::EndReason,
    flight_loop::{FlightLoop, FlightLoopSnapshot, FlightSetpoints}, flight_modes::{FlightCommand, Sticks},
    math::Vec3, position_control::bodyz_to_attitude, sim::{hash_hex, Simulation},
    takeoff::{TakeoffParams, TakeoffState}, wind::Wind,
};
use rapier3d_f64::math::Vector;
use serde::{Deserialize, Serialize};

// flight_loop/tests.rs:84-109,302-326 (6.7) and :114-119 (centred attitude).
const HOLD_TOLERANCE_M: f64 = 0.01;
const TILT_TOLERANCE_DEG: f64 = 0.1;
pub const SETTLE_S: f64 = 10.0;
// database/reference/physics.v1.json (MIS_TAKEOFF_ALT), flight_loop/tests.rs:310.
const TAKEOFF_HEIGHT_M: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlightSegment {
    pub from_s: f64,
    pub command: ScriptCommand,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ScriptCommand {
    Position { forward: f64, right: f64, yaw_right: f64, throttle: f64 },
    Takeoff { #[serde(skip_serializing_if = "Option::is_none")] altitude_m: Option<f64> },
    Hold,
    Land,
}

impl From<ScriptCommand> for FlightCommand {
    fn from(command: ScriptCommand) -> Self {
        match command {
            ScriptCommand::Position { forward, right, yaw_right, throttle } =>
                Self::Position(Sticks { forward, right, yaw_right, throttle }),
            ScriptCommand::Takeoff { altitude_m } => Self::Takeoff { altitude_m },
            ScriptCommand::Hold => Self::Hold,
            ScriptCommand::Land => Self::Land,
        }
    }
}

pub(super) fn validate(script: &[FlightSegment], duration_s: f64) -> Result<(), String> {
    if script.first().is_none_or(|s| s.from_s != 0.0) {
        return Err("flightScript must be nonempty and start at time zero".into());
    }
    let mut previous = -1.0;
    for s in script {
        if !s.from_s.is_finite() || s.from_s <= previous || s.from_s >= duration_s {
            return Err("flightScript times must increase strictly within duration".into());
        }
        previous = s.from_s;
        match s.command {
            ScriptCommand::Position { forward, right, yaw_right, throttle }
                if [forward, right, yaw_right, throttle].iter().any(|x| !(-1.0..=1.0).contains(x)) =>
                    return Err("Position sticks must be finite and in [-1, 1]".into()),
            ScriptCommand::Takeoff { altitude_m: Some(z) } if !z.is_finite() || z <= 0.0 =>
                return Err("Takeoff altitude must be finite and positive".into()),
            _ => {}
        }
    }
    Ok(())
}

pub fn position_hold_scenario(name: &str, duration_s: f64) -> Scenario {
    Scenario {
        name: name.into(), duration_s, modifications: vec![], script: vec![], checks: vec![],
        flight_script: Some(vec![FlightSegment {
            from_s: 0.0,
            command: ScriptCommand::Position { forward: 0.0, right: 0.0, yaw_right: 0.0, throttle: 0.0 },
        }]),
    }
}

pub fn takeoff_hold_land_scenario(name: &str) -> Scenario {
    // Same windows as flight_loop/tests.rs:315-338, including spool and ramp.
    let params = TakeoffParams::default();
    let hold_s = params.mpc_spoolup_time + params.mpc_tko_ramp_t + SETTLE_S;
    let land_s = hold_s + SETTLE_S;
    Scenario {
        name: name.into(), duration_s: land_s + SETTLE_S, modifications: vec![], script: vec![], checks: vec![],
        flight_script: Some(vec![
            FlightSegment { from_s: 0.0, command: ScriptCommand::Takeoff { altitude_m: Some(TAKEOFF_HEIGHT_M) } },
            FlightSegment { from_s: hold_s, command: ScriptCommand::Hold },
            FlightSegment { from_s: land_s, command: ScriptCommand::Land },
        ]),
    }
}

#[derive(Debug, Clone, Copy)]
pub enum FlightAcceptance {
    None,
    WindHold { wind: Wind, drag: Option<BodyDrag>, air_density_kg_m3: f64, mass_kg: f64 },
    /// Install after pre-gust hold. The saved start is relative to installation.
    Gust { wind: Wind, start_s: f64, length_m: f64 },
    TakeoffLand { land_speed_mps: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FlightMeasurements {
    WindHold {
        horizontal_error_m: f64, vertical_error_m: f64, position_limit_m: f64,
        tilt_deg: f64, expected_tilt_deg: Option<f64>, tilt_tolerance_deg: f64,
    },
    Gust { peak_displacement_m: Option<f64>, recovery_s: Option<f64>, position_limit_m: f64 },
    TakeoffLand {
        states: LandingSequence, hold_horizontal_error_m: Option<f64>, hold_vertical_error_m: Option<f64>,
        position_limit_m: f64, touchdown_speed_mps: Option<f64>, speed_limit_mps: f64,
        hold_height_from_start_m: Option<f64>, ended_landed: bool,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingSequence {
    pub spool_up_s: Option<f64>,
    pub ramp_up_s: Option<f64>,
    pub flight_s: Option<f64>,
    pub hold_s: Option<f64>,
    pub land_s: Option<f64>,
    pub ground_contact_s: Option<f64>,
    pub maybe_landed_s: Option<f64>,
    pub landed_s: Option<f64>,
    pub ready_s: Option<f64>,
}

impl LandingSequence {
    fn observe(&mut self, snap: FlightLoopSnapshot, command: ScriptCommand, t: f64) {
        let time = match snap.takeoff_state {
            TakeoffState::SpoolUp => Some(&mut self.spool_up_s),
            TakeoffState::RampUp => Some(&mut self.ramp_up_s),
            TakeoffState::Flight => Some(&mut self.flight_s),
            _ => None,
        };
        if let Some(time) = time { time.get_or_insert(t); }
        if matches!(command, ScriptCommand::Takeoff { .. }) && snap.auto_mode == Some(AutoMode::Hold) {
            self.hold_s.get_or_insert(t);
        }
        if snap.auto_mode == Some(AutoMode::Land) {
            self.land_s.get_or_insert(t);
            for (flag, time) in [
                (snap.land_state.ground_contact, &mut self.ground_contact_s),
                (snap.land_state.maybe_landed, &mut self.maybe_landed_s),
                (snap.land_state.landed, &mut self.landed_s),
                (snap.land_state.landed && snap.takeoff_state == TakeoffState::ReadyForTakeoff, &mut self.ready_s),
            ] {
                if flag { time.get_or_insert(t); }
            }
        }
    }

    fn in_order(&self) -> bool {
        let [Some(spool), Some(ramp), Some(flight), Some(hold), Some(land), Some(contact),
            Some(maybe), Some(landed), Some(ready)] =
            [self.spool_up_s, self.ramp_up_s, self.flight_s, self.hold_s, self.land_s,
                self.ground_contact_s, self.maybe_landed_s, self.landed_s, self.ready_s]
        else { return false };
        spool < ramp && ramp < flight && flight <= hold && hold < land
            && land < contact && contact < maybe && maybe < landed && landed <= ready
    }
}

fn tilt_deg(q: [f64; 4]) -> f64 {
    let z = rotate(super::normalize(q), Vec3::new(0.0, 0.0, 1.0));
    z.x.hypot(z.y).atan2(z.z).to_degrees()
}

/// At rest T z_body = m g z_world - D(q, -wind). Rebuild the attitude at
/// heading zero using the controller's thrust-axis conversion. Include
/// vertical drag and unequal body-axis drag in the force balance.
pub fn equilibrium_tilt_deg(drag: Option<BodyDrag>, rho: f64, mass_kg: f64, wind: Vector) -> Option<f64> {
    let mut axis = Vector::Z;
    let Some(drag) = drag else { return Some(0.0) };
    for _ in 0..f64::MANTISSA_DIGITS {
        let q = bodyz_to_attitude(axis.to_array(), 0.0);
        let force = drag.force_world(rho, q, Vec3::new(-wind.x, -wind.y, -wind.z));
        let thrust = mass_kg * G * Vector::Z - Vector::new(force.x, force.y, force.z);
        if !thrust.is_finite() || thrust.z <= 0.0 { return None; }
        let next = thrust.normalize();
        // Unit-vector residual, well below the 0.1-degree flight tolerance.
        if (next - axis).length() <= f64::EPSILON.sqrt() { return Some(tilt_deg(q)); }
        axis = next;
    }
    None
}

pub fn run_flight_script(
    sim: &mut Simulation, controller: &mut FlightLoop, scenario: &Scenario,
    acceptance: FlightAcceptance,
) -> Result<ScenarioReport, String> {
    run_flight_script_observed(sim, controller, scenario, acceptance, |_, _, _| {})
}

/// Observe the initial state, then each completed step with the applied command and setpoints.
pub fn run_flight_script_observed(
    sim: &mut Simulation, controller: &mut FlightLoop, scenario: &Scenario,
    acceptance: FlightAcceptance,
    mut observe: impl FnMut(&Simulation, &FlightLoop, Option<(FlightCommand, FlightSetpoints)>),
) -> Result<ScenarioReport, String> {
    let n = controller.flight().motor_count();
    scenario.validate(n)?;
    let script = scenario.flight_script.as_ref().ok_or("FlightLoop requires flightScript")?;
    let start = Vector::from_array(sim.state().com_m);
    let boundaries: Vec<_> = script.iter().map(|s| steps_for(s.from_s)).collect();
    let mut report = ScenarioReport {
        name: scenario.name.clone(), passed: false, checks: vec![], elapsed_s: 0.0,
        max_attitude_error_deg: 0.0, final_altitude_error_m: None, mean_throttle: vec![0.0; n],
        max_throttle: vec![0.0; n], first_throttle: vec![], saturated_fraction: 0.0, charge_used_mah: 0.0,
        end_reason: ScenarioEnd::Duration, final_state_hash: String::new(), flight: None,
    };
    let mut segment = 0;
    let mut states = LandingSequence::default();
    let mut hold_delta = None;
    let mut touchdown = None;
    let mut peak = None::<f64>;
    let mut ramp_end = None;
    let mut recovery = None;
    let mut wind_valid = true;
    observe(sim, controller, None);
    for k in 0..steps_for(scenario.duration_s) {
        while segment + 1 < script.len() && boundaries[segment + 1] <= k { segment += 1; }
        let command = script[segment].command;
        if let FlightAcceptance::Gust { wind, .. } = acceptance {
            if k == steps_for(SETTLE_S) { controller.flight_mut().set_wind(wind); }
        }
        let before = sim.state();
        let touching_before = sim.touching_ground();
        let input = command.into();
        let mut inputs = None;
        controller.step_observed(sim, input, |setpoints, _, _| inputs = Some((input, setpoints)))?;
        observe(sim, controller, inputs);
        let state = sim.state();
        let snap = controller.last_step().ok_or("flight script produced no step")?;
        let flight = controller.flight();
        let displacement = Vector::from_array(state.com_m) - start;
        if let Some(q) = inputs.and_then(|(_, sp)| sp.attitude) {
            report.max_attitude_error_deg = report.max_attitude_error_deg.max(super::angle(super::normalize(state.quaternion), q));
        }
        report.saturated_fraction += u8::from(snap.saturation.positive.iter().chain(&snap.saturation.negative).any(|x| *x)) as f64;
        report.final_altitude_error_m = snap.position_setpoint[2].is_finite().then(|| state.com_m[2] - snap.position_setpoint[2]);
        let motors = flight.motors();
        if k == 0 { report.first_throttle = motors.iter().map(|m| m.throttle).collect(); }
        for (i, m) in motors.iter().enumerate() {
            report.mean_throttle[i] += m.throttle;
            report.max_throttle[i] = report.max_throttle[i].max(m.throttle);
        }
        wind_valid &= !flight.loads().wind_invalid;
        match acceptance {
            FlightAcceptance::Gust { start_s, length_m, .. } if k >= steps_for(SETTLE_S + start_s) => {
                let distance = displacement.length();
                peak = Some(peak.map_or(distance, |p| p.max(distance)));
                if flight.gust_distance_m().is_some_and(|d| d >= length_m) {
                    let end = *ramp_end.get_or_insert(state.time_s);
                    if inside_hold(displacement) {
                        recovery.get_or_insert(state.time_s - end);
                    } else {
                        recovery = None;
                    }
                }
            }
            FlightAcceptance::TakeoffLand { .. } => {
                states.observe(snap, command, state.time_s);
                if matches!(command, ScriptCommand::Hold) { hold_delta = Some(displacement); }
                if matches!(command, ScriptCommand::Land) && !touching_before && sim.touching_ground() {
                    // Last pre-contact vertical speed, before the detector's delay.
                    touchdown.get_or_insert((-before.linear_velocity_mps[2]).max(0.0));
                }
            }
            _ => {}
        }
        if flight.ended().is_some() { break; }
    }
    let state = sim.state();
    let displacement = Vector::from_array(state.com_m) - start;
    let flight = controller.flight();
    report.end_reason = match flight.ended() {
        None => ScenarioEnd::Duration,
        Some(EndReason::VoltageCutoff) => ScenarioEnd::VoltageCutoff,
        Some(EndReason::ChargeCutoff) => ScenarioEnd::ChargeCutoff,
    };
    report.elapsed_s = state.time_s;
    report.charge_used_mah = flight.battery().charge_used_c / 3.6;
    report.final_state_hash = hash_hex(sim.state_hash_with(&flight.hash_words()));
    if state.steps > 0 {
        report.saturated_fraction /= state.steps as f64;
        for mean in &mut report.mean_throttle { *mean /= state.steps as f64; }
    }
    let (metrics, passed) = match acceptance {
        FlightAcceptance::None => (None, true),
        FlightAcceptance::WindHold { wind, drag, air_density_kg_m3, mass_kg } => {
            let height = start.z - sim.height_below(start.x, start.y).unwrap_or(0.0);
            let expected = wind.mean_velocity(height).ok()
                .and_then(|v| equilibrium_tilt_deg(drag, air_density_kg_m3, mass_kg, v));
            let tilt = tilt_deg(state.quaternion);
            let passed = wind_valid && inside_hold(displacement)
                && expected.is_some_and(|expected| (tilt - expected).abs() <= TILT_TOLERANCE_DEG);
            (Some(FlightMeasurements::WindHold {
                horizontal_error_m: displacement.x.hypot(displacement.y), vertical_error_m: displacement.z,
                position_limit_m: HOLD_TOLERANCE_M, tilt_deg: tilt, expected_tilt_deg: expected,
                tilt_tolerance_deg: TILT_TOLERANCE_DEG,
            }), passed)
        }
        FlightAcceptance::Gust { .. } => {
            // Entered the hold band before the end and stayed there for the rest of the run.
            let recovery = recovery.filter(|s| ramp_end.is_some_and(|end| end + s < state.time_s));
            (Some(FlightMeasurements::Gust {
                peak_displacement_m: peak, recovery_s: recovery, position_limit_m: HOLD_TOLERANCE_M,
            }), wind_valid && recovery.is_some())
        }
        FlightAcceptance::TakeoffLand { land_speed_mps } => {
            let error = hold_delta.map(|delta| delta - TAKEOFF_HEIGHT_M * Vector::Z);
            let ended_landed = controller.last_step().is_some_and(|snap| snap.land_state.landed
                && snap.takeoff_state == TakeoffState::ReadyForTakeoff) && sim.touching_ground();
            let passed = states.in_order() && ended_landed && error.is_some_and(inside_hold)
                && touchdown.is_some_and(|speed| speed <= land_speed_mps);
            (Some(FlightMeasurements::TakeoffLand {
                states, hold_horizontal_error_m: error.map(|e| e.x.hypot(e.y)),
                hold_vertical_error_m: error.map(|e| e.z), position_limit_m: HOLD_TOLERANCE_M,
                touchdown_speed_mps: touchdown, speed_limit_mps: land_speed_mps,
                hold_height_from_start_m: hold_delta.map(|d| d.z), ended_landed,
            }), passed)
        }
    };
    report.flight = metrics;
    report.passed = passed && report.end_reason == ScenarioEnd::Duration;
    Ok(report)
}

fn inside_hold(delta: Vector) -> bool {
    delta.x.hypot(delta.y) < HOLD_TOLERANCE_M && delta.z.abs() < HOLD_TOLERANCE_M
}
