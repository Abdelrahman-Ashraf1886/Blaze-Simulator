use super::*;
use serde_json::json;

fn wind(from_deg: f64, mean: Value, gust: Value) -> Wind {
    Wind::from_json(&json!({"fromDeg": from_deg, "mean": mean, "gust": gust})).unwrap()
}

fn constant(speed_mps: f64) -> Value {
    json!({"kind": "constant", "speedMps": speed_mps})
}

fn shear(roughness: Value) -> Value {
    json!({"kind": "shear", "speedAt20FtMps": 10.0, "roughness": roughness})
}

fn gust(start_s: f64) -> Value {
    json!({"amplitudeMps": 8.0, "lengthM": 4.0, "startS": start_s})
}

#[test]
fn calm_is_exactly_zero() {
    for model in [Wind::calm(), Wind::from_json(&Value::Null).unwrap(), wind(90.0, constant(0.0), Value::Null)] {
        let velocity = model.velocity(-1.0, 2.0).unwrap();
        assert_eq!([velocity.x.to_bits(), velocity.y.to_bits(), velocity.z.to_bits()], [0; 3]);
        assert!(model.gust_state().is_none());
    }
}

#[test]
fn constant_wind_uses_world_from_bearings_at_any_height() {
    // Phase 6 plan:103-106.
    for (from_deg, expected) in [
        (0.0, Vector::new(-5.0, 0.0, 0.0)),
        (90.0, Vector::new(0.0, 5.0, 0.0)),
        (180.0, Vector::new(5.0, 0.0, 0.0)),
        (270.0, Vector::new(0.0, -5.0, 0.0)),
    ] {
        let model = wind(from_deg, constant(5.0), Value::Null);
        let at_ground = model.velocity(0.0, 0.0).unwrap();
        assert!((at_ground - expected).length() < 1e-12, "bearing {from_deg}");
        for height in [-1.0, 20.0, 1000.0] {
            assert_eq!(model.velocity(height, 0.0).unwrap(), at_ground);
        }
    }
}

#[test]
fn shear_reference_hand_values_and_height_limits() {
    // Phase 6 plan:327-329. Heights are independent SI conversions from feet.
    for (preset, ratio, roughness_m) in [
        ("categoryC", 1.329, 0.04572),
        ("otherPhases", 1.699, 0.6096),
    ] {
        let model = wind(0.0, shear(json!({"kind": preset})), Value::Null);
        let speed = |height| -model.velocity(height, 0.0).unwrap().x;
        assert_eq!(speed(6.096), 10.0);
        assert!((speed(30.48) / 10.0 - ratio).abs() < 0.0005);
        assert_eq!(speed(0.0), speed(3.0 * 0.3048));
        assert_eq!(speed(-1.0), speed(3.0 * 0.3048));
        assert!(speed(304.8).is_finite());
        assert!(matches!(model.velocity(305.0, 0.0), Err(WindError::ShearHeightAboveLimit(305.0))));

        let custom = wind(0.0, shear(json!({"kind": "custom", "lengthM": roughness_m})), Value::Null);
        assert_eq!(custom.velocity(30.48, 0.0).unwrap(), model.velocity(30.48, 0.0).unwrap());
    }
}

#[test]
fn gust_values_and_first_derivative_match_on_both_sides() {
    // Phase 6 plan:134-135,328-329. For V_m = 8 and d_m = 4 the
    // derivative at the midpoint is (V_m / 2) * pi / d_m = pi.
    let model = wind(0.0, Value::Null, gust(0.0));
    let speed = |distance| -model.velocity(0.0, distance).unwrap().x;
    assert_eq!(speed(-1.0), 0.0);
    assert_eq!(speed(5.0), 8.0);
    let step = 1e-5;
    for (distance, expected, derivative) in [(0.0, 0.0, 0.0), (2.0, 4.0, PI), (4.0, 8.0, 0.0)] {
        let at = speed(distance);
        assert!((at - expected).abs() < 1e-12);
        let left = (at - speed(distance - step)) / step;
        let right = (speed(distance + step) - at) / step;
        assert!((left - derivative).abs() < 1e-4, "left at {distance}: {left}");
        assert!((right - derivative).abs() < 1e-4, "right at {distance}: {right}");
    }
}

#[test]
fn combined_wind_adds_gust_to_each_mean_profile() {
    for mean in [constant(10.0), shear(json!({"kind": "otherPhases"}))] {
        let model = wind(90.0, mean, gust(3.0));
        let height = 30.48;
        let mean = model.mean_velocity(height).unwrap();
        assert!((model.velocity(height, 2.0).unwrap() - mean - Vector::new(0.0, 4.0, 0.0)).length() < 1e-12);
    }
}

#[test]
fn gust_start_distance_and_hash_words() {
    let model = wind(0.0, constant(3.0), gust(2.0));
    let mut state = model.gust_state().unwrap();
    let initial = state.hash_words();
    let same_gust = wind(90.0, Value::Null, gust(2.0));
    assert_eq!(same_gust.gust_state().unwrap().hash_words(), initial);
    model.velocity(100.0, 4.0).unwrap();
    assert_eq!(state.hash_words(), initial);

    let ground_velocity = Vector::new(2.0, 0.0, 0.0);
    let airspeed = (ground_velocity - model.mean_velocity(0.0).unwrap()).length();
    assert_eq!(airspeed, 5.0);
    state.advance(airspeed, 1.0).unwrap();
    assert_eq!(state.distance_m(), 0.0);
    assert_eq!(state.hash_words(), [1.0_f64.to_bits(), initial[1]]);
    state.advance(airspeed, 1.5).unwrap();
    assert_eq!(state.distance_m(), 2.5);
    assert_eq!(state.hash_words(), [0, 2.5_f64.to_bits()]);
    let active = state.hash_words();
    state.advance(0.0, 1.0).unwrap();
    state.advance(airspeed, 0.0).unwrap();
    assert_eq!(state.hash_words(), active);
    state.advance(airspeed, 1.0).unwrap();
    assert_eq!(state.hash_words(), [0, 7.5_f64.to_bits()]);

    let mut at_start = model.gust_state().unwrap();
    at_start.advance(airspeed, 2.0).unwrap();
    assert_eq!(at_start.hash_words(), [0, 0]);
    at_start.advance(airspeed, 1.0).unwrap();
    assert_eq!(at_start.distance_m(), 5.0);
}

#[test]
fn refuses_missing_malformed_and_unknown_fields() {
    let valid = json!({"fromDeg": 0.0, "mean": constant(5.0), "gust": gust(0.0)});
    for field in ["fromDeg", "mean", "gust"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(matches!(Wind::from_json(&missing), Err(WindError::Json(_))), "{field}");
    }
    for bad in [
        json!(false),
        json!([0.0, null, null]),
        json!({"fromDeg": "north", "mean": null, "gust": null}),
        json!({"fromDeg": 0.0, "mean": null, "gust": null, "turbulence": false}),
        json!({"fromDeg": 0.0, "mean": {"kind": "constant", "speedMps": 5, "extra": 0}, "gust": null}),
        json!({"fromDeg": 0.0, "mean": shear(json!({"kind": "categoryC", "lengthM": 1})), "gust": null}),
        json!({"fromDeg": 0.0, "mean": shear(json!(["categoryC"])), "gust": null}),
        json!({"fromDeg": 0.0, "mean": ["constant", 5.0], "gust": null}),
        json!({"fromDeg": 0.0, "mean": null, "gust": [8.0, 4.0, 0.0]}),
        json!({"fromDeg": 0.0, "mean": null, "gust": {"amplitudeMps": 1, "lengthM": 1}}),
        json!({"fromDeg": 0.0, "mean": null, "gust": {"amplitudeMps": 1, "lengthM": 1, "startS": 0, "extra": 0}}),
    ] {
        assert!(matches!(Wind::from_json(&bad), Err(WindError::Json(_) | WindError::ExpectedObject(_))), "{bad}");
    }
}

#[test]
fn refuses_invalid_model_numbers() {
    for (mean, gust, expected_field) in [
        (constant(-1.0), Value::Null, "mean.speedMps"),
        (json!({"kind": "shear", "speedAt20FtMps": -1, "roughness": {"kind": "categoryC"}}), Value::Null, "mean.speedAt20FtMps"),
        (shear(json!({"kind": "custom", "lengthM": 0})), Value::Null, "mean.roughness.lengthM"),
        (shear(json!({"kind": "custom", "lengthM": 6.096})), Value::Null, "mean.roughness.lengthM"),
        (shear(json!({"kind": "custom", "lengthM": 0.9144})), Value::Null, "mean.roughness.lengthM"),
        (Value::Null, json!({"amplitudeMps": -1, "lengthM": 1, "startS": 0}), "gust.amplitudeMps"),
        (Value::Null, json!({"amplitudeMps": 1, "lengthM": 0, "startS": 0}), "gust.lengthM"),
        (Value::Null, gust(-1.0), "gust.startS"),
    ] {
        let result = Wind::from_json(&json!({"fromDeg": 0.0, "mean": mean, "gust": gust}));
        assert!(matches!(result, Err(WindError::InvalidNumber { field, .. }) if field == expected_field));
    }
}

#[test]
fn refuses_invalid_samples_and_leaves_gust_state_unchanged_on_error() {
    let model = wind(0.0, constant(f64::MAX), json!({"amplitudeMps": f64::MAX, "lengthM": 1, "startS": 1}));
    for (height, distance) in [(f64::NAN, 0.0), (0.0, f64::INFINITY)] {
        assert!(matches!(model.velocity(height, distance), Err(WindError::InvalidNumber { .. })));
    }
    assert!(matches!(model.velocity(0.0, 1.0), Err(WindError::Overflow("wind speed"))));

    let mut state = model.gust_state().unwrap();
    let initial = state.hash_words();
    for (speed, duration) in [(-1.0, 1.0), (f64::NAN, 1.0), (1.0, -1.0), (1.0, f64::INFINITY)] {
        assert!(matches!(state.advance(speed, duration), Err(WindError::InvalidNumber { .. })));
        assert_eq!(state.hash_words(), initial);
    }
    assert!(matches!(state.advance(f64::MAX, 3.0), Err(WindError::Overflow("gust distance"))));
    assert_eq!(state.hash_words(), initial);
}
