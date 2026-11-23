use super::*;
use crate::controller::{Controller, ControllerInput, Gains, Setpoint};
use crate::vehicle::{MotorBody, Spin};
const NAN: f64 = f64::NAN;
const ID: Quat = [0.0, 0.0, 0.0, 1.0];
fn near(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-12, "{a} != {b}");
}
fn input() -> PositionInput {
    PositionInput {
        position: [0.0; 3],
        velocity: [0.0; 3],
        yaw: 0.0,
    }
}
fn hold() -> PositionSetpoint {
    PositionSetpoint {
        position: [0.0; 3],
        ..PositionSetpoint::default()
    }
}
fn direct(acceleration: [f64; 3]) -> PositionSetpoint {
    PositionSetpoint {
        acceleration,
        ..PositionSetpoint::default()
    }
}
fn control() -> PositionControl {
    PositionControl::new(PositionGains::px4_v1_13_3()).unwrap()
}
fn reference() -> Value {
    serde_json::from_str(include_str!(
        "../../../../database/reference/physics.v1.json"
    ))
    .unwrap()
}
/// Reference entries this module owns, by PX4 name: the whole `px4Position`
/// set (5.0) plus the `MPC_*` entries of `px4` that 4.7 stores (vertical gains
/// and thrust limits), which `PositionGains` also carries.
fn reference_entries() -> Vec<(String, Value)> {
    let data = reference();
    let mut out = Vec::new();
    for set in data["sets"].as_array().unwrap() {
        let id = set["id"].as_str().unwrap();
        if id != "px4Position" && id != "px4" {
            continue;
        }
        for entry in set["values"].as_array().unwrap() {
            let key = entry["key"].as_str().unwrap();
            if id == "px4Position" || key.starts_with("MPC_") {
                out.push((key.to_owned(), entry.clone()));
            }
        }
    }
    out
}
#[test]
fn defaults_match_reference_by_name_and_count() {
    let actual = serde_json::to_value(PositionGains::px4_v1_13_3()).unwrap();
    let actual = actual.as_object().unwrap();
    let entries = reference_entries();
    let mut seen = std::collections::HashSet::new();
    for (name, entry) in &entries {
        assert!(seen.insert(name.clone()), "duplicate {name}");
        let field = actual
            .get(&name.to_ascii_lowercase())
            .unwrap_or_else(|| panic!("{name} has no PositionGains field"));
        assert_eq!(field.as_f64(), entry["value"].as_f64(), "{name}");
    }
    // No field without a reference entry, and the px4Position set is complete.
    assert_eq!(actual.len(), entries.len());
    let position = reference()["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "px4Position")
        .unwrap()["values"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(position, 36);
}
#[test]
fn ranges_overrides_and_atomic_gain_rejection() {
    for (name, e) in reference_entries() {
        let name = name.as_str();
        // Documented @min/@max; with none, "finite and not negative".
        let min = e["min"].as_f64().unwrap_or(0.0);
        for value in [min - 0.001, f64::INFINITY, f64::NAN] {
            let mut raw = serde_json::to_value(PositionGains::px4_v1_13_3()).unwrap();
            raw[&name.to_ascii_lowercase()] = Value::from(value);
            let result = serde_json::from_value::<PositionGains>(raw)
                .map_err(|e| e.to_string())
                .and_then(|g| g.validate());
            assert!(result.is_err(), "{name}: {value}");
        }
        if let Some(max) = e["max"].as_f64() {
            let overrides = Map::from_iter([(name.to_owned(), Value::from(max + 0.001))]);
            assert!(gains_with_overrides(Some(&overrides)).is_err(), "{name}");
        }
        // The documented bounds themselves are accepted (the three thrust
        // parameters are tied by min <= hover <= max, so skip those here).
        if !matches!(name, "MPC_THR_MIN" | "MPC_THR_HOVER" | "MPC_THR_MAX") {
            for bound in [e["min"].as_f64(), e["max"].as_f64()].into_iter().flatten() {
                let overrides = Map::from_iter([(name.to_owned(), Value::from(bound))]);
                gains_with_overrides(Some(&overrides)).unwrap_or_else(|e| panic!("{name}: {e}"));
            }
        }
    }
    for bad in [
        serde_json::json!({"mpc_xy_p":1.0}),
        serde_json::json!({"UNKNOWN":1.0}),
        serde_json::json!({"MPC_XY_P":"1"}),
        serde_json::json!({"MPC_Z_P":1.501}),
        serde_json::json!({"MPC_THR_MIN":0.01}),
        serde_json::json!({"MPC_THR_MAX":0.2}),
        serde_json::json!({"MPC_THR_HOVER":0.9}),
    ] {
        assert!(gains_with_overrides(bad.as_object()).is_err());
    }
    near(
        gains_with_overrides(serde_json::json!({"MPC_XY_P":1.2}).as_object())
            .unwrap()
            .mpc_xy_p,
        1.2,
    );
    let mut c = control();
    let before = *c.gains();
    let mut bad = before;
    bad.mpc_xy_vel_p_acc = 0.0;
    assert!(c.set_gains(bad).is_err());
    assert_eq!(*c.gains(), before);
}
#[test]
fn margin_above_max_thrust_is_not_a_range_error_but_the_step_is_refused() {
    // MPC_THR_XY_MARG (max 0.5) and MPC_THR_MAX (min 0) are each in range, so
    // validation passes (no invented relation). With a horizontal demand above
    // the margin, PX4's sqrt(max^2 - margin^2) is NaN and `valid` is false.
    let mut g = PositionGains::px4_v1_13_3();
    g.mpc_thr_hover = 0.1;
    g.mpc_thr_min = 0.05;
    g.mpc_thr_max = 0.2;
    g.validate().unwrap();
    let mut c = PositionControl::new(g).unwrap();
    assert!(c
        .step(&input(), &direct([100.0, 0.0, 100.0]), 0.001)
        .is_err());
    assert_eq!(c.integral, [0.0; 3]);
    // Below the margin the same gains work: allocated thrust is the demand.
    c.step(&input(), &direct([0.5, 0.0, 0.0]), 0.001).unwrap();
}
#[test]
fn constrain_xy_all_five_branches() {
    assert_eq!(constrain_xy([1.0, 0.0], [0.0, 1.0], 2.0), [1.0, 1.0]);
    assert_eq!(constrain_xy([3.0, 0.0], [0.0, 4.0], 2.0), [2.0, 0.0]);
    assert_eq!(constrain_xy([1.5, 0.0], [1.5, 0.0], 2.0), [2.0, 0.0]);
    assert_eq!(constrain_xy([0.0, 0.0], [0.0, 4.0], 2.0), [0.0, 2.0]);
    let q = constrain_xy([1.0, 0.0], [0.0, 4.0], 2.0);
    near(q[0], 1.0);
    near(q[1], 3.0_f64.sqrt());
    assert_eq!(constrain_xy([0.0; 2], [0.0; 2], 0.0), [0.0; 2]);
}
#[test]
fn exact_tilt_and_horizontal_margin_scaling() {
    let g = PositionGains::px4_v1_13_3();
    let mut c = control();
    // Pure horizontal demand: tilt=atan(a/g), clipped to 45 degrees.
    let out = c
        .step(&input(), &direct([1000.0, 0.0, 0.0]), 0.001)
        .unwrap();
    let z = Rotation::from_xyzw(
        out.attitude[0],
        out.attitude[1],
        out.attitude[2],
        out.attitude[3],
    ) * Vector::Z;
    near(z.z.acos(), g.mpc_tiltmax_air.to_radians());
    near(out.thrust[0], 0.5);
    near(out.thrust[2], 0.5);
    c.reset();
    // Tilted raw thrust has XY direction 3:4 and exceeds margin while Z is
    // over max. PX4 reserves .3 XY, leaving sqrt(1-.3^2) vertical.
    let out = c
        .step(&input(), &direct([60.0, 80.0, 100.0]), 0.001)
        .unwrap();
    near(out.thrust[2], (1.0 - 0.3_f64.powi(2)).sqrt());
    near(out.thrust[0], 0.3 * 0.6);
    near(out.thrust[1], 0.3 * 0.8);
    near(out.collective_thrust, 1.0);
    // For raw XY below margin, reserve only the demand, not the whole margin.
    let raw = acceleration_control([0.1, 0.0, -100.0], &g, g.mpc_thr_hover);
    let out = c.step(&input(), &direct([0.1, 0.0, 100.0]), 0.001).unwrap();
    near(out.thrust[0], raw[0]);
    near(out.thrust[2], (1.0 - raw[0] * raw[0]).sqrt());
    let z = limit_tilt(Vector::Z, Vector::Z, 0.4);
    near(z.z, 1.0);
    let z = limit_tilt(-Vector::Z, Vector::Z, 0.4);
    near(z.z, 0.4_f64.cos());
}
#[test]
fn attitude_known_quaternions_yaw_inversion_and_horizontal_fallback() {
    let angle = 30.0_f64.to_radians();
    let (q, t) = thrust_to_attitude([angle.sin(), 0.0, angle.cos()], 0.0);
    near(t, 1.0);
    near(q[0], 0.0);
    near(q[1], (angle / 2.0).sin());
    near(q[2], 0.0);
    near(q[3], (angle / 2.0).cos());
    let q = bodyz_to_attitude([0.0, 0.0, 1.0], std::f64::consts::FRAC_PI_2);
    near(q[2], 0.5_f64.sqrt());
    near(q[3], 0.5_f64.sqrt());
    let q = bodyz_to_attitude([0.0, 0.0, -1.0], 0.0);
    let r = Rotation::from_xyzw(q[0], q[1], q[2], q[3]);
    // Inverted-flight rule keeps nose forward, Y and Z reverse (180deg roll).
    assert!((r * Vector::X - Vector::X).length() < 1e-12);
    assert!((r * Vector::Z + Vector::Z).length() < 1e-12);
    let q = bodyz_to_attitude([1.0, 0.0, 0.0], 0.0);
    let r = Rotation::from_xyzw(q[0], q[1], q[2], q[3]);
    assert!((r * Vector::X + Vector::Z).length() < 1e-12);
    assert!((r * Vector::Z - Vector::X).length() < 1e-12);
    let (q, t) = thrust_to_attitude([0.0; 3], 0.0);
    near(t, 0.0);
    near(q[3].abs(), 1.0);
    // Engine +Y acceleration tilts thrust +Y, independent of yaw choice.
    for yaw in [0.0, 0.7, -1.2] {
        let q = bodyz_to_attitude([0.0, 0.5, 0.5], yaw);
        let r = Rotation::from_xyzw(q[0], q[1], q[2], q[3]);
        assert!(
            (r * Vector::Z - Vector::new(0.0, 0.5_f64.sqrt(), 0.5_f64.sqrt())).length() < 1e-12
        );
    }
}
#[test]
fn nan_disables_layers_and_invalid_input_is_transactional() {
    let mut c = control();
    let missing = PositionInput {
        position: [NAN; 3],
        velocity: [NAN; 3],
        yaw: 0.4,
    };
    let out = c.step(&missing, &direct([0.0, 0.0, 0.0]), 0.001).unwrap();
    near(out.collective_thrust, 0.5);
    near(out.attitude[2], (0.4_f64 / 2.0).sin());
    near(out.yaw_rate, 0.0);
    assert!(out.velocity_setpoint.iter().all(|v| v.is_nan()));
    let mut sp = PositionSetpoint {
        velocity: [1.0, 2.0, 0.0],
        ..PositionSetpoint::default()
    };
    let out = c.step(&input(), &sp, 0.001).unwrap();
    near(out.velocity_setpoint[0], 1.0);
    near(out.velocity_setpoint[1], 2.0);
    // Position NaN leaves XY free from position feedback, retaining velocity control.
    sp.position = [NAN, NAN, 1.0];
    let out = c.step(&input(), &sp, 0.001).unwrap();
    near(out.velocity_setpoint[2], 1.0);
    let before = c.clone();
    for bad in [
        PositionSetpoint::default(),
        PositionSetpoint {
            position: [1.0, NAN, 0.0],
            ..hold()
        },
        PositionSetpoint {
            velocity: [1.0, NAN, 0.0],
            ..hold()
        },
        PositionSetpoint {
            acceleration: [1.0, NAN, 0.0],
            ..hold()
        },
        PositionSetpoint {
            yaw: f64::INFINITY,
            ..hold()
        },
    ] {
        assert!(c.step(&input(), &bad, 0.001).is_err());
        assert_eq!(c.integral, before.integral);
        assert_eq!(c.acc_sp_z, before.acc_sp_z);
        assert_eq!(c.derivative[0].previous, before.derivative[0].previous);
        assert_eq!(
            c.derivative[0].initialized,
            before.derivative[0].initialized
        );
        assert!(c.derivative[0].state.to_bits() == before.derivative[0].state.to_bits());
    }
    assert!(c.step(&missing, &hold(), 0.001).is_err());
    assert!(c.step(&input(), &hold(), 0.0).is_err());
    assert!(c.step(&input(), &hold(), NAN).is_err());
}
#[test]
fn position_velocity_priority_and_vertical_limits() {
    let mut c = control();
    let g = *c.gains();
    let sp = PositionSetpoint {
        position: [10.0, 0.0, 100.0],
        velocity: [0.0, 20.0, 0.0],
        ..PositionSetpoint::default()
    };
    let out = c.step(&input(), &sp, 0.001).unwrap();
    near(out.velocity_setpoint[0], 9.5);
    near(
        out.velocity_setpoint[1],
        (12.0_f64.powi(2) - 9.5_f64.powi(2)).sqrt(),
    );
    near(out.velocity_setpoint[2], g.mpc_z_vel_max_up);
    let out = c
        .step(
            &input(),
            &PositionSetpoint {
                position: [0.0, 0.0, -100.0],
                ..hold()
            },
            0.001,
        )
        .unwrap();
    near(out.velocity_setpoint[2], -g.mpc_z_vel_max_dn);
}
#[test]
fn velocity_d_and_acceleration_feedforward_have_engine_frame_signs() {
    let mut c = control();
    let mut est = input();
    let mut sp = PositionSetpoint {
        velocity: [0.0; 3],
        acceleration: [0.1, 0.2, 0.3],
        yaw_rate: 0.25,
        ..PositionSetpoint::default()
    };
    let first = c.step(&est, &sp, 0.001).unwrap();
    for (a, b) in first.acceleration_setpoint.into_iter().zip(sp.acceleration) {
        near(a, b);
    }
    near(first.yaw_rate, 0.25);
    // Separate controller with D enabled vertically, too; legal documented gain.
    c.reset();
    let mut gains = *c.gains();
    gains.mpc_z_vel_d_acc = 0.2;
    c.set_gains(gains).unwrap();
    sp.acceleration = [NAN; 3];
    c.step(&est, &sp, 0.001).unwrap();
    est.velocity = [0.01; 3];
    sp.velocity = est.velocity; // Zero error, isolates -D*dmeasurement/dt.
    let out = c.step(&est, &sp, 0.001).unwrap();
    let b = 2.0 * std::f64::consts::PI * 5.0 * 0.001;
    for a in out.acceleration_setpoint {
        near(a, -0.2 * (b / (1.0 + b)) * 10.0);
    }
}
#[test]
fn filtered_derivative_first_sample_lowpass_and_px4_reset() {
    // BlockDerivative.cpp:48-68 with BlockLowPass.cpp:48-57.
    let mut d = Derivative::default();
    assert!(d.state.is_nan()); // BlockLowPass.hpp:79
    let dt = 0.001;
    let f = 5.0;
    near(d.update(10.0, dt, f), 0.0); // first sample: no derivative yet
    near(d.state, 0.0);
    let b = 2.0 * std::f64::consts::PI * f * dt;
    let alpha = b / (1.0 + b);
    near(d.update(10.01, dt, f), alpha * (10.01 - 10.0) / dt);
    let last = d.state;
    near(d.update(10.01, dt, f), (1.0 - alpha) * last);
    // BlockDerivative::reset only clears the initialised flag: the first sample
    // after it returns 0, but the low-pass state is decayed, not zeroed.
    let kept = d.state;
    d.reset();
    near(d.update(100.0, dt, f), 0.0);
    near(d.state, (1.0 - alpha) * kept);
    near(
        d.update(101.0, dt, f),
        alpha * (1.0 / dt) + (1.0 - alpha) * (1.0 - alpha) * kept,
    );
    // Cut-off 0 gives alpha 0, so the state stays at its first value, 0.
    let mut frozen = Derivative::default();
    near(frozen.update(1.0, dt, 0.0), 0.0);
    near(frozen.update(2.0, dt, 0.0), 0.0);
}
#[test]
fn invalid_velocity_resets_the_derivative_like_the_px4_module() {
    // MulticopterPositionControl.cpp:265-294: x and y are reset together, z alone.
    let mut c = control();
    let mut est = input();
    let sp = hold();
    for k in 0..5 {
        est.velocity = [0.1 * k as f64; 3];
        c.step(&est, &sp, 0.001).unwrap();
    }
    assert!(c.derivative.iter().all(|d| d.initialized));
    let kept = c.derivative[0].state;
    est.velocity = [NAN, 1.0, 1.0];
    // Position hold derives a velocity setpoint, so the NaN estimate is refused
    // and the refused step leaves every filter as it was.
    assert!(c.step(&est, &sp, 0.001).is_err());
    assert!(c.derivative.iter().all(|d| d.initialized)); // transactional
    let free = PositionSetpoint {
        velocity: [NAN, NAN, NAN],
        acceleration: [0.0; 3],
        ..PositionSetpoint::default()
    };
    c.step(&est, &free, 0.001).unwrap();
    assert!(!c.derivative[0].initialized && !c.derivative[1].initialized);
    assert!(c.derivative[2].initialized); // z velocity is valid
    near(c.derivative[0].state, kept); // state kept, as in PX4
}
#[test]
fn vertical_and_horizontal_anti_windup_equations_and_reset() {
    // Saturation must allow integration that brings the output back in range.
    let mut recovery = control();
    recovery.gains.mpc_thr_max = 0.6;
    recovery.integral[2] = -3.0; // Upward trim, NED acceleration.
    let descending = PositionSetpoint {
        velocity: [0.0, 0.0, -0.1],
        ..PositionSetpoint::default()
    };
    recovery.step(&input(), &descending, 0.001).unwrap();
    near(recovery.integral[2], -3.0 + 0.1 * 2.0 * 0.001);
    recovery.integral[2] = 8.0; // Downward trim: minimum thrust.
    let ascending = PositionSetpoint {
        velocity: [0.0, 0.0, 0.1],
        ..PositionSetpoint::default()
    };
    recovery.step(&input(), &ascending, 0.001).unwrap();
    near(recovery.integral[2], 8.0 - 0.1 * 2.0 * 0.001);
    for (velocity, measured) in [(100.0, 0.0), (-100.0, 10.0)] {
        let mut c = control();
        let mut est = input();
        est.velocity[2] = measured;
        let sp = PositionSetpoint {
            velocity: [0.0, 0.0, velocity],
            ..PositionSetpoint::default()
        };
        for _ in 0..100 {
            c.step(&est, &sp, 0.001).unwrap();
        }
        near(c.velocity_integral()[2], 0.0);
    }
    let mut c = control();
    let sp = PositionSetpoint {
        velocity: [12.0, 0.0, 0.0],
        ..PositionSetpoint::default()
    };
    let out = c.step(&input(), &sp, 0.001).unwrap();
    let g = c.gains();
    let correction = 12.0 - 2.0 / g.mpc_xy_vel_p_acc * (21.6 - out.thrust[0] * G / g.mpc_thr_hover);
    near(c.integral[0], correction * g.mpc_xy_vel_i_acc * 0.001);
    assert!(c.integral[0] < 0.0); // Tracking actively unwinds even for positive error.
                                  // No arbitrary horizontal +/-g bound: a stored trim may exceed g.
    c.integral = [2.0 * G, 0.0, 2.0 * G];
    c.step(&input(), &hold(), 0.001).unwrap();
    assert!(c.integral[0] > G);
    assert!(c.integral[2].abs() <= G);
    c.integral = [1.0, 2.0, 3.0];
    c.reset_integral(); // PX4 resetIntegral: the integral only
    assert_eq!(c.integral, [0.0; 3]);
    assert!(c.derivative[0].initialized);
    c.reset();
    assert!(!c.derivative[0].initialized && c.derivative[0].state.is_nan());
}
fn quad() -> Vec<MotorBody> {
    [
        (0.2, 0.2, Spin::Cw),
        (0.2, -0.2, Spin::Ccw),
        (-0.2, -0.2, Spin::Cw),
        (-0.2, 0.2, Spin::Ccw),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (x, y, spin))| MotorBody {
        part_id: i.to_string(),
        position: [x, y, 0.0],
        thrust_axis: [0.0, 0.0, 1.0],
        spin,
    })
    .collect()
}
/// Plan test 3: identical inputs through 4.7's `Controller::step` and this
/// controller, 10 s at 1 ms, collective thrust equal to 1e-12 at every step.
/// Stated differences, none of which is active here:
/// - D: this controller differentiates with PX4's filtered derivative, 4.7 with
///   an unfiltered difference. Both are zero because MPC_Z_VEL_D_ACC = 0.
/// - 4.7 also stops integrating while the allocator reported collective
///   saturation on the previous step; PX4's PositionControl has no such input.
///   With a level attitude and 4 motors the allocator saturates only when the
///   collective reaches 1, which is also where both thrust-limit rules stop the
///   integrator, so the two agree.
/// - 4.7 clamps its thrust to [MPC_THR_MIN, MPC_THR_MAX]; PX4 applies the minimum
///   in `_accelerationControl` and the maximum through the margin rule. For a
///   vertical-only demand the margin rule is exactly MPC_THR_MAX.
/// - 4.7 divides by the cosine of the commanded attitude, here the identity (1).
fn vertical_conformance(thr_min: f64, profile: impl Fn(f64) -> (f64, f64, f64, f64)) -> [bool; 2] {
    let mut g = Gains::px4_v1_13_3();
    g.mpc_thr_min = thr_min;
    assert_eq!(g.mpc_z_vel_d_acc, 0.0);
    let mut old = Controller::new(&quad(), 0.02, g).unwrap();
    let mut gains = PositionGains::px4_v1_13_3();
    gains.mpc_thr_min = thr_min;
    let mut new = PositionControl::new(gains).unwrap();
    let mut limited = [false; 2]; // [upper limit reached, lower limit reached]
    for k in 0..10000 {
        let t = k as f64 * 0.001;
        let (z, v, target, feed) = profile(t);
        let a = old
            .step(
                &ControllerInput {
                    attitude: ID,
                    body_rates: [0.0; 3],
                    z,
                    z_velocity: v,
                },
                &Setpoint {
                    attitude: ID,
                    yaw_rate: 0.0,
                    z: Some(target),
                    z_velocity: feed,
                },
                0.001,
            )
            .collective_thrust;
        let b = new
            .step(
                &PositionInput {
                    position: [0.0, 0.0, z],
                    velocity: [0.0, 0.0, v],
                    yaw: 0.0,
                },
                &PositionSetpoint {
                    position: [0.0, 0.0, target],
                    velocity: [0.0, 0.0, feed],
                    ..PositionSetpoint::default()
                },
                0.001,
            )
            .unwrap();
        near(a, b.collective_thrust);
        limited[0] |= b.collective_thrust >= gains.mpc_thr_max - 1e-12;
        limited[1] |= b.collective_thrust <= gains.mpc_thr_min + 1e-12;
    }
    limited
}
#[test]
fn vertical_conformance_to_47_over_ten_second_profile() {
    // A slow altitude profile with feed-forward, clear of both thrust limits.
    let limits = vertical_conformance(0.12, |t| {
        let target = if t < 2.0 {
            0.0
        } else if t < 6.0 {
            0.2
        } else {
            -0.1
        };
        (
            0.2 * (0.3 * t).sin(),
            0.06 * (0.3 * t).cos(),
            target,
            if t < 4.0 { 0.1 } else { 0.0 },
        )
    });
    assert_eq!(limits, [false, false]);
}
#[test]
fn vertical_conformance_to_47_through_both_thrust_limits() {
    // Targets of +-100 m saturate the velocity setpoint and the thrust: upward
    // demand reaches MPC_THR_MAX, downward demand reaches MPC_THR_MIN (raised to
    // 0.4 so that the 1 m/s descent limit demands less than it), exercising both
    // vertical anti-windup branches (PositionControl.cpp:151-155) against 4.7's.
    let limits = vertical_conformance(0.4, |t| {
        let target = if t < 3.0 {
            100.0
        } else if t < 6.0 {
            -100.0
        } else {
            0.5
        };
        (0.1 * (0.5 * t).sin(), 0.05 * (0.5 * t).cos(), target, 0.0)
    });
    assert_eq!(limits, [true, true]);
}
// Test-only P loop required by the plan: D=0 is below documented MPC_XY_VEL_D_ACC
// min=.1, so production validation correctly refuses it. Bypass only internally.
fn p_only() -> PositionControl {
    let mut c = control();
    c.gains.mpc_xy_vel_i_acc = 0.0;
    c.gains.mpc_xy_vel_d_acc = 0.0;
    c
}
/// Plan test 1: p'' = Kv (Kp (r - p) - p') with I = D = 0, a unit step r = 1.
/// Closed form: wn = sqrt(Kv Kp), zeta = Kv / (2 wn), wd = wn sqrt(1 - zeta^2) and
/// p(t) = 1 - exp(-Kv t / 2) (cos(wd t) + Kv / (2 wd) sin(wd t)); with the defaults
/// wn = 1.308 rad/s, zeta = 0.688, overshoot 5.1 % at tp = pi / wd = 3.31 s.
/// The plant is a point mass whose acceleration is held for each 1 ms step:
/// - `thrust_plant = false` feeds it the controller's acceleration setpoint, the
///   PID output before the thrust vector is formed: only the sampling error is left;
/// - `thrust_plant = true` feeds it the thrust vector (a = thrust * g / hover),
///   which also passes through PX4's limitTilt small-angle replacement.
///
/// Returns (largest |p - exact|, peak, time of peak).
fn step_response(dt: f64, thrust_plant: bool) -> (f64, f64, f64) {
    let mut c = p_only();
    let mut s = input();
    let sp = PositionSetpoint {
        position: [1.0, 0.0, 0.0],
        ..hold()
    };
    let mut peak = 0.0_f64;
    let mut peak_time = 0.0;
    let mut max_error = 0.0_f64;
    let kv = c.gains.mpc_xy_vel_p_acc;
    let kp = c.gains.mpc_xy_p;
    let wd = (kv * kp - kv * kv / 4.0).sqrt();
    for k in 0..(12.0 / dt) as usize {
        let o = c.step(&s, &sp, dt).unwrap();
        let a = if thrust_plant {
            o.thrust[0] * G / c.hover_thrust()
        } else {
            o.acceleration_setpoint[0]
        };
        s.position[0] += s.velocity[0] * dt + 0.5 * a * dt * dt;
        s.velocity[0] += a * dt;
        let t = (k + 1) as f64 * dt;
        let exact =
            1.0 - (-kv * t / 2.0).exp() * ((wd * t).cos() + kv / (2.0 * wd) * (wd * t).sin());
        max_error = max_error.max((s.position[0] - exact).abs());
        if s.position[0] > peak {
            peak = s.position[0];
            peak_time = t;
        }
    }
    (max_error, peak, peak_time)
}
#[test]
fn analytical_position_step_and_discretization_bound() {
    let coarse = step_response(0.001, false);
    let fine = step_response(0.0005, false);
    // A held acceleration makes the error first order in dt: halving the step
    // halves it, so the 1 ms error is bounded by twice the 0.5 ms error (5 %
    // slack for round-off), and the 1 ms result is under 1 mm for this 1 m step.
    assert!(
        coarse.0 < 2.1 * fine.0 && fine.0 < 0.55 * coarse.0,
        "{coarse:?} {fine:?}"
    );
    assert!(coarse.0 < 0.001);
    let kv = 1.8_f64;
    let kp = 0.95;
    let wd = (kv * kp - kv * kv / 4.0).sqrt();
    let peak = 1.0 + (-std::f64::consts::PI * kv / (2.0 * wd)).exp();
    let tp = std::f64::consts::PI / wd;
    assert!((peak - 1.0507).abs() < 1e-4 && (tp - 3.3108).abs() < 1e-3);
    assert!((coarse.1 - peak).abs() < 2.1 * fine.0);
    assert!((coarse.2 - tp).abs() <= 2.0 * (fine.2 - tp).abs() + 0.001);
}
#[test]
fn position_step_through_the_thrust_vector_stays_within_the_limit_tilt_bound() {
    // Through the thrust vector the response differs from the closed form by more
    // than the sampling error, and not with dt (0.5 ms gives the same maximum):
    // PX4's limitTilt (ControlMath.cpp:63-65) replaces the tilt direction by +x
    // when the unit vector's horizontal part is below sqrt(FLT_EPSILON), i.e. for
    // |a| < a_q = bx g / sqrt(1 - bx^2) = 3.39e-3 m/s^2 with bx = sqrt(FLT_EPSILON).
    // A negative command in that band is applied with the other sign, so the
    // applied acceleration differs from the linear law by at most 2 a_q. The error
    // e = p - exact obeys e'' + Kv e' + Kv Kp e = delta, |delta| <= 2 a_q, so
    // |e| <= 2 a_q * integral |h|, h = exp(-Kv t / 2) sin(wd t) / wd, and
    // integral |h| = coth(Kv pi / (4 wd)) / (Kv Kp). Add the sampling error.
    let (kv, kp) = (1.8_f64, 0.95_f64);
    let wd = (kv * kp - kv * kv / 4.0).sqrt();
    let bx = (f32::EPSILON as f64).sqrt();
    let a_q = bx * G / (1.0 - bx * bx).sqrt();
    let l1 = 1.0 / (kv * kp) / (kv * std::f64::consts::PI / (4.0 * wd)).tanh();
    let bound = 2.0 * a_q * l1 + step_response(0.001, false).0;
    let through_thrust = step_response(0.001, true);
    assert!(through_thrust.0 <= bound, "{through_thrust:?} > {bound}");
    // The bound is about 4.4 mm plus the 0.6 mm sampling error.
    assert!(bound < 6e-3);
    // And the quirk really is what is seen: outside the band the map is exact.
    let mut c = p_only();
    for a in [0.01, -0.01, 1.7, -1.7] {
        let out = c.step(&input(), &direct([a, 0.0, 0.0]), 0.001).unwrap();
        near(out.thrust[0] * G / c.hover_thrust(), a);
    }
}

#[test]
fn default_pid_rejects_constant_disturbance() {
    // Plan test 2. With D = 0 the loop with the integrator has the characteristic
    // polynomial s^3 + Kv s^2 + (Ki + Kv Kp) s + Ki Kp = s^3 + 1.8 s^2 + 2.11 s + 0.38
    // for the defaults: one real root at -0.2146 (Newton from -0.2) and a complex
    // pair with real part -0.7927 (the roots sum to -Kv). The slowest decay is
    // exp(-0.2146 t), so after 100 s the transient is below exp(-21) = 5e-10.
    // The default D (0.2) adds the filtered-derivative state but the equilibrium is
    // the same: p = r, v = 0, integrator = -d (the plant acceleration is
    // thrust g / hover + d). The full defaults are used, not the reduced polynomial.
    let mut c = control();
    let mut s = input();
    let d = 0.2;
    let dt = 0.001;
    for _ in 0..100000 {
        let o = c
            .step(
                &s,
                &PositionSetpoint {
                    position: [1.0, 0.0, 0.0],
                    ..hold()
                },
                dt,
            )
            .unwrap();
        let a = o.thrust[0] * G / c.hover_thrust() + d;
        s.position[0] += s.velocity[0] * dt + 0.5 * a * dt * dt;
        s.velocity[0] += a * dt;
    }
    assert!((s.position[0] - 1.0).abs() < 1e-6);
    assert!(s.velocity[0].abs() < 1e-6);
    assert!((c.velocity_integral()[0] + d).abs() < 1e-6);
}
#[test]
fn update_hover_thrust_keeps_the_commanded_thrust() {
    // PositionControl.cpp:73-86. With a = the last vertical acceleration setpoint
    // (NED), h the old and h' the new hover thrust, the integrator gains
    // (a - g) h / h' + g - a, and then a' h'/g - h' = a h/g - h exactly.
    let mut c = control();
    c.integral[2] = 1.0; // NED, downward: less thrust than hover
    let hold_z = PositionSetpoint {
        velocity: [0.0; 3],
        ..PositionSetpoint::default()
    };
    let before = c.step(&input(), &hold_z, 0.001).unwrap().collective_thrust;
    near(before, 0.5 - 1.0 * 0.5 / G); // |a h/g - h| with a = 1
    c.update_hover_thrust(0.4).unwrap();
    near(c.hover_thrust(), 0.4);
    let after = c.step(&input(), &hold_z, 0.001).unwrap().collective_thrust;
    // No jump at the switch.
    near(after, before);
    // The new value is clamped to [0.1, 0.9] for use, but the integrator step
    // uses the unclamped one (PX4 order of operations); <= FLT_EPSILON is ignored.
    let mut c = control();
    c.update_hover_thrust(0.95).unwrap();
    near(c.hover_thrust(), 0.9);
    near(c.velocity_integral()[2], -((0.0 - G) * 0.5 / 0.95 + G));
    let integral = c.integral;
    c.update_hover_thrust(0.0).unwrap();
    c.update_hover_thrust(1e-8).unwrap();
    assert_eq!(c.integral, integral);
    near(c.hover_thrust(), 0.9);
    assert!(c.update_hover_thrust(NAN).is_err());
    assert!(c.set_hover_thrust(f64::INFINITY).is_err());
    c.set_hover_thrust(0.05).unwrap();
    near(c.hover_thrust(), 0.1);
    // A new MPC_THR_HOVER takes over only when it changes.
    let mut g = *c.gains();
    c.set_gains(g).unwrap();
    near(c.hover_thrust(), 0.1);
    g.mpc_thr_hover = 0.6;
    c.set_gains(g).unwrap();
    near(c.hover_thrust(), 0.6);
    c.set_hover_thrust(0.3).unwrap();
    c.reset();
    near(c.hover_thrust(), 0.6);
}
#[test]
fn hover_thrust_scales_the_thrust_and_the_acceleration_map() {
    // Thrust for a horizontal acceleration a is a h / g (level hover, no z
    // demand); the plant used by the step tests relies on it.
    for hover in [0.3, 0.5, 0.7] {
        let mut c = control();
        c.set_hover_thrust(hover).unwrap();
        let out = c.step(&input(), &direct([2.0, 0.0, 0.0]), 0.001).unwrap();
        near(out.thrust[0], 2.0 * hover / G);
        near(out.thrust[2], hover);
    }
}
#[test]
fn limit_tilt_keeps_px4s_small_angle_replacement() {
    // ControlMath.cpp:63-65: a horizontal part shorter than sqrt(FLT_EPSILON)
    // (3.45e-4) is replaced by +x, whatever its sign. Above it the sign is kept.
    let z = (1.0_f64 - 1e-8).sqrt();
    let flipped = limit_tilt(Vector::new(-1e-4, 0.0, z), Vector::Z, 1.0);
    assert!(flipped.x > 0.0);
    near(flipped.x, (1e-4_f64).asin()); // the tilt size is kept
    let kept = limit_tilt(
        Vector::new(-1e-3, 0.0, (1.0 - 1e-6_f64).sqrt()),
        Vector::Z,
        1.0,
    );
    assert!(kept.x < 0.0);
    // Round-off above 1 in the dot product must not give NaN.
    let up = limit_tilt(Vector::new(0.0, 0.0, 1.0 + 1e-16), Vector::Z, 1.0);
    assert!(up.is_finite());
}
#[test]
fn tilt_limit_gives_exactly_the_documented_angle_for_any_bound() {
    // Level hover needs thrust h = 0.5, tilted it needs h / cos(tilt) <= 1, so the
    // tilt bound is the active limit up to acos(0.5) = 60 degrees.
    for degrees in [20.0, 45.0, 55.0] {
        let mut g = PositionGains::px4_v1_13_3();
        g.mpc_tiltmax_air = degrees;
        let mut c = PositionControl::new(g).unwrap();
        for (a_x, a_y) in [(1000.0, 0.0), (-300.0, 400.0), (0.0, -1000.0)] {
            let out = c.step(&input(), &direct([a_x, a_y, 0.0]), 0.001).unwrap();
            let z = Rotation::from_xyzw(
                out.attitude[0],
                out.attitude[1],
                out.attitude[2],
                out.attitude[3],
            ) * Vector::Z;
            assert!(
                (z.z.acos() - degrees.to_radians()).abs() < 1e-9,
                "{degrees}"
            );
            // The tilt direction follows the demand (engine +x/+y), not just its size.
            let h = f64::hypot(a_x, a_y);
            assert!((z.x - degrees.to_radians().sin() * a_x / h).abs() < 1e-9);
            assert!((z.y - degrees.to_radians().sin() * a_y / h).abs() < 1e-9);
        }
    }
}
#[test]
fn thrust_limit_caps_the_tilt_below_a_large_tilt_bound() {
    // Bound 89 degrees, demand far above it: the tilt-limited thrust is
    // h / cos(89 deg) = 28.6, far over MPC_THR_MAX. The vertical part stays at
    // h = 0.5 (below its margin floor), so the horizontal part is cut to
    // sqrt(1 - 0.25) and the attitude is atan(sqrt(0.75) / 0.5) = 60 degrees.
    let mut g = PositionGains::px4_v1_13_3();
    g.mpc_tiltmax_air = 89.0;
    let mut c = PositionControl::new(g).unwrap();
    let out = c
        .step(&input(), &direct([1000.0, 0.0, 0.0]), 0.001)
        .unwrap();
    near(out.thrust[0], 0.75_f64.sqrt());
    near(out.thrust[2], 0.5);
    near(out.collective_thrust, 1.0);
    let z = Rotation::from_xyzw(
        out.attitude[0],
        out.attitude[1],
        out.attitude[2],
        out.attitude[3],
    ) * Vector::Z;
    near(z.z.acos(), 60.0_f64.to_radians());
}
#[test]
fn a_nan_axis_stays_free() {
    // x and y have only an acceleration setpoint (no velocity or position), z has a
    // position. The estimate says the vehicle is moving in x and y, but no layer
    // controls those axes, so neither the velocity P term, the integral nor the
    // derivative acts on them (PositionControl.cpp:129, :147, :189).
    let mut c = control();
    let est = PositionInput {
        position: [5.0, -3.0, 0.0],
        velocity: [3.0, 4.0, 0.0],
        yaw: 0.0,
    };
    let sp = PositionSetpoint {
        position: [NAN, NAN, 0.0],
        acceleration: [0.7, -0.2, NAN],
        ..PositionSetpoint::default()
    };
    for _ in 0..50 {
        let out = c.step(&est, &sp, 0.001).unwrap();
        near(out.acceleration_setpoint[0], 0.7);
        near(out.acceleration_setpoint[1], -0.2);
        assert!(out.velocity_setpoint[0].is_nan() && out.velocity_setpoint[1].is_nan());
        assert!(out.velocity_setpoint[2].is_finite());
    }
    assert_eq!(c.integral[0], 0.0);
    assert_eq!(c.integral[1], 0.0);
    // The z axis, which is controlled, is not affected by the free axes.
    near(c.velocity_integral()[2], 0.0);
    // Position given, velocity and acceleration NaN: the axis is controlled by
    // the position P term alone (feed-forward absent).
    let out = c
        .step(
            &est,
            &PositionSetpoint {
                position: [6.0, -3.0, 0.0],
                ..PositionSetpoint::default()
            },
            0.001,
        )
        .unwrap();
    near(out.velocity_setpoint[0], 0.95);
}
