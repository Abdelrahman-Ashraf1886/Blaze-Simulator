//! Ground-effect ratio (plan, test 6). Tolerances were set before the first run;
//! each is stated next to where it comes from.

use super::*;

/// Relative rounding bound for a ratio: at most a few correctly rounded operations,
/// and the subtraction from 1 (at most 1/4 taken off) amplifies by no more than 1/3.
const ROUNDING: f64 = 4.0 * f64::EPSILON;

/// A 10 in propeller (R = 127 mm) giving 4 N at sea-level density.
const R: f64 = 0.127;
const T: f64 = 4.0;
const RHO: f64 = 1.225;

fn rotor(height_ratio: f64, airspeed: f64) -> RotorInput {
    RotorInput { hub_height_m: height_ratio * R, radius_m: R, horizontal_airspeed_m_s: airspeed, thrust_n: T, air_density_kg_m3: RHO }
}

fn g(height_ratio: f64, airspeed: f64) -> f64 {
    thrust_ratio(&rotor(height_ratio, airspeed)).unwrap().ratio
}

/// A rotor whose radius is 1 m (heights are then exact) and hover induced velocity is 2 m/s.
fn unit_rotor(height: f64, airspeed: f64) -> RotorInput {
    let thrust_n = 2.0 * PI * RHO * 4.0;
    RotorInput { hub_height_m: height, radius_m: 1.0, horizontal_airspeed_m_s: airspeed, thrust_n, air_density_kg_m3: RHO }
}

fn close(a: f64, b: f64, relative: f64) -> bool {
    (a - b).abs() <= relative * b.abs()
}

#[test]
fn equation_2_gives_the_exact_rationals() {
    // 1/(1 − 1/(16 h²)) = 16h²/(16h² − 1); h = 0.6: 5.76/4.76 = 144/119.
    // The last column is the plan's rounded value (4 decimals, so within 5e-5).
    for (h, num, den, plan) in [
        (0.5, 4.0, 3.0, 1.3333),
        (0.6, 144.0, 119.0, 1.2101),
        (1.0, 16.0, 15.0, 1.0667),
        (2.0, 64.0, 63.0, 1.0159),
        (4.0, 256.0, 255.0, 1.0039),
    ] {
        for input in [rotor(h, 0.0), unit_rotor(h, 0.0)] {
            let out = thrust_ratio(&input).unwrap();
            assert!(close(out.ratio, num / den, ROUNDING), "h = {h}: {}", out.ratio);
            assert!((out.ratio - plan).abs() <= 5e-5);
        }
        assert!(!thrust_ratio(&unit_rotor(h, 0.0)).unwrap().below_tested_range);
    }
}

#[test]
fn equation_4_equals_equation_2_at_zero_airspeed() {
    for i in 0..200 {
        let h = 0.5 + i as f64 * 0.05;
        let eq2 = 1.0 / (1.0 - 1.0 / (16.0 * h * h));
        assert!(close(g(h, 0.0), eq2, ROUNDING));
        assert_eq!(g(h, -0.0).to_bits(), g(h, 0.0).to_bits());
        // No jump at V → 0 either: cos²θ = w² ≥ 1 − s with s = (1e-9/5.68)² < 1e-19.
        assert!(close(g(h, 1e-9), eq2, ROUNDING));
    }
}

#[test]
fn equation_4_gives_the_exact_rationals_with_airspeed() {
    // w = (v_i/v_h)² solves w² + s w = 1, and cos²θ = 1/(1 + s/w) = w².
    // w = 1/2: s = 1/w − w = 3/2, cos²θ = 1/4; at Z = R: 1/(1 − 1/64) = 64/63.
    // w = 1/4: s = 15/4, cos²θ = 1/16; at Z = R/2: 1/(1 − 1/64) = 64/63 again.
    // Here v_h = 2 m/s, so V = 2√s. Rounding of v_i enters squared, on a term ≤ 1/64:
    // ROUNDING still covers it.
    for (h, s) in [(1.0, 1.5f64), (0.5, 3.75)] {
        let out = thrust_ratio(&unit_rotor(h, 2.0 * s.sqrt())).unwrap();
        assert!(close(out.ratio, 64.0 / 63.0, ROUNDING), "{}", out.ratio);
    }
}

#[test]
fn induced_velocity_matches_hand_values() {
    // Solved outside this code with 40-digit decimals, by bisection on Glauert's
    // T = 2πR²ρ v √(V² + v²). 1e-14: about ten roundings.
    for (v, expected) in [(0.0, 5.676_338_632_216_333), (5.0, 4.696_865_425_650_657), (12.0, 2.623_128_689_299_325_4)] {
        let vi = induced_velocity(T, R, RHO, v);
        assert!(close(vi, expected, 1e-14), "V = {v}: {vi}");
    }
    // It satisfies that equation over a wide range of speeds (slow to far past v_h).
    for i in 0..=400 {
        let v = 1e-3 * 10f64.powf(i as f64 * 0.02);
        let vi = induced_velocity(T, R, RHO, v);
        let back = 2.0 * PI * R * R * RHO * vi * (v * v + vi * vi).sqrt();
        assert!(close(back, T, 1e-14), "V = {v}: {back}");
    }
    // High-speed limit v → T/(2πR²ρV): the relative difference is below 1/s² = (v_h/V)⁴.
    let v = 1000.0;
    let expected = T / (2.0 * PI * R * R * RHO * v);
    assert!(close(induced_velocity(T, R, RHO, v), expected, (5.7f64 / v).powi(4) + 1e-14));
}

#[test]
fn the_wake_agrees_with_chen_beyond_twice_the_hover_velocity() {
    // NASA TM 102219, p. 64-17: beyond V/v_h = 2 the mean induced velocity has decreased
    // "by more than 50%" of the hover value and the skew angle (zero incidence) exceeds 75°.
    // Inequalities, so no tolerance. (Its p. 64-12 also says "about 80°" at "about 2.3";
    // this model gives 79.47° there. Not asserted: the source's rounding is unknown.)
    let vh = induced_velocity(T, R, RHO, 0.0);
    for q in [2.0, 2.3, 3.0, 5.0] {
        let vi = induced_velocity(T, R, RHO, q * vh);
        assert!(vi < 0.5 * vh, "q = {q}: {vi}");
        assert!((q * vh / vi).atan().to_degrees() > 75.0, "q = {q}");
    }
}

#[test]
fn equivalent_and_true_speeds_give_the_same_ratio() {
    // The report uses equivalent speeds V√σ and v√σ: the ratio at (ρ, V) is the one at
    // (ρ₀, V√σ) for the same thrust. 1e-14 for the roundings of σ and its root.
    for sigma in [0.5, 0.75, 0.9, 1.1] {
        for v in [0.5, 2.0, 6.0, 15.0] {
            let here = RotorInput { air_density_kg_m3: RHO * sigma, ..rotor(0.7, v) };
            let sea_level = rotor(0.7, v * sigma.sqrt());
            let (a, b) = (thrust_ratio(&here).unwrap().ratio, thrust_ratio(&sea_level).unwrap().ratio);
            assert!(close(a, b, 1e-14), "{a} {b}");
        }
    }
}

#[test]
fn the_ratio_falls_with_airspeed_and_tends_to_one() {
    let vh = induced_velocity(T, R, RHO, 0.0);
    for h in [0.2, 0.5, 0.6, 1.0, 2.0, 4.0] {
        let mut previous = g(h, 0.0);
        for i in 1..=300 {
            // Up to 6 v_h: steps of 0.02 v_h.
            let now = g(h, vh * i as f64 * 0.02);
            assert!(now < previous, "h = {h}, i = {i}");
            previous = now;
        }
        // cos²θ = w² ≤ 1/s², so G − 1 ≤ (1/4)/(3/4)/s².
        for q in [10.0f64, 100.0, 1000.0] {
            let excess = g(h, vh * q) - 1.0;
            assert!((0.0..=1.0 / (3.0 * q.powi(4)) + ROUNDING).contains(&excess), "h = {h}, q = {q}: {excess}");
        }
        assert_eq!(g(h, 1e200), 1.0);
        assert_eq!(g(h, f64::MAX), 1.0);
    }
}

#[test]
fn more_thrust_keeps_more_of_the_effect_at_the_same_airspeed() {
    let at = |thrust_n| thrust_ratio(&RotorInput { thrust_n, ..rotor(0.8, 5.0) }).unwrap().ratio;
    assert!(at(1.0) < at(2.0) && at(2.0) < at(8.0));
    // At zero airspeed the thrust does not matter.
    let hover = |thrust_n| thrust_ratio(&RotorInput { thrust_n, ..rotor(0.8, 0.0) }).unwrap().ratio;
    assert_eq!(hover(1e-6).to_bits(), hover(50.0).to_bits());
}

#[test]
fn the_height_is_held_below_the_tested_range_and_flagged() {
    for v in [0.0, 1.0, 5.0, 20.0] {
        let at_bound = thrust_ratio(&unit_rotor(MIN_HEIGHT_RATIO, v)).unwrap();
        assert!(!at_bound.below_tested_range);
        // R/4 is eq. 2's pole; below it eq. 2 is negative; Z = 0 divides by zero.
        for z in [0.5 - f64::EPSILON, 0.4, 0.25, 0.25 - 1e-12, 0.1, 1e-300, 0.0, -0.0, -0.3, -1e300] {
            let out = thrust_ratio(&unit_rotor(z, v)).unwrap();
            assert!(out.below_tested_range, "z = {z}");
            assert_eq!(out.ratio.to_bits(), at_bound.ratio.to_bits(), "z = {z}");
        }
        assert!(!thrust_ratio(&unit_rotor(0.5 + f64::EPSILON, v)).unwrap().below_tested_range);
    }
    // The hold is on the height only: airspeed still reduces the ratio there.
    assert!(g(0.1, 5.0) < g(0.1, 0.0));
}

#[test]
fn the_ratio_is_continuous_at_the_bound() {
    // Just above: |dG/dh| at h = 1/2 is 2x/(h(1 − x)²) = 16/9 for x = 1/(16h²) = 1/4, and it
    // falls with h and with airspeed. Just below: the same bits (previous test).
    for v in [0.0, 5.0, 20.0] {
        let at = thrust_ratio(&unit_rotor(0.5, v)).unwrap().ratio;
        for d in [1e-3, 1e-6, 1e-9, 1e-12] {
            let above = thrust_ratio(&unit_rotor(0.5 + d, v)).unwrap().ratio;
            let below = thrust_ratio(&unit_rotor(0.5 - d, v)).unwrap().ratio;
            assert!(above <= at && at - above <= 16.0 / 9.0 * d + 2.0 * f64::EPSILON, "v = {v}, d = {d}");
            assert_eq!(below.to_bits(), at.to_bits());
        }
    }
}

#[test]
fn a_stopped_or_reversed_rotor_has_no_ground_effect() {
    for thrust_n in [0.0, -0.0, -1e-300, -4.0, -f64::MAX] {
        for (z, v) in [(0.0, 0.0), (0.3, 0.0), (0.3, 8.0), (1.0, 0.0), (-1.0, 3.0)] {
            let out = thrust_ratio(&RotorInput { thrust_n, ..rotor(z, v) }).unwrap();
            assert_eq!(out, GroundEffect { ratio: 1.0, below_tested_range: false });
        }
    }
}

#[test]
fn far_from_the_ground_the_ratio_is_one() {
    // 1/(16h²) < ε/2 from h ≈ 2.4e7.
    for h in [1e8, 1e20, 1e200, f64::MAX] {
        for v in [0.0, 5.0] {
            let out = thrust_ratio(&unit_rotor(h, v)).unwrap();
            assert_eq!(out, GroundEffect { ratio: 1.0, below_tested_range: false });
        }
    }
}

#[test]
fn extreme_finite_inputs_stay_in_range() {
    // Over- and underflow in Z/R, v_h, s or V/v_i must not make a NaN or leave [1, 4/3].
    let extremes = [f64::MIN_POSITIVE, 5e-324, 1e-200, 1e-100, 1.0, 1e100, 1e200, f64::MAX];
    for thrust_n in extremes {
        for radius_m in extremes {
            for air_density_kg_m3 in extremes {
                for horizontal_airspeed_m_s in extremes.into_iter().chain([0.0]) {
                    for hub_height_m in extremes.into_iter().chain([0.0, -1.0, -f64::MAX]) {
                        let input = RotorInput { hub_height_m, radius_m, horizontal_airspeed_m_s, thrust_n, air_density_kg_m3 };
                        let out = thrust_ratio(&input).unwrap();
                        assert!((1.0..=4.0 / 3.0).contains(&out.ratio), "{input:?}: {out:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn invalid_inputs_are_refused() {
    let ok = rotor(1.0, 2.0);
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(matches!(thrust_ratio(&RotorInput { hub_height_m: x, ..ok }), Err(InvalidInput::HubHeight(_))));
        assert!(matches!(thrust_ratio(&RotorInput { radius_m: x, ..ok }), Err(InvalidInput::Radius(_))));
        assert!(matches!(thrust_ratio(&RotorInput { horizontal_airspeed_m_s: x, ..ok }), Err(InvalidInput::Airspeed(_))));
        assert!(matches!(thrust_ratio(&RotorInput { thrust_n: x, ..ok }), Err(InvalidInput::Thrust(_))));
        assert!(matches!(thrust_ratio(&RotorInput { air_density_kg_m3: x, ..ok }), Err(InvalidInput::AirDensity(_))));
    }
    for x in [0.0, -0.0, -1.0] {
        assert_eq!(thrust_ratio(&RotorInput { radius_m: x, ..ok }), Err(InvalidInput::Radius(x)));
        assert_eq!(thrust_ratio(&RotorInput { air_density_kg_m3: x, ..ok }), Err(InvalidInput::AirDensity(x)));
    }
    assert_eq!(thrust_ratio(&RotorInput { horizontal_airspeed_m_s: -1.0, ..ok }), Err(InvalidInput::Airspeed(-1.0)));
    // A bad input is reported even where the result would not depend on it.
    let stopped = RotorInput { thrust_n: 0.0, radius_m: 0.0, ..ok };
    let e = thrust_ratio(&stopped).unwrap_err();
    assert_eq!(e.to_string(), "the rotor radius must be a positive number (got 0)");
}

#[test]
fn a_deterministic_sweep_stays_between_one_and_four_thirds() {
    // Fixed grid: heights −1…8 R, airspeeds 0…30 m/s, thrusts 0.01…100 N, radii 3…30 in / 2, two densities.
    let mut count = 0u32;
    let mut sum_bits = [0u64; 2];
    for pass in &mut sum_bits {
        for zi in 0..=90 {
            for vi in 0..=30 {
                for ti in 0..=8 {
                    for radius_m in [0.0381, 0.0635, 0.127, 0.254, 0.381] {
                        for air_density_kg_m3 in [0.7, 1.225] {
                            let h = -1.0 + zi as f64 * 0.1;
                            let input = RotorInput {
                                hub_height_m: h * radius_m,
                                radius_m,
                                horizontal_airspeed_m_s: vi as f64,
                                thrust_n: 0.01 * 10f64.powf(ti as f64 * 0.5),
                                air_density_kg_m3,
                            };
                            let out = thrust_ratio(&input).unwrap();
                            assert!((1.0..=4.0 / 3.0).contains(&out.ratio), "{input:?}: {out:?}");
                            assert_eq!(out.below_tested_range, input.hub_height_m / radius_m < 0.5);
                            *pass = pass.wrapping_mul(31).wrapping_add(out.ratio.to_bits());
                            count += 1;
                        }
                    }
                }
            }
        }
    }
    // Same inputs, same bits; and the sweep really ran: 2 · 91 · 31 · 9 · 5 · 2.
    assert_eq!(sum_bits[0], sum_bits[1]);
    assert_eq!(count, 507_780);
}
