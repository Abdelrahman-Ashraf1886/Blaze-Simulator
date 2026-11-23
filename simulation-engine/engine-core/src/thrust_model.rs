//! PX4 v1.13.3 THR_MDL_FAC, for non-reversible motors with a signal in [0, 1].
//!
//! Forward model, from the parameter's doc comment, `motor_params.c` lines 57-73
//! (formula on line 63, `PARAM_DEFINE_FLOAT(THR_MDL_FAC, 0.0f)` on line 73):
//! `rel_thrust = factor * rel_signal^2 + (1 - factor) * rel_signal`.
//! <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/lib/mixer_module/motor_params.c#L57-L73>.
//!
//! PX4 applies the inverse to each motor command in
//! `FunctionMotors::updateValues`, `functions.hpp` lines 141-165: only when
//! `0 < factor <= 1` (line 143), as `x = -b/(2a) + sqrt(b^2/(4a^2) + u/a)` with
//! `a = factor`, `b = 1 - factor` (lines 146-157); any other factor leaves the
//! command unchanged. PX4 computes in f32; this port uses f64.
//! <https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/lib/mixer_module/functions.hpp#L141-L165>.
//!
//! These helpers are not applied to flight outputs until Phase 5.9.

/// Relative thrust = f*x² + (1-f)*x. Panics outside the documented domain.
pub fn forward(command: f64, factor: f64) -> f64 {
    validate(command, factor);
    if factor == 0.0 {
        return command;
    }
    factor * command * command + (1.0 - factor) * command
}

/// Motor signal for the requested relative thrust. Rationalizing PX4's positive
/// quadratic root avoids cancellation near f=0. Panics outside [0, 1].
pub fn inverse(thrust: f64, factor: f64) -> f64 {
    validate(thrust, factor);
    if factor == 0.0 || thrust == 0.0 {
        return thrust;
    }
    let b = 1.0 - factor;
    2.0 * thrust / (b + (b * b + 4.0 * factor * thrust).sqrt())
}

fn validate(value: f64, factor: f64) {
    assert!(
        (0.0..=1.0).contains(&value),
        "signal/thrust must be in [0, 1]"
    );
    assert!(
        (0.0..=1.0).contains(&factor),
        "THR_MDL_FAC must be in [0, 1]"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_roundtrip_and_monotonicity() {
        for f in [0.0, 1e-15, 0.1, 0.5, 0.99, 1.0] {
            let mut previous = -1.0;
            for i in 0..=1000 {
                let x = i as f64 / 1000.0;
                let y = forward(x, f);
                assert!(y > previous);
                previous = y;
                assert!((inverse(y, f) - x).abs() < 1e-12);
                assert!((forward(inverse(x, f), f) - x).abs() < 1e-12);
                assert_eq!(forward(x, 0.0).to_bits(), x.to_bits());
                assert_eq!(inverse(x, 0.0).to_bits(), x.to_bits());
                assert_eq!(forward(x, 1.0), x * x);
                assert!((inverse(x, 1.0) - x.sqrt()).abs() < 1e-15);
            }
        }
    }

    #[test]
    fn hand_values_and_px4_closed_form_agree() {
        // f = 0.5: 0.5*0.25 + 0.5*0.5 = 0.375.
        assert_eq!(forward(0.5, 0.5), 0.375);
        assert!((inverse(0.375, 0.5) - 0.5).abs() < 1e-15);
        // PX4's own expression (functions.hpp 150-157), evaluated directly.
        for f in [0.1, 0.3, 0.5, 0.9, 1.0] {
            for i in 1..=100 {
                let u = i as f64 / 100.0;
                let b = 1.0 - f;
                let px4 = -b / (2.0 * f) + (b * b / (4.0 * f * f) + u / f).sqrt();
                assert!((inverse(u, f) - px4).abs() < 1e-12, "f={f} u={u}");
            }
        }
        for f in [0.0, 0.5, 1.0] {
            assert_eq!(forward(0.0, f), 0.0);
            assert_eq!(forward(1.0, f), 1.0);
            assert_eq!(inverse(0.0, f), 0.0);
            assert_eq!(inverse(1.0, f), 1.0);
        }
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        for invalid in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            assert!(std::panic::catch_unwind(|| forward(0.5, invalid)).is_err());
            assert!(std::panic::catch_unwind(|| inverse(invalid, 0.5)).is_err());
        }
    }
}
