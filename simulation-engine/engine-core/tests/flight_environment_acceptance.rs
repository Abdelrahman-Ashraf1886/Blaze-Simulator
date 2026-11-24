use engine_core::{
    aero::BodyDrag, math::STANDARD_GRAVITY,
    scenario::{equilibrium_tilt_deg, position_hold_scenario, takeoff_hold_land_scenario, Scenario},
};
use rapier3d_f64::math::Vector;

#[test]
fn equilibrium_matches_the_single_axis_closed_form() {
    // Plan's Automated Tests, item 4 (reference hover). Isolate body X to
    // get an independent solution: sin(theta) = k cos²(theta).
    let mass = 1.5;
    let rho = 1.225;
    let area = 0.022;
    let speed = 8.0;
    let drag = BodyDrag { area_m2: [area, 0.0, 0.0], cd_body: [1.0; 3] };
    let k = 0.5 * rho * area * speed * speed / (mass * STANDARD_GRAVITY);
    let theta = (2.0 * k / (1.0 + (1.0 + 4.0 * k * k).sqrt())).asin().to_degrees();
    let measured = equilibrium_tilt_deg(Some(drag), rho, mass, speed * Vector::X).unwrap();
    assert!((measured - theta).abs() <= f64::EPSILON.sqrt().to_degrees());
}

#[test]
fn script_has_one_controller_and_valid_commands() {
    // 6.7 flight_loop/tests.rs:302-338.
    let scenario = takeoff_hold_land_scenario("terrain");
    let wire = serde_json::to_value(&scenario).unwrap();
    assert_eq!(serde_json::from_value::<Scenario>(wire).unwrap(), scenario);
    let mut manual = position_hold_scenario("wind_hold", scenario.duration_s);
    manual.flight_script.as_mut().unwrap()[0].from_s = scenario.duration_s;
    assert!(manual.validate(0).is_err());
}
