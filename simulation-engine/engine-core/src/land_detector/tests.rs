use super::*;
use crate::math::STANDARD_GRAVITY as G;
use crate::takeoff::{Takeoff, TakeoffParams, TakeoffState};
use serde_json::Value;

const START_US: u64 = 10 * MICROS_PER_SECOND;
const STAGE_US: u64 = 333_333; // Default LNDMC_TRIG_TIME * 1 s / 3, truncated.

fn resting() -> LandDetectorInput {
    LandDetectorInput {
        now_us: START_US,
        armed: true,
        local_position_timestamp_us: START_US,
        vertical_velocity_up_m_s: Some(0.0),
        horizontal_velocity_m_s: Some([0.0; 2]),
        body_rates_rad_s: [0.0; 3],
        specific_force_body_m_s2: [0.0, 0.0, G],
        collective_thrust: LandDetectorParams::default().mpc_thr_min,
        hover_thrust_estimate_update: None,
        climb_rate_control_enabled: true,
        vertical_velocity_setpoint_up_m_s_update: Some(-0.7),
    }
}

fn at(detector: &mut LandDetector, mut input: LandDetectorInput, now_us: u64) -> LandState {
    input.now_us = now_us;
    input.local_position_timestamp_us = now_us;
    detector.step(input)
}

fn levels(state: LandState) -> [bool; 3] {
    [state.ground_contact, state.maybe_landed, state.landed]
}

fn airborne(detector: &mut LandDetector) {
    let input = LandDetectorInput { collective_thrust: 0.5, ..resting() };
    assert_eq!(levels(detector.step(input)), [false; 3]);
}

#[test]
fn defaults_and_bounds_match_reference() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../database/reference/physics.v1.json"
    ))
    .unwrap();
    let entry = |id: &str, key: &str| {
        let set = data["sets"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap();
        set["values"].as_array().unwrap().iter().find(|e| e["key"] == key).unwrap()
    };
    type Field = fn(&mut LandDetectorParams) -> &mut f64;
    type Limits = (Option<f64>, Option<f64>);
    let fields: [(&str, &str, Field, Limits); 9] = [
        ("takeoffLandPx4", "LNDMC_TRIG_TIME", |p| &mut p.lndmc_trig_time, (None, None)),
        ("takeoffLandPx4", "LNDMC_Z_VEL_MAX", |p| &mut p.lndmc_z_vel_max, (None, None)),
        ("takeoffLandPx4", "LNDMC_XY_VEL_MAX", |p| &mut p.lndmc_xy_vel_max, (None, None)),
        ("takeoffLandPx4", "LNDMC_ROT_MAX", |p| &mut p.lndmc_rot_max, (None, None)),
        ("px4Position", "MPC_LAND_SPEED", |p| &mut p.mpc_land_speed, (None, None)),
        ("px4Position", "MPC_MANTHR_MIN", |p| &mut p.mpc_manthr_min, (None, None)),
        ("px4", "MPC_THR_MIN", |p| &mut p.mpc_thr_min, (Some(0.05), Some(1.0))),
        ("px4", "MPC_THR_HOVER", |p| &mut p.mpc_thr_hover, (Some(0.1), Some(0.8))),
        // Only the firmware records this parameter, see mc_pos_control_params.c:417-425.
        ("", "MPC_LAND_CRWL", |p| &mut p.mpc_land_crwl, (Some(0.3), None)),
    ];
    let mut params = LandDetectorParams::default();
    for (set, key, field, (min, max)) in fields {
        let (value, min, max) = if key == "MPC_LAND_CRWL" {
            (0.3, min, max)
        } else {
            let entry = entry(set, key);
            (entry["value"].as_f64().unwrap(), min.or(entry["min"].as_f64()), max.or(entry["max"].as_f64()))
        };
        assert_eq!(*field(&mut params), value, "{key}");
        for (value, valid) in [
            (min, true),
            (min.map(f64::next_down), false),
            (max, true),
            (max.map(f64::next_up), false),
            (Some(f64::INFINITY), false),
            (Some(f64::NAN), false),
        ] {
            if let Some(value) = value {
                let mut candidate = params;
                *field(&mut candidate) = value;
                assert_eq!(LandDetector::new(candidate).is_ok(), valid, "{key} = {value}");
            }
        }
    }
    assert_eq!(u64::from(params.mpc_use_hte), entry("px4", "MPC_USE_HTE")["value"].as_u64().unwrap());
    let constant = |key: &str| entry("landDetectorConstantsPx4", key)["value"].as_u64().unwrap();
    assert_eq!(FREEFALL_TRIGGER_TIME_US, constant("FREEFALL_TRIGGER_TIME_US") * 1_000);
    assert_eq!(LAND_DETECTOR_LAND_PHASE_TIME_US, constant("LAND_DETECTOR_LAND_PHASE_TIME_US") * MICROS_PER_SECOND);
}

#[test]
fn levels_rise_in_order_and_clear_without_a_falling_delay() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    assert_eq!(levels(detector.state()), [true; 3]);
    airborne(&mut detector);
    let t = START_US + 1;
    for (elapsed, expected) in [
        (0, [false, false, false]),
        (STAGE_US - 1, [false, false, false]),
        (STAGE_US, [true, false, false]),
        (2 * STAGE_US - 1, [true, false, false]),
        (2 * STAGE_US, [true, true, false]),
        (3 * STAGE_US - 1, [true, true, false]),
        (3 * STAGE_US, [true, true, true]),
    ] {
        assert_eq!(levels(at(&mut detector, resting(), t + elapsed)), expected);
    }
    let moving = LandDetectorInput { horizontal_velocity_m_s: Some([1.0, 1.2]), ..resting() };
    assert_eq!(levels(at(&mut detector, moving, t + 3 * STAGE_US)), [false; 3]);
}

#[test]
fn interrupted_requests_restart_each_level_timer() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let mut t = START_US + 1;
    at(&mut detector, resting(), t);
    let moving = LandDetectorInput { horizontal_velocity_m_s: Some([2.0, 0.0]), ..resting() };
    at(&mut detector, moving, t + STAGE_US - 1);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [false; 3]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true, false, false]);

    let above_idle = LandDetectorInput { collective_thrust: 0.2, ..resting() };
    assert_eq!(levels(at(&mut detector, above_idle, t + STAGE_US - 1)), [true, false, false]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true, false, false]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true, true, false]);

    let rotating = LandDetectorInput { body_rates_rad_s: [2.0, 0.0, 0.0], ..resting() };
    assert_eq!(levels(at(&mut detector, rotating, t + STAGE_US - 1)), [true, false, false]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true, false, false]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true, true, false]);
    t += STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), t)), [true; 3]);
}

#[test]
fn widened_vertical_and_roll_pitch_thresholds_expire_at_two_seconds_from_maybe_landed() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let t = START_US + 1;
    at(&mut detector, resting(), t);
    at(&mut detector, resting(), t + STAGE_US);
    let maybe_at = t + 2 * STAGE_US;
    assert_eq!(levels(at(&mut detector, resting(), maybe_at)), [true, true, false]);
    assert_eq!(levels(at(&mut detector, resting(), maybe_at + STAGE_US)), [true; 3]);

    let vertical = LandDetectorInput { vertical_velocity_up_m_s: Some(-1.0), ..resting() };
    let rotating = LandDetectorInput { body_rates_rad_s: [0.3, 0.4, 9.0], ..resting() };
    let expiry = maybe_at + 2 * MICROS_PER_SECOND;
    for (input, expected) in [
        (vertical, [false; 3]),
        (rotating, [true, false, false]),
    ] {
        let mut detector = detector.clone();
        assert_eq!(levels(at(&mut detector, input, expiry - 1)), [true; 3]);
        assert_eq!(levels(at(&mut detector, input, expiry)), expected);
    }
}

#[test]
fn freefall_requires_300_ms_and_blocks_maybe_landed_on_same_tick() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    let low_force = LandDetectorInput { specific_force_body_m_s2: [0.0, 0.0, 1.99], ..resting() };
    let at_limit = LandDetectorInput { specific_force_body_m_s2: [0.0, 2.0, 0.0], ..resting() };
    assert!(!detector.step(low_force).freefall);
    assert!(!at(&mut detector, at_limit, START_US + 299_999).freefall);
    let t = START_US + 300_000;
    assert!(!at(&mut detector, low_force, t).freefall);
    assert!(!at(&mut detector, low_force, t + 299_999).freefall);
    let state = at(&mut detector, low_force, t + 300_000);
    assert!(state.freefall);
    assert_eq!(levels(state), [true, false, false]);
    assert!(!at(&mut detector, at_limit, t + 300_000).freefall);
}

#[test]
fn commanded_descent_is_z_up_and_manual_mode_uses_manual_minimum_throttle() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let climb = LandDetectorInput { vertical_velocity_setpoint_up_m_s_update: Some(0.7), ..resting() };
    let t = START_US + 1;
    assert_eq!(levels(at(&mut detector, climb, t)), [false; 3]);
    assert_eq!(levels(at(&mut detector, climb, t + STAGE_US)), [false; 3]);
    let descend = LandDetectorInput { vertical_velocity_setpoint_up_m_s_update: Some(-0.27), ..resting() };
    at(&mut detector, descend, t + STAGE_US);
    let no_update = LandDetectorInput { vertical_velocity_setpoint_up_m_s_update: None, ..resting() };
    assert_eq!(levels(at(&mut detector, no_update, t + 2 * STAGE_US)), [true, false, false]);
    let no_vz = LandDetectorInput { vertical_velocity_setpoint_up_m_s_update: Some(f64::NAN), ..resting() };
    assert_eq!(levels(at(&mut detector, no_vz, t + 2 * STAGE_US)), [false; 3]);

    // Default automatic minimum is 0.158, manual minimum is 0.09.
    let manual = LandDetectorInput { climb_rate_control_enabled: false, ..resting() };
    at(&mut detector, manual, t + 2 * STAGE_US);
    assert_eq!(levels(at(&mut detector, manual, t + 3 * STAGE_US)), [true, false, false]);
    assert_eq!(levels(at(&mut detector, manual, t + 4 * STAGE_US)), [true, false, false]);
    let manual_idle = LandDetectorInput { collective_thrust: 0.08, ..manual };
    at(&mut detector, manual_idle, t + 4 * STAGE_US);
    assert_eq!(levels(at(&mut detector, manual_idle, t + 5 * STAGE_US)), [true, true, false]);
}

#[test]
fn stale_vertical_velocity_uses_strict_eight_second_low_thrust_fallback() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let t = START_US + MICROS_PER_SECOND;
    // The ground-contact check sees stale velocity, despite the Some(0) sample.
    let mut input = LandDetectorInput { now_us: t, ..resting() };
    assert_eq!(levels(detector.step(input)), [false; 3]);
    input.now_us = t + 8 * MICROS_PER_SECOND;
    assert_eq!(levels(detector.step(input)), [false; 3]);
    input.now_us += 1;
    assert_eq!(levels(detector.step(input)), [false; 3]);
    input.now_us += STAGE_US;
    assert_eq!(levels(detector.step(input)), [false, true, false]);
    input.now_us += STAGE_US;
    assert_eq!(levels(detector.step(input)), [false, true, true]);
}

#[test]
fn recent_hover_estimate_relaxes_contact_and_stays_valid_during_descent() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let t = START_US + 1;
    let input = LandDetectorInput { collective_thrust: 0.35, ..resting() };
    let new_estimate = LandDetectorInput {
        hover_thrust_estimate_update: Some(HoverThrustUpdate { timestamp_us: t, hover_thrust: 0.6 }),
        ..input
    };
    at(&mut detector, new_estimate, t);
    assert_eq!(levels(at(&mut detector, input, t + STAGE_US)), [true, false, false]);
    assert_eq!(levels(at(&mut detector, input, t + MICROS_PER_SECOND)), [true, false, false]);
    let manual = LandDetectorInput { climb_rate_control_enabled: false, ..input };
    // Ground contact checks the previous descent state before reading this tick's command.
    assert_eq!(levels(at(&mut detector, manual, t + MICROS_PER_SECOND)), [true, false, false]);
    assert_eq!(levels(at(&mut detector, manual, t + MICROS_PER_SECOND + 1)), [false; 3]);
    assert_eq!(detector.hover_thrust, 0.6);
}

#[test]
fn disarmed_requests_all_landing_levels_even_when_moving() {
    let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
    airborne(&mut detector);
    let input = LandDetectorInput {
        armed: false,
        collective_thrust: 1.0,
        vertical_velocity_up_m_s: Some(2.0),
        ..resting()
    };
    let t = START_US + 1;
    assert_eq!(levels(at(&mut detector, input, t)), [false; 3]);
    assert_eq!(levels(at(&mut detector, input, t + STAGE_US - 1)), [false; 3]);
    assert_eq!(levels(at(&mut detector, input, t + STAGE_US)), [true; 3]);
}

#[test]
fn stationary_low_thrust_takeoff_attempt_never_reaches_flight_and_replays_exactly() {
    let replay = || {
        let mut detector = LandDetector::new(LandDetectorParams::default()).unwrap();
        let mut takeoff = Takeoff::new(TakeoffParams::default()).unwrap();
        let input = LandDetectorInput {
            vertical_velocity_setpoint_up_m_s_update: Some(1.5),
            ..resting()
        };
        let mut hashes = Vec::new();
        for tick in 0..=10 {
            let dt = MICROS_PER_SECOND / 2;
            let now = START_US + tick * dt;
            let state = at(&mut detector, input, now);
            assert!(state.landed);
            assert_ne!(takeoff.update_state(true, state.landed, true, false, now), TakeoffState::Flight);
            takeoff.update_ramp(dt, 1.5);
            hashes.push((detector.hash_words(), takeoff.hash_words()));
        }
        hashes
    };
    assert_eq!(replay(), replay());
}
