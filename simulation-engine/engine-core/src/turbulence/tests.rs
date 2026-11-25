use super::*;

// The 20 ft reference and 10 m/s shear fixture are in wind.rs and wind/tests.rs.
const W20_MPS: f64 = 10.0;
const REFERENCE_HEIGHT_M: f64 = 20.0 * METRES_PER_FOOT;

#[test]
fn splitmix64_reference_vector_and_zero_distance_draw_count() {
    // First outputs of Vigna's reference C function with x initialized to zero.
    let mut rng = SplitMix64(0);
    assert_eq!([rng.next(), rng.next(), rng.next()], [
        0xe220_a839_7b1d_cdaf, 0x6e78_9e6a_a1b9_65f4, 0x06c4_5d18_8009_454f,
    ]);
    let params = Parameters::at_height(REFERENCE_HEIGHT_M, W20_MPS);
    let mut state = DrydenState::new(0);
    let before = state.hash_words();
    state.advance(Some((0.0, params)));
    let mut expected = SplitMix64(before[0]);
    for _ in 0..6 {
        expected.next();
    }
    assert_eq!(state.hash_words()[0], expected.0);
    assert_eq!(state.hash_words()[1..], before[1..]);
    for ds in [f64::from_bits(1), f64::EPSILON * params.length_m[0], f64::MAX] {
        state.advance(Some((ds, params)));
        assert!(state.velocity(params).into_iter().all(f64::is_finite));
    }
}

#[test]
fn height_limits_hold_lengths_and_intensities_and_flag_only_outside() {
    for (boundary, outside, below, above) in [
        (MIN_HEIGHT_M, 0.0, true, false),
        (MAX_HEIGHT_M, 2.0 * MAX_HEIGHT_M, false, true),
    ] {
        let at = Parameters::at_height(boundary, W20_MPS);
        let held = Parameters::at_height(outside, W20_MPS);
        assert!(!at.below_range && !at.above_range);
        assert_eq!((held.below_range, held.above_range), (below, above));
        assert_eq!(held.length_m, at.length_m);
        assert_eq!(held.sigma_mps, at.sigma_mps);
        assert_eq!(at.length_m[2], boundary);
        assert_eq!(at.sigma_mps[2], 0.1 * W20_MPS);
    }
}

#[test]
fn seeded_series_is_repeatable_across_height_changes() {
    let mut first = DrydenState::new(0);
    let mut same = DrydenState::new(0);
    let mut other = DrydenState::new(1);
    for height in [MIN_HEIGHT_M, REFERENCE_HEIGHT_M, MAX_HEIGHT_M] {
        let params = Parameters::at_height(height, W20_MPS);
        for ds in [0.0, params.length_m[2], params.length_m[0]] {
            for state in [&mut first, &mut same, &mut other] {
                state.advance(Some((ds, params)));
            }
            assert_eq!(first.hash_words(), same.hash_words());
            assert_ne!(first.velocity(params), other.velocity(params));
        }
    }
}

#[test]
fn independent_initial_and_advanced_variances_match_dryden() {
    // Use 2^15 independent histories so the simultaneous 95% bound is
    // narrow. Apply Laurent–Massart (2000), Lemma 1, to sum(X² / sigma²)
    // with n degrees of freedom (the population means are known to be zero).
    const N: u32 = 1 << 15;
    let start = Parameters::at_height(MIN_HEIGHT_M, W20_MPS);
    let end = Parameters::at_height(REFERENCE_HEIGHT_M, W20_MPS);
    let mut sums = [[0.0; 3]; 2];
    for seed in 0..u64::from(N) {
        let mut state = DrydenState::new(seed);
        let initial = state.velocity(start);
        // A changed height gives different r on the horizontal and vertical axes.
        state.advance(Some((end.length_m[2], end)));
        let advanced = state.velocity(end);
        for (row, output) in sums.iter_mut().zip([initial, advanced]) {
            for (sum, value) in row.iter_mut().zip(output) {
                *sum += value * value;
            }
        }
    }
    let n = f64::from(N);
    let x = (2.0_f64 * (sums.len() * 3) as f64 / 0.05).ln();
    let lower = 1.0 - 2.0 * (x / n).sqrt();
    let upper = 1.0 + 2.0 * (x / n).sqrt() + 2.0 * x / n;
    for (row, params) in sums.into_iter().zip([start, end]) {
        for (sum, sigma) in row.into_iter().zip(params.sigma_mps) {
            let relative_variance = sum / (n * sigma * sigma);
            assert!((lower..=upper).contains(&relative_variance), "{relative_variance} outside [{lower}, {upper}]");
        }
    }
}

#[test]
fn averaged_periodograms_match_the_three_dryden_spectra() {
    // Madden's averaged periodogram comparison (plan:164–168). In normalized
    // distance take bins 2, 4, 8 so they measure the half, unit and double
    // corner frequency. At 1000 ft the three length scales coincide.
    const BINS: [u32; 3] = [2, 4, 8];
    const N: u32 = 1 << 10;
    const WINDOWS: u32 = 1 << 8;
    let params = Parameters::at_height(MAX_HEIGHT_M, W20_MPS);
    let r = TAU * f64::from(BINS[1]) / f64::from(N);
    let ds = r * params.length_m[2];
    let basis: Vec<_> = (0..N).map(|j| {
        BINS.map(|k| (TAU * f64::from(k * j) / f64::from(N)).sin_cos())
    }).collect();
    let mut powers = [[0.0; 3]; 3];
    for seed in 0..u64::from(WINDOWS) {
        let mut state = DrydenState::new(seed);
        let mut amplitudes = [[(0.0, 0.0); 3]; 3];
        for phases in &basis {
            for (axis, (value, bins)) in state.velocity(params).into_iter().zip(&mut amplitudes).enumerate() {
                let normalized = value / params.sigma_mps[axis];
                for ((real, imag), (sin, cos)) in bins.iter_mut().zip(phases) {
                    *real += normalized * cos;
                    *imag += normalized * sin;
                }
            }
            state.advance(Some((ds, params)));
        }
        for (axis, bins) in powers.iter_mut().zip(amplitudes) {
            for (power, (real, imag)) in axis.iter_mut().zip(bins) {
                *power += real * real + imag * imag;
            }
        }
    }

    // Vector sums are Gaussian. Each independent window contributes two
    // weighted chi-squares. The sum of their weights is its mean, bounding
    // both the largest weight and the sum of squared weights. Laurent–Massart
    // then bounds the simultaneous sampling error at 95% across nine bins.
    let x = (2.0_f64 * 3.0 * BINS.len() as f64 / 0.05).ln() / f64::from(WINDOWS);
    let relative_error = 2.0 * x.sqrt() + 2.0 * x;
    for (axis, spectrum) in powers.into_iter().enumerate() {
        let r_axis = ds / params.length_m[axis];
        for (bin, power) in spectrum.into_iter().enumerate() {
            let omega = TAU * f64::from(BINS[bin]) / (f64::from(N) * r_axis);
            let denominator = 1.0 + omega * omega;
            let target = if axis == 0 { 2.0 / denominator } else { (1.0 + 3.0 * omega * omega) / (denominator * denominator) };
            // The finite rectangular-window expectation follows from the
            // analytic covariance, C F C^T. Include its difference from the
            // continuous target to account for both windowing and aliasing.
            let sampled = r_axis * (1.0 + 2.0 * (1..N).zip(&basis[1..]).map(|(j, phase)| {
                let lag = f64::from(j) * r_axis;
                let covariance = (-lag).exp() * if axis == 0 { 1.0 } else { 1.0 - lag / 2.0 };
                (1.0 - f64::from(j) / f64::from(N)) * covariance * phase[bin].1
            }).sum::<f64>());
            let bias = (sampled - target).abs();
            assert!(bias < relative_error * target);
            let measured = power * r_axis / (f64::from(N) * f64::from(WINDOWS));
            assert!((measured - target).abs() <= relative_error * sampled + bias,
                "axis {axis}, omega {omega}: measured {measured}, target {target}");
        }
    }
}
