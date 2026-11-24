use super::*;

#[test]
fn recorder_keeps_fixed_capacity_and_serializes_non_finite_as_null() {
    let mut trace = Trace::new(5, 2, 4).unwrap();
    let storage = (trace.samples.capacity(), trace.motor_commands.capacity());
    assert_eq!(storage, (3, 12));
    for step in 0..5 {
        trace.record(step, Sample {
            time_s: step as f64 * crate::sim::DEFAULT_DT_S,
            signal: Signal::Rate { setpoint_radps: 0.0, measured_radps: f64::NAN },
            commanded_body_rates_radps: [0.0; 3],
            commanded_attitude_xyzw: None,
            saturation: SaturationDiagnostic { positive: [false; 4], negative: [false; 4] },
        }, &[0.5; 4]);
    }
    assert_eq!(storage, (trace.samples.capacity(), trace.motor_commands.capacity()));
    let json = serde_json::to_value(&trace).unwrap();
    let samples = json["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 3);
    assert!(samples[0]["signal"]["measuredRadps"].is_null());
    assert_eq!(samples[2]["motorCommands01"], serde_json::json!([0.5; 4].to_vec()));
}
