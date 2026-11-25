//! Scalar telemetry from the completed physics step, in vehicle motor order.
use engine_core::{
    auto_modes::{AutoMode, ReturnState},
    closed_loop::{ClosedLoop, SaturationDiagnostic},
    controller::Setpoint,
    flight::{Flight, RotorGroundEffect},
    flight_loop::{FlightLoop, FlightMode, FlightSetpoints},
    flight_modes::FlightCommand,
    ground_effect::InvalidInput,
    hover_thrust::HoverThrustEstimate,
    propulsion::{MotorModel, Propulsion},
    sensors::{ImuSample, Sensors},
    sim::Simulation,
    takeoff::TakeoffState,
    vehicle::Vehicle,
};
use serde::{de, Deserialize, Deserializer, Serialize};

#[derive(Clone, Copy)]
pub struct SampleEverySteps(u64);

impl<'de> Deserialize<'de> for SampleEverySteps {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let steps = u64::deserialize(d)?;
        // Match Zod's safe integer range for JSON numbers (protocol.ts).
        const MAX_SAFE_INTEGER: u64 = (1 << f64::MANTISSA_DIGITS) - 1;
        if (1..=MAX_SAFE_INTEGER).contains(&steps) {
            Ok(Self(steps))
        } else {
            Err(de::Error::custom(format!("sampleEverySteps must be an integer in 1..={MAX_SAFE_INTEGER}")))
        }
    }
}

#[derive(Default, Serialize)]
pub struct Samples {
    pub steps: Vec<u64>,
    // serde_json serializes all non-finite f64 values as null.
    pub rows: Vec<Vec<f64>>,
}

const MISSING: f64 = f64::NAN;
const XYZ: &[&str] = &["x", "y", "z"];
const XYZW: &[&str] = &["x", "y", "z", "w"];

#[derive(Clone, Copy)]
pub enum ControllerKind {
    AttitudeHold,
    FlightLoop,
}

pub struct Sampling {
    every: Option<SampleEverySteps>,
    sensors: Option<Sensors>,
    base_columns: usize,
    motors: Vec<MotorModel>,
    columns: Vec<String>,
    hover_column: usize,
}

impl Sampling {
    pub fn new(
        every: Option<SampleEverySteps>, sensors: Option<Sensors>, vehicle: &Vehicle,
        propulsion: &Propulsion, kind: ControllerKind,
    ) -> Option<Self> {
        if every.is_none() && sensors.is_none() {
            return None;
        }
        // Match Flight::new's definition/vehicle mapping (flight.rs:304-324).
        let motors = vehicle.definition.motors.iter().map(|motor| {
            let index = propulsion.definition.motors.iter().position(|p| p.part_id == motor.part_id)
                .expect("Flight already checked motor propulsion data");
            propulsion.motors[index].clone()
        }).collect();
        let (mut columns, hover_column) = channels(vehicle.definition.motors.len(), kind);
        let base_columns = columns.len();
        if sensors.is_some() {
            axes(&mut columns, "sensor.gyro", XYZ);
            axes(&mut columns, "sensor.gyroClipped", XYZ);
            axes(&mut columns, "sensor.accelerometer", XYZ);
            axes(&mut columns, "sensor.accelerometerClipped", XYZ);
            names(&mut columns, &["sensor.barometer.pressure", "sensor.barometer.altitude"]);
            axes(&mut columns, "sensor.gps.position", XYZ);
            axes(&mut columns, "sensor.gps.velocity", XYZ);
        }
        Some(Self { every, motors, columns, base_columns, hover_column, sensors })
    }

    pub fn channels(&self) -> &[String] {
        &self.columns
    }

    pub fn recording(&self) -> bool {
        self.every.is_some()
    }

    pub fn extend_hash(&self, hash: u64) -> u64 {
        self.sensors.as_ref().map_or(hash, |sensors| sensors.extend_hash(hash))
    }

    pub fn attitude(
        &mut self, samples: &mut Samples, sim: &Simulation, controller: &ClosedLoop,
        input: Option<(Setpoint, [f64; 3])>,
    ) {
        let hover_column = self.hover_column;
        self.record(samples, sim, controller.flight(), |row| {
            row.push(0.0); // attitudeHold
            if let Some((sp, rates)) = input {
                let control = controller.control();
                row.push(sp.z.unwrap_or(MISSING));
                row.extend(sp.attitude);
                row.extend(rates);
                row.extend([control.collective_thrust, controller.vertical_velocity_integral()]);
                row.extend(control.rate_integral);
                saturation(row, control.saturation);
                hover(row, controller.hover_thrust_estimate());
                row.extend(sp.attitude);
                row.extend([sp.yaw_rate, sp.z.unwrap_or(MISSING), sp.z_velocity]);
            } else {
                // The estimate is available before any controller step.
                row.resize(hover_column, MISSING);
                hover(row, controller.hover_thrust_estimate());
            }
        });
    }

    pub fn flight_loop(
        &mut self, samples: &mut Samples, sim: &Simulation, controller: &FlightLoop,
        input: Option<(FlightCommand, FlightSetpoints)>,
    ) {
        let hover_column = self.hover_column;
        self.record(samples, sim, controller.flight(), |row| {
            if let Some(((command, sp), snap)) = input.zip(controller.last_step()) {
                row.extend([
                    match snap.mode {
                        FlightMode::Rates => 1.0,
                        FlightMode::Stabilized => 2.0,
                        FlightMode::Altitude => 3.0,
                        FlightMode::Position => 4.0,
                    },
                    snap.auto_mode.map_or(MISSING, |mode| match mode {
                        AutoMode::Takeoff => 0.0,
                        AutoMode::Hold => 1.0,
                        AutoMode::Land => 2.0,
                        AutoMode::Return => 3.0,
                    }),
                    snap.return_state.map_or(MISSING, |state| match state {
                        ReturnState::Climb => 0.0,
                        ReturnState::Return => 1.0,
                        ReturnState::Descend => 2.0,
                        ReturnState::Loiter => 3.0,
                        ReturnState::Land => 4.0,
                        ReturnState::Landed => 5.0,
                    }),
                    match snap.takeoff_state {
                        TakeoffState::Disarmed => 0.0,
                        TakeoffState::SpoolUp => 1.0,
                        TakeoffState::ReadyForTakeoff => 2.0,
                        TakeoffState::RampUp => 3.0,
                        TakeoffState::Flight => 4.0,
                    },
                    flag(snap.land_state.freefall),
                    flag(snap.land_state.ground_contact),
                    flag(snap.land_state.maybe_landed),
                    flag(snap.land_state.landed),
                ]);
                row.extend(snap.position_setpoint);
                row.extend(snap.velocity_setpoint);
                row.extend(snap.acceleration_setpoint);
                row.extend(sp.attitude.unwrap_or([MISSING; 4]));
                row.extend(sp.rates);
                row.push(sp.collective_thrust);
                row.extend(sp.thrust_world.unwrap_or([MISSING; 3]));
                row.extend(snap.velocity_integral);
                row.extend(controller.rate_integral());
                saturation(row, snap.saturation);
                hover(row, snap.hover_thrust);
                flight_input(row, command);
            } else {
                row.resize(hover_column, MISSING);
                hover(row, controller.hover_thrust_estimate());
            }
        });
    }

    fn record(&mut self, samples: &mut Samples, sim: &Simulation, flight: &Flight, controller: impl FnOnce(&mut Vec<f64>)) {
        let state = sim.state();
        if let Some(sensors) = &mut self.sensors {
            sensors.observe(state, sim.config());
        }
        if !self.every.is_some_and(|every| state.steps.is_multiple_of(every.0)) {
            return;
        }
        let mut row = Vec::with_capacity(self.columns.len());
        row.extend([state.time_s, state.steps as f64]);
        row.extend(state.position_m);
        row.extend(state.com_m);
        row.extend(state.quaternion);
        row.extend(state.linear_velocity_mps);
        row.extend(state.angular_velocity_body_radps);
        row.push(flag(sim.touching_ground()));
        let battery = flight.battery();
        let loads = flight.loads();
        for (i, (motor, model)) in flight.motors().iter().zip(&self.motors).enumerate() {
            let speed = motor.rpm * (std::f64::consts::TAU / 60.0);
            // Reuse the electrical model (propulsion.rs:139-142,284-292). Density
            // scaling changes only thrust and drag coefficients (flight.rs:402-404).
            let voltage = model.effective_duty(motor.throttle) * battery.voltage_v;
            row.extend([motor.throttle, speed, motor.thrust_n, motor.drag_torque_nm, model.motor_current(speed, voltage)]);
            row.extend(ground_effect(loads.ground_effect_status.get(i).copied()));
        }
        row.extend([battery.voltage_v, battery.current_a, battery.charge_used_c]);
        row.extend(loads.thrust_body_n);
        row.extend(loads.drag_body_n);
        row.extend(loads.arm_torque_nm);
        row.extend(loads.drag_reaction_torque_nm);
        row.extend(loads.spin_up_reaction_torque_nm);
        row.extend(loads.rotor_gyro_torque_nm);
        row.extend(loads.total_torque_nm);
        row.extend(loads.wind_com_world_mps);
        if let Some(turbulence) = loads.turbulence {
            row.extend(turbulence.velocity_world_mps);
            row.extend([flag(turbulence.below_range), flag(turbulence.above_range)]);
        } else {
            row.extend([MISSING; 5]);
        }
        row.extend([loads.ground_effect_added_thrust_n, flag(loads.wind_above_range), flag(loads.wind_invalid)]);
        controller(&mut row);
        if state.steps == 0 {
            row.resize(self.base_columns, MISSING);
        }
        if let Some(sensors) = &self.sensors {
            imu_sample(&mut row, sensors.gyro());
            imu_sample(&mut row, sensors.accelerometer());
            row.extend(sensors.barometer().map_or([MISSING; 2], |sample| {
                [sample.pressure_pa, sample.altitude_m.unwrap_or(MISSING)]
            }));
            let gps = sensors.gps();
            row.extend(gps.map_or([MISSING; 3], |sample| sample.position_m));
            row.extend(gps.map_or([MISSING; 3], |sample| sample.velocity_mps));
        }
        debug_assert_eq!(row.len(), self.columns.len());
        samples.steps.push(state.steps);
        samples.rows.push(row);
    }
}

fn imu_sample(row: &mut Vec<f64>, sample: Option<ImuSample>) {
    row.extend(sample.map_or([MISSING; 3], |s| s.value));
    row.extend(sample.map_or([MISSING; 3], |s| s.clipped.map(flag)));
}

fn flag(value: bool) -> f64 {
    f64::from(u8::from(value))
}

fn ground_effect(status: Option<RotorGroundEffect>) -> [f64; 3] {
    match status {
        None => [MISSING; 3],
        Some(RotorGroundEffect::Inactive) => [0.0, MISSING, MISSING],
        Some(RotorGroundEffect::Applied { below_tested_range }) => [1.0, flag(below_tested_range), MISSING],
        Some(RotorGroundEffect::InvalidInput(reason)) => [2.0, MISSING, match reason {
            InvalidInput::HubHeight(_) => 0.0,
            InvalidInput::Radius(_) => 1.0,
            InvalidInput::Airspeed(_) => 2.0,
            InvalidInput::Thrust(_) => 3.0,
            InvalidInput::AirDensity(_) => 4.0,
        }],
        Some(RotorGroundEffect::InvalidWind) => [3.0, MISSING, MISSING],
        Some(RotorGroundEffect::NonFiniteThrust) => [4.0, MISSING, MISSING],
    }
}

fn saturation(row: &mut Vec<f64>, flags: SaturationDiagnostic) {
    row.extend(flags.positive.map(flag));
    row.extend(flags.negative.map(flag));
}

fn hover(row: &mut Vec<f64>, estimate: HoverThrustEstimate) {
    row.extend([estimate.hover_thrust, estimate.variance, flag(estimate.valid)]);
}

fn flight_input(row: &mut Vec<f64>, command: FlightCommand) {
    // Same field order as the FlightLoop input columns. Inactive inputs are null.
    let (kind, sticks) = match command {
        FlightCommand::Rates { .. } => (0.0, None),
        FlightCommand::AttitudeSetpoint { .. } => (1.0, None),
        FlightCommand::PositionSetpoint(_) => (2.0, None),
        FlightCommand::Stabilized(sticks) => (3.0, Some(sticks)),
        FlightCommand::Altitude(sticks) => (4.0, Some(sticks)),
        FlightCommand::Position(sticks) => (5.0, Some(sticks)),
        FlightCommand::Takeoff { .. } => (6.0, None),
        FlightCommand::Hold => (7.0, None),
        FlightCommand::Land => (8.0, None),
        FlightCommand::Return => (9.0, None),
    };
    row.push(kind);
    row.extend(sticks.map_or([MISSING; 4], |s| [s.forward, s.right, s.yaw_right, s.throttle]));
    let (rates, collective, attitude, yaw_rate) = match command {
        FlightCommand::Rates { body_radps, collective } => (body_radps, collective, [MISSING; 4], MISSING),
        FlightCommand::AttitudeSetpoint { attitude, yaw_rate, collective } => ([MISSING; 3], collective, attitude, yaw_rate),
        _ => ([MISSING; 3], MISSING, [MISSING; 4], MISSING),
    };
    row.extend(rates);
    row.push(collective);
    row.extend(attitude);
    row.push(yaw_rate);
    if let FlightCommand::PositionSetpoint(sp) = command {
        row.extend(sp.position);
        row.extend(sp.velocity);
        row.extend(sp.acceleration);
        row.extend([sp.yaw, sp.yaw_rate]);
    } else {
        row.extend([MISSING; 11]);
    }
    row.push(match command {
        FlightCommand::Takeoff { altitude_m } => altitude_m.unwrap_or(MISSING),
        _ => MISSING,
    });
}

fn axes(out: &mut Vec<String>, name: &str, axes: &[&str]) {
    out.extend(axes.iter().map(|axis| format!("{name}.{axis}")));
}

fn names(out: &mut Vec<String>, fields: &[&str]) {
    out.extend(fields.iter().map(|&name| name.into()));
}

fn channels(motors: usize, kind: ControllerKind) -> (Vec<String>, usize) {
    let mut out = Vec::new();
    names(&mut out, &["time", "step"]);
    axes(&mut out, "state.position", XYZ);
    axes(&mut out, "state.com", XYZ);
    axes(&mut out, "state.quaternion", XYZW);
    axes(&mut out, "state.velocity", XYZ);
    axes(&mut out, "state.bodyRates", XYZ);
    names(&mut out, &["state.groundContact"]);
    for i in 0..motors {
        axes(&mut out, &format!("motor.{i}"), &[
            "throttle", "speed", "thrust", "dragTorque", "current",
            "groundEffectStatus", "groundEffectBelowTestedRange", "groundEffectInvalidReason",
        ]);
    }
    names(&mut out, &["pack.voltage", "pack.current", "pack.chargeUsed"]);
    for name in ["thrust", "drag", "armTorque", "dragReactionTorque", "spinUpReactionTorque",
        "rotorGyroTorque", "totalTorque", "wind", "turbulence"] {
        axes(&mut out, &format!("loads.{name}"), XYZ);
    }
    names(&mut out, &["loads.turbulenceBelowRange", "loads.turbulenceAboveRange",
        "loads.groundEffectAddedThrust", "loads.windAboveRange", "loads.windInvalid", "controller.mode"]);
    let manual = matches!(kind, ControllerKind::FlightLoop);
    if manual {
        names(&mut out, &["controller.autoMode", "controller.returnState", "controller.takeoffState"]);
        axes(&mut out, "controller.land", &["freefall", "groundContact", "maybeLanded", "landed"]);
        for name in ["setpoint.position", "setpoint.velocity", "setpoint.acceleration"] {
            axes(&mut out, name, XYZ);
        }
    } else {
        names(&mut out, &["setpoint.position.z"]);
    }
    axes(&mut out, "setpoint.attitude", XYZW);
    axes(&mut out, "setpoint.rates", XYZ);
    names(&mut out, &["setpoint.collectiveThrust"]);
    if manual {
        axes(&mut out, "setpoint.thrustWorld", XYZ);
    }
    axes(&mut out, "controller.velocityIntegral", if manual { XYZ } else { &["z"] });
    axes(&mut out, "controller.rateIntegral", XYZ);
    for sign in ["positive", "negative"] {
        axes(&mut out, &format!("controller.saturation.{sign}"), &["roll", "pitch", "yaw", "collective"]);
    }
    let hover_column = out.len();
    names(&mut out, &["controller.hoverThrust", "controller.hoverThrustVariance", "controller.hoverThrustValid"]);
    if manual {
        names(&mut out, &["input.command"]);
        axes(&mut out, "input.stick", &["forward", "right", "yawRight", "throttle"]);
        axes(&mut out, "input.rates", XYZ);
        names(&mut out, &["input.collective"]);
        axes(&mut out, "input.attitude", XYZW);
        names(&mut out, &["input.yawRate"]);
        for name in ["input.position", "input.velocity", "input.acceleration"] {
            axes(&mut out, name, XYZ);
        }
        names(&mut out, &["input.heading", "input.headingRate", "input.takeoffAltitude"]);
    } else {
        axes(&mut out, "input.attitude", XYZW);
        names(&mut out, &["input.yawRate", "input.altitude", "input.climbRate"]);
    }
    (out, hover_column)
}
