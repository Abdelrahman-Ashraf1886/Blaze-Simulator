use super::*;

#[test]
fn land_speed_is_linear_in_start_relative_height_without_range_crawl() {
    let gains = PositionGains::px4_v1_13_3();
    let low = gains.mpc_land_alt2;
    let high = gains.mpc_land_alt1;
    assert_eq!(landing_speed(0.0, &gains), gains.mpc_land_speed);
    assert_eq!(landing_speed(low, &gains), gains.mpc_land_speed);
    assert_eq!(landing_speed(high, &gains), gains.mpc_z_vel_max_dn);
    assert_eq!(landing_speed(high + low, &gains), gains.mpc_z_vel_max_dn);
    // Same arithmetic tolerance as flight_modes/tests.rs:6-8.
    let midpoint = (gains.mpc_land_speed + gains.mpc_z_vel_max_dn) / 2.0;
    assert!((landing_speed((low + high) / 2.0, &gains) - midpoint).abs() <= 1e-12);
}

#[test]
fn takeoff_target_uses_run_origin_and_validates_an_explicit_height() {
    let state = PositionInput { position: [0.0, 0.0, MIS_TAKEOFF_ALT], velocity: [0.0; 3], yaw: 0.0 };
    let start_z = state.position[2];
    let explicit_height = 2.0 * MIS_TAKEOFF_ALT;
    for (altitude_m, height) in [(None, MIS_TAKEOFF_ALT), (Some(explicit_height), explicit_height)] {
        let command = AutoCommand::from_flight(FlightCommand::Takeoff { altitude_m }).unwrap().unwrap();
        let active = AutoFlight::new(command, &state, start_z).unwrap();
        assert_eq!(active.target, [0.0, 0.0, start_z + height]);
    }
    for height in [0.0, -MIS_TAKEOFF_ALT, f64::NAN, f64::INFINITY] {
        assert!(AutoCommand::from_flight(FlightCommand::Takeoff { altitude_m: Some(height) }).is_err());
    }
}
