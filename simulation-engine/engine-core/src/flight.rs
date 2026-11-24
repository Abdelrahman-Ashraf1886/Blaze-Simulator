//! Flight dynamics (Phase 4.6): the motors, battery and body drag acting on the
//! rigid body of `sim.rs`.
//!
//! Every fixed step `dt`, with the motor throttles `d_i ∈ [0, 1]` held over the
//! step (zero-order hold, like `BodyInput`):
//!
//! 1. Rotor loads from the rotor speeds ω_i at the start of the step. Motor i
//!    has its thrust point p_i and unit thrust axis a_i in body axes (true pose,
//!    tilt included) and a spin sign s_i = +1 for CCW, −1 for CW seen from above
//!    the rotor, so its angular momentum is h_i = s_i J_i ω_i a_i.
//!    - Thrust: F_i = k_T,i ω_i² a_i, through p_i. Force on the body Σ F_i, and
//!      torque about the CoM c: Σ (p_i − c) × F_i.
//!    - Drag-torque reaction: the motor holds the rotor against the air's drag
//!      torque Q_i = k_Q,i ω_i², so the body receives −s_i Q_i a_i (a CW rotor
//!      pushes the body CCW: +a_i).
//!    - Gyroscopic coupling of the spinning rotors: −ω_b × Σ h_i (ω_b the body
//!      rate in body axes). The body's own gyroscopic term is rapier's (sim.rs).
//! 2. The rotors and the battery advance by dt (`Propulsion::step`, RK4): pack
//!    sag V = V_oc − R_int·I and charge used ∫ I dt. Spinning a rotor up takes
//!    shaft torque J_i dω_i/dt, whose reaction on the body over the step is
//!    exactly −s_i J_i (ω_i(t+dt) − ω_i(t))/dt · a_i.
//! 3. Body drag (`aero.rs`), F = −½ ρ C_d A v|v| per body axis through the
//!    CoM, from the air-relative velocity at the start of the step. ρ is the caller's (ISA at
//!    the user's altitude, `src/domain/atmosphere.ts`); there is no default.
//! 4. The body steps (rapier, gravity included).
//!
//! Throttles are given in the order of `VehicleDefinition.motors`.
//! With optional wind, sample the mean plus gust at the CoM's height above
//! ground or terrain. Where there is no ground below the sample, use world z.
//! Use the start-of-step gust distance for all samples, then advance it with
//! the CoM speed relative to the mean air (`wind.rs:252-265`).
//!
//! With optional ground effect, scale each rotor's thrust by the single-rotor
//! model in `ground_effect.rs` (phase-6-flight-environment.md:66-68,191-200).
//! Use the vertical hub clearance and the horizontal airspeed at the moving
//! hub. Skip rotors with no ground below them or whose world thrust axis points
//! down. Shaft power and drag torque are unchanged. Rotor interactions, rotor
//! inflow, forward-flight prop drag, blade flapping and thermal limits are
//! outside this model. Battery cut-off is opt-in (`set_cutoff`).

use crate::aero::{rotate_inverse, BodyDrag};
use crate::ground_effect::{self, InvalidInput, RotorInput};
use crate::math::Vec3 as MVec3;
use crate::propulsion::{Propulsion, PropulsionState};
use crate::sim::{BodyInput, SimState, Simulation};
use crate::vehicle::{vec, Spin, Vehicle};
use crate::wind::{GustState, Wind, WindError};
use rapier3d_f64::math::{Rotation, Vector};
use serde::Serialize;

/// One motor as the flight step uses it.
#[derive(Debug, Clone, PartialEq)]
struct FlightMotor {
    part_id: String,
    /// Index into `Propulsion::motors` (matched by part id).
    model: usize,
    /// Thrust point relative to the CoM, body axes.
    arm: Vector,
    axis: Vector,
    /// +1 CCW, −1 CW (seen from above the rotor).
    spin: f64,
}

/// Per-motor values at the end of a run (or step).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotorReading {
    pub part_id: String,
    pub throttle: f64,
    pub rpm: f64,
    /// Free-air thrust at the end-of-step speed. Applied thrust is in `StepLoads`.
    pub thrust_n: f64,
    pub drag_torque_nm: f64,
}

/// Battery values: pack terminal voltage and current for the held throttles.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryReading {
    pub voltage_v: f64,
    pub current_a: f64,
    pub charge_used_c: f64,
    /// 1 − charge used / capacity.
    pub state_of_charge: f64,
}

/// Loads on the body for one step, body axes (for tests and the debug panel).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loads {
    pub force_body_n: Vector,
    pub torque_body_nm: Vector,
}

#[derive(Debug, Clone, Copy)]
struct RotorForces {
    thrust: Vector,
    arm: Vector,
    reaction: Vector,
    torque: Vector,
    momentum: Vector,
}

impl RotorForces {
    fn loads(self, omega_body: Vector) -> Loads {
        Loads { force_body_n: self.thrust, torque_body_nm: self.torque - omega_body.cross(self.momentum) }
    }
}

/// A battery cut-off the user chose; the run ends when it is reached (4.8).
/// There is no default: no source states one for a given pack.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cutoff {
    /// The pack terminal voltage under load falls to this, V.
    VoltageV(f64),
    /// The charge drawn reaches this, mAh.
    ChargeMah(f64),
}

/// Why a run ended before its duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    VoltageCutoff,
    ChargeCutoff,
}

/// What acted on the body over the last step, body axes, by source (the debug
/// panel, 4.8). Forces in N, torques about the CoM in N·m. The rotor speeds
/// are those at the start of the step (the loads of step 1 of the module
/// header); `total_torque_nm` is the sum actually applied.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepLoads {
    /// Σ F_i of the rotors.
    pub thrust_body_n: [f64; 3],
    /// Body drag, through the CoM.
    pub drag_body_n: [f64; 3],
    /// Σ (p_i − c) × F_i: the thrust forces at their arms.
    pub arm_torque_nm: [f64; 3],
    /// The rotors' drag torque held by the motors, −s_i Q_i a_i.
    pub drag_reaction_torque_nm: [f64; 3],
    /// Spinning the rotors up or down, −s_i J_i dω_i/dt a_i.
    pub spin_up_reaction_torque_nm: [f64; 3],
    /// −ω_b × Σ h_i.
    pub rotor_gyro_torque_nm: [f64; 3],
    pub total_torque_nm: [f64; 3],
    /// World wind at the CoM at the start of the step, m/s.
    #[serde(skip)]
    pub wind_com_world_mps: [f64; 3],
    /// Sum of scalar thrust increases in N, before projection onto the rotor axes.
    #[serde(skip)]
    pub ground_effect_added_thrust_n: f64,
    /// Per-rotor status in vehicle motor order. Empty when ground effect is disabled.
    #[serde(skip)]
    pub ground_effect_status: Vec<RotorGroundEffect>,
    /// The CoM or a sampled hub was above the 1000 ft shear limit.
    #[serde(skip)]
    pub wind_above_range: bool,
    /// A wind sample or gust update failed. A failed CoM sample uses calm air
    /// for drag, a failed hub sample skips ground effect, and a failed gust
    /// update leaves the gust state unchanged.
    #[serde(skip)]
    pub wind_invalid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RotorGroundEffect {
    Inactive,
    Applied { below_tested_range: bool },
    /// Use free-air thrust and retain the reason. With radii and density checked
    /// at setup, only a non-finite hub height, airspeed or free-air thrust can
    /// be rejected by the model during a step.
    InvalidInput(InvalidInput),
    InvalidWind,
    /// A non-finite result from scaling. Use free-air thrust.
    NonFiniteThrust,
}

#[derive(Default)]
struct WindFlags {
    above_range: bool,
    invalid: bool,
}

impl WindFlags {
    fn sample(&mut self, wind: &Wind, height: f64, gust_distance: Option<f64>) -> Option<Vector> {
        let at = |height| match gust_distance {
            Some(distance) => wind.velocity(height, distance),
            None => wind.mean_velocity(height),
        };
        let mut sample = at(height);
        if matches!(sample, Err(WindError::ShearHeightAboveLimit(_))) {
            // Reviewer's decision: hold at the top of the shear profile (wind.rs:16,21,187-199).
            self.above_range = true;
            sample = at(1000.0 * 0.3048);
        }
        self.invalid |= sample.is_err();
        sample.ok()
    }
}

fn arr(v: Vector) -> [f64; 3] {
    [v.x, v.y, v.z]
}

/// Why `Flight::scale_to_air_density` refused. Nothing changed when it does.
#[derive(Debug, Clone, PartialEq)]
pub enum ScaleToAirDensityError {
    /// A motor's propulsion data has no reference density, and none is assumed.
    MissingReferenceDensity { part_id: String },
    /// The air density is not a positive finite number, kg/m³.
    InvalidDensity(f64),
}

impl std::fmt::Display for ScaleToAirDensityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingReferenceDensity { part_id } => write!(
                f,
                "motor \"{part_id}\" has no reference density (referenceDensityKgM3): the air density its thrust and torque data was measured or computed at"
            ),
            Self::InvalidDensity(air) => write!(f, "the air density must be a positive number (got {air})"),
        }
    }
}

impl std::error::Error for ScaleToAirDensityError {}

/// Callers that return `String` (the scenario builders) keep their `?`; the text is the same.
impl From<ScaleToAirDensityError> for String {
    fn from(e: ScaleToAirDensityError) -> String {
        e.to_string()
    }
}

#[derive(Debug)]
pub struct Flight {
    motors: Vec<FlightMotor>,
    propulsion: Propulsion,
    state: PropulsionState,
    drag: Option<(BodyDrag, f64)>,
    rotor_air_density: Option<f64>,
    wind: Option<Wind>,
    gust: Option<GustState>,
    rotor_radii: Vec<f64>,
    last_ground_effect_rotors: Option<RotorForces>,
    throttle: Vec<f64>,
    cutoff: Option<Cutoff>,
    ended: Option<EndReason>,
    loads: StepLoads,
    /// (k_T, k_Q) of each propulsion motor as loaded, the data's own coefficients;
    /// `scale_to_air_density` always scales from these, never from a scaled value.
    base_coefficients: Vec<(f64, f64)>,
}

impl Flight {
    /// `drag` needs the air density ρ (kg/m³, finite and positive).
    pub fn new(vehicle: &Vehicle, propulsion: Propulsion, drag: Option<BodyDrag>, air_density: Option<f64>) -> Result<Flight, String> {
        let c = vec(vehicle.totals.com);
        let mut motors = Vec::new();
        for m in &vehicle.definition.motors {
            let model = propulsion
                .definition
                .motors
                .iter()
                .position(|p| p.part_id == m.part_id)
                .ok_or_else(|| format!("no propulsion data for motor \"{}\"", m.part_id))?;
            motors.push(FlightMotor {
                part_id: m.part_id.clone(),
                model,
                arm: vec(m.position) - c,
                axis: vec(m.thrust_axis),
                spin: match m.spin {
                    Spin::Ccw => 1.0,
                    Spin::Cw => -1.0,
                },
            });
        }
        let drag = match (drag, air_density) {
            (None, _) => None,
            (Some(d), Some(rho)) if rho.is_finite() && rho > 0.0 => Some((d, rho)),
            (Some(_), Some(rho)) => return Err(format!("airDensityKgM3 must be a positive number (got {rho})")),
            (Some(_), None) => return Err("the vehicle has body drag: give the air density (airDensityKgM3)".into()),
        };
        let state = propulsion.rest();
        let n = motors.len();
        let base_coefficients = propulsion.motors.iter().map(|m| (m.k_thrust, m.k_torque)).collect();
        Ok(Flight {
            motors, propulsion, state, drag, throttle: vec![0.0; n], cutoff: None,
            ended: None, loads: StepLoads::default(), base_coefficients,
            rotor_air_density: air_density.filter(|rho| rho.is_finite() && *rho > 0.0),
            wind: None, gust: None, rotor_radii: Vec::new(), last_ground_effect_rotors: None,
        })
    }

    /// Install wind. Configure before the first step to measure gust start time
    /// from simulation time zero. Replacing wind starts its gust clock anew.
    pub fn set_wind(&mut self, wind: Wind) {
        self.gust = wind.gust_state();
        self.wind = Some(wind);
    }

    /// Enable the single-rotor model with one finite, positive radius in metres
    /// per vehicle motor. Hub positions are the vehicle's motor positions.
    /// Supply the actual air density to `new` or `scale_to_air_density` first.
    /// Call `scale_to_air_density` when the loaded coefficients need conversion
    /// from their reference densities. Invalid settings leave the flight unchanged.
    pub fn set_ground_effect(&mut self, radii_m: &[f64]) -> Result<(), String> {
        if self.rotor_air_density.is_none() {
            return Err("ground effect requires a finite, positive air density".into());
        }
        if radii_m.len() != self.motors.len() || !radii_m.iter().all(|r| r.is_finite() && *r > 0.0) {
            return Err(format!("give {} propeller radii in metres, each finite and positive", self.motors.len()));
        }
        self.rotor_radii = radii_m.to_vec();
        self.loads.ground_effect_status.resize(radii_m.len(), RotorGroundEffect::Inactive);
        self.last_ground_effect_rotors = None;
        Ok(())
    }

    /// Ends the run when the battery reaches `cutoff` (checked after each step,
    /// so a run overshoots it by at most one step). Must be finite and positive.
    pub fn set_cutoff(&mut self, cutoff: Cutoff) -> Result<(), String> {
        let (Cutoff::VoltageV(x) | Cutoff::ChargeMah(x)) = cutoff;
        if !(x.is_finite() && x > 0.0) {
            return Err(format!("the cut-off must be a positive number (got {x})"));
        }
        self.cutoff = Some(cutoff);
        Ok(())
    }

    /// Scales each motor's thrust and torque coefficients from the air density its data was
    /// fitted at (`MotorPropulsion::reference_density_kg_m3`: stated by the data's source, or
    /// the user's entry for it, per motor) to the density of this flight (`air_kg_m3`):
    /// T = k_T ω² and Q = k_Q ω² both scale as ρ/ρ_ref,i (4.8). The motor model then gives
    /// ω, current and battery use at the new loading. Every density must be positive, and
    /// every motor must have its reference density: none is assumed. Scaling is from the
    /// loaded coefficients, so calling it again replaces the scaling (k = k_base · ρ/ρ_ref)
    /// instead of compounding it. Nothing changes if it fails.
    pub fn scale_to_air_density(&mut self, air_kg_m3: f64) -> Result<(), ScaleToAirDensityError> {
        if !(air_kg_m3.is_finite() && air_kg_m3 > 0.0) {
            return Err(ScaleToAirDensityError::InvalidDensity(air_kg_m3));
        }
        let mut ratios = Vec::with_capacity(self.propulsion.motors.len());
        for (m, def) in self.propulsion.motors.iter().zip(&self.propulsion.definition.motors) {
            match m.reference_density {
                Some(rho) if rho.is_finite() && rho > 0.0 => ratios.push(air_kg_m3 / rho),
                _ => return Err(ScaleToAirDensityError::MissingReferenceDensity { part_id: def.part_id.clone() }),
            }
        }
        for ((m, (k_thrust, k_torque)), ratio) in self.propulsion.motors.iter_mut().zip(&self.base_coefficients).zip(ratios) {
            m.k_thrust = k_thrust * ratio;
            m.k_torque = k_torque * ratio;
        }
        self.rotor_air_density = Some(air_kg_m3);
        Ok(())
    }

    /// Why the run ended, once the cut-off was reached. An ended flight no longer steps.
    pub fn ended(&self) -> Option<EndReason> {
        self.ended
    }

    /// What acted on the body over the last step, by source.
    pub fn loads(&self) -> &StepLoads {
        &self.loads
    }

    /// Starts the rotors at these speeds (rad/s, vehicle motor order), e.g. a
    /// hover trim. Negative or non-finite speeds are refused.
    pub fn set_rotor_speeds(&mut self, omega: &[f64]) -> Result<(), String> {
        if omega.len() != self.motors.len() || !omega.iter().all(|w| w.is_finite() && *w >= 0.0) {
            return Err(format!("give {} rotor speeds, each finite and ≥ 0", self.motors.len()));
        }
        for (m, w) in self.motors.iter().zip(omega) {
            self.state.omega[m.model] = *w;
        }
        Ok(())
    }

    pub fn motor_count(&self) -> usize {
        self.motors.len()
    }

    /// Rotor loads for body rate `omega_body`. With ground effect enabled,
    /// use the last step's rotor sample so it agrees with the applied thrust
    /// and arm torque. Before that sample, use current speeds and free-air thrust.
    pub fn rotor_loads(&self, omega_body: Vector) -> Loads {
        self.last_ground_effect_rotors
            .unwrap_or_else(|| self.rotor_forces(|_, _, thrust| thrust))
            .loads(omega_body)
    }

    fn rotor_forces(&self, mut adjust_thrust: impl FnMut(usize, &FlightMotor, f64) -> f64) -> RotorForces {
        let mut result = RotorForces {
            thrust: Vector::ZERO, arm: Vector::ZERO, reaction: Vector::ZERO,
            torque: Vector::ZERO, momentum: Vector::ZERO,
        };
        for (i, m) in self.motors.iter().enumerate() {
            let model = &self.propulsion.motors[m.model];
            let w = self.state.omega[m.model];
            let thrust = m.axis * adjust_thrust(i, m, model.thrust(w));
            let arm = m.arm.cross(thrust);
            let drag = m.axis * (m.spin * model.drag_torque(w));
            result.thrust += thrust;
            result.arm += arm;
            result.reaction -= drag;
            // Preserve the original sum order for the applied torque and state hash.
            result.torque += arm - drag;
            result.momentum += m.axis * (m.spin * model.j * w);
        }
        result
    }

    fn step_wind(
        &mut self, sim: &Simulation, s: &SimState, dt: f64, gust_distance: Option<f64>, flags: &mut WindFlags,
    ) -> Vector {
        let Some(wind) = &self.wind else { return Vector::ZERO };
        let [x, y, z] = s.com_m;
        let height = z - sim.height_below(x, y).unwrap_or(0.0);
        let sample = flags.sample(wind, height, gust_distance).unwrap_or(Vector::ZERO);
        if let Some(gust) = &mut self.gust {
            if let Some(mean) = flags.sample(wind, height, None) {
                flags.invalid |= gust.advance((vec(s.linear_velocity_mps) - mean).length(), dt).is_err();
            }
        }
        sample
    }

    /// One fixed step of the vehicle with `throttle` (vehicle motor order,
    /// clamped to [0, 1]) held over it. After the cut-off (`set_cutoff`) was
    /// reached the flight no longer steps.
    pub fn step(&mut self, sim: &mut Simulation, throttle: &[f64]) {
        if self.ended.is_some() {
            return;
        }
        let dt = sim.config().dt_s;
        for (i, x) in self.throttle.iter_mut().enumerate() {
            *x = throttle.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
        }
        let s = sim.state();
        let omega_body = vec(s.angular_velocity_body_radps);
        let gust_distance = self.gust.as_ref().map(GustState::distance_m);
        let mut wind_flags = WindFlags::default();
        let wind_com = self.step_wind(sim, &s, dt, gust_distance, &mut wind_flags);
        let mut ground_status = std::mem::take(&mut self.loads.ground_effect_status);
        let mut added_thrust = 0.0;
        let rotors = if let Some(rho) = self.rotor_air_density.filter(|_| !self.rotor_radii.is_empty()) {
            let [x, y, z, w] = s.quaternion;
            let attitude = Rotation::from_xyzw(x, y, z, w);
            let rotors = self.rotor_forces(|i, motor, thrust| {
                ground_status[i] = RotorGroundEffect::Inactive;
                if (attitude * motor.axis).z < 0.0 {
                    return thrust;
                }
                let hub = vec(s.com_m) + attitude * motor.arm;
                let Some(ground) = sim.height_below(hub.x, hub.y) else { return thrust };
                let height = hub.z - ground;
                let mut air_velocity = vec(s.linear_velocity_mps) + attitude * omega_body.cross(motor.arm);
                if let Some(wind) = &self.wind {
                    let Some(sample) = wind_flags.sample(wind, height, gust_distance) else {
                        ground_status[i] = RotorGroundEffect::InvalidWind;
                        return thrust;
                    };
                    air_velocity -= sample;
                }
                let input = RotorInput {
                    hub_height_m: height, radius_m: self.rotor_radii[i],
                    horizontal_airspeed_m_s: air_velocity.x.hypot(air_velocity.y),
                    thrust_n: thrust, air_density_kg_m3: rho,
                };
                let effect = match ground_effect::thrust_ratio(&input) {
                    Ok(effect) => effect,
                    Err(error) => {
                        ground_status[i] = RotorGroundEffect::InvalidInput(error);
                        return thrust;
                    }
                };
                let adjusted = effect.ratio * thrust;
                if !adjusted.is_finite() {
                    ground_status[i] = RotorGroundEffect::NonFiniteThrust;
                    return thrust;
                }
                ground_status[i] = RotorGroundEffect::Applied { below_tested_range: effect.below_tested_range };
                added_thrust += adjusted - thrust;
                adjusted
            });
            self.last_ground_effect_rotors = Some(rotors);
            rotors
        } else {
            self.rotor_forces(|_, _, thrust| thrust)
        };
        let mut loads = rotors.loads(omega_body);
        let mut spin_up = Vector::ZERO;
        let mut drag_force = Vector::ZERO;
        // Propulsion takes throttles in its own (definition) order.
        let mut d = vec![0.0; self.propulsion.motors.len()];
        for (m, &x) in self.motors.iter().zip(&self.throttle) {
            d[m.model] = x;
        }
        let before = self.state.omega.clone();
        self.propulsion.step(&mut self.state, &d, dt);
        for m in &self.motors {
            let dw = self.state.omega[m.model] - before[m.model];
            let q = m.axis * (m.spin * self.propulsion.motors[m.model].j * dw / dt);
            loads.torque_body_nm -= q;
            spin_up -= q;
        }
        if let Some((drag, rho)) = &self.drag {
            // Keep the original velocity bits when wind is absent or exactly calm.
            let v = if wind_com == Vector::ZERO { s.linear_velocity_mps } else { arr(vec(s.linear_velocity_mps) - wind_com) };
            let fw = drag.force_world(*rho, s.quaternion, MVec3::new(v[0], v[1], v[2]));
            let fb = rotate_inverse(s.quaternion, fw);
            drag_force = Vector::new(fb.x, fb.y, fb.z);
            loads.force_body_n += drag_force;
        }
        self.loads = StepLoads {
            thrust_body_n: arr(rotors.thrust),
            drag_body_n: arr(drag_force),
            arm_torque_nm: arr(rotors.arm),
            drag_reaction_torque_nm: arr(rotors.reaction),
            spin_up_reaction_torque_nm: arr(spin_up),
            rotor_gyro_torque_nm: arr(-omega_body.cross(rotors.momentum)),
            total_torque_nm: arr(loads.torque_body_nm),
            wind_com_world_mps: arr(wind_com),
            ground_effect_added_thrust_n: added_thrust,
            ground_effect_status: ground_status,
            wind_above_range: wind_flags.above_range,
            wind_invalid: wind_flags.invalid,
        };
        sim.step(&BodyInput { force_body_n: loads.force_body_n, torque_body_nm: loads.torque_body_nm });
        if let Some(cutoff) = self.cutoff {
            let b = self.battery();
            self.ended = match cutoff {
                Cutoff::VoltageV(v) if b.voltage_v <= v => Some(EndReason::VoltageCutoff),
                Cutoff::ChargeMah(q) if b.charge_used_c / 3.6 >= q => Some(EndReason::ChargeCutoff),
                _ => None,
            };
        }
    }

    pub fn motors(&self) -> Vec<MotorReading> {
        self.motors
            .iter()
            .zip(&self.throttle)
            .map(|(m, &throttle)| {
                let model = &self.propulsion.motors[m.model];
                let w = self.state.omega[m.model];
                MotorReading {
                    part_id: m.part_id.clone(),
                    throttle,
                    rpm: w * 60.0 / (2.0 * std::f64::consts::PI),
                    thrust_n: model.thrust(w),
                    drag_torque_nm: model.drag_torque(w),
                }
            })
            .collect()
    }

    pub fn battery(&self) -> BatteryReading {
        let mut d = vec![0.0; self.propulsion.motors.len()];
        for (m, &x) in self.motors.iter().zip(&self.throttle) {
            d[m.model] = x;
        }
        let used = self.state.charge_used_c;
        BatteryReading {
            voltage_v: self.propulsion.pack_voltage(&self.state.omega, &d),
            current_a: self.propulsion.pack_current(&self.state.omega, &d),
            charge_used_c: used,
            state_of_charge: 1.0 - used / self.propulsion.battery.capacity_c,
        }
    }

    /// Exact bit patterns of the rotor speeds, charge used and optional gust state, appended
    /// to the body's state hash (`Simulation::state_hash_with`).
    pub fn hash_words(&self) -> Vec<u64> {
        let mut words: Vec<u64> = self.state.omega.iter().map(|w| w.to_bits()).collect();
        words.push(self.state.charge_used_c.to_bits());
        if let Some(gust) = &self.gust {
            words.extend(gust.hash_words());
        }
        words
    }
}

#[cfg(test)]
mod tests;
