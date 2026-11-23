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
//!    CoM, from the velocity at the start of the step. ρ is the caller's (ISA at
//!    the user's altitude, `src/domain/atmosphere.ts`); there is no default.
//! 4. The body steps (rapier, gravity included).
//!
//! Throttles are given in the order of `VehicleDefinition.motors`.
//! Not modelled (stated): rotor inflow and ground effect, blade flapping, prop
//! drag in forward flight (thrust is the static k_T ω² at any airspeed), motor
//! and ESC thermal limits. A battery cut-off is enforced only when the caller
//! sets one (`set_cutoff`, 4.8); `sim.run` sets none.

use crate::aero::{rotate_inverse, BodyDrag};
use crate::math::Vec3 as MVec3;
use crate::propulsion::{Propulsion, PropulsionState};
use crate::sim::{BodyInput, Simulation};
use crate::vehicle::{vec, Spin, Vehicle};
use rapier3d_f64::math::Vector;
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
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
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
}

fn arr(v: Vector) -> [f64; 3] {
    [v.x, v.y, v.z]
}

#[derive(Debug)]
pub struct Flight {
    motors: Vec<FlightMotor>,
    propulsion: Propulsion,
    state: PropulsionState,
    drag: Option<(BodyDrag, f64)>,
    throttle: Vec<f64>,
    cutoff: Option<Cutoff>,
    ended: Option<EndReason>,
    loads: StepLoads,
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
        Ok(Flight { motors, propulsion, state, drag, throttle: vec![0.0; n], cutoff: None, ended: None, loads: StepLoads::default() })
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

    /// Scales the rotors' thrust and torque coefficients from the density of the data
    /// they were fitted at (`reference_kg_m3`) to the density of this flight
    /// (`air_kg_m3`): T = k_T ω² and Q = k_Q ω² both scale as ρ/ρ_ref (4.8). The
    /// motor model then gives ω, current and battery use at the new loading. Both
    /// densities must be given and positive: no source states ρ_ref for every data
    /// set, so it is the user's entry where none does, never assumed.
    pub fn scale_to_air_density(&mut self, reference_kg_m3: f64, air_kg_m3: f64) -> Result<(), String> {
        for (name, rho) in [("reference density", reference_kg_m3), ("air density", air_kg_m3)] {
            if !(rho.is_finite() && rho > 0.0) {
                return Err(format!("the {name} must be a positive number (got {rho})"));
            }
        }
        let ratio = air_kg_m3 / reference_kg_m3;
        for m in &mut self.propulsion.motors {
            m.k_thrust *= ratio;
            m.k_torque *= ratio;
        }
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

    /// Rotor loads (step 1 of the module header) for body rate `omega_body`.
    pub fn rotor_loads(&self, omega_body: Vector) -> Loads {
        let (mut f, mut t, mut h) = (Vector::ZERO, Vector::ZERO, Vector::ZERO);
        for m in &self.motors {
            let model = &self.propulsion.motors[m.model];
            let w = self.state.omega[m.model];
            let thrust = m.axis * model.thrust(w);
            f += thrust;
            t += m.arm.cross(thrust) - m.axis * (m.spin * model.drag_torque(w));
            h += m.axis * (m.spin * model.j * w);
        }
        t -= omega_body.cross(h);
        Loads { force_body_n: f, torque_body_nm: t }
    }

    /// The rotor loads of `rotor_loads` by source: thrust force, arm torque,
    /// drag-torque reaction and gyroscopic torque (for the debug panel only; the
    /// step applies `rotor_loads`).
    fn rotor_split(&self, omega_body: Vector) -> (Vector, Vector, Vector, Vector) {
        let (mut f, mut arm, mut reaction, mut h) = (Vector::ZERO, Vector::ZERO, Vector::ZERO, Vector::ZERO);
        for m in &self.motors {
            let model = &self.propulsion.motors[m.model];
            let w = self.state.omega[m.model];
            let thrust = m.axis * model.thrust(w);
            f += thrust;
            arm += m.arm.cross(thrust);
            reaction -= m.axis * (m.spin * model.drag_torque(w));
            h += m.axis * (m.spin * model.j * w);
        }
        (f, arm, reaction, -omega_body.cross(h))
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
        let mut loads = self.rotor_loads(omega_body);
        let (thrust, arm, reaction, gyro) = self.rotor_split(omega_body);
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
            let v = s.linear_velocity_mps;
            let fw = drag.force_world(*rho, s.quaternion, MVec3::new(v[0], v[1], v[2]));
            let fb = rotate_inverse(s.quaternion, fw);
            drag_force = Vector::new(fb.x, fb.y, fb.z);
            loads.force_body_n += drag_force;
        }
        self.loads = StepLoads {
            thrust_body_n: arr(thrust),
            drag_body_n: arr(drag_force),
            arm_torque_nm: arr(arm),
            drag_reaction_torque_nm: arr(reaction),
            spin_up_reaction_torque_nm: arr(spin_up),
            rotor_gyro_torque_nm: arr(gyro),
            total_torque_nm: arr(loads.torque_body_nm),
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

    /// Exact bit patterns of the rotor speeds and the charge used, appended
    /// to the body's state hash (`Simulation::state_hash_with`).
    pub fn hash_words(&self) -> Vec<u64> {
        let mut words: Vec<u64> = self.state.omega.iter().map(|w| w.to_bits()).collect();
        words.push(self.state.charge_used_c.to_bits());
        words
    }
}

#[cfg(test)]
mod tests;
