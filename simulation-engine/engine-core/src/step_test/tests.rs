use super::*;
use crate::{
    controller::{Allocator, Gains},
    hover_thrust::HoverThrustParams,
    position_control::PositionGains,
    propulsion::{BatteryParams, MotorPropulsion, PropulsionDefinition},
    trace::TraceSample,
    vehicle::{fixtures::{box_part, with_totals}, MotorBody, Spin},
};

// scenario/tests.rs:21-64, whose fixture functions are private.
const ARM_M: f64 = 0.15;
const RHO: f64 = 1.225;
const DT: f64 = DEFAULT_DT_S;

fn quad() -> (Vehicle, Propulsion) {
    let mut def = with_totals(vec![box_part("body", 1.0, [0.0; 3], [0.01, 0.01, 0.02, 0.0, 0.0, 0.0])]);
    let mount = |i: usize, x, y, spin| MotorBody {
        part_id: format!("m{i}"),
        position: [x, y, 0.0],
        thrust_axis: [0.0, 0.0, 1.0],
        spin,
    };
    def.motors = vec![
        mount(1, ARM_M, -ARM_M, Spin::Ccw), mount(2, -ARM_M, ARM_M, Spin::Ccw),
        mount(3, ARM_M, ARM_M, Spin::Cw), mount(4, -ARM_M, -ARM_M, Spin::Cw),
    ];
    let propulsion = Propulsion::from_definition(PropulsionDefinition {
        version: 1,
        motors: def.motors.iter().map(|m| MotorPropulsion {
            part_id: m.part_id.clone(), kv_rad_per_sv: 100.0, resistance_ohm: 0.1,
            no_load_current_a: 0.5, thrust_coef_ns2: 2e-5, torque_coef_nms2: 1e-7,
            inertia_kg_m2: 2e-5, throttle_map: None, reference_density_kg_m3: Some(RHO),
        }).collect(),
        battery: BatteryParams { open_circuit_voltage_v: 10.0, internal_resistance_ohm: 0.01, capacity_c: 18_720.0 },
    }, &def).unwrap();
    (Vehicle::from_definition(def).unwrap(), propulsion)
}

fn roll_step() -> StepTest {
    // controller/tests.rs:494-508 uses a 10 degree target at 1 s in a 10 s
    // run. Use the equivalent radians per second for the rate step.
    StepTest {
        step: Step::Rate { axis: RotationAxis::Roll, amplitude_radps: 10.0_f64.to_radians() / 1.0 },
        hold_s: 1.0,
        duration_s: 10.0,
        decimation_steps: 1,
    }
}

fn execute(v: &Vehicle, p: &Propulsion, spec: StepTest, cutoff: Cutoff, gains: Gains) -> Report {
    let hover = HoverStart::new(v, p, None, RHO, cutoff).unwrap();
    run(v, spec, hover, |flight| {
        let loop_ = FlightLoop::new(v, flight, p.yaw_ratio(), gains, PositionGains::px4_v1_13_3(), 0, HoverThrustParams::default())?;
        Ok((loop_, ()))
    }).unwrap().0
}

fn rate(sample: TraceSample<'_>) -> (f64, f64) {
    let Signal::Rate { setpoint_radps, measured_radps } = sample.sample.signal else {
        panic!("expected rate measurement");
    };
    (setpoint_radps, measured_radps)
}

// First nonzero body-rate sample, two ticks after the command. The first tick
// integrates the rotors, then the second uses their thrust (flight.rs:315-329,
// 348). Linearizing T=k_T*w² gives 2*k_T*w0*dw. The signed quad-X rows yield
// roll torque N*arm*2*k_T*w0*s, s=(w_plus-w_minus)/2. Rotor spin and yaw
// reactions cancel across the equal-and-opposite spin pair on each side.
//
// From propulsion.rs:140-150,296-303, the differential motor equation is
// s' = kt*delta*V/(J*R) - lambda*s - 2*k_Q*m*s/J, m=(w_plus+w_minus)/2-w0.
// The first-order pack-voltage perturbation cancels for antisymmetric duty.
// Advance the linear equation with the plant's RK4 (propulsion.rs:323-336).
// For the remainder, L bounds the stage derivative's speed sensitivity,
// including sag. Stage excursions satisfy E <= dt*B + dt*L*E where B is
// the largest initial speed derivative. The voltage and quadratic errors
// below bound the omitted terms at each RK4 stage. The final body-rate
// tolerance is their propagated bound plus the thrust product remainder.
fn first_roll_prediction(v: &Vehicle, p: &Propulsion, u: f64, rate_radps: f64) -> (f64, f64) {
    let m = &p.motors[0];
    let n = p.motors.len();
    let n_f = n as f64;
    let omega = (v.totals.mass_kg * STANDARD_GRAVITY / (n_f * m.k_thrust)).sqrt();
    let volt = p.pack_voltage(&vec![omega; n], &vec![u; n]);
    let g = Gains::px4_v1_13_3();
    let torque = (g.mc_rollrate_k * g.mc_rollrate_p + g.mc_rollrate_ff) * rate_radps;
    let mut allocator = Allocator::new(&v.definition.motors, p.yaw_ratio()).unwrap();
    let mixed = allocator.allocate([torque, 0.0, 0.0, u]);
    assert!(mixed.commands.iter().all(|d| (0.0..1.0).contains(d)));
    let delta = mixed.commands.iter().map(|d| (d - u).abs()).fold(0.0, f64::max);
    let volt_stepped = p.pack_voltage(&vec![omega; n], mixed.commands);
    let b = mixed.commands.iter().map(|d| m.omega_dot(omega, d * volt_stepped).abs()).fold(0.0, f64::max);
    let voltage_sensitivity = n_f * p.battery.internal_resistance_ohm * (u + delta) / (m.kv * m.r);
    let max_speed = m.kv * p.battery.open_circuit_voltage_v;
    let motor_gain = m.kt / (m.j * m.r);
    let lambda = (m.kt / (m.kv * m.r) + 2.0 * m.k_torque * omega) / m.j;
    let lipschitz = motor_gain * (u + delta) * voltage_sensitivity
        + (m.kt / (m.kv * m.r) + 2.0 * m.k_torque * max_speed) / m.j;
    assert!(lipschitz * DT < 1.0);
    let excursion = DT * b / (1.0 - DT * lipschitz);
    assert!(excursion < omega.min(max_speed - omega));
    let voltage_error = (volt_stepped - volt).abs() + voltage_sensitivity * excursion;
    let derivative_error = motor_gain * delta * voltage_error + 2.0 * m.k_torque * excursion.powi(2) / m.j;
    let speed_error = DT * derivative_error / (1.0 - DT * lambda);
    let a = -DT * lambda;
    let signed_speed = DT * motor_gain * delta * volt * (1.0 + a / 2.0 + a.powi(2) / 6.0 + a.powi(3) / 24.0);
    let rate_per_thrust_product = n_f * ARM_M * 2.0 * m.k_thrust * DT / v.totals.inertia[0];
    (
        rate_per_thrust_product * omega * signed_speed,
        rate_per_thrust_product * (omega * speed_error + excursion.powi(2)) + 1e-12, // flight_modes/tests.rs:6-8
    )
}

#[test]
fn roll_step_timing_tracking_and_small_signal_linearity() {
    let (v, p) = quad();
    let spec = roll_step();
    let gains = Gains::px4_v1_13_3();
    let cutoff = Cutoff::ChargeMah(p.battery.capacity_c / 3.6);
    let full = execute(&v, &p, spec, cutoff, gains);
    let Step::Rate { axis, amplitude_radps } = spec.step else { unreachable!() };
    let half = execute(&v, &p, StepTest {
        step: Step::Rate { axis, amplitude_radps: amplitude_radps / 2.0 },
        ..spec
    }, cutoff, gains);
    assert_eq!(full.end_reason, StepTestEnd::Duration);
    assert_eq!(full.trace.samples().next().unwrap().sample.time_s, 0.0);
    assert_eq!(full.step_time_s, spec.hold_s);
    let hold = steps_for(spec.hold_s) as usize;
    assert_eq!(rate(full.trace.samples().nth(hold - 1).unwrap()).0, 0.0);
    let onset = full.trace.samples().nth(hold).unwrap();
    assert_eq!(onset.sample.time_s, spec.hold_s);
    assert_eq!(rate(onset).0, amplitude_radps);
    assert!(rate(full.trace.samples().last().unwrap()).1 > 0.0);
    // Same 1% tracking budget as controller/tests.rs:508.
    assert!((rate(full.trace.samples().last().unwrap()).1 - amplitude_radps).abs() < amplitude_radps / 100.0);
    let (full_prediction, full_tol) = first_roll_prediction(&v, &p, full.hover_collective_01, amplitude_radps);
    let (half_prediction, half_tol) = first_roll_prediction(&v, &p, half.hover_collective_01, amplitude_radps / 2.0);
    let full_response = rate(full.trace.samples().nth(hold + 2).unwrap()).1;
    let half_response = rate(half.trace.samples().nth(hold + 2).unwrap()).1;
    for (response, predicted, tol) in [(full_response, full_prediction, full_tol), (half_response, half_prediction, half_tol)] {
        assert!((response - predicted).abs() <= tol, "{response} vs {predicted} within {tol}");
    }
    let tol = full_tol / 2.0 + half_tol + (full_prediction / 2.0 - half_prediction).abs();
    assert!((full_response / 2.0 - half_response).abs() <= tol);
}

#[test]
fn decimation_keeps_every_nth_sample_without_changing_the_run() {
    let (v, p) = quad();
    let cutoff = Cutoff::ChargeMah(p.battery.capacity_c / 3.6);
    let gains = Gains::px4_v1_13_3();
    let spec = roll_step();
    let full = execute(&v, &p, spec, cutoff, gains);
    let repeated = execute(&v, &p, spec, cutoff, gains);
    let decimation_steps = v.definition.motors.len() as u64;
    let decimated = execute(&v, &p, StepTest { decimation_steps, ..spec }, cutoff, gains);
    assert_eq!(full.state_hash, repeated.state_hash);
    assert_eq!(full.state_hash, decimated.state_hash);
    assert!(decimated.trace.samples().eq(full.trace.samples().step_by(decimation_steps as usize)));
}

#[test]
fn step_commands_cover_each_axis_and_keep_the_hover_reference() {
    let starting_com = quad().0.totals.com;
    let amplitude = roll_step().hold_s;
    for axis in [RotationAxis::Roll, RotationAxis::Pitch, RotationAxis::Yaw] {
        let (rate, _) = command(Step::Rate { axis, amplitude_radps: amplitude }, true, starting_com, 0.5);
        let FlightCommand::Rates { body_radps, collective } = rate else { panic!() };
        assert_eq!(body_radps[axis as usize], amplitude);
        assert_eq!(collective, 0.5);
        let (attitude, _) = command(Step::Attitude { axis, amplitude_rad: amplitude }, true, starting_com, 0.5);
        let FlightCommand::AttitudeSetpoint { attitude, yaw_rate, collective } = attitude else { panic!() };
        assert_eq!(attitude[axis as usize], (amplitude / 2.0).sin());
        assert_eq!(yaw_rate, 0.0);
        assert_eq!(collective, 0.5);
    }
    for step in [Step::Position { axis: HorizontalAxis::X, amplitude_m: amplitude },
        Step::Position { axis: HorizontalAxis::Y, amplitude_m: amplitude }, Step::Altitude { amplitude_m: amplitude }]
    {
        let (cmd, _) = command(step, true, starting_com, 0.5);
        let FlightCommand::PositionSetpoint(sp) = cmd else { panic!() };
        let axis = position_axis(step);
        assert_eq!(sp.position[axis], starting_com[axis] + amplitude);
        assert!(sp.velocity.iter().all(|x| x.is_nan()));
    }
}

#[test]
fn refuses_missing_inertia_and_unreachable_step_and_returns_cutoff_trace() {
    let (v, mut p) = quad();
    // scenario/tests.rs:338-347 uses 11 V to end a 10 V pack on the first step.
    let cutoff = Cutoff::VoltageV(11.0);
    let spec = roll_step();
    let short = execute(&v, &p, spec, cutoff, Gains::px4_v1_13_3());
    assert_eq!(short.end_reason, StepTestEnd::VoltageCutoff);
    assert_eq!(short.elapsed_s, DT);
    assert_eq!(short.trace.samples().len(), 1);
    assert!(StepTest { hold_s: spec.duration_s, ..spec }.timing().unwrap_err().contains("holdS"));
    assert!(StepTest { decimation_steps: 0, ..spec }.timing().unwrap_err().contains("decimationSteps"));
    p.motors[0].j = 0.0;
    assert!(HoverStart::new(&v, &p, None, RHO, cutoff).err().unwrap().contains("inertiaKgM2"));
}

#[test]
fn controller_failure_returns_samples_from_before_the_error() {
    let (v, p) = quad();
    let spec = StepTest {
        step: Step::Rate { axis: RotationAxis::Roll, amplitude_radps: f64::MAX },
        hold_s: DT,
        duration_s: 2.0 * DT,
        decimation_steps: 1,
    };
    // This gain has no upper bound (controller.rs:184). The deliberately
    // extreme gain and reference overflow the allocator's demand at onset.
    let gains = Gains { mc_rollrate_k: f64::MAX, ..Gains::px4_v1_13_3() };
    let report = execute(&v, &p, spec, Cutoff::ChargeMah(p.battery.capacity_c / 3.6), gains);
    assert_eq!(report.end_reason, StepTestEnd::Error);
    assert!(report.error.is_some());
    assert_eq!(report.elapsed_s, DT);
    assert_eq!(report.trace.samples().len(), 1);
}

/// A CoM 5 mm forward (any real build has some offset): the test starts, reports the torque
/// offset x weight about the pitch axis, and the hold trims it.
#[test]
fn an_offset_centre_of_mass_is_reported_and_trimmed_during_the_hold() {
    let (centred, p) = quad();
    let mut def = with_totals(vec![box_part("body", 1.0, [0.005, 0.0, 0.0], [0.01, 0.01, 0.02, 0.0, 0.0, 0.0])]);
    def.motors = centred.definition.motors.clone();
    let v = Vehicle::from_definition(def).unwrap();
    let spec = StepTest { step: Step::Altitude { amplitude_m: 1.0 }, hold_s: 5.0, duration_s: 15.0, decimation_steps: 10 };
    let report = execute(&v, &p, spec, Cutoff::VoltageV(1.0), Gains::px4_v1_13_3());
    let expected = 0.005 * 1.0 * STANDARD_GRAVITY;
    assert!((report.start_imbalance_nm[1].abs() - expected).abs() < 1e-9 * expected.max(1.0), "{:?}", report.start_imbalance_nm);
    assert!(report.start_imbalance_nm[0].abs() < 1e-12);
    assert_eq!(report.end_reason, StepTestEnd::Duration);
    let last = report.trace.samples().last().unwrap();
    let Signal::Position { setpoint_m, measured_m } = last.sample.signal else { panic!("expected position") };
    // 5 % of the step: the settled band, not a tuning claim.
    assert!((measured_m - setpoint_m).abs() < 0.05, "{measured_m} vs {setpoint_m}");
}

#[test]
fn gyro_bias_shifts_the_true_steady_rate_in_the_opposite_direction() {
    use crate::gyro_filters::GyroFilterConfig;
    use crate::sensors::{ImuConfig, SensorConfig, Sensors};
    let (v, p) = quad();
    let cutoff = Cutoff::ChargeMah(p.battery.capacity_c / 3.6);
    // Same duration as roll_step() with a zero rate command to isolate the bias.
    let spec = StepTest {
        step: Step::Rate { axis: RotationAxis::Yaw, amplitude_radps: 0.0 },
        decimation_steps: 10,
        ..roll_step()
    };
    // Reuse the roll step amplitude as the constant residual yaw gyro bias.
    let bias = 10.0_f64.to_radians();
    let sensors = Sensors::new(0, SensorConfig {
        gyro: Some(ImuConfig {
            noise_sigma: 0.0, vibration_sigma: 0.0, bias: [0.0, 0.0, bias],
            random_walk: 0.0, delay_steps: 0, range: None,
        }),
        fly_on_gyro: Some(GyroFilterConfig {
            gyro_cutoff_hz: 40.0, dgyro_cutoff_hz: 30.0, notch0: None, notch1: None,
        }),
        ..Default::default()
    }).unwrap();
    let hover = HoverStart::new(&v, &p, None, RHO, cutoff).unwrap();
    let (report, ()) = run_with_sensors(&v, spec, hover, Some(sensors), |flight| {
        let loop_ = FlightLoop::new(&v, flight, p.yaw_ratio(), Gains::px4_v1_13_3(),
            PositionGains::px4_v1_13_3(), 0, HoverThrustParams::default())?;
        Ok((loop_, ()))
    }).unwrap();
    let column = report.rate_loop_feedback.unwrap();
    assert_eq!(report.end_reason, StepTestEnd::Duration);
    assert_eq!(column.len(), report.trace.samples().len());
    assert!(!column[0].from_gyro);
    assert!(column[1].from_gyro);
    let true_rate = rate(report.trace.samples().last().unwrap()).1;
    let gyro = column.last().unwrap().rate_used_radps[2];
    // Same 2% steady band used for step metrics (step-response.ts:44).
    assert!((true_rate + bias).abs() < 0.02 * bias, "true rate={true_rate}, residual bias={bias}");
    assert!(gyro.abs() < 0.02 * bias, "gyro rate={gyro}");
}
