use super::*;
#[test]
fn defaults_match_reference() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../database/reference/physics.v1.json"
    ))
    .unwrap();
    let px4 = data["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "px4")
        .unwrap();
    let actual = serde_json::to_value(Gains::px4_v1_13_3()).unwrap();
    // One field per cited PARAM_DEFINE entry, exact source-unit default equality.
    assert_eq!(
        actual.as_object().unwrap().len(),
        px4["values"].as_array().unwrap().len()
    );
    for entry in px4["values"].as_array().unwrap() {
        let key = entry["key"].as_str().unwrap().to_lowercase();
        assert_eq!(actual[&key].as_f64(), entry["value"].as_f64(), "{key}");
    }
}

// Hand-calculated X quad: FL, FR, RR, RL, hubs +/-0.2m. Diagonal
// CW pairs FL/RR react +Z; FR/RL CCW react -Z. All thrust axes +Z.
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
        part_id: format!("motor{i}"),
        position: [x, y, 0.0],
        thrust_axis: [0.0, 0.0, 1.0],
        spin,
    })
    .collect()
}
// Numerical tolerance: 1e-11 normalized units, conservative f64 roundoff for
// these well-conditioned four-row inversions and quaternion operations.
const EPS: f64 = 1e-11;
fn near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < EPS, "{actual} != {expected}");
}
fn identity_check(a: &Allocator) {
    for r in 0..4 {
        for c in 0..4 {
            let product: f64 = a
                .effectiveness()
                .iter()
                .zip(a.pseudo_inverse())
                .map(|(b, p)| b[r] * p[c])
                .sum();
            // B B+ = I: unit diagonal and zero off diagonal by the MP definition.
            near(product, if r == c { 1.0 } else { 0.0 });
        }
    }
}
#[test]
fn quad_signs_and_pseudoinverse() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    identity_check(&a);
    // Raw roll/pitch inverse entries = +/-1/(4*.2) = +/-1.25.
    // s_r=s_p=sqrt(4*1.25^2/(4/2))=1.25*sqrt(2), hence mix=+/-1/sqrt(2).
    // Raw yaw inverse = +/-1/(4*.02)=+/-12.5; max=12.5, hence mix=+/-1.
    // Raw thrust inverse=.25; mean abs=.25, hence mix=1 and B_thrust=.25.
    let signs = [
        [1.0, -1.0, -1.0, 1.0],
        [-1.0, -1.0, 1.0, 1.0],
        [1.0, -1.0, 1.0, -1.0],
    ];
    for (i, row) in a.pseudo_inverse().iter().enumerate() {
        near(row[0], signs[0][i] / 2.0_f64.sqrt());
        near(row[1], signs[1][i] / 2.0_f64.sqrt());
        near(row[2], signs[2][i]);
        near(row[3], 1.0);
        near(a.effectiveness()[i][3], 0.25);
    }
    for axis in 0..3 {
        let mut demand = [0.0, 0.0, 0.0, 0.5];
        demand[axis] = 0.1;
        let out = a.allocate(demand);
        for (i, u) in out.commands.iter().enumerate() {
            near(
                *u,
                0.5 + 0.1 * signs[axis][i] / if axis < 2 { 2.0_f64.sqrt() } else { 1.0 },
            );
        }
        assert!(!out.saturation.any());
    }
    // Mean command 0.5 gives collective 0.5 with zero torque.
    for u in a.allocate([0.0, 0.0, 0.0, 0.5]).commands {
        near(*u, 0.5);
    }
}
#[test]
fn hexa_x_and_tilted_motor() {
    // Six hubs at 30+60*k degrees, alternating spin (hexa X).
    let hexa: Vec<_> = (0..6)
        .map(|i| {
            let angle = (30.0 + 60.0 * i as f64).to_radians();
            MotorBody {
                part_id: format!("h{i}"),
                position: [0.3 * angle.cos(), 0.3 * angle.sin(), 0.0],
                thrust_axis: [0.0, 0.0, 1.0],
                spin: if i % 2 == 0 { Spin::Cw } else { Spin::Ccw },
            }
        })
        .collect();
    let mut a = Allocator::new(&hexa, 0.02).unwrap();
    identity_check(&a);
    // Symmetry gives equal command at pure half collective for all six hubs.
    for u in a.allocate([0.0, 0.0, 0.0, 0.5]).commands {
        near(*u, 0.5);
    }
    let mut tilted = quad();
    // Tilt front-left thrust 5deg toward +X, hub at z=0.1.
    tilted[0].position[2] = 0.1;
    let (ax, az) = 5.0_f64.to_radians().sin_cos();
    tilted[0].thrust_axis = [ax, 0.0, az];
    let mut a = Allocator::new(&tilted, 0.02).unwrap();
    identity_check(&a);
    // Hand torque: r cross axis + 0.02 axis. Verify ratios after PX4 scaling.
    let raw = [
        0.2 * az + 0.02 * ax,
        0.1 * ax - 0.2 * az,
        -0.2 * ax + 0.02 * az,
        az,
    ];
    // Each B row remains proportional to the raw geometry. Motor FR is
    // unchanged: raw [.2*-1, -.2, -.02, 1]. Infer each scale from that column.
    let fr_raw = [-0.2, -0.2, -0.02, 1.0];
    for r in 0..4 {
        near(
            a.effectiveness()[0][r],
            raw[r] * a.effectiveness()[1][r] / fr_raw[r],
        );
    }
    near(
        a.effectiveness()[1][0] / fr_raw[0],
        a.effectiveness()[1][1] / fr_raw[1],
    );
    // Nontrivial feasible tilted demand reconstructs all four axes.
    let demand = [0.01, -0.02, 0.005, 0.4];
    let out = a.allocate(demand);
    for (x, y) in out.achieved.into_iter().zip(demand) {
        near(x, y);
    }
    // At 30deg the hub's lateral-force yaw moment overwhelms reaction yaw:
    // zero-torque collective requires negative RL command. Report saturation.
    tilted[0].thrust_axis = [0.5, 0.0, 3.0_f64.sqrt() / 2.0];
    let mut a = Allocator::new(&tilted, 0.02).unwrap();
    let out = a.allocate([0.0, 0.0, 0.0, 0.4]);
    assert!(out.saturation.any());
    for u in out.commands {
        assert!((0.0..=1.0).contains(u));
    } // Physical bounds.
      // A demand made from equal commands IS feasible even with that geometry:
      // B * [0.4;4]. Exercise the sequential path even for feasible full mixing.
    let feasible = std::array::from_fn(|r| a.effectiveness().iter().map(|v| v[r] * 0.4).sum());
    let out = a.allocate(feasible);
    // Full mixing gives .4 per motor, but mixing RP+thrust without yaw
    // violates bounds first. PX4 changes that intermediate mix, then adds yaw:
    // RP survive, yaw and thrust do not recover the original feasible solution.
    near(out.achieved[0], feasible[0]);
    near(out.achieved[1], feasible[1]);
    near(out.commands[1], 0.0);
    assert!(out.saturation.negative[2] && out.saturation.positive[3]);
    for u in out.commands {
        assert!((0.0..=1.0).contains(u));
    }
    assert!(out.saturation.any());
}
#[test]
fn rejects_rank_deficient_and_invalid_geometry() {
    let mut motors = quad();
    for m in &mut motors {
        m.spin = Spin::Cw;
    }
    assert!(Allocator::new(&motors, 0.02).unwrap_err().contains("rank"));
    assert!(Allocator::new(&[], 0.02).is_err());
    assert!(Allocator::new(&quad(), 0.0).is_err()); // No yaw authority without kQ.
    assert!(Allocator::new(&quad(), f64::NAN).is_err());
    motors = quad();
    motors[0].thrust_axis = [0.0; 3];
    assert!(Allocator::new(&motors, 0.02).is_err());
    motors = quad();
    motors[0].position[0] = f64::INFINITY;
    assert!(Allocator::new(&motors, 0.02).is_err());
}
#[test]
fn rectangular_quad_shares_roll_pitch_scale() {
    let mut motors = quad();
    for m in &mut motors {
        m.position[0] *= 2.0;
    }
    let a = Allocator::new(&motors, 0.02).unwrap();
    identity_check(&a);
    // y arm=.2 -> raw roll +/-1.25; x arm=.4 -> raw pitch +/- .625.
    // Shared max norm=1.25*sqrt(2): roll +/-1/sqrt(2), pitch +/-1/(2sqrt(2)).
    for row in a.pseudo_inverse() {
        near(row[0].abs(), 1.0 / 2.0_f64.sqrt());
        near(row[1].abs(), 0.5 / 2.0_f64.sqrt());
    }
}
#[test]
fn airmode_disabled_reduces_high_thrust_but_never_raises_low_thrust() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    let d = 0.2 / 2.0_f64.sqrt();
    let out = a.allocate([0.2, 0.0, 0.0, 0.95]);
    // Initial high motors=.95+d; subtract .95+d-1 from all motors.
    near(out.achieved[0], 0.2);
    near(out.achieved[3], 1.0 - d);
    assert!(out.saturation.positive[3] && !out.saturation.positive[0]);
    let out = a.allocate([0.2, 0.0, 0.0, 0.05]);
    // No thrust increase: roll gives way to keep the low motors at zero.
    near(out.achieved[3], 0.05);
    near(out.achieved[0], 0.05 * 2.0_f64.sqrt());
    assert!(out.saturation.positive[0] && !out.saturation.negative[3]);
}
#[test]
fn yaw_yields_before_roll_pitch_and_collective() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    let out = a.allocate([0.2, 0.1, 5.0, 0.5]);
    // RP maximum differential=.3/sqrt(2). Lower bound limits yaw to
    // .5-.3/sqrt(2); upper motors stay below 1, so thrust stays .5.
    for u in out.commands {
        assert!((0.0..=1.0).contains(u));
    }
    near(out.achieved[0], 0.2);
    near(out.achieved[1], 0.1);
    near(out.achieved[3], 0.5);
    near(out.achieved[2], 0.5 - 0.3 / 2.0_f64.sqrt());
    assert!(out.saturation.positive[2]);
    assert!(
        !out.saturation.positive[0] && !out.saturation.positive[1] && !out.saturation.positive[3]
    );
    let out = a.allocate([10.0, -10.0, 10.0, 0.5]);
    for u in out.commands {
        assert!((0.0..=1.0).contains(u));
    }
    assert!(out.saturation.positive[0] && out.saturation.negative[1] && out.saturation.positive[2]);
    near(out.achieved[3], 0.5);
    assert!(a.allocate([0.0, 0.0, 0.0, 2.0]).saturation.positive[3]);
}
#[test]
fn yaw_uses_fifteen_percent_headroom_then_reduces_thrust() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    let out = a.allocate([0.0, 0.0, 0.2, 1.0]);
    // [1.2,.8,1.2,.8] -> yaw gain=-.05 at upper=1.15:
    // [1.15,.85,1.15,.85], then thrust reduction .15 -> [1,.7,1,.7].
    // Without temporary headroom yaw would vanish at full collective.
    for (u, expected) in out.commands.iter().zip([1.0, 0.7, 1.0, 0.7]) {
        near(*u, expected);
    }
    near(out.achieved[2], 0.15);
    near(out.achieved[3], 0.85);
    assert!(out.saturation.positive[2] && out.saturation.positive[3]);
}
#[test]
fn desaturation_recomputes_half_gain_and_skips_tiny_vectors() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    a.commands.copy_from_slice(&[-0.4, 1.2, -0.4, 1.2]);
    // Thrust vector=-1: k_min=-.4, k_max=.2, first gain=-.2.
    // First pass gives [-.2,1.4,...]; recomputed half gain=.5*(-.2+.4)=.1.
    // Second pass centers the unavoidable saturation at [-.3,1.3,...].
    near(a.compute_desaturation_gain(3, 1.0), -0.2);
    a.desaturate_actuators(3, 1.0, false);
    for (u, expected) in a.commands.iter().zip([-0.3, 1.3, -0.3, 1.3]) {
        near(*u, expected);
    }
    a.commands.copy_from_slice(&[-1.0, 0.5, 0.5, 0.5]);
    a.inverse[0][2] = (f32::EPSILON as f64) / 2.0;
    near(a.compute_desaturation_gain(2, 1.0), 0.0);
}
fn quaternion(r: Rotation) -> Quat {
    [r.x, r.y, r.z, r.w]
}
const ID: Quat = [0.0, 0.0, 0.0, 1.0];
#[test]
fn attitude_small_large_double_cover_and_yaw_weight() {
    let g = Gains::px4_v1_13_3();
    let angle = 1e-5_f64;
    let roll = quaternion(Rotation::from_rotation_x(angle));
    let rates = attitude_rates(&g, ID, roll, 0.0);
    near(rates[0], g.mc_roll_p * angle); // 2sin(a/2)=a+O(a^3), cubic error <1e-15.
    near(rates[1], 0.0);
    near(rates[2], 0.0); // Pure roll has no cross-axis error.
    for rotation in [
        Rotation::from_rotation_x(2.0),
        Rotation::from_rotation_y(2.0),
        Rotation::from_rotation_z(3.0),
    ] {
        let target = quaternion(rotation);
        let a = attitude_rates(&g, ID, target, 0.0);
        let b = attitude_rates(&g, ID, target.map(|x| -x), 0.0);
        let c = attitude_rates(&g, ID.map(|x| -x), target, 0.0);
        for i in 0..3 {
            near(a[i], b[i]);
            near(a[i], c[i]);
        }
    }
    let rates = attitude_rates(&g, ID, quaternion(Rotation::from_rotation_x(2.0)), 0.0);
    near(rates[0], g.mc_rollrate_max.to_radians()); // 6.5*2sin(1) exceeds 220deg/s.
    let rates = attitude_rates(&g, ID, quaternion(Rotation::from_rotation_y(2.0)), 0.0);
    near(rates[1], g.mc_pitchrate_max.to_radians()); // Same pitch gain and clamp.
    let yaw = 0.3;
    let rates = attitude_rates(&g, ID, quaternion(Rotation::from_rotation_z(yaw)), 0.0);
    near(
        rates[2],
        2.0 * g.mc_yaw_p / g.mc_yaw_weight * (g.mc_yaw_weight * yaw / 2.0).sin(),
    ); // PX4 weighted yaw.
    let rates = attitude_rates(&g, ID, ID, 100.0);
    near(rates[2], g.mc_yawrate_max.to_radians()); // FF is limited to MC_YAWRATE_MAX.
}
#[test]
fn rate_integral_limit_freeze_unwind_and_d_measurement() {
    let g = Gains::px4_v1_13_3();
    let mut rate = RateControl::default();
    for _ in 0..10000 {
        rate.update(&g, [0.0; 3], [1.0; 3], Saturation::default(), 0.001);
    }
    assert_eq!(
        rate.integral(),
        [g.mc_rr_int_lim, g.mc_pr_int_lim, g.mc_yr_int_lim]
    ); // PX4 integral limits.
    let sat = Saturation {
        positive: [true; 4],
        ..Saturation::default()
    };
    let before = rate.integral();
    for _ in 0..1000 {
        rate.update(&g, [0.0; 3], [1.0; 3], sat, 0.001);
    }
    assert_eq!(rate.integral(), before); // No integral increments into positive saturation.
    rate.update(&g, [0.0; 3], [-1.0; 3], sat, 0.001);
    for (a, b) in rate.integral().into_iter().zip(before) {
        assert!(a < b);
    }
    let mut g = g;
    g.mc_rollrate_p = 0.0;
    g.mc_rollrate_i = 0.0;
    let mut rate = RateControl::default();
    near(
        rate.update(&g, [0.0; 3], [0.0; 3], Saturation::default(), 0.001)[0],
        0.0,
    ); // First derivative zero.
    near(
        rate.update(&g, [0.0; 3], [1.0, 0.0, 0.0], Saturation::default(), 0.001)[0],
        0.0,
    ); // No setpoint derivative kick.
    near(
        rate.update(
            &g,
            [0.1, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            Saturation::default(),
            0.001,
        )[0],
        -g.mc_rollrate_d * 0.1 / 0.001,
    ); // -D*dmeasurement/dt.
    g.mc_rollrate_p = 0.2;
    g.mc_rollrate_ff = 0.3;
    g.mc_rollrate_k = 2.0;
    let mut rate = RateControl::default();
    near(
        rate.update(&g, [0.0; 3], [1.0, 0.0, 0.0], Saturation::default(), 0.001)[0],
        0.7,
    ); // K*P+FF=2*.2+.3.
}
#[test]
fn vertical_source_equation_limits_and_reset() {
    let gains = Gains::px4_v1_13_3();
    let mut controller = Controller::new(&quad(), 0.02, gains).unwrap();
    let est = ControllerInput {
        attitude: ID,
        body_rates: [0.0; 3],
        z: 0.0,
        z_velocity: 0.0,
    };
    let mut sp = Setpoint {
        attitude: ID,
        yaw_rate: 0.0,
        z: None,
        z_velocity: 0.0,
    };
    near(
        controller.step(&est, &sp, 0.001).collective_thrust,
        gains.mpc_thr_hover,
    ); // hover*(1+0/g).
    sp.z_velocity = 0.1;
    near(
        controller.step(&est, &sp, 0.001).collective_thrust,
        gains.mpc_thr_hover * (1.0 + gains.mpc_z_vel_p_acc * 0.1 / G),
    ); // Velocity P acceleration mapping.
    sp.z = Some(1000.0);
    near(
        controller.step(&est, &sp, 0.001).collective_thrust,
        gains.mpc_thr_max,
    ); // Max up velocity gives 12m/s2 > thrust headroom.
    sp.z = Some(-1000.0);
    sp.z_velocity = 0.0;
    controller.reset();
    near(
        controller.step(&est, &sp, 0.001).collective_thrust,
        gains.mpc_thr_hover * (1.0 - gains.mpc_z_vel_p_acc * gains.mpc_z_vel_max_dn / G),
    ); // NED descent limit negates in Z-up.
    let mut bad = gains;
    bad.mpc_thr_hover = 0.0;
    assert!(controller.set_gains(bad).is_err());
    assert_eq!(*controller.gains(), gains);
}

use crate::sim::{BodyInput, SimConfig, SimState, Simulation};
use crate::vehicle::{
    fixtures::{box_part, with_totals},
    Vehicle,
};

/// Test-local linear actuator, NOT the 4.5 propulsion model: one kg body,
/// four T_max=g/2 N motors gives T/W=2 and hover command 0.5. Inertia
/// (0.02,0.025,0.03)kg m2 is a chosen physical test body. yaw_ratio=0.02m.
/// Only the plant uses the true CoM; controller always sees the same quad.
fn flight(offset: f64, roll: f64, seconds: usize) -> (SimState, u64, [f64; 3], bool, [f64; 4]) {
    let motors = quad();
    let v = Vehicle::from_definition(with_totals(vec![box_part(
        "body",
        1.0,
        [0.0, offset, 0.0],
        [0.02, 0.025, 0.03, 0.0, 0.0, 0.0],
    )]))
    .unwrap();
    let mut sim = Simulation::new(&v, SimConfig::default()).unwrap();
    let mut c = Controller::new(&motors, 0.02, Gains::px4_v1_13_3()).unwrap();
    let mut saturated = false;
    let mut commands = [0.0; 4];
    for k in 0..seconds * 1000 {
        let s = sim.state();
        let est = ControllerInput {
            attitude: s.quaternion,
            body_rates: s.angular_velocity_body_radps,
            z: s.position_m[2],
            z_velocity: s.linear_velocity_mps[2],
        };
        // One second initial hover, then the requested roll step; altitude 1m.
        let sp = Setpoint {
            attitude: quaternion(Rotation::from_rotation_x(if k >= 1000 {
                roll
            } else {
                0.0
            })),
            yaw_rate: 0.0,
            z: Some(1.0),
            z_velocity: 0.0,
        };
        let out = c.step(&est, &sp, 0.001);
        saturated |= k >= 1000 && out.saturation.any();
        commands.copy_from_slice(out.motor_commands);
        let mut input = BodyInput::default();
        for (motor, u) in motors.iter().zip(out.motor_commands) {
            let force = Vector::from_array(motor.thrust_axis) * (*u * G / 2.0);
            let arm = Vector::from_array(motor.position) - Vector::from_array(v.totals.com);
            let sign = if motor.spin == Spin::Cw { 1.0 } else { -1.0 };
            input.force_body_n += force;
            input.torque_body_nm += arm.cross(force) + force * (sign * 0.02);
        }
        sim.step(&input);
    }
    (
        sim.state(),
        sim.state_hash(),
        c.rate_integral(),
        saturated,
        commands,
    )
}
fn roll_of(s: &SimState) -> f64 {
    let r = q(s.quaternion);
    (2.0 * (r.w * r.x + r.y * r.z)).atan2(1.0 - 2.0 * (r.x * r.x + r.y * r.y))
}
#[test]
fn closed_loop_hover_and_determinism() {
    let a = flight(0.0, 0.0, 10);
    let b = flight(0.0, 0.0, 10);
    // Bit-identical state hash over the same 10s at 1ms.
    assert_eq!(a.1, b.1);
    // Acceptance bounds: <1cm altitude error and <0.1deg attitude after 10s,
    // chosen as 1% of the 1m altitude step and 1% of the 10deg tracking step.
    assert!(
        (a.0.position_m[2] - 1.0).abs() < 0.01,
        "z={}",
        a.0.position_m[2]
    );
    // Full quaternion angle checks roll AND pitch AND yaw at level hover;
    // absolute w makes this independent of the quaternion double cover.
    let angle = 2.0 * q(a.0.quaternion).w.abs().clamp(0.0, 1.0).acos();
    assert!(angle < 0.1_f64.to_radians()); // Same 0.1deg attitude acceptance above.
}
#[test]
fn closed_loop_ten_degree_roll() {
    let a = flight(0.0, 10.0_f64.to_radians(), 10);
    // 1% tracking/altitude error after 9s settling (10s run, step at 1s).
    assert!(
        (roll_of(&a.0) - 10.0_f64.to_radians()).abs() < 0.1_f64.to_radians(),
        "roll={}",
        roll_of(&a.0)
    );
    assert!(
        (a.0.position_m[2] - 1.0).abs() < 0.01,
        "z={}",
        a.0.position_m[2]
    );
}
#[test]
fn closed_loop_offset_trims_and_excessive_offset_loses_attitude() {
    let a = flight(0.02, 0.0, 15);
    // Torque balance: sum(y*u)=offset*sum(u); at collective .5,
    // 4*.2*delta=.02*2 -> delta=.05, commands .55/.45.
    // PX4 mix roll=+/-1/sqrt(2), so normalized trim=.05*sqrt(2).
    // Acceptance <1% of 10deg step after 15s; trim tolerance .002.
    assert!(
        roll_of(&a.0).abs() < 0.1_f64.to_radians(),
        "roll={}",
        roll_of(&a.0)
    );
    assert!(
        (a.2[0] - 0.05 * 2.0_f64.sqrt()).abs() < 0.002,
        "integral={:?}",
        a.2
    );
    assert!(
        (a.4[0] - 0.55).abs() < 0.002 && (a.4[1] - 0.45).abs() < 0.002,
        "commands={:?}",
        a.4
    );
    let intermediate = flight(0.06, 0.0, 15);
    // At 6cm, delta=d/(2*a)=.15 -> commands .65/.35,
    // normalized roll trim=.15*sqrt(2)=.212132 < I limit .3.
    assert!(roll_of(&intermediate.0).abs() < 0.1_f64.to_radians());
    assert!((intermediate.2[0] - 0.15 * 2.0_f64.sqrt()).abs() < 0.002);
    assert!((intermediate.4[0] - 0.65).abs() < 0.002);
    assert!((intermediate.4[1] - 0.35).abs() < 0.002);
    // No steady level-hover offset can hold attitude ONLY by reducing thrust
    // in this body: weight balance fixes collective=.5, while torque balance
    // fixes delta=d/(2*a). For d<=a=.2, .5+delta<=1 (no motor saturation).
    // The default roll I limit is reached sooner: delta_max=.3/sqrt(2)=.212132,
    // d_max=2*.2*delta_max=.084853m; high motor=.712132, still below 1.
    // Beyond that, reducing thrust cannot maintain both level attitude and
    // weight balance. Even with altitude sacrificed and thrust demand=1,
    // trim<=.3 only reduces collective to >=1-.3/sqrt(2)=.787868;
    // balancing d>=.084853 would need roll>=sqrt(2)*.787868*d/.2
    // >=.472792, above the .3 integral limit. There is no steady zero-error
    // attitude equilibrium rescued by thrust reduction beyond the hover limit.
    // Transient high-collective thrust reduction is covered
    // by airmode_disabled_reduces_high_thrust_but_never_raises_low_thrust.
    // CoM 25cm lies beyond the 20cm support polygon. No positive thrust
    // distribution can cancel roll torque at any collective.
    let b = flight(0.25, 0.0, 5);
    assert!(b.3); // Saturation observed after the initial 1s transient.
                  // At least one motor reaches an actuator bound (0 or 1), up to the
                  // same f64 roundoff tolerance used in the hand allocation checks.
    assert!(b.4.iter().any(|u| *u < EPS || *u > 1.0 - EPS));
    // Loss of attitude: more than the commanded tracking test's 10deg angle.
    assert!(
        roll_of(&b.0).abs() > 10.0_f64.to_radians(),
        "roll={}",
        roll_of(&b.0)
    );
}

#[test]
fn attitude_zero_yaw_weight_and_opposed_thrust_are_finite() {
    let mut g = Gains::px4_v1_13_3();
    g.mc_yaw_weight = 0.0;
    let out = attitude_rates(&g, ID, quaternion(Rotation::from_rotation_z(1.0)), 0.0);
    // Zero yaw weight explicitly removes yaw; no divide-by-zero compensation.
    for value in out {
        near(value, 0.0);
    }
    let target = [1.0, 0.0, 0.0, 0.0]; // Exact 180deg roll: opposed thrust axes.
    let a = attitude_rates(&g, ID, target, 0.0);
    let b = attitude_rates(&g, ID, target.map(|x| -x), 0.0);
    // Opposed-vector fallback produces max positive roll, no pitch/yaw.
    near(a[0], g.mc_rollrate_max.to_radians());
    near(a[1], 0.0);
    near(a[2], 0.0);
    for (x, y) in a.into_iter().zip(b) {
        near(x, y);
    }
}
#[test]
fn vertical_integral_and_thrust_limits_block_windup() {
    let gains = Gains::px4_v1_13_3();
    let mut c = Controller::new(&quad(), 0.02, gains).unwrap();
    let mut est = ControllerInput {
        attitude: ID,
        body_rates: [0.0; 3],
        z: 0.0,
        z_velocity: 0.0,
    };
    let mut sp = Setpoint {
        attitude: ID,
        yaw_rate: 0.0,
        z: None,
        z_velocity: 100.0,
    };
    for _ in 0..1000 {
        c.step(&est, &sp, 0.001);
    }
    near(c.vertical_integral, 0.0); // At max thrust, positive velocity error cannot integrate.
                                    // Descending faster than max descent requests minimum thrust and must also freeze I.
    est.z_velocity = 10.0;
    sp.z_velocity = -100.0;
    c.reset();
    for _ in 0..1000 {
        c.step(&est, &sp, 0.001);
    }
    near(c.vertical_integral, 0.0);
    near(
        c.step(&est, &sp, 0.001).collective_thrust,
        gains.mpc_thr_min,
    ); // MPC_THR_MIN lower bound.
       // Zero velocity P lets a small velocity error accumulate until I is thrust-limited.
       // With hover=.5 and g, I=+g would request thrust=1; PX4 clamps I to +/-g.
    let mut gains = gains;
    gains.mpc_z_vel_p_acc = 0.0;
    c.set_gains(gains).unwrap();
    est.z_velocity = 0.0;
    sp.z_velocity = 1.0;
    for _ in 0..10000 {
        c.step(&est, &sp, 0.001);
    }
    assert!(c.vertical_integral.abs() <= G); // PX4 acceleration-integral bound +/- standard gravity.
    c.reset();
    near(c.vertical_integral, 0.0); // Reset clears vertical trim as well as rate trim.
}

// Frozen Phase 4.7 allocation path for bitwise regression.
impl Allocator {
    fn allocate_phase_4_7(&mut self, demand: [f64; 4]) -> Allocation<'_> {
        assert!(demand.iter().all(|x| x.is_finite()));
        for (u, v) in self.commands.iter_mut().zip(&self.inverse) {
            *u = v[0] * demand[0] + v[1] * demand[1] + v[3] * demand[3];
        }
        self.desaturate_actuators(3, 1.0, true);
        self.desaturate_actuators(0, 1.0, false);
        self.desaturate_actuators(1, 1.0, false);
        for (u, v) in self.commands.iter_mut().zip(&self.inverse) {
            *u += v[2] * demand[2];
        }
        self.desaturate_actuators(2, 1.15, false);
        self.desaturate_actuators(3, 1.0, true);
        for u in &mut self.commands {
            *u = u.clamp(0.0, 1.0);
        }
        let achieved: [f64; 4] = std::array::from_fn(|r| {
            self.commands
                .iter()
                .zip(&self.effectiveness)
                .map(|(u, v)| u * v[r])
                .sum()
        });
        let mut saturation = Saturation::default();
        for r in 0..4 {
            // Roundoff tolerance in normalized units prevents flag chatter.
            saturation.positive[r] = demand[r] - achieved[r] > 1e-9;
            saturation.negative[r] = achieved[r] - demand[r] > 1e-9;
        }
        Allocation {
            commands: &self.commands,
            achieved,
            saturation,
        }
    }
}

#[test]
fn airmode_zero_is_bit_identical_to_phase_4_7() {
    // Replay a grid spanning feasible demands, both saturation directions,
    // yaw headroom, and asymmetric/tilted geometries against the frozen path.
    let mut tilted = quad();
    tilted[0].thrust_axis = [0.5, 0.0, 3.0_f64.sqrt() / 2.0];
    for geometry in [quad(), tilted] {
        let mut legacy = Allocator::new(&geometry, 0.02).unwrap();
        let mut current = legacy.clone();
        assert_eq!(current.airmode, 0);
        for mode in [None, Some(0)] {
            if let Some(mode) = mode {
                current.set_airmode(mode).unwrap();
            }
            for roll in [-10.0, -0.2, 0.0, 0.2, 10.0] {
                for pitch in [-0.1, 0.0, 0.1] {
                    for yaw in [-5.0, -0.2, 0.0, 0.2, 5.0] {
                        for thrust in [0.0, 0.05, 0.5, 0.95, 1.0, 2.0] {
                            let demand = [roll, pitch, yaw, thrust];
                            let before = legacy.allocate_phase_4_7(demand);
                            let after = current.allocate(demand);
                            assert_eq!(
                                before
                                    .commands
                                    .iter()
                                    .map(|x| x.to_bits())
                                    .collect::<Vec<_>>(),
                                after
                                    .commands
                                    .iter()
                                    .map(|x| x.to_bits())
                                    .collect::<Vec<_>>()
                            );
                            assert_eq!(
                                before.achieved.map(f64::to_bits),
                                after.achieved.map(f64::to_bits)
                            );
                            assert_eq!(before.saturation.positive, after.saturation.positive);
                            assert_eq!(before.saturation.negative, after.saturation.negative);
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn airmode_zero_is_bit_identical_to_phase_4_7_on_random_demands() {
    // Fixed-seed xorshift64*: deterministic, no new dependency. Demands reach
    // well past the feasible range so every saturation branch is exercised.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut uniform = move |lo: f64, hi: f64| {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let r = state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
        lo + (hi - lo) * (r as f64 / (1_u64 << 53) as f64)
    };
    let mut tilted = quad();
    tilted[1].thrust_axis = [0.0, -0.4, (1.0_f64 - 0.16).sqrt()];
    for geometry in [quad(), tilted] {
        let mut legacy = Allocator::new(&geometry, 0.02).unwrap();
        let mut current = legacy.clone();
        for i in 0..20_000 {
            let demand = [
                uniform(-1.5, 1.5),
                uniform(-1.5, 1.5),
                uniform(-1.5, 1.5),
                uniform(-0.2, 2.5),
            ];
            let before = legacy.allocate_phase_4_7(demand);
            let after = current.allocate(demand);
            let bits = |c: &[f64]| c.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert_eq!(bits(before.commands), bits(after.commands), "case {i}");
            assert_eq!(before.achieved.map(f64::to_bits), after.achieved.map(f64::to_bits));
            assert_eq!(before.saturation.positive, after.saturation.positive);
            assert_eq!(before.saturation.negative, after.saturation.negative);
        }
    }
}

#[test]
fn airmode_rp_raises_collective_for_both_attitude_axes_but_not_yaw() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    a.set_airmode(1).unwrap();
    assert!(a.set_airmode(3).is_err());
    assert_eq!(a.airmode, 1);
    for axis in 0..2 {
        for sign in [-1.0, 1.0] {
            let mut demand = [0.0, 0.0, 0.0, 0.05];
            demand[axis] = sign * 0.2;
            let out = a.allocate(demand);
            // Differential +/-d becomes [0,2d] by raising mean to d.
            let d = 0.2 / 2.0_f64.sqrt();
            near(out.achieved[axis], demand[axis]);
            near(out.achieved[3], d);
            assert_eq!(out.saturation.positive, [false; 4]);
            assert_eq!(out.saturation.negative, [false, false, false, true]);
            for u in out.commands {
                assert!(u.abs() < EPS || (*u - 2.0 * d).abs() < EPS);
            }
        }
    }
    let out = a.allocate([0.0, 0.0, 0.2, 0.05]);
    near(out.achieved[2], 0.05);
    near(out.achieved[3], 0.05);
    assert_eq!(out.saturation.positive, [false, false, true, false]);
    assert_eq!(out.saturation.negative, [false; 4]);
}

#[test]
fn airmode_rpy_raises_collective_for_yaw_and_prioritizes_roll_pitch() {
    let mut a = Allocator::new(&quad(), 0.02).unwrap();
    a.set_airmode(2).unwrap();
    for sign in [-1.0, 1.0] {
        let out = a.allocate([0.0, 0.0, sign * 0.2, 0.05]);
        near(out.achieved[2], sign * 0.2);
        near(out.achieved[3], 0.2);
        assert_eq!(out.saturation.positive, [false; 4]);
        assert_eq!(out.saturation.negative, [false, false, false, true]);
        for (i, u) in out.commands.iter().enumerate() {
            near(
                *u,
                if (i % 2 == 0) == (sign > 0.0) {
                    0.4
                } else {
                    0.0
                },
            );
        }
    }
    // Full mixing exceeds BOTH bounds: FL=.5+5+.1/sqrt(2),
    // FR=.5-5-.3/sqrt(2). Collective centering raises the mean
    // by .1/sqrt(2). Yaw then gives way until FL=1 and FR=0:
    // yaw=.5-.2/sqrt(2). RP remain unchanged.
    let out = a.allocate([0.2, 0.1, 5.0, 0.5]);
    near(out.achieved[0], 0.2);
    near(out.achieved[1], 0.1);
    near(out.achieved[2], 0.5 - 0.2 / 2.0_f64.sqrt());
    near(out.achieved[3], 0.5 + 0.1 / 2.0_f64.sqrt());
    assert_eq!(out.saturation.positive, [false, false, true, false]);
    assert_eq!(out.saturation.negative, [false, false, false, true]);
    for mode in [1, 2] {
        a.set_airmode(mode).unwrap();
        let out = a.allocate([0.2, 0.0, 0.0, 0.95]);
        near(out.achieved[0], 0.2);
        near(out.achieved[3], 1.0 - 0.2 / 2.0_f64.sqrt());
        assert_eq!(out.saturation.positive, [false, false, false, true]);
        let out = a.allocate([-10.0, 0.0, 0.0, 0.5]);
        assert!(out.saturation.negative[0]);
        for u in out.commands {
            assert!((0.0..=1.0).contains(u));
        }
    }
}
