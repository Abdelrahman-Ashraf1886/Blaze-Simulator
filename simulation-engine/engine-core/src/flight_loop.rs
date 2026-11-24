//! Manual and automatic flight on the propulsion and rigid-body plant. Sampling and motor
//! order follow closed_loop.rs:100-123 and controller.rs:783-787.

use crate::auto_modes::{AutoCommand, AutoFlight, AutoMode};
use crate::closed_loop::{unit_attitude, SaturationDiagnostic};
use crate::controller::{attitude_rates, Allocator, Gains, RateControl, Saturation};
use crate::flight::Flight;
use crate::flight_modes::{FlightCommand, FlightModes, ModeSetpoint};
use crate::hover_thrust::{HoverThrustEstimate, HoverThrustEstimator, HoverThrustParams, HoverThrustSample};
use crate::land_detector::{HoverThrustUpdate, LandDetector, LandDetectorInput, LandDetectorParams, LandState};
use crate::math::STANDARD_GRAVITY;
use crate::position_control::{limit_tilt, thrust_to_attitude, PositionControl, PositionGains, PositionInput, PositionOutput, PositionSetpoint};
use crate::sim::{Simulation, ALLOWED_LINEAR_ERROR_M};
use crate::takeoff::{Takeoff, TakeoffParams, TakeoffState, MICROS_PER_SECOND};
use crate::thrust_model::MotorOutput;
use crate::vehicle::{Quat, Vehicle};
use rapier3d_f64::{math::{Rotation, Vector}, prelude::{ColliderSet, RigidBodySet}};

// modules/ekf2/ekf2_params.c:53. Timestamp arithmetic stays in microseconds.
const EKF2_PREDICT_US: u64 = 10_000;
const ESTIMATE_INTERVAL_S: f64 = EKF2_PREDICT_US as f64 / MICROS_PER_SECOND as f64;
// MulticopterPositionControl.cpp:55,427,437.
const TILT_SLEW_RAD_S: f64 = 0.2;
const CUT_THRUST_ACCEL_UP: f64 = -100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlightMode {
    Rates,
    Stabilized,
    Altitude,
    Position,
}

/// The last completed step, in world Z-up coordinates. Non-finite setpoint
/// components denote inactive axes or layers (PositionSetpoint).
#[derive(Debug, Clone, Copy)]
pub struct FlightLoopSnapshot {
    pub mode: FlightMode,
    pub auto_mode: Option<AutoMode>,
    pub takeoff_state: TakeoffState,
    pub land_state: LandState,
    pub climb_speed_limit_m_s: f64,
    pub tilt_limit_rad: f64,
    pub position_setpoint: [f64; 3],
    pub velocity_setpoint: [f64; 3],
    pub acceleration_setpoint: [f64; 3],
    pub saturation: SaturationDiagnostic,
    pub velocity_integral: [f64; 3],
    pub hover_thrust: HoverThrustEstimate,
}

pub struct FlightLoop {
    flight: Flight,
    modes: FlightModes,
    hover: HoverSampling,
    motor_output: MotorOutput,
    position: PositionControl,
    gains: Gains,
    rate: RateControl,
    allocator: Allocator,
    saturation: Saturation,
    velocity_feedback: Option<[f64; 3]>,
    last_step: Option<FlightLoopSnapshot>,
    origin_z: Option<f64>,
    auto: Option<AutoFlight>,
    takeoff: Takeoff,
    detector: LandDetector,
    detector_hover_update: Option<HoverThrustUpdate>,
    tilt_limit_rad: f64,
    start_support: Vec<Vector>,
}

/// Samples the acceleration produced by an interval of plant steps. Both loop
/// forms consume the same gated EKF update after the last step of the interval.
pub(crate) struct HoverSampling {
    estimator: HoverThrustEstimator,
    interval_steps: u64,
    sample_time_us: u64,
    interval_start_vz: Option<f64>,
}

impl HoverSampling {
    pub(crate) fn new(hover: HoverThrustParams) -> Result<Self, String> {
        Ok(Self {
            estimator: HoverThrustEstimator::new(hover)?,
            interval_steps: 0,
            sample_time_us: 0,
            interval_start_vz: None,
        })
    }

    pub(crate) fn after_step(&mut self, sim: &Simulation, initial_vz: f64,
        vertical_thrust: f64, landed: bool, position: &mut PositionControl) -> Result<Option<HoverThrustUpdate>, String> {
        let start_vz = *self.interval_start_vz.get_or_insert(initial_vz);
        self.interval_steps += 1;
        let dt = sim.config().dt_s;
        let steps = (ESTIMATE_INTERVAL_S / dt).round() as u64;
        let exact_interval = steps != 0 && ESTIMATE_INTERVAL_S / steps as f64 == dt;
        // FlightLoop validates exact divisibility. The legacy API also accepts
        // other fixed steps: use the first plant endpoint at or beyond 10 ms.
        let steps_per_sample = if exact_interval { steps } else { (ESTIMATE_INTERVAL_S / dt).ceil() as u64 };
        if self.interval_steps == steps_per_sample {
            let elapsed = if exact_interval { ESTIMATE_INTERVAL_S } else { self.interval_steps as f64 * dt };
            self.interval_steps = 0;
            self.sample_time_us = self.sample_time_us.saturating_add((elapsed * 1_000_000.0).round() as u64);
            let end = sim.state();
            let [vx, vy, vz] = end.linear_velocity_mps;
            self.interval_start_vz = Some(vz);
            self.estimator.step(HoverThrustSample {
                timestamp_us: self.sample_time_us,
                armed: true,
                landed,
                // Over the ground plane or terrain. With no ground below (free space) PX4's
                // dist_bottom gate has nothing to close it, so the vehicle is in the air.
                distance_above_ground_m: sim.height_below(end.com_m[0], end.com_m[1])
                    .map_or(f64::INFINITY, |ground| end.com_m[2] - ground),
                // EKF2.cpp:938-941 publishes the world velocity derivative.
                vertical_acceleration_up_m_s2: (vz - start_vz) / elapsed,
                vertical_thrust_up: vertical_thrust,
                vertical_velocity_up_m_s: vz,
                horizontal_speed_m_s: vx.hypot(vy),
            });
            // MulticopterPositionControl.cpp:327-334 consumes valid estimates.
            if vertical_thrust.is_finite() {
                if let Some(hover) = self.estimator.controller_update() {
                    position.update_hover_thrust(hover)?;
                    return Ok(Some(HoverThrustUpdate {
                        timestamp_us: self.sample_time_us,
                        hover_thrust: hover,
                    }));
                }
            }
        }
        Ok(None)
    }
}

impl FlightLoop {
    pub fn new(
        vehicle: &Vehicle,
        flight: Flight,
        yaw_ratio: f64,
        gains: Gains,
        position: PositionGains,
        airmode: u8,
        hover: HoverThrustParams,
    ) -> Result<Self, String> {
        gains.validate()?;
        if hover.mpc_thr_hover != position.mpc_thr_hover || hover.mpc_use_hte != (position.mpc_use_hte != 0.0) {
            return Err("position and estimator must share MPC_THR_HOVER and MPC_USE_HTE".into());
        }
        let mut allocator = Allocator::new(&vehicle.definition.motors, yaw_ratio)?;
        allocator.set_airmode(airmode)?;
        Ok(Self {
            flight,
            hover: HoverSampling::new(hover)?,
            motor_output: MotorOutput::new(vehicle.definition.motors.len()),
            modes: FlightModes::new(position, airmode)?,
            position: PositionControl::new(position)?,
            gains,
            rate: RateControl::default(),
            allocator,
            saturation: Saturation::default(),
            velocity_feedback: None,
            last_step: None,
            origin_z: None,
            auto: None,
            takeoff: Takeoff::new(TakeoffParams {
                mpc_z_vel_p_acc: position.mpc_z_vel_p_acc,
                ..TakeoffParams::default()
            })?,
            detector: LandDetector::new(LandDetectorParams {
                mpc_land_speed: position.mpc_land_speed,
                mpc_thr_min: position.mpc_thr_min,
                mpc_manthr_min: position.mpc_manthr_min,
                mpc_thr_hover: position.mpc_thr_hover,
                mpc_use_hte: hover.mpc_use_hte,
                ..LandDetectorParams::default()
            })?,
            detector_hover_update: None,
            tilt_limit_rad: 0.0, // SlewRate.hpp:89-90.
            start_support: start_support_points(vehicle),
        })
    }

    pub fn flight(&self) -> &Flight {
        &self.flight
    }

    pub fn with_thrust_model(mut self, factor: f64) -> Result<Self, String> {
        self.motor_output.set_factor(factor)?;
        Ok(self)
    }

    pub(crate) fn relative_thrust(&self, throttle: f64) -> f64 {
        self.motor_output.relative_thrust(throttle)
    }

    pub fn hover_thrust_estimate(&self) -> HoverThrustEstimate {
        self.hover.estimator.estimate()
    }

    pub fn last_step(&self) -> Option<FlightLoopSnapshot> {
        self.last_step
    }

    /// Rotor and new flight-mode state for Simulation::state_hash_with.
    pub fn hash_words(&self) -> Vec<u64> {
        let mut words = self.flight.hash_words();
        words.extend(self.takeoff.hash_words());
        words.extend(self.detector.hash_words());
        words.extend([
            self.origin_z.is_some() as u64,
            self.origin_z.unwrap_or_default().to_bits(),
            self.tilt_limit_rad.to_bits(),
            self.auto.is_some() as u64,
        ]);
        if let Some(auto) = &self.auto {
            auto.hash_words(&mut words);
        }
        words.push(self.detector_hover_update.is_some() as u64);
        if let Some(update) = self.detector_hover_update {
            words.extend([update.timestamp_us, update.hover_thrust.to_bits()]);
        }
        if let Some(step) = self.last_step {
            words.extend([
                step.mode as u64, step.land_state.freefall as u64, step.land_state.ground_contact as u64,
                step.land_state.maybe_landed as u64, step.land_state.landed as u64,
            ]);
        }
        words
    }

    /// Seed the vertical integral for a direct position run at steady hover,
    /// retaining the configured hover gain and estimator parameters.
    pub(crate) fn trim_direct_position(&mut self, collective: f64, dt: f64) -> Result<(), String> {
        let mut position = self.position.clone();
        let nominal = position.hover_thrust();
        position.set_hover_thrust(collective)?;
        if position.hover_thrust() != collective {
            return Err("hover collective is outside the position controller's hover-thrust range".into());
        }
        // PositionControl::update_hover_thrust (position_control.rs:487-500)
        // computes the integral that preserves thrust as hover changes.
        position.update_hover_thrust(nominal)?;
        if position.velocity_integral()[2].abs() > crate::math::STANDARD_GRAVITY {
            return Err("MPC_THR_HOVER requires more than the vertical integral limit to trim this hover".into());
        }
        // Check the position controller's thrust limits at the zero-error
        // operating point without advancing its derivative or integral state.
        let estimate = PositionInput { position: [0.0; 3], velocity: [0.0; 3], yaw: 0.0 };
        let level = PositionSetpoint { position: estimate.position, ..Default::default() };
        let trim = position.clone().step(&estimate, &level, dt)?;
        // Same floating-point comparison tolerance as flight_modes/tests.rs:6-8.
        if (trim.collective_thrust - collective).abs() > 1e-12 {
            return Err("MPC_THR_MIN/MPC_THR_MAX prevent the position controller from holding this hover".into());
        }
        self.position = position;
        Ok(())
    }

    pub fn step(&mut self, sim: &mut Simulation, command: FlightCommand) -> Result<(), String> {
        self.step_with_commands(sim, command, |_, _, _, _| {})
    }

    /// Expose the controller and allocator outputs for direct setpoint runs.
    /// The motor slice borrows the allocator's existing command buffer.
    pub(crate) fn step_with_commands(
        &mut self,
        sim: &mut Simulation,
        command: FlightCommand,
        observe: impl FnOnce([f64; 3], Option<Quat>, &[f64], SaturationDiagnostic),
    ) -> Result<(), String> {
        if self.flight.ended().is_some() {
            return Ok(());
        }
        let state = sim.state();
        let attitude = unit_attitude(state.quaternion);
        let [x, y, z, w] = attitude;
        // Heading of the body X axis projected onto the engine's world XY plane.
        let estimate = PositionInput {
            position: state.com_m,
            velocity: state.linear_velocity_mps,
            yaw: (2.0 * (w * z + x * y)).atan2(1.0 - 2.0 * (y * y + z * z)),
        };
        let dt = sim.config().dt_s;
        let steps_per_sample = (ESTIMATE_INTERVAL_S / dt).round() as u64;
        if steps_per_sample == 0 || ESTIMATE_INTERVAL_S / steps_per_sample as f64 != dt {
            return Err("flight loop dt must divide EKF2_PREDICT_US (10000 us)".into());
        }
        let start = self.origin_z.is_none();
        let origin_z = self.origin_z.unwrap_or(estimate.position[2]);
        let touching_ground = sim.touching_ground() || (start && self.start_support.iter().any(|&point| {
            // The contact log starts empty (environment.rs:594). Probe the
            // initial collider points against the same surface and tolerance.
            let world = Rotation::from_xyzw(x, y, z, w) * point + Vector::from_array(state.position_m);
            sim.height_below(world.x, world.y).is_some_and(|height| world.z - height <= ALLOWED_LINEAR_ERROR_M)
        }));
        let land = self.last_step.map_or(LandState {
            freefall: false,
            ground_contact: touching_ground,
            maybe_landed: touching_ground,
            landed: touching_ground,
        }, |step| step.land_state);
        let now_us = (state.time_s * MICROS_PER_SECOND as f64).round() as u64;
        let next_us = ((state.steps + 1) as f64 * dt * MICROS_PER_SECOND as f64).round() as u64;
        let g = *self.position.gains();
        let ramp_s = self.takeoff.ramp_time_s();
        let mut auto = match AutoCommand::from_flight(command)? {
            Some(request) => Some(match self.auto.as_ref().filter(|a| a.accepts(request)) {
                Some(active) => active.clone(),
                None => AutoFlight::new(request, &estimate, origin_z)?,
            }),
            None => None,
        };
        // MulticopterHoverThrustEstimator.cpp:165-182 predicts without a
        // measurement when no local position setpoint is published.
        let mut vertical_thrust = f64::NAN;
        let mut modes = self.modes.clone();
        let mut takeoff = self.takeoff.clone();
        let skip_start = start && !touching_ground;
        let want_takeoff = auto.as_ref().is_some_and(|a| a.wants_takeoff(&estimate, origin_z, &g, ramp_s))
            || wants_manual_takeoff(command, &estimate);
        let position_mode = auto.is_some() || matches!(command,
            FlightCommand::PositionSetpoint(_) | FlightCommand::Altitude(_) | FlightCommand::Position(_));
        // Takeoff.cpp:102-104. An airborne start uses skip_takeoff by design.
        // Direct attitude/rate modes use the PX4 bypass (MC position control:511-515)
        // once airborne, leaving a grounded run armed and ready after landing.
        let skip_takeoff = skip_start || (!position_mode && !touching_ground && !land.landed);
        // Takeoff.cpp:82-94 falls through to ready when landed. Require physical
        // separation at ramp completion since low commanded thrust is only a
        // proxy for contact and can clear before an underpowered plant lifts.
        let landed_for_takeoff = land.landed || (takeoff.state() == TakeoffState::RampUp && touching_ground);
        let takeoff_state = takeoff.update_state(true, landed_for_takeoff, want_takeoff, skip_takeoff, now_us);
        let input_command = match &mut auto {
            Some(active) => FlightCommand::PositionSetpoint(
                active.setpoint(&estimate, takeoff_state, origin_z, &g, ramp_s, dt)),
            None => command,
        };
        let sp = modes.step(input_command, &estimate, self.velocity_feedback, land.landed, dt)?;
        let climb_limit = takeoff.update_ramp(next_us - now_us, g.mpc_z_vel_max_up);
        let flying = takeoff_state == TakeoffState::Flight;
        let mut tilt_limit_rad = self.tilt_limit_rad;
        if skip_start {
            tilt_limit_rad = g.mpc_tiltmax_air.to_radians();
        }
        if position_mode {
            let target_tilt = if flying { g.mpc_tiltmax_air } else { g.mpc_tiltmax_lnd }.to_radians();
            tilt_limit_rad += (target_tilt - tilt_limit_rad)
                .clamp(-TILT_SLEW_RAD_S * dt, TILT_SLEW_RAD_S * dt);
        }
        let mut setpoints = PositionSetpoint::default();
        let (mode, rates, thrust, desired_attitude) = match sp {
            ModeSetpoint::Rates {
                body_radps,
                collective,
            } => (FlightMode::Rates, body_radps, collective, None),
            ModeSetpoint::Attitude {
                attitude: desired,
                yaw_rate,
                collective,
            } => (
                FlightMode::Stabilized,
                attitude_rates(&self.gains, attitude, desired, yaw_rate),
                collective,
                Some(desired),
            ),
            ModeSetpoint::Position(mut sp) => {
                let mut position = self.position.clone();
                if self.modes.using_direct_position() != modes.using_direct_position()
                    && self.velocity_feedback.is_some()
                {
                    let retained = position.hover_thrust();
                    position.reset();
                    position.set_hover_thrust(retained)?;
                }
                // MulticopterPositionControl.cpp:413-432 resets on each incoming
                // trajectory setpoint while on the ground or ramping up.
                if !flying {
                    if !sp.position[2].is_finite() && !sp.velocity[2].is_finite() {
                        sp.velocity[2] = 0.0;
                    }
                    sp.acceleration[2] = f64::NAN;
                    position.set_hover_thrust(g.mpc_thr_hover)?;
                }
                if !matches!(takeoff_state, TakeoffState::RampUp | TakeoffState::Flight)
                    || (flying && land.ground_contact)
                {
                    sp = PositionSetpoint { acceleration: [0.0, 0.0, CUT_THRUST_ACCEL_UP], ..Default::default() };
                    position.reset_integral();
                }
                let out = RuntimeLimits {
                    climb: climb_limit.min(g.mpc_z_vel_max_up),
                    min_thrust: if flying { g.mpc_thr_min } else { 0.0 },
                    tilt_rad: tilt_limit_rad,
                }.step(&mut position, &estimate, sp, dt)?;
                self.position = position;
                vertical_thrust = out.thrust[2]; // PositionOutput, position_control.rs:371-378 (world Z-up).
                self.velocity_feedback = Some(out.velocity_setpoint);
                setpoints.position = sp.position;
                setpoints.velocity = out.velocity_setpoint;
                setpoints.acceleration = out.acceleration_setpoint;
                let mode = if matches!(command, FlightCommand::Altitude(_)) {
                    FlightMode::Altitude
                } else {
                    FlightMode::Position
                };
                (
                    mode,
                    attitude_rates(&self.gains, attitude, out.attitude, out.yaw_rate),
                    out.collective_thrust,
                    Some(out.attitude),
                )
            }
        };
        if !matches!(sp, ModeSetpoint::Position(_)) && self.velocity_feedback.take().is_some() {
            // MulticopterPositionControl.cpp:511-515 retains hover thrust on mode exit.
            // Its explicit reset at :413-419 belongs to the takeoff ramp.
            let retained = self.position.hover_thrust();
            self.position.reset();
            self.position.set_hover_thrust(retained)?;
        }
        self.modes = modes;
        self.auto = auto;
        self.origin_z = Some(origin_z);
        self.takeoff = takeoff;
        self.tilt_limit_rad = tilt_limit_rad;
        // PX4 MulticopterRateControl.cpp:242. Blocking both directions retains
        // the integral while still sampling the derivative and computing torque.
        let rate_saturation = if land.maybe_landed || land.landed {
            Saturation { positive: [true; 4], negative: [true; 4] }
        } else {
            self.saturation
        };
        let torque = self.rate.update(
            &self.gains,
            state.angular_velocity_body_radps,
            rates,
            rate_saturation,
            dt,
        );
        let allocation = self
            .allocator
            .allocate([torque[0], torque[1], torque[2], thrust]);
        self.saturation = allocation.saturation;
        let signals = self.motor_output.signals(allocation.commands);
        self.flight.step(sim, signals);
        let end = sim.state();
        let advanced = end.steps != state.steps;
        // LandDetector.cpp:69-78 uses a local-position callback with a 50 ms
        // backup. Our local-position samples arrive every 10 ms (EKF2_PREDICT_US),
        // so the backup never expires while the plant is running.
        let land_state = if advanced && end.steps.is_multiple_of(steps_per_sample) {
            let [vx, vy, vz] = end.linear_velocity_mps;
            let [x, y, z, w] = unit_attitude(end.quaternion);
            let specific_force = Vector::new(
                (vx - estimate.velocity[0]) / dt,
                (vy - estimate.velocity[1]) / dt,
                (vz - estimate.velocity[2]) / dt + sim.config().gravity_mps2,
            );
            let body_force = Rotation::from_xyzw(x, y, z, w).inverse() * specific_force;
            self.detector.step(LandDetectorInput {
                now_us: next_us,
                armed: true,
                local_position_timestamp_us: next_us,
                vertical_velocity_up_m_s: Some(vz),
                horizontal_velocity_m_s: Some([vx, vy]),
                body_rates_rad_s: end.angular_velocity_body_radps,
                specific_force_body_m_s2: [body_force.x, body_force.y, body_force.z],
                collective_thrust: thrust,
                hover_thrust_estimate_update: self.detector_hover_update.take(),
                climb_rate_control_enabled: position_mode,
                // MulticopterLandDetector.cpp:212-225 subscribes to the
                // trajectory, before MC position control resets its local copy.
                vertical_velocity_setpoint_up_m_s_update: match sp {
                    ModeSetpoint::Position(trajectory) => Some(trajectory.velocity[2]),
                    _ => None,
                },
            })
        } else {
            land
        };
        // Fuse using the just-published landed flag. A resulting hover
        // estimate becomes available to the detector on its next callback.
        if advanced {
            self.detector_hover_update = self.hover.after_step(
                sim, estimate.velocity[2], vertical_thrust, land_state.landed, &mut self.position,
            )?.or(self.detector_hover_update);
        }
        let saturation = SaturationDiagnostic {
            positive: self.saturation.positive,
            negative: self.saturation.negative,
        };
        self.last_step = Some(FlightLoopSnapshot {
            mode,
            auto_mode: self.auto.as_ref().map(|a| a.mode),
            takeoff_state,
            land_state,
            climb_speed_limit_m_s: climb_limit,
            tilt_limit_rad,
            position_setpoint: setpoints.position,
            velocity_setpoint: setpoints.velocity,
            acceleration_setpoint: setpoints.acceleration,
            saturation,
            velocity_integral: self.position.velocity_integral(),
            hover_thrust: self.hover.estimator.estimate(),
        });
        observe(rates, desired_attitude, signals, saturation);
        Ok(())
    }
}

fn wants_manual_takeoff(command: FlightCommand, estimate: &PositionInput) -> bool {
    match command {
        // FlightTaskManualAltitude.cpp:364-367, with the engine's positive-up stick.
        FlightCommand::Altitude(sticks) | FlightCommand::Position(sticks) => sticks.throttle > 0.3,
        // MulticopterPositionControl.cpp:382-399 (fresh direct position setpoint).
        FlightCommand::PositionSetpoint(sp) => sp.position[2] > estimate.position[2]
            || sp.velocity[2] > 0.0 || sp.acceleration[2] > 0.0,
        _ => false,
    }
}

// Same collider points as the initial terrain validation (environment.rs:528-552).
fn start_support_points(vehicle: &Vehicle) -> Vec<Vector> {
    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let handle = vehicle.build_body(&mut bodies, &mut colliders);
    let mut points = Vec::new();
    for collider in bodies[handle].colliders().iter().map(|&h| &colliders[h]) {
        let shape = collider.shape();
        let pose = collider.position();
        if shape.as_cuboid().is_some() {
            points.extend(shape.compute_local_aabb().vertices().map(|v| *pose * v));
        } else if let Some(hull) = shape.as_convex_polyhedron() {
            points.extend(hull.points().iter().map(|&v| *pose * v));
        } else if let Some(support) = shape.as_support_map() {
            points.push(support.support_point(pose, -Vector::Z));
            if let Some(cylinder) = shape.as_cylinder() {
                points.extend([-cylinder.half_height, cylinder.half_height]
                    .map(|y| *pose * Vector::new(0.0, y, 0.0)));
            }
        }
    }
    points
}

struct RuntimeLimits {
    climb: f64,
    min_thrust: f64,
    tilt_rad: f64,
}

impl RuntimeLimits {
    fn step(&self, control: &mut PositionControl, state: &PositionInput, mut sp: PositionSetpoint,
        dt: f64) -> Result<PositionOutput, String> {
        let g = *control.gains();
        // PositionControl.cpp:124-138. Apply the signed cap before the velocity
        // PID, whose configured limit only accepts positive climb speeds.
        let position_velocity = (sp.position[2] - state.position[2]) * g.mpc_z_p;
        let target = match (position_velocity.is_finite(), sp.velocity[2].is_finite()) {
            (true, true) => position_velocity + sp.velocity[2],
            (true, false) => position_velocity,
            _ => sp.velocity[2],
        };
        let capped = self.climb < g.mpc_z_vel_max_up && target > self.climb;
        if capped {
            sp.position[2] = f64::NAN;
            sp.velocity[2] = self.climb;
            // Limits.hpp:78-80 tests the climb bound first. During the start
            // of the ramp that bound can demand a faster descent than the
            // configured down limit. Carry the difference through the P term.
            if self.climb < -g.mpc_z_vel_max_dn {
                let acceleration = if sp.acceleration[2].is_finite() { sp.acceleration[2] } else { 0.0 };
                sp.acceleration[2] = acceleration
                    + g.mpc_z_vel_p_acc * (self.climb + g.mpc_z_vel_max_dn);
            }
        }
        let mut out = control.step(state, &sp, dt)?;
        if capped {
            out.velocity_setpoint[2] = self.climb;
        }
        if self.min_thrust == g.mpc_thr_min && self.tilt_rad == g.mpc_tiltmax_air.to_radians() {
            return Ok(out);
        }

        // PositionControl.cpp:61-65,157-180,197-208. The public controller
        // validates the configured parameter ranges, so apply these runtime
        // actuator limits to its output acceleration.
        let [ax, ay, az] = out.acceleration_setpoint;
        let body_z = limit_tilt(Vector::new(ax, ay, STANDARD_GRAVITY).normalize(), Vector::Z, self.tilt_rad);
        let collective = (control.hover_thrust() * (1.0 + az / STANDARD_GRAVITY) / body_z.z)
            .max(self.min_thrust.max(1e-3));
        let mut thrust = body_z * collective;
        let horizontal = thrust.x.hypot(thrust.y);
        let max_squared = g.mpc_thr_max.powi(2);
        let z_max = (max_squared - horizontal.min(g.mpc_thr_xy_marg).powi(2)).sqrt();
        if !z_max.is_finite() {
            return Err("nonfinite thrust under takeoff limits".into());
        }
        thrust.z = thrust.z.min(z_max);
        let xy_max = (max_squared - thrust.z.powi(2)).max(0.0).sqrt();
        if horizontal > xy_max {
            thrust.x *= xy_max / horizontal;
            thrust.y *= xy_max / horizontal;
        }
        out.thrust = thrust.to_array();
        let yaw = if sp.yaw.is_finite() { sp.yaw } else { state.yaw };
        (out.attitude, out.collective_thrust) = thrust_to_attitude(out.thrust, yaw);
        Ok(out)
    }
}

#[cfg(test)]
mod tests;
