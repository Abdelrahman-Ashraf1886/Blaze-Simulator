use super::*;
use serde_json::Value;

// Synthetic, level vehicle sampled at 50 Hz. T/h is thrust divided by weight.
const PERIOD_US: u64 = 20_000;

fn airborne() -> HoverThrustSample {
    HoverThrustSample {
        timestamp_us: 0,
        armed: true,
        landed: false,
        distance_above_ground_m: 2.0,
        vertical_acceleration_up_m_s2: 0.0,
        vertical_thrust_up: 0.5,
        vertical_velocity_up_m_s: 0.0,
        horizontal_speed_m_s: 0.0,
    }
}

fn advance(
    filter: &mut HoverThrustEstimator,
    s: &mut HoverThrustSample,
    n: usize,
) -> HoverThrustEstimate {
    for _ in 0..n {
        s.timestamp_us += PERIOD_US;
        filter.step(*s);
    }
    filter.estimate()
}

fn close(actual: f64, expected: f64) {
    // Absolute tolerance for hand calculations with f64, in the tested units.
    assert!((actual - expected).abs() <= 1e-12, "{actual} != {expected}");
}

#[test]
fn defaults_and_inclusive_bounds_match_reference() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../database/reference/physics.v1.json"
    ))
    .unwrap();
    let defaults = HoverThrustParams::default();
    let set = |id: &str| {
        data["sets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["values"]
            .as_array()
            .unwrap()
    };
    let entries = set("px4HoverThrust");
    assert_eq!(entries.len(), 6);
    for entry in entries {
        let mut p = defaults;
        let field = |p: &mut HoverThrustParams, value: f64| match entry["key"].as_str().unwrap() {
            "HTE_HT_NOISE" => std::mem::replace(&mut p.hte_ht_noise, value),
            "HTE_ACC_GATE" => std::mem::replace(&mut p.hte_acc_gate, value),
            "HTE_HT_ERR_INIT" => std::mem::replace(&mut p.hte_ht_err_init, value),
            "HTE_VXY_THR" => std::mem::replace(&mut p.hte_vxy_thr, value),
            "HTE_VZ_THR" => std::mem::replace(&mut p.hte_vz_thr, value),
            "HTE_THR_RANGE" => std::mem::replace(&mut p.hte_thr_range, value),
            unknown => panic!("unmapped {unknown}"),
        };
        let min = entry["min"].as_f64().unwrap();
        let max = entry["max"].as_f64().unwrap();
        assert_eq!(field(&mut p, min), entry["value"].as_f64().unwrap());
        assert!(p.validate().is_ok());
        field(&mut p, max);
        assert!(p.validate().is_ok());
        for bad in [min.next_down(), max.next_up(), f64::INFINITY, f64::NAN] {
            field(&mut p, bad);
            assert!(HoverThrustEstimator::new(p).is_err());
        }
    }
    let mpc = |key: &str| {
        set("px4").iter().find(|e| e["key"] == key).unwrap()["value"]
            .as_f64()
            .unwrap()
    };
    assert_eq!(defaults.mpc_thr_hover, mpc("MPC_THR_HOVER"));
    assert_eq!(u8::from(defaults.mpc_use_hte) as f64, mpc("MPC_USE_HTE"));
}

#[test]
fn converges_to_closed_form_hover_thrust_with_either_acceleration_sign() {
    for acceleration in [-2.0, 2.0] {
        let mut f = HoverThrustEstimator::new(Default::default()).unwrap();
        let mut s = airborne();
        s.vertical_acceleration_up_m_s2 = acceleration;
        let true_hover = s.vertical_thrust_up / (1.0 + acceleration / G);
        let result = advance(&mut f, &mut s, 10_000);
        assert!(result.valid);
        assert!((result.hover_thrust - true_hover).abs() < result.variance.sqrt());
    }
}

#[test]
fn mass_step_response_matches_the_rate_implied_by_process_noise() {
    let dt = PERIOD_US as f64 * 1e-6;
    for noise in [0.0036, 0.036] {
        let p = HoverThrustParams {
            hte_ht_noise: noise,
            ..Default::default()
        };
        let mut f = HoverThrustEstimator::new(p).unwrap();
        let mut s = airborne();
        let hover = s.vertical_thrust_up;
        let q = (noise * dt).powi(2);
        // At equilibrium T=h, |H|=g/h and the learned acceleration variance
        // is at its floor R=1. The scalar Riccati equation gives P(P+q)=qR/H².
        let h2 = (G / hover).powi(2);
        let p_inf = ((q * q + 4.0 * q / h2).sqrt() - q) / 2.0;
        close(advance(&mut f, &mut s, 20_000).variance, p_inf);
        let retained = 1.0 / (1.0 + h2 * (p_inf + q));
        let samples = (-1.0 / retained.ln()).ceil() as usize;
        // The linearized response after about one time constant is 1-(1-KH)^n.
        // Central difference in fractional mass cancels first-order nonlinear error.
        let response = |fraction: f64| {
            let mut stepped = f.clone();
            let mut input = s;
            input.vertical_acceleration_up_m_s2 = G / (1.0 + fraction) - G;
            advance(&mut stepped, &mut input, samples).hover_thrust
        };
        let fraction = 1e-4;
        let slope = (response(fraction) - response(-fraction)) / (2.0 * fraction * hover);
        assert!((slope - (1.0 - retained.powf(samples as f64))).abs() < 10.0 * fraction.powi(2));

        // A finite 20% payload increase at the same thrust lowers acceleration.
        s.vertical_acceleration_up_m_s2 = G / 1.2 - G;
        let tracked = advance(&mut f, &mut s, 15 * samples);
        assert!((tracked.hover_thrust - hover * 1.2).abs() < tracked.variance.sqrt());
    }
}

#[test]
fn speed_scales_measurement_noise_by_the_larger_excess_squared() {
    for (vz, vxy, scale) in [(2.0, 10.0, 1.0), (-4.0, 0.0, 3.0), (4.0, 14.0, 5.0)] {
        let p = HoverThrustParams::default();
        let mut f = HoverThrustEstimator::new(p).unwrap();
        let mut s = airborne();
        s.vertical_velocity_up_m_s = vz;
        s.horizontal_speed_m_s = vxy;
        s.vertical_acceleration_up_m_s2 = -1.0;
        let prior = p.hte_ht_err_init.powi(2) + (p.hte_ht_noise * PERIOD_US as f64 * 1e-6).powi(2);
        let h = -G / p.mpc_thr_hover;
        let r = INITIAL_ACCEL_VARIANCE * scale * scale;
        let post = 1.0 / (1.0 / prior + h * h / r);
        let result = advance(&mut f, &mut s, 1);
        close(result.variance, post);
        close(
            result.hover_thrust,
            p.mpc_thr_hover + post * h / r * s.vertical_acceleration_up_m_s2,
        );
    }
}

#[test]
fn outliers_are_gated_and_persistent_rejection_increases_uncertainty() {
    let p = HoverThrustParams::default();
    let mut f = HoverThrustEstimator::new(p).unwrap();
    let mut s = airborne();
    s.vertical_acceleration_up_m_s2 = 1_000.0;
    let q = (p.hte_ht_noise * PERIOD_US as f64 * 1e-6).powi(2);
    // Every test ratio saturates the signed LPF input at +1. With tau=1 s
    // it first exceeds 0.2 after ceil(ln(0.8)/ln(1-alpha)) rejections.
    let n = (0.8_f64.ln() / (1.0 / (1.0 + PERIOD_US as f64 * 1e-6)).ln()).ceil() as usize;
    let gated = advance(&mut f, &mut s, n);
    close(gated.variance, p.hte_ht_err_init.powi(2) + n as f64 * q);
    let bumped = advance(&mut f, &mut s, 1);
    close(bumped.variance - gated.variance, (1.0 + 1e3) * q);
    assert_eq!(bumped.hover_thrust, p.mpc_thr_hover);
    assert!(!bumped.valid);
}

#[test]
fn estimate_stops_at_both_configured_bounds() {
    let p = HoverThrustParams {
        hte_thr_range: 0.05,
        ..Default::default()
    };
    for (true_hover, limit) in [
        (0.4, p.mpc_thr_hover - p.hte_thr_range),
        (0.6, p.mpc_thr_hover + p.hte_thr_range),
    ] {
        let mut f = HoverThrustEstimator::new(p).unwrap();
        let mut s = airborne();
        s.vertical_acceleration_up_m_s2 = G * (s.vertical_thrust_up / true_hover - 1.0);
        assert_eq!(advance(&mut f, &mut s, 2_000).hover_thrust, limit);
    }
}

#[test]
fn a_zero_bound_update_leaves_the_filter_usable() {
    let params = HoverThrustParams {
        mpc_thr_hover: 0.1,
        ..Default::default()
    };
    let mut filter = HoverThrustEstimator::new(params).unwrap();
    let mut sample = airborne();
    sample.vertical_thrust_up = params.mpc_thr_hover;
    let prior = params.hte_ht_err_init.powi(2) + (params.hte_ht_noise * PERIOD_US as f64 * 1e-6).powi(2);
    let h = -G / params.mpc_thr_hover;
    let innovation_variance = h * prior * h + INITIAL_ACCEL_VARIANCE;
    let gain = prior * h / innovation_variance;
    // At T=h the predicted acceleration is zero. Force the unconstrained
    // posterior below zero while staying inside the innovation gate.
    sample.vertical_acceleration_up_m_s2 = 1.1 * params.mpc_thr_hover / -gain;
    assert!(sample.vertical_acceleration_up_m_s2 < params.hte_acc_gate * innovation_variance.sqrt());
    let rejected = advance(&mut filter, &mut sample, 1);
    assert_eq!(rejected.hover_thrust, params.mpc_thr_hover);
    assert!(!rejected.valid);
    close(rejected.variance, prior);
    sample.vertical_acceleration_up_m_s2 = 0.0;
    assert!(advance(&mut filter, &mut sample, 400).valid);
}

#[test]
fn first_valid_requires_two_seconds_of_passing_requests_then_survives_an_outlier() {
    let p = HoverThrustParams {
        hte_ht_err_init: 0.0,
        ..Default::default()
    };
    let mut f = HoverThrustEstimator::new(p).unwrap();
    let mut s = airborne();
    assert!(!advance(&mut f, &mut s, 100).valid);
    s.vertical_acceleration_up_m_s2 = 1_000.0;
    assert!(!advance(&mut f, &mut s, 1).valid); // restarts acquisition
    s.vertical_acceleration_up_m_s2 = 0.0;
    assert!(!advance(&mut f, &mut s, 100).valid);
    assert!(advance(&mut f, &mut s, 1).valid); // 100 intervals since first pass
    s.vertical_acceleration_up_m_s2 = 1_000.0;
    assert!(advance(&mut f, &mut s, 1).valid);
    f.set_params(HoverThrustParams {
        hte_ht_err_init: 1.0,
        ..p
    })
    .unwrap();
    assert!(!advance(&mut f, &mut s, 1).valid); // variance alone now fails
}

#[test]
fn clearance_latches_until_landing_and_disarm_restores_the_prior() {
    let mut f = HoverThrustEstimator::new(Default::default()).unwrap();
    let initial = f.estimate();
    let mut s = airborne();
    s.distance_above_ground_m = 1.0;
    s.vertical_acceleration_up_m_s2 = -1.0;
    assert_eq!(advance(&mut f, &mut s, 200), initial);
    s.distance_above_ground_m = 1.0_f64.next_up();
    advance(&mut f, &mut s, 1);
    s.distance_above_ground_m = 0.5;
    let flying = advance(&mut f, &mut s, 400);
    assert!(flying.valid);
    assert!(flying.hover_thrust > initial.hover_thrust);
    s.landed = true;
    let frozen = HoverThrustEstimate {
        valid: false,
        ..flying
    };
    assert_eq!(advance(&mut f, &mut s, 10), frozen);
    s.landed = false;
    assert_eq!(advance(&mut f, &mut s, 10), frozen);
    s.armed = false;
    assert_eq!(advance(&mut f, &mut s, 1), initial);
    assert_eq!(f.accel_variance, INITIAL_ACCEL_VARIANCE);
}

#[test]
fn timing_gates_and_nonfinite_measurements_follow_module_order() {
    let p = HoverThrustParams::default();
    let mut f = HoverThrustEstimator::new(p).unwrap();
    let mut s = airborne();
    let valid = advance(&mut f, &mut s, 400);
    s.vertical_thrust_up = f64::NAN; // prediction only, no new validity request
    let predicted = advance(&mut f, &mut s, 1);
    assert!(predicted.valid);
    close(
        predicted.variance - valid.variance,
        (p.hte_ht_noise * PERIOD_US as f64 * 1e-6).powi(2),
    );
    s.vertical_acceleration_up_m_s2 = f64::NAN;
    let frozen = HoverThrustEstimate {
        valid: false,
        ..predicted
    };
    assert_eq!(advance(&mut f, &mut s, 1), frozen);
    s.vertical_acceleration_up_m_s2 = 0.0;
    for dt_us in [0, 1_000, 1_000_000] {
        s.timestamp_us += dt_us;
        assert_eq!(f.step(s), frozen);
    }
    s.timestamp_us += 1_001;
    assert!(f.step(s).variance > frozen.variance);
}

#[test]
fn selector_only_offers_valid_estimates_when_enabled() {
    let p = HoverThrustParams {
        mpc_use_hte: false,
        ..Default::default()
    };
    let mut f = HoverThrustEstimator::new(p).unwrap();
    let mut s = airborne();
    s.vertical_acceleration_up_m_s2 = -1.0;
    let result = advance(&mut f, &mut s, 400);
    assert!(result.valid && result.hover_thrust > p.mpc_thr_hover);
    assert_eq!(f.controller_update(), None);
    f.set_params(HoverThrustParams::default()).unwrap();
    assert_eq!(f.controller_update(), Some(result.hover_thrust));
    s.landed = true;
    advance(&mut f, &mut s, 1);
    assert_eq!(f.controller_update(), None);
}
