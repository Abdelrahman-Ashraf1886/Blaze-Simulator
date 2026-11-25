use super::*;
use std::f64::consts::{PI, SQRT_2, TAU};

type Equation = ([f64; 3], [f64; 2]);

fn reference_low_pass(hz: f64) -> Equation {
    // Bilinear transform of 1 / (s² + sqrt(2)s + 1), prewarped at the cutoff.
    let g = (PI * hz / f64::from(SAMPLE_HZ)).tan();
    let norm = 1.0 / (1.0 + SQRT_2 * g + g * g);
    ([g * g * norm, 2.0 * g * g * norm, g * g * norm],
     [2.0 * (g * g - 1.0) * norm, (1.0 - SQRT_2 * g + g * g) * norm])
}

fn reference_notch(hz: f64, width: f64) -> Equation {
    // Reciprocal zeros on the unit circle, with the PX4 bandwidth transform.
    let middle = -2.0 * (TAU * hz / f64::from(SAMPLE_HZ)).cos();
    let damping = (PI * width / f64::from(SAMPLE_HZ)).tan();
    let norm = 1.0 + damping;
    ([1.0 / norm, middle / norm, 1.0 / norm], [middle / norm, (1.0 - damping) / norm])
}

fn reference_alpha(hz: f64) -> Equation {
    // Backward Euler on the one-pole RC filter.
    let rc = f64::from(SAMPLE_HZ) / (TAU * hz);
    ([1.0 / (1.0 + rc), 0.0, 0.0], [-rc / (1.0 + rc), 0.0])
}

fn response((b, a): Equation, w: f64) -> (f64, f64) {
    let real = |c: [f64; 3]| c[0] + c[1] * w.cos() + c[2] * (2.0 * w).cos();
    let imag = |c: [f64; 3]| -c[1] * w.sin() - c[2] * (2.0 * w).sin();
    let den = [1.0, a[0], a[1]];
    let (br, bi, ar, ai) = (real(b), imag(b), real(den), imag(den));
    (br.hypot(bi) / ar.hypot(ai), bi.atan2(br) - ai.atan2(ar))
}

fn assert_response(create: impl Fn() -> Box<dyn FnMut(f32) -> f32>, equation: Equation, bins: &[u32]) {
    // Project the steady sinusoid onto in-phase and quadrature bases. Integer
    // bins over one second avoid spectral leakage. Discard one second first.
    let samples = SAMPLE_HZ as u32;
    for &hz in bins {
        let w = TAU * f64::from(hz) / f64::from(samples);
        let mut apply = create();
        let mut measured = (0.0, 0.0);
        for n in 0..2 * samples {
            let (s, c) = (w * f64::from(n)).sin_cos();
            let y = f64::from(apply(s as f32));
            if n >= samples {
                measured.0 += y * s * 2.0 / f64::from(samples);
                measured.1 += y * c * 2.0 / f64::from(samples);
            }
        }
        let (gain, phase) = response(equation, w);
        // Cartesian phasor comparison also works at the notch zero, where
        // phase has no meaning. Tolerance allows the port's f32 arithmetic.
        assert!((measured.0 - gain * phase.cos()).abs() < 4e-5, "{hz} Hz in-phase");
        assert!((measured.1 - gain * phase.sin()).abs() < 4e-5, "{hz} Hz quadrature");
    }
    let (b, a) = equation;
    let mut impulse = Vec::new();
    let mut apply = create();
    assert_eq!(apply(0.0), 0.0);
    for n in 0_usize..128 {
        // Step response is the sum of the impulse response, computed in
        // f64 from the transfer polynomial and zero initial conditions.
        let at = |delay| n.checked_sub(delay).map_or(0.0, |k| impulse[k]);
        impulse.push(b.get(n).copied().unwrap_or(0.0) - a[0] * at(1) - a[1] * at(2));
        let expected = impulse.iter().sum::<f64>();
        assert!((f64::from(apply(1.0)) - expected).abs() < 4e-5, "step sample {n}");
    }
}

#[test]
fn two_pole_rate_response_and_reset() {
    // PX4 gyro defaults from database/reference/physics.v1.json:1540–1548.
    let hz = 40.0;
    assert_response(|| {
        let mut filter = LowPass::new(hz);
        Box::new(move |x| filter.apply(x))
    }, reference_low_pass(f64::from(hz)), &[10, 40, 100, 300]);
    let mut filter = LowPass::new(hz);
    filter.apply(3.0);
    filter.reset(-2.0);
    for _ in 0..16 {
        assert!((filter.apply(-2.0) + 2.0).abs() < 4e-5);
    }
}

#[test]
fn static_notch_response_and_reset() {
    // Diagnostic center below Nyquist, with reference bandwidth (physics.v1.json:1596–1604).
    let config = NotchConfig { frequency_hz: SAMPLE_HZ / 8.0, bandwidth_hz: 20.0 };
    assert_response(|| {
        let mut filter = Notch::new(config).unwrap();
        Box::new(move |x| filter.apply(x))
    }, reference_notch(f64::from(config.frequency_hz), f64::from(config.bandwidth_hz)),
       &[10, 100, 125, 150, 300]);
    let mut filter = Notch::new(config).unwrap();
    filter.apply(3.0);
    filter.apply(4.0);
    filter.initialized = false;
    for _ in 0..16 {
        assert!((filter.apply(-2.0) + 2.0).abs() < 4e-5);
    }
}

#[test]
fn acceleration_alpha_response_and_zero_initial_derivative() {
    // PX4 angular-acceleration default from physics.v1.json:1554–1562.
    let hz = 30.0;
    assert_response(|| {
        let mut filter = Alpha::new(hz);
        Box::new(move |x| filter.apply(x))
    }, reference_alpha(f64::from(hz)), &[10, 30, 100, 300]);
    let mut filters = GyroFilters::new(GyroFilterConfig {
        gyro_cutoff_hz: 40.0, dgyro_cutoff_hz: hz, notch0: None, notch1: None,
    });
    let start = filters.apply([1.0, 2.0, -3.0]);
    assert_eq!(start.acceleration_radps2, [0.0; 3]);
    for (rate, expected) in start.rate_radps.into_iter().zip([1.0, 2.0, -3.0]) {
        assert!((rate - expected).abs() < 4e-5);
    }
}

#[test]
fn px4_bypasses_zero_and_nyquist() {
    for hz in [0.0, SAMPLE_HZ / 2.0, SAMPLE_HZ] {
        let config = NotchConfig { frequency_hz: hz, bandwidth_hz: 20.0 };
        assert!(Notch::new(config).is_none());
        assert_eq!(LowPass::new(hz).apply(2.0), 2.0);
        assert_eq!(Alpha::new(hz).apply(3.0), 3.0);
    }
}
