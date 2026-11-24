use super::*;
use serde_json::Value;

#[test]
fn defaults_and_bounds_match_reference() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../database/reference/physics.v1.json"
    ))
    .unwrap();
    let mut params = TakeoffParams::default();
    for (set_id, key, field, px4_bounds) in [
        ("takeoffLandPx4", "MPC_SPOOLUP_TIME", &mut params.mpc_spoolup_time, None),
        ("takeoffLandPx4", "MPC_TKO_RAMP_T", &mut params.mpc_tko_ramp_t, None),
        // The reference records the default only. See mc_pos_control_params.c:169-170.
        ("px4", "MPC_Z_VEL_P_ACC", &mut params.mpc_z_vel_p_acc, Some((2.0, 15.0))),
    ] {
        let set = data["sets"].as_array().unwrap().iter().find(|s| s["id"] == set_id).unwrap();
        let entry = set["values"].as_array().unwrap().iter().find(|e| e["key"] == key).unwrap();
        assert_eq!(*field, entry["value"].as_f64().unwrap());
        let (min, max) = px4_bounds.unwrap_or_else(|| {
            (entry["min"].as_f64().unwrap(), entry["max"].as_f64().unwrap())
        });
        for (value, valid) in [
            (min, true),
            (max, true),
            (min.next_down(), false),
            (max.next_up(), false),
            (f64::NAN, false),
        ] {
            let mut candidate = TakeoffParams::default();
            match key {
                "MPC_SPOOLUP_TIME" => candidate.mpc_spoolup_time = value,
                "MPC_TKO_RAMP_T" => candidate.mpc_tko_ramp_t = value,
                "MPC_Z_VEL_P_ACC" => candidate.mpc_z_vel_p_acc = value,
                _ => unreachable!(),
            }
            assert_eq!(Takeoff::new(candidate).is_ok(), valid, "{key} = {value}");
        }
    }
}

#[test]
fn switch_visits_all_states_and_falls_through_in_source_order() {
    use TakeoffState::*;
    let mut takeoff = Takeoff::new(TakeoffParams::default()).unwrap();
    assert_eq!(takeoff.state(), Disarmed);
    assert_eq!(takeoff.update_state(false, true, true, false, 0), Disarmed);
    assert_eq!(takeoff.update_state(true, true, false, false, 1), SpoolUp);
    assert_eq!(takeoff.update_state(true, true, true, false, 1_000_000), SpoolUp);
    assert_eq!(takeoff.update_state(true, true, false, false, 1_000_001), ReadyForTakeoff);
    assert_eq!(takeoff.update_state(true, true, true, false, 1_000_002), RampUp);
    assert_eq!(takeoff.update_ramp(3_000_000, 1.5), 1.5);
    assert_eq!(takeoff.update_state(true, false, false, false, 4_000_002), Flight);
    assert_eq!(takeoff.update_state(true, true, true, false, 4_000_003), ReadyForTakeoff);
    assert_eq!(takeoff.update_state(true, true, true, false, 4_000_004), RampUp);
    assert_eq!(takeoff.update_ramp(0, 1.5), -2.451_662_5);
    assert_eq!(takeoff.update_ramp(3_000_000, 1.5), 1.5);
    // Completed ramp immediately takes the landing branch with landed still true.
    assert_eq!(takeoff.update_state(true, true, true, false, 7_000_004), ReadyForTakeoff);
}

#[test]
fn disarm_cancels_spoolup_and_overrides_every_switch_arm() {
    use TakeoffState::*;
    let mut takeoff = Takeoff::new(TakeoffParams::default()).unwrap();
    assert_eq!(takeoff.update_state(true, true, true, false, 1), SpoolUp);
    assert_eq!(takeoff.update_state(false, true, true, true, 500_001), Disarmed);
    assert_eq!(takeoff.update_state(true, true, true, false, 500_002), SpoolUp);
    assert_eq!(takeoff.update_state(true, true, true, false, 1_500_001), SpoolUp);
    assert_eq!(takeoff.update_state(true, true, true, false, 1_500_002), RampUp);

    assert_eq!(takeoff.update_state(false, false, false, true, 1_500_003), Disarmed);
    assert_eq!(takeoff.update_state(true, true, false, false, 1_500_004), SpoolUp);
    assert_eq!(takeoff.update_state(true, true, false, false, 2_500_004), ReadyForTakeoff);
    assert_eq!(takeoff.update_state(false, true, true, true, 2_500_005), Disarmed);
    assert_eq!(takeoff.update_state(true, true, false, true, 2_500_006), Flight);
    assert_eq!(takeoff.update_state(true, true, false, true, 2_500_007), Flight);
    assert_eq!(takeoff.update_state(false, true, true, true, 2_500_008), Disarmed);
}

#[test]
fn ramp_matches_hand_values_and_finishes_after_exact_integer_elapsed_time() {
    use TakeoffState::*;
    let mut takeoff = Takeoff::new(TakeoffParams {
        mpc_spoolup_time: 0.0,
        ..TakeoffParams::default()
    })
    .unwrap();
    // 9.80665 / 4 downward, then equal steps toward 1.5 m/s upward.
    assert_eq!(takeoff.update_ramp(1_000_000, 1.5), -2.451_662_5);
    assert_eq!(takeoff.update_state(true, true, true, false, 0), RampUp);
    assert_eq!(takeoff.update_ramp(0, 1.5), -2.451_662_5);
    assert!((takeoff.update_ramp(1_000_000, 1.5) - (-1.134_441_666_666_667)).abs() < 1e-14);
    assert!((takeoff.update_ramp(1_000_000, 1.5) - 0.182_779_166_666_667).abs() < 1e-14);
    assert!(takeoff.update_ramp(999_999, 1.5) < 1.5);
    assert_eq!(takeoff.update_state(true, false, false, false, 2_999_999), RampUp);
    assert_eq!(takeoff.update_ramp(1, 1.5), 1.5);
    assert_eq!(takeoff.update_state(true, false, false, false, 3_000_000), Flight);
    assert_eq!(takeoff.update_ramp(0, 2.0), 2.0);
    assert_eq!(Takeoff::generate_initial_ramp_value(0.0), -980.665);
}

#[test]
fn zero_ramp_still_requires_ramp_update_before_flight() {
    let mut takeoff = Takeoff::new(TakeoffParams {
        mpc_spoolup_time: 0.0,
        mpc_tko_ramp_t: 0.0,
        ..TakeoffParams::default()
    })
    .unwrap();
    assert_eq!(takeoff.update_state(true, false, true, false, 0), TakeoffState::RampUp);
    assert_eq!(takeoff.update_state(true, false, true, false, 0), TakeoffState::RampUp);
    assert_eq!(takeoff.update_ramp(0, 1.5), 1.5);
    assert_eq!(takeoff.update_state(true, false, true, false, 0), TakeoffState::Flight);
}
