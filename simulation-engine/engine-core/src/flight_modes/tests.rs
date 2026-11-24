//! Inputs are endpoints, midpoints or the configured dead zone. Defaults:
//! position_control.rs:201-249 (reference comparison in position_control/tests.rs:31-68).
use super::*;
use crate::sim::DEFAULT_DT_S as DT;

fn near(actual: f64, expected: f64) {
    // Same rounding tolerance as position_control/tests.rs:7-9.
    assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
}

fn modes(mode: f64) -> FlightModes {
    let gains = PositionGains {
        mpc_pos_mode: mode,
        ..PositionGains::px4_v1_13_3()
    };
    FlightModes::new(gains, 0).unwrap()
}

fn rest() -> PositionInput {
    PositionInput {
        position: [0.0; 3],
        velocity: [0.0; 3],
        yaw: 0.0,
    }
}

fn position(
    m: &mut FlightModes,
    command: FlightCommand,
    state: &PositionInput,
) -> PositionSetpoint {
    let ModeSetpoint::Position(sp) = m.step(command, state, None, false, DT).unwrap() else {
        panic!("expected position control")
    };
    sp
}

#[test]
fn rates_pass_through_without_stick_shaping() {
    let body_radps = [0.0, -PI, TAU];
    let input = FlightCommand::Rates {
        body_radps,
        collective: 0.5,
    };
    let ModeSetpoint::Rates {
        body_radps: rates,
        collective,
    } = modes(4.0).step(input, &rest(), None, false, DT).unwrap()
    else {
        panic!()
    };
    assert_eq!(rates, body_radps);
    assert_eq!(collective, 0.5);
}

#[test]
fn direct_setpoints_bypass_stick_shaping_and_reset_the_manual_task() {
    let mut m = modes(4.0);
    let state = rest();
    let stick = FlightCommand::Stabilized(Sticks { forward: 1.0, ..Default::default() });
    m.step(stick, &state, None, false, DT).unwrap();
    let attitude = [0.0, 0.0, 1.0, 0.0];
    let ModeSetpoint::Attitude { attitude: actual, yaw_rate, collective } = m.step(
        FlightCommand::AttitudeSetpoint { attitude, yaw_rate: PI, collective: 0.5 },
        &state, None, true, DT,
    ).unwrap() else { panic!("expected direct attitude"); };
    assert_eq!((actual, yaw_rate, collective), (attitude, PI, 0.5));
    let ModeSetpoint::Attitude { attitude, .. } = m.step(
        FlightCommand::Stabilized(Sticks::default()), &state, None, false, DT,
    ).unwrap() else { panic!("expected stabilized attitude"); };
    assert_eq!(attitude, [0.0, 0.0, 0.0, 1.0]);

    let waypoint = PositionSetpoint { position: [0.0, 1.0, -1.0], ..Default::default() };
    let ModeSetpoint::Position(actual) = m.step(
        FlightCommand::PositionSetpoint(waypoint), &state, None, true, DT,
    ).unwrap() else { panic!("expected direct position"); };
    assert_eq!(actual.position, waypoint.position);
    assert!(actual.velocity.iter().all(|x| x.is_nan()));
    assert!(actual.yaw.is_nan());
    let locked = position(&mut m, FlightCommand::Position(Sticks::default()), &state);
    assert_eq!(locked.position, state.position);
}

#[test]
fn direct_setpoints_refuse_invalid_quaternions_and_position_layers() {
    let mut m = modes(4.0);
    for command in [
        FlightCommand::AttitudeSetpoint { attitude: [0.0; 4], yaw_rate: 0.0, collective: 0.5 },
        FlightCommand::AttitudeSetpoint { attitude: [0.0, 0.0, 0.0, 1.0], yaw_rate: f64::NAN, collective: 0.5 },
        FlightCommand::PositionSetpoint(PositionSetpoint { position: [0.0, f64::NAN, 0.0], ..Default::default() }),
        FlightCommand::PositionSetpoint(PositionSetpoint { yaw: f64::INFINITY, ..Default::default() }),
        FlightCommand::PositionSetpoint(PositionSetpoint::default()),
    ] {
        assert!(m.step(command, &rest(), None, false, DT).is_err());
        assert_eq!(m.active, None);
    }
}

#[test]
fn stabilized_diagonal_limits_tilt_and_preserves_axis_angle_yaw() {
    let mut m = modes(4.0);
    let sticks = Sticks {
        forward: 1.0,
        right: 1.0,
        throttle: -0.5,
        yaw_right: 1.0,
    };
    let cmd = FlightCommand::Stabilized(sticks);
    let ModeSetpoint::Attitude {
        attitude: [x, y, z, w],
        collective,
        yaw_rate,
    } = m.step(cmd, &rest(), None, false, DT).unwrap()
    else {
        panic!()
    };
    // mc_att_control_main.cpp:157-171: equal axes, total tilt 35 degrees;
    // the FRD diagonal yaw formula changes sign in FLU.
    let half_angle = 35.0_f64.to_radians() / 2.0;
    near(x, half_angle.sin() / 2.0_f64.sqrt());
    near(y, x);
    near(z, 0.0);
    near(w, half_angle.cos());
    near(
        (2.0 * (x * y + w * z)).atan2(1.0 - 2.0 * (y * y + z * z)),
        (half_angle.tan().powi(2)).atan(),
    );
    near(collective, (0.08 + 0.5) / 2.0);
    near(yaw_rate, 0.0);
    let ModeSetpoint::Attitude { yaw_rate, .. } = m.step(cmd, &rest(), None, false, DT).unwrap()
    else {
        panic!()
    };
    near(yaw_rate, -150.0_f64.to_radians());
}

#[test]
fn altitude_uses_raw_tilt_and_shaped_climb_descent_and_yaw() {
    let mut m = modes(4.0);
    // 0.55 lies halfway from the 0.1 dead zone to full stick. With expo
    // 0.6 the shaped value is 0.4/2 + 0.6/8 = 0.275.
    let sticks = Sticks {
        right: 0.5,
        throttle: 0.55,
        yaw_right: 0.55,
        ..Default::default()
    };
    let cmd = |s| FlightCommand::Altitude(s);
    let sp = position(&mut m, cmd(sticks), &rest());
    near(sp.acceleration[1], -0.5 * G * 35.0_f64.to_radians().tan());
    near(sp.velocity[2], 3.0 * 0.275);
    near(
        sp.yaw_rate,
        -150.0_f64.to_radians() * 0.275 * DT / (0.08 + DT),
    );
    assert!(sp.position[2].is_nan() && sp.yaw.is_nan());
    near(
        position(
            &mut m,
            cmd(Sticks {
                throttle: -0.55,
                ..sticks
            }),
            &rest(),
        )
        .velocity[2],
        -0.275,
    );
    let sp = position(
        &mut m,
        cmd(Sticks {
            throttle: 0.1,
            ..Default::default()
        }),
        &rest(),
    );
    near(sp.velocity[2], 0.0);
    near(sp.position[2], 0.0);
}

#[test]
fn velocity_mode_shapes_then_rotates_and_limits_diagonals() {
    let state = PositionInput {
        yaw: PI / 2.0,
        ..rest()
    };
    let mut m = modes(0.0);
    for (forward, right, expected) in [
        (0.55, 0.0, [0.0, 2.75]),
        (1.0, 1.0, [10.0 / 2.0_f64.sqrt(); 2]),
        (0.1, -0.1, [0.0; 2]),
    ] {
        let sp = position(
            &mut m,
            FlightCommand::Position(Sticks {
                forward,
                right,
                ..Default::default()
            }),
            &state,
        );
        near(sp.velocity[0], expected[0]);
        near(sp.velocity[1], expected[1]);
        assert_eq!(sp.position[0].is_finite(), expected[1] == 0.0);
    }
}

#[test]
fn acceleration_mode_limits_first_jerk_integrates_velocity_and_brakes() {
    let mut m = modes(4.0);
    let active = FlightCommand::Position(Sticks {
        right: 1.0,
        yaw_right: 1.0,
        ..Default::default()
    });
    let sp = position(&mut m, active, &rest());
    near(sp.acceleration[1], -8.0 * DT);
    near(sp.velocity[1], -8.0 * DT * DT);
    near(sp.yaw_rate, -TAU * DT);
    // Release after demand exceeds the position-lock threshold. Drag opposes
    // velocity; StickAccelerationXY.cpp:164-177 locks below the squared
    // speed threshold, including when a small residual velocity remains.
    for _ in 0..(1.0 / DT) as usize {
        position(&mut m, active, &rest());
    }
    let center = FlightCommand::Position(Sticks::default());
    let mut braking = false;
    let mut locked = false;
    for _ in 0..(10.0 / DT) as usize {
        let sp = position(&mut m, center, &rest());
        braking |= sp.acceleration[1] > 0.0;
        if sp.velocity[1].powi(2) <= EPS && sp.position[1] == 0.0 {
            locked = true;
            break;
        }
    }
    assert!(braking && locked);
}

#[test]
fn ground_contact_selects_stabilized_until_airborne() {
    for cmd in [
        FlightCommand::Altitude(Sticks::default()),
        FlightCommand::Position(Sticks::default()),
    ] {
        let mut m = modes(4.0);
        assert!(matches!(
            m.step(cmd, &rest(), None, true, DT).unwrap(),
            ModeSetpoint::Attitude { .. }
        ));
        assert!(matches!(
            m.step(cmd, &rest(), None, false, DT).unwrap(),
            ModeSetpoint::Position(_)
        ));
    }
}

#[test]
fn acceleration_mode_vertical_step_starts_with_bounded_jerk_and_reaches_stick_speed() {
    // ManualVelocitySmoothingZ.cpp:52-76 advances the old trajectory first.
    // From rest at full stick, constant jerk J gives a=Jt, v=Jt²/2 on
    // the first moving sample. The final speed is the shaped endpoint.
    let mut state = rest();
    state.position[2] = PositionGains::px4_v1_13_3().mpc_land_alt1;
    for (throttle, terminal) in [(1.0, 3.0), (-1.0, -1.0)] {
        let mut m = modes(4.0);
        let cmd = FlightCommand::Position(Sticks {
            throttle,
            ..Default::default()
        });
        let initial = position(&mut m, cmd, &state);
        near(initial.velocity[2], 0.0);
        near(initial.acceleration[2], 0.0);
        let next = position(&mut m, cmd, &state);
        near(next.acceleration[2], throttle * 8.0 * DT);
        near(next.velocity[2], throttle * 4.0 * DT * DT);
        let mut previous = next;
        // J=8, configured accelerations 4 up/3 down. Ten seconds is the
        // closed_loop/tests.rs:72-84 settling window for this plant.
        for _ in 0..(10.0 / DT) as usize {
            let sp = position(&mut m, cmd, &state);
            assert!((sp.acceleration[2] - previous.acceleration[2]).abs() <= 8.0 * DT + 1e-12);
            assert!(sp.acceleration[2] <= 4.0 + 1e-12 && sp.acceleration[2] >= -3.0 - 1e-12);
            previous = sp;
        }
        near(previous.velocity[2], terminal);
        near(previous.acceleration[2], 0.0);
    }
}

#[test]
fn ground_slowdown_limits_climb_and_descent_at_each_height() {
    // position_control.rs:236-239,248-249. At 7.5 m both limits are halfway
    // between the 5 m endpoint (1.5/0.7) and the 10 m endpoint (3/1).
    for (height, up, down) in [(0.0, 1.5, -0.7), (5.0, 1.5, -0.7),
                                (7.5, 2.25, -0.85), (10.0, 3.0, -1.0)] {
        let mut state = rest();
        state.position[2] = height;
        for (throttle, expected) in [(1.0, up), (-1.0, down)] {
            let sticks = Sticks { throttle, ..Default::default() };
            for (mode, cmd) in [(0.0, FlightCommand::Altitude(sticks)),
                                (0.0, FlightCommand::Position(sticks)),
                                (4.0, FlightCommand::Position(sticks))] {
                let mut m = modes(mode);
                let mut sp = position(&mut m, cmd, &state);
                if mode == 4.0 {
                    near(sp.velocity[2], 0.0);
                    // Same settling window as the bounded-jerk test above.
                    for _ in 0..(10.0 / DT) as usize {
                        sp = position(&mut m, cmd, &state);
                    }
                }
                near(sp.velocity[2], expected);
            }
        }
    }
}

#[test]
fn vertical_unlock_copies_position_controller_feedback() {
    for feedback in [Some(1.0), None] {
        let mut m = modes(4.0);
        position(&mut m, FlightCommand::Position(Sticks::default()), &rest());
        let cmd = FlightCommand::Position(Sticks { throttle: 1.0, ..Default::default() });
        let ModeSetpoint::Position(sp) = m.step(
            cmd, &rest(), feedback.map(|vz| [0.0, 0.0, vz]), false, DT,
        ).unwrap() else { panic!("expected position control") };
        // Missing feedback keeps the trajectory's own (zero) velocity, never NaN.
        near(sp.velocity[2], feedback.unwrap_or(0.0));
    }
}
