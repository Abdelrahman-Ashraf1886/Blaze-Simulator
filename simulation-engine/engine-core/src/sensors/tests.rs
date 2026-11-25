use super::*;

const SIM: SimConfig = SimConfig { dt_s: crate::sim::DEFAULT_DT_S, gravity_mps2: STANDARD_GRAVITY };

// Shared with tests/unit/sensors.test.ts. Pressures calculated from
// atmosphere.ts:72–79 and database/reference/physics.v1.json:12–102.
const ISA_FIXTURE: &str = r#"
[
  [-5000, 177686.975465047],
  [0, 101325],
  [1000, 89874.57050221058],
  [11000, 22632.06397346292]
]
"#;

fn state(steps: u64) -> SimState {
    SimState {
        steps, time_s: steps as f64 * SIM.dt_s,
        position_m: [0.0; 3], quaternion: [0.0, 0.0, 0.0, 1.0], com_m: [0.0; 3],
        linear_velocity_mps: [0.0; 3], angular_velocity_radps: [0.0; 3],
        angular_velocity_body_radps: [0.0; 3],
    }
}

fn imu() -> ImuConfig {
    ImuConfig {
        noise_sigma: 0.0, vibration_sigma: 0.0, bias: [0.0; 3],
        random_walk: 0.0, delay_steps: 0, range: None,
    }
}

#[test]
fn isa_pressure_and_inverse_match_the_shared_fixture() {
    let cases: Vec<[f64; 2]> = serde_json::from_str(ISA_FIXTURE).unwrap();
    for [altitude, pressure] in cases {
        let actual = isa_pressure(altitude).unwrap();
        // Different deterministic math implementations can differ by a few ULPs.
        assert!((actual - pressure).abs() <= 1e-8, "{altitude}: {actual} vs {pressure}");
        assert!((isa_altitude(actual).unwrap() - altitude).abs() <= 1e-8);
    }
    assert_eq!(isa_pressure(ISA_MAX_ALTITUDE_M + 1.0), None);
    assert_eq!(isa_altitude(0.0), None);
}

#[test]
fn spinning_mount_specific_force_uses_the_post_step_pose_and_com() {
    let mut before = state(0);
    let mut after = state(1);
    // A 90-degree CCW yaw maps body +X to world +Y. The CoM is at body
    // [1,0,0], and the mount is at [3,0,0], so r = [2,0,0].
    let q = std::f64::consts::FRAC_1_SQRT_2;
    after.quaternion = [0.0, 0.0, q, q];
    after.position_m = [4.0, 5.0, 6.0];
    after.com_m = [4.0, 6.0, 6.0];
    // CoM acceleration +3 world Y, omega +2 Z, alpha +4 Z.
    after.linear_velocity_mps = [0.0, 3.0 * SIM.dt_s, 0.0];
    before.angular_velocity_radps[2] = 2.0 - 4.0 * SIM.dt_s;
    after.angular_velocity_radps[2] = 2.0;
    after.angular_velocity_body_radps[2] = 2.0;
    let config = SensorConfig { accelerometer: Some((imu(), [3.0, 0.0, 0.0])), ..Default::default() };
    let mut sensors = Sensors::new(0, config).unwrap();
    sensors.observe(before, SIM);
    assert_eq!(sensors.accelerometer(), None);
    sensors.observe(after, SIM);
    // R⁻¹(a-g) = [3,0,g], α×r = [0,8,0], ω×(ω×r) = [-8,0,0].
    for (actual, expected) in sensors.accelerometer().unwrap().value.into_iter().zip([-5.0, 8.0, STANDARD_GRAVITY]) {
        assert!((actual - expected).abs() < 1e-10, "{actual} vs {expected}");
    }
}

#[test]
fn delayed_impulse_preserves_clipping_flags_and_slow_samples_hold() {
    let config = SensorConfig {
        gyro: Some(ImuConfig { bias: [1.0, 0.0, 0.0], delay_steps: 2, range: Some(3.0), ..imu() }),
        gps: Some(GpsConfig {
            position_sigma_horizontal_m: 0.0, position_sigma_vertical_m: 0.0,
            velocity_sigma_mps: 0.0, period_steps: 3, delay_steps: 1,
        }),
        ..Default::default()
    };
    let mut sensors = Sensors::new(0, config).unwrap();
    for step in 0..=6 {
        let mut truth = state(step);
        if step == 1 { truth.angular_velocity_body_radps = [4.0, -4.0, 3.0]; }
        truth.com_m[0] = step as f64;
        truth.linear_velocity_mps[1] = -(step as f64);
        sensors.observe(truth, SIM);
        let gyro = match step {
            0..=2 => None,
            3 => Some(ImuSample { value: [3.0, -3.0, 3.0], clipped: [true, true, false] }),
            _ => Some(ImuSample { value: [1.0, 0.0, 0.0], clipped: [false; 3] }),
        };
        assert_eq!(sensors.gyro(), gyro, "step {step}");
        let acquired = match step {
            0..=1 => None,
            2..=4 => Some(1.0),
            _ => Some(4.0),
        };
        assert_eq!(sensors.gps(), acquired.map(|x| GpsSample {
            position_m: [x, 0.0, 0.0], velocity_mps: [0.0, -x, 0.0],
        }), "step {step}");
    }
}

// Gaussian two-sided tail bound for the mean and Laurent–Massart chi-square
// bounds for unbiased sample variance, each with coverage at least 99.9%.
fn gaussian_bounds(samples: &[f64], expected_mean: f64, expected_variance: f64) {
    let n = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / n;
    let df = n - 1.0;
    let variance = samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / df;
    let x = (2.0_f64 / 0.001).ln();
    let mean_margin = (2.0 * x * expected_variance / n).sqrt();
    let variance_margin = 2.0 * (x / df).sqrt();
    let lower = expected_variance * (1.0 - variance_margin);
    let upper = expected_variance * (1.0 + variance_margin + 2.0 * x / df);
    assert!((mean - expected_mean).abs() <= mean_margin, "mean {mean}, expected {expected_mean} ± {mean_margin}");
    assert!((lower..=upper).contains(&variance), "variance {variance}, bounds [{lower}, {upper}]");
}

#[test]
fn white_noise_and_vibration_have_the_expected_mean_and_sample_variance() {
    let config = ImuConfig { noise_sigma: 2.0, vibration_sigma: 3.0, bias: [4.0; 3], ..imu() };
    let mut sensors = Sensors::new(19, SensorConfig { gyro: Some(config), ..Default::default() }).unwrap();
    sensors.observe(state(0), SIM);
    let mut axes = [vec![], vec![], vec![]];
    for step in 1..=16_384 {
        sensors.observe(state(step), SIM);
        for (axis, value) in axes.iter_mut().zip(sensors.gyro().unwrap().value) {
            axis.push(value);
        }
    }
    for samples in &axes {
        gaussian_bounds(samples, 4.0, 2.0_f64.powi(2) + 3.0_f64.powi(2));
    }
    assert_ne!(axes[0], axes[1]);
    assert_ne!(axes[1], axes[2]);
}

#[test]
fn random_walk_variance_grows_linearly_with_elapsed_time() {
    const DENSITY: f64 = 2.0;
    const EARLY: u64 = 16;
    const LATE: u64 = 64;
    let mut early = Vec::new();
    let mut late = Vec::new();
    for seed in 0..4096 {
        let config = ImuConfig { random_walk: DENSITY, ..imu() };
        let mut sensors = Sensors::new(seed, SensorConfig { gyro: Some(config), ..Default::default() }).unwrap();
        sensors.observe(state(0), SIM);
        for step in 1..=LATE {
            sensors.observe(state(step), SIM);
            if step == EARLY { early.push(sensors.gyro().unwrap().value[0]); }
        }
        late.push(sensors.gyro().unwrap().value[0]);
    }
    gaussian_bounds(&early, 0.0, DENSITY.powi(2) * EARLY as f64 * SIM.dt_s);
    gaussian_bounds(&late, 0.0, DENSITY.powi(2) * LATE as f64 * SIM.dt_s);
}

#[test]
fn gyro_feedback_waits_for_the_delayed_sample() {
    let mut sensors = Sensors::new(19, SensorConfig {
        gyro: Some(ImuConfig { delay_steps: 2, ..imu() }),
        fly_on_gyro: Some(GyroFilterConfig {
            gyro_cutoff_hz: 0.0, dgyro_cutoff_hz: 0.0, notch0: None, notch1: None,
        }),
        ..Default::default()
    }).unwrap();
    let mut truth = state(0);
    truth.angular_velocity_body_radps = [1.0, 2.0, 3.0];
    let config = SimConfig::default();
    sensors.observe(truth, config);
    let initial = sensors.rate_feedback().unwrap();
    assert!(!initial.from_gyro);
    assert_eq!(initial.rate_radps, truth.angular_velocity_body_radps);
    for step in 1..=4 {
        let mut truth = state(step);
        truth.angular_velocity_body_radps = [step as f64 * 2.0; 3];
        sensors.observe(truth, config);
        let feedback = sensors.rate_feedback().unwrap();
        match step {
            1 | 2 => assert_eq!(feedback, initial),
            3 | 4 => {
                assert!(feedback.from_gyro);
                assert_eq!(feedback.rate_radps, sensors.gyro().unwrap().value);
                let expected = if step == 3 { 0.0 } else { 2.0 / config.dt_s };
                assert_eq!(feedback.acceleration_radps2, [expected; 3]);
            }
            _ => unreachable!(),
        }
    }
}
