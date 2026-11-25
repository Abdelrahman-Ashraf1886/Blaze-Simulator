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
        let active = VerticalFlight::new(command, &state, start_z).unwrap();
        assert_eq!(active.target, [0.0, 0.0, start_z + height]);
    }
    for height in [0.0, -MIS_TAKEOFF_ALT, f64::NAN, f64::INFINITY] {
        assert!(AutoCommand::from_flight(FlightCommand::Takeoff { altitude_m: Some(height) }).is_err());
    }
}

fn estimate(position: [f64; 3], yaw: f64) -> PositionInput {
    PositionInput { position, velocity: [0.0; 3], yaw }
}

#[test]
fn return_altitude_uses_the_radius_cone_and_outer_altitude() {
    let p = ReturnParams::default();
    // Use a fixture acceptance radius smaller than RTL_MIN_DIST so both
    // branches of the cone can be exercised independently of navigation gains.
    let radius = p.min_dist / 2.0;
    let home = MIS_TAKEOFF_ALT;
    // Inside the acceptance radius, the altitude is twice the distance.
    assert_eq!(return_altitude(home, home, radius / 2.0, p, radius), home + radius);
    assert_eq!(return_altitude(home, home, radius, p, radius), home + 2.0 * radius);
    // At 45°, tan(angle) = 1. Extend the cone to test both sides of the 2R floor.
    let cone = ReturnParams { min_dist: 3.0 * radius, ..p };
    assert_eq!(return_altitude(home, home, 1.5 * radius, cone, radius), home + 2.0 * radius);
    let edge = return_altitude(home, home, cone.min_dist, cone, radius);
    assert!((edge - (home + cone.min_dist)).abs() <= EPS, "{edge}");
    assert_eq!(return_altitude(home, home, cone.min_dist + radius, cone, radius), home + p.return_alt);
    // The cone never commands descent during climb/return.
    assert_eq!(return_altitude(home + p.return_alt, home, 0.0, p, radius), home + p.return_alt);
}

#[test]
fn return_gains_override_only_the_supplied_exact_names() {
    // rtl_params.c:47-138,166-176. Use documented lower bounds and fixed heading.
    let mut gains = serde_json::json!({
        "RTL_RETURN_ALT": 0, "RTL_DESCEND_ALT": 2, "RTL_LAND_DELAY": -1,
        "RTL_MIN_DIST": 0.5, "RTL_CONE_ANG": 0, "RTL_HDG_MD": 0,
        "MPC_ACC_HOR": PositionGains::px4_v1_13_3().mpc_acc_hor,
    });
    let gains = gains.as_object_mut().unwrap();
    let p = ReturnParams::take_overrides(gains).unwrap();
    assert_eq!([p.return_alt, p.descend_alt, p.land_delay, p.min_dist, p.cone_angle], [0.0, 2.0, -1.0, 0.5, 0.0]);
    assert_eq!(gains.keys().collect::<Vec<_>>(), ["MPC_ACC_HOR"]);
}

#[test]
fn multicopter_return_advances_only_after_position_altitude_yaw_and_delay() {
    use ReturnState::*;
    let p = ReturnParams { land_delay: 1.0, ..ReturnParams::default() };
    let home = Home { position: [p.min_dist, p.min_dist, MIS_TAKEOFF_ALT], yaw: PI / 2.0 };
    let away = estimate([home.position[0] + p.return_alt, home.position[1], home.position[2]], 0.0);
    let mut rtl = ReturnFlight::new(&away, home, false, p).unwrap();
    assert_eq!(rtl.state, Climb);
    assert_eq!(rtl.target, [away.position[0], away.position[1], home.position[2] + p.return_alt]);
    let second = MICROS_PER_SECOND;
    rtl.advance_state(&away, false, second);
    assert_eq!(rtl.state, Climb);
    let climbed = estimate(rtl.target, away.yaw);
    rtl.advance_state(&climbed, false, second);
    assert_eq!(rtl.state, Return);
    assert_eq!(wrap_yaw(rtl.desired_yaw(&climbed)), -PI);
    rtl.advance_state(&climbed, false, 2 * second);
    assert_eq!(rtl.state, Return);
    let wrong_yaw = estimate(rtl.target, home.yaw + 2.0 * rtl.navigation.yaw_tolerance);
    rtl.advance_state(&wrong_yaw, false, 2 * second);
    assert_eq!(rtl.state, Return);
    let over_home = estimate(rtl.target, home.yaw);
    rtl.advance_state(&over_home, false, 3 * second);
    assert_eq!(rtl.state, Descend);
    assert_eq!(rtl.target[2], home.position[2] + p.descend_alt);
    rtl.advance_state(&over_home, false, 4 * second);
    assert_eq!(rtl.state, Descend);
    let loiter = estimate(rtl.target, home.yaw);
    rtl.advance_state(&loiter, false, 4 * second);
    assert_eq!(rtl.state, Loiter);
    rtl.advance_state(&loiter, false, 4 * second);
    rtl.advance_state(&loiter, false, 5 * second - 1);
    assert_eq!(rtl.state, Loiter);
    rtl.advance_state(&loiter, false, 5 * second);
    assert_eq!(rtl.state, Land);
    rtl.advance_state(&loiter, false, 6 * second);
    assert_eq!(rtl.state, Land);
    rtl.advance_state(&estimate(home.position, home.yaw), true, 7 * second);
    assert_eq!(rtl.state, Landed);
}

#[test]
fn return_handles_direct_landing_unlimited_loiter_and_activation_already_landed() {
    use ReturnState::*;
    let p = ReturnParams::default();
    let home = Home { position: [0.0; 3], yaw: 0.0 };
    let low_at_home = estimate([0.0, 0.0, MIS_TAKEOFF_ALT], home.yaw);
    let mut rtl = ReturnFlight::new(&low_at_home, home, false, p).unwrap();
    assert_eq!(rtl.state, Climb);
    assert_eq!(rtl.target, low_at_home.position);
    rtl.advance_state(&low_at_home, false, 0);
    assert_eq!(rtl.state, Return);
    rtl.advance_state(&low_at_home, false, 1);
    assert_eq!(rtl.state, Land);
    assert_eq!(ReturnFlight::new(&low_at_home, home, true, p).unwrap().state, Landed);

    let high_at_home = estimate([0.0, 0.0, p.return_alt], home.yaw);
    for (delay, after_return) in [(0.01, Land), (-1.0, Descend)] {
        let mut rtl = ReturnFlight::new(&high_at_home, home, false, ReturnParams { land_delay: delay, ..p }).unwrap();
        assert_eq!(rtl.state, Return);
        rtl.advance_state(&high_at_home, false, 0);
        assert_eq!(rtl.state, after_return);
        if after_return == Descend {
            let at_loiter = estimate(rtl.target, home.yaw);
            rtl.advance_state(&at_loiter, false, 1);
            assert_eq!(rtl.state, Loiter);
            rtl.advance_state(&at_loiter, false, MICROS_PER_SECOND);
            assert_eq!(rtl.state, Loiter);
        }
    }
}

#[test]
fn straight_return_track_respects_speed_acceleration_and_jerk_and_stops() {
    let g = PositionGains::px4_v1_13_3();
    let origin = [0.0; 3];
    let dt = crate::sim::DEFAULT_DT_S;
    let radius = ReturnParams::default().descend_alt;
    let state = estimate([radius, radius, 0.0], 0.0);
    let mut track = ReturnTrack::new(&state, origin).unwrap();
    let cruise = ReturnNavigation::px4().unwrap().cruise_speed;
    let mut sp = PositionSetpoint::default();
    let mut preceding_acceleration = 0.0;
    let duration = ReturnParams::default().return_alt / MPC_Z_V_AUTO_DN;
    for _ in 0..(duration / dt) as usize {
        track.setpoint(&mut sp, origin, cruise, &g, dt);
        let speed = sp.velocity[0].hypot(sp.velocity[1]);
        let acceleration = track.motion.a;
        assert!(speed <= cruise + EPS);
        assert!(acceleration.abs() <= g.mpc_acc_hor + EPS);
        assert!((acceleration - preceding_acceleration).abs() <= g.mpc_jerk_auto * dt + EPS);
        assert_eq!(sp.position[0], sp.position[1]);
        preceding_acceleration = acceleration;
    }
    // Position tolerance from the 6.7 landing test, flight_loop/tests.rs:303-306.
    assert!(sp.position[0].hypot(sp.position[1]) < 0.01, "{:?}", sp.position);
    assert!(sp.velocity[0].hypot(sp.velocity[1]) < EPS, "{:?}", sp.velocity);
}
