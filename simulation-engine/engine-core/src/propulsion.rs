//! Motor, propeller and battery models (Phase 4.5).
//!
//! The coefficients are fitted on the TypeScript side (`src/domain/propulsion.ts`,
//! where every formula and data source is documented) and arrive with
//! `vehicle.load` as the optional `propulsion` structure, separate from the
//! pinned `VehicleDefinition`. This module validates them and simulates the
//! response; 4.6 applies the forces in the flight step.
//!
//! Model (SI: ω rad/s, I A, V V, R Ω, J kg·m²)
//! - Motor (ideal brushless DC): K_t = 1/K_v; winding V_m = ω/K_v + R·I_m.
//! - ESC (ideal averaging, lossless; a labelled assumption): V_m = e·V, supply
//!   current I_s = e·I_m, where e = map(d) is the effective duty for the
//!   throttle command d ∈ [0, 1]. The optional per-motor `throttleMap` is the
//!   empirical effective control ratio derived from the manufacturer's bench
//!   rows (not an ESC efficiency); without it e = d. Interpolation is identical
//!   to `effectiveDuty` in TypeScript (shared fixture test).
//! - Rotor: J dω/dt = K_t (I_m − I₀) − k_Q ω²; thrust T = k_T ω²,
//!   drag torque Q = k_Q ω².
//!   I₀ is a loss (friction, iron), so it can only stop the rotor, never drive
//!   it backwards: at ω = 0 a negative net torque leaves the rotor at rest.
//! - Battery: V = V_oc − R_int·I with I = Σ I_s over the motors;
//!   charge used = ∫ I dt.
//!   With I_m,i = (d_i V − ω_i/K_v,i)/R_i the pack voltage is linear in V and is
//!   solved exactly at every evaluation:
//!   V = (V_oc + R_int Σ d_i ω_i/(K_v,i R_i)) / (1 + R_int Σ d_i²/R_i).
//! - Integration: classic RK4 on (ω₁…ω_n, charge) with the throttles held over
//!   the step.

use crate::vehicle::{VehicleDefinition, VehicleError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROPULSION_DEFINITION_VERSION: u32 = 1;

/// One motor with its propeller, as `vehicle.load` sends it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotorPropulsion {
    /// Matches a `VehicleDefinition` motor.
    pub part_id: String,
    /// K_v, rad/(s·V).
    #[serde(rename = "kvRadPerSV")]
    pub kv_rad_per_sv: f64,
    pub resistance_ohm: f64,
    pub no_load_current_a: f64,
    /// k_T, N·s².
    pub thrust_coef_ns2: f64,
    /// k_Q, N·m·s².
    pub torque_coef_nms2: f64,
    /// J_rotor + J_prop, kg·m².
    pub inertia_kg_m2: f64,
    /// Throttle → effective duty pairs `[d, e]` (an empirical bench ratio, see
    /// `src/domain/propulsion.ts`): sorted by d, e non-decreasing in (0, 1].
    /// Absent = ideal ESC, e = d.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_map: Option<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatteryParams {
    pub open_circuit_voltage_v: f64,
    pub internal_resistance_ohm: f64,
    /// Coulombs.
    pub capacity_c: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropulsionDefinition {
    pub version: u32,
    pub motors: Vec<MotorPropulsion>,
    pub battery: BatteryParams,
}

/// The motor model in SI, ready to evaluate.
#[derive(Debug, Clone, PartialEq)]
pub struct MotorModel {
    pub kv: f64,
    pub kt: f64,
    pub r: f64,
    pub i0: f64,
    pub k_thrust: f64,
    pub k_torque: f64,
    pub j: f64,
    /// `[d, e]` points; empty = ideal (e = d).
    pub map: Vec<[f64; 2]>,
}

impl MotorModel {
    pub fn new(m: &MotorPropulsion) -> Self {
        MotorModel {
            kv: m.kv_rad_per_sv,
            kt: 1.0 / m.kv_rad_per_sv,
            r: m.resistance_ohm,
            i0: m.no_load_current_a,
            k_thrust: m.thrust_coef_ns2,
            k_torque: m.torque_coef_nms2,
            j: m.inertia_kg_m2,
            map: m.throttle_map.clone().unwrap_or_default(),
        }
    }

    /// Effective duty for throttle d, exactly as `effectiveDuty` in
    /// `src/domain/propulsion.ts`: linear between points, the nearest point's
    /// ratio held outside them, bounded to [0, 1].
    pub fn effective_duty(&self, d: f64) -> f64 {
        let t = d.clamp(0.0, 1.0);
        let p = &self.map;
        if t == 0.0 || p.is_empty() {
            return t;
        }
        let (first, last) = (p[0], p[p.len() - 1]);
        if t <= first[0] {
            return (first[1] / first[0] * t).min(1.0);
        }
        if t >= last[0] {
            return (last[1] / last[0] * t).min(1.0);
        }
        for w in p.windows(2) {
            let (a, b) = (w[0], w[1]);
            if t <= b[0] {
                let f = (t - a[0]) / (b[0] - a[0]);
                return a[1] + f * (b[1] - a[1]);
            }
        }
        last[1]
    }

    /// Winding current at speed ω with V_m across the motor.
    pub fn motor_current(&self, omega: f64, v_m: f64) -> f64 {
        (v_m - omega / self.kv) / self.r
    }

    /// dω/dt at speed ω with V_m across the motor (I₀ never reverses the rotor).
    pub fn omega_dot(&self, omega: f64, v_m: f64) -> f64 {
        let torque = self.kt * (self.motor_current(omega, v_m) - self.i0) - self.k_torque * omega * omega;
        if omega <= 0.0 && torque < 0.0 {
            0.0
        } else {
            torque / self.j
        }
    }

    /// Steady speed with V_m across the motor and an extra series resistance
    /// `r_extra`: a ω² + b ω − c = 0, a = (R+r)·k_Q·K_v, b = 1/K_v,
    /// c = V_m − (R+r)·I₀; ω = 2c / (b + √(b² + 4ac)), 0 for c ≤ 0.
    pub fn steady_omega(&self, v_m: f64, r_extra: f64) -> f64 {
        let r = self.r + r_extra;
        let a = r * self.k_torque * self.kv;
        let b = 1.0 / self.kv;
        let c = v_m - r * self.i0;
        if c <= 0.0 {
            0.0
        } else {
            2.0 * c / (b + (b * b + 4.0 * a * c).sqrt())
        }
    }

    pub fn thrust(&self, omega: f64) -> f64 {
        self.k_thrust * omega * omega
    }

    pub fn drag_torque(&self, omega: f64) -> f64 {
        self.k_torque * omega * omega
    }
}

/// A validated propulsion definition.
#[derive(Debug, Clone, PartialEq)]
pub struct Propulsion {
    pub definition: PropulsionDefinition,
    /// Same order as `definition.motors`.
    pub motors: Vec<MotorModel>,
    pub battery: BatteryParams,
}

/// Rotor speeds and charge drawn so far.
#[derive(Debug, Clone, PartialEq)]
pub struct PropulsionState {
    pub omega: Vec<f64>,
    pub charge_used_c: f64,
}

fn error(path: impl Into<String>, message: impl Into<String>) -> VehicleError {
    VehicleError { path: path.into(), message: message.into() }
}

impl Propulsion {
    /// Reads and validates the structure against the loaded vehicle. Paths in
    /// the errors start with `propulsion.`.
    pub fn from_json(value: Value, vehicle: &VehicleDefinition) -> Result<Propulsion, Vec<VehicleError>> {
        let def: PropulsionDefinition = serde_json::from_value(value)
            .map_err(|e| vec![error("propulsion", format!("not a propulsion definition: {e}"))])?;
        Propulsion::from_definition(def, vehicle)
    }

    pub fn from_definition(def: PropulsionDefinition, vehicle: &VehicleDefinition) -> Result<Propulsion, Vec<VehicleError>> {
        let mut errors = Vec::new();
        if def.version != PROPULSION_DEFINITION_VERSION {
            return Err(vec![error(
                "propulsion.version",
                format!("is {}; this engine reads version {PROPULSION_DEFINITION_VERSION}", def.version),
            )]);
        }
        let positive = |errors: &mut Vec<VehicleError>, path: String, v: f64| {
            if !(v.is_finite() && v > 0.0) {
                errors.push(error(path, format!("must be a positive number (got {v})")));
            }
        };
        let mut seen = std::collections::HashSet::new();
        for (i, m) in def.motors.iter().enumerate() {
            let p = |f: &str| format!("propulsion.motors[{i}].{f}");
            if !seen.insert(m.part_id.as_str()) {
                errors.push(error(p("partId"), format!("\"{}\" is listed twice", m.part_id)));
            }
            if !vehicle.motors.iter().any(|v| v.part_id == m.part_id) {
                errors.push(error(p("partId"), format!("\"{}\" is not a motor of the vehicle", m.part_id)));
            }
            positive(&mut errors, p("kvRadPerSV"), m.kv_rad_per_sv);
            positive(&mut errors, p("resistanceOhm"), m.resistance_ohm);
            positive(&mut errors, p("thrustCoefNs2"), m.thrust_coef_ns2);
            positive(&mut errors, p("torqueCoefNms2"), m.torque_coef_nms2);
            positive(&mut errors, p("inertiaKgM2"), m.inertia_kg_m2);
            if let Some(map) = &m.throttle_map {
                let ok = !map.is_empty()
                    && map.iter().all(|[d, e]| d.is_finite() && e.is_finite() && *d > 0.0 && *d <= 1.0 && *e > 0.0 && *e <= 1.0)
                    && map.windows(2).all(|w| w[1][0] > w[0][0] && w[1][1] >= w[0][1]);
                if !ok {
                    errors.push(error(
                        p("throttleMap"),
                        "must be non-empty [throttle, effectiveDuty] pairs in (0, 1], throttle increasing, effective duty non-decreasing",
                    ));
                }
            }
            if !(m.no_load_current_a.is_finite() && m.no_load_current_a >= 0.0) {
                errors.push(error(p("noLoadCurrentA"), format!("must be a number ≥ 0 (got {})", m.no_load_current_a)));
            }
        }
        for v in &vehicle.motors {
            if !def.motors.iter().any(|m| m.part_id == v.part_id) {
                errors.push(error("propulsion.motors", format!("no data for vehicle motor \"{}\"", v.part_id)));
            }
        }
        let b = def.battery;
        positive(&mut errors, "propulsion.battery.openCircuitVoltageV".into(), b.open_circuit_voltage_v);
        positive(&mut errors, "propulsion.battery.internalResistanceOhm".into(), b.internal_resistance_ohm);
        positive(&mut errors, "propulsion.battery.capacityC".into(), b.capacity_c);
        if !errors.is_empty() {
            return Err(errors);
        }
        let motors = def.motors.iter().map(MotorModel::new).collect();
        Ok(Propulsion { battery: def.battery, motors, definition: def })
    }

    /// Mean k_Q/k_T over the motors (m): the yaw-to-thrust ratio the control
    /// allocation uses (`closed_loop.rs`).
    pub fn yaw_ratio(&self) -> f64 {
        self.motors.iter().map(|m| m.k_torque / m.k_thrust).sum::<f64>() / self.motors.len() as f64
    }

    pub fn rest(&self) -> PropulsionState {
        PropulsionState { omega: vec![0.0; self.motors.len()], charge_used_c: 0.0 }
    }

    /// Effective duty of each motor for the throttle commands (clamped to [0, 1]).
    pub fn duties(&self, throttle: &[f64]) -> Vec<f64> {
        self.motors.iter().enumerate().map(|(i, m)| m.effective_duty(throttle.get(i).copied().unwrap_or(0.0))).collect()
    }

    /// Pack terminal voltage for the rotor speeds and throttle commands.
    pub fn pack_voltage(&self, omega: &[f64], throttle: &[f64]) -> f64 {
        self.pack_voltage_at(omega, &self.duties(throttle))
    }

    /// Supply current drawn from the pack, Σ e_i I_m,i, for throttle commands.
    pub fn pack_current(&self, omega: &[f64], throttle: &[f64]) -> f64 {
        let e = self.duties(throttle);
        let v = self.pack_voltage_at(omega, &e);
        self.motors.iter().zip(omega).zip(&e).map(|((m, &w), &d)| d * m.motor_current(w, d * v)).sum()
    }

    /// Pack voltage for effective duties (header formula with d → e).
    fn pack_voltage_at(&self, omega: &[f64], throttle: &[f64]) -> f64 {
        let r_int = self.battery.internal_resistance_ohm;
        let (mut num, mut den) = (self.battery.open_circuit_voltage_v, 1.0);
        for ((m, &w), &d) in self.motors.iter().zip(omega).zip(throttle) {
            num += r_int * d * w / (m.kv * m.r);
            den += r_int * d * d / m.r;
        }
        num / den
    }

    /// `throttle` here holds effective duties.
    fn derivative(&self, omega: &[f64], throttle: &[f64]) -> (Vec<f64>, f64) {
        let v = self.pack_voltage_at(omega, throttle);
        let mut current = 0.0;
        let dw = self
            .motors
            .iter()
            .zip(omega)
            .zip(throttle)
            .map(|((m, &w), &d)| {
                current += d * m.motor_current(w, d * v);
                m.omega_dot(w, d * v)
            })
            .collect();
        (dw, current)
    }

    /// Advances the rotors and the drawn charge by `dt` (RK4), throttles held
    /// constant over the step. Throttles are clamped to [0, 1].
    pub fn step(&self, state: &mut PropulsionState, throttle: &[f64], dt: f64) {
        let d = self.duties(throttle);
        let w0 = state.omega.clone();
        let add = |w: &[f64], k: &[f64], h: f64| -> Vec<f64> { w.iter().zip(k).map(|(a, b)| (a + h * b).max(0.0)).collect() };
        let (k1, i1) = self.derivative(&w0, &d);
        let (k2, i2) = self.derivative(&add(&w0, &k1, dt / 2.0), &d);
        let (k3, i3) = self.derivative(&add(&w0, &k2, dt / 2.0), &d);
        let (k4, i4) = self.derivative(&add(&w0, &k3, dt), &d);
        for i in 0..w0.len() {
            state.omega[i] = (w0[i] + dt / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])).max(0.0);
        }
        state.charge_used_c += dt / 6.0 * (i1 + 2.0 * i2 + 2.0 * i3 + i4);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The TypeScript hand-solution motor (tests/unit/propulsion.test.ts):
    /// K_v = 100 rad/(s·V), R = 0.1 Ω, I₀ = 0.5 A, k_Q = 1e-7 N·m·s².
    fn motor(part_id: &str) -> MotorPropulsion {
        MotorPropulsion {
            part_id: part_id.into(),
            kv_rad_per_sv: 100.0,
            resistance_ohm: 0.1,
            no_load_current_a: 0.5,
            thrust_coef_ns2: 2e-5,
            torque_coef_nms2: 1e-7,
            inertia_kg_m2: 2e-5,
            throttle_map: None,
        }
    }

    fn vehicle(ids: &[&str]) -> VehicleDefinition {
        serde_json::from_value(json!({
            "version": 1, "parts": [], "totalMassKg": 1.0, "com": [0, 0, 0], "inertia": [1, 1, 1, 0, 0, 0], "missingMass": [],
            "motors": ids.iter().map(|id| json!({"partId": id, "position": [0, 0, 0], "thrustAxis": [0, 0, 1], "spin": "cw"})).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn propulsion(n: usize, r_int: f64) -> Propulsion {
        let ids: Vec<String> = (1..=n).map(|i| format!("m{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let def = PropulsionDefinition {
            version: 1,
            motors: ids.iter().map(|id| motor(id)).collect(),
            battery: BatteryParams { open_circuit_voltage_v: 10.0, internal_resistance_ohm: r_int, capacity_c: 18_720.0 },
        };
        // Validation needs R_int > 0; the ideal-source cases set it afterwards.
        let mut p = Propulsion::from_definition(PropulsionDefinition { battery: BatteryParams { internal_resistance_ohm: 0.01, ..def.battery }, ..def.clone() }, &vehicle(&refs)).unwrap();
        p.battery.internal_resistance_ohm = r_int;
        p.definition = def;
        p
    }

    fn run(p: &Propulsion, s: &mut PropulsionState, d: &[f64], t: f64, dt: f64) {
        for _ in 0..(t / dt).round() as usize {
            p.step(s, d, dt);
        }
    }

    #[test]
    fn steady_speed_matches_the_hand_solution() {
        // ω = (−0.01 + √(0.01² + 4·1e-6·9.95)) / 2e-6 = 911.852502 rad/s
        let m = MotorModel::new(&motor("m1"));
        assert!((m.steady_omega(10.0, 0.0) - 911.852_502).abs() < 1e-5);
        assert_eq!(m.steady_omega(0.04, 0.0), 0.0);
        // At the steady speed the net torque is zero.
        let w = m.steady_omega(10.0, 0.0);
        assert!(m.omega_dot(w, 10.0).abs() < 1e-9);
    }

    #[test]
    fn spin_up_matches_the_riccati_solution() {
        // Ideal source (R_int = 0): J dω/dt = A − Bω − Cω², A = K_t(V/R − I₀),
        // B = K_t²/R, C = k_Q. With roots ω₁ > 0 > ω₂ of Cω² + Bω − A:
        // ω(t) = (ω₁ − ω₂ K e^{−λt}) / (1 − K e^{−λt}), K = (ω₀−ω₁)/(ω₀−ω₂) = ω₁/ω₂,
        // λ = C(ω₁ − ω₂)/J.
        let p = propulsion(1, 0.0);
        let m = p.motors[0].clone();
        let (a, b, c) = (m.kt * (10.0 / m.r - m.i0), m.kt * m.kt / m.r, m.k_torque);
        let disc = (b * b + 4.0 * a * c).sqrt();
        let (w1, w2) = ((-b + disc) / (2.0 * c), (-b - disc) / (2.0 * c));
        let lambda = c * (w1 - w2) / m.j;
        let k = w1 / w2;
        let exact = |t: f64| (w1 - w2 * k * (-lambda * t).exp()) / (1.0 - k * (-lambda * t).exp());
        let mut s = p.rest();
        let mut t = 0.0;
        for _ in 0..5 {
            run(&p, &mut s, &[1.0], 0.02, 1e-4);
            t += 0.02;
            let e = exact(t);
            assert!((s.omega[0] - e).abs() < 1e-8 * w1, "t = {t}: {} vs {e}", s.omega[0]);
        }
        assert!((w1 - m.steady_omega(10.0, 0.0)).abs() < 1e-9);
    }

    #[test]
    fn without_drag_the_motor_is_first_order_with_the_mechanical_time_constant() {
        // k_Q = 0: ω(t) = ω_ss (1 − e^{−t/τ}), τ = J·R/K_t², ω_ss = K_v (V − R·I₀).
        let mut p = propulsion(1, 0.0);
        p.motors[0].k_torque = 0.0;
        let m = p.motors[0].clone();
        let tau = m.j * m.r / (m.kt * m.kt);
        let w_ss = m.kv * (10.0 - m.r * m.i0);
        let mut s = p.rest();
        run(&p, &mut s, &[1.0], tau, tau / 1000.0);
        let exact = w_ss * (1.0 - (-1.0f64).exp());
        assert!((s.omega[0] - exact).abs() < 1e-9 * w_ss, "{} vs {exact}", s.omega[0]);
    }

    #[test]
    fn battery_sag_matches_the_series_resistance_solution() {
        // n identical motors at throttle d on a pack with R_int: in steady state each
        // sees V_m = d·V_oc − n·d²·R_int·I_m, i.e. R → R + n·d²·R_int.
        for n in [1usize, 4] {
            let p = propulsion(n, 0.02);
            let d = 0.7;
            let mut s = p.rest();
            run(&p, &mut s, &vec![d; n], 2.0, 1e-4);
            let m = p.motors[0].clone();
            let expected = m.steady_omega(d * 10.0, n as f64 * d * d * 0.02);
            for w in &s.omega {
                assert!((w - expected).abs() < 1e-6 * expected, "n = {n}: {w} vs {expected}");
            }
            // V = V_oc − R_int·I, I = Σ d·I_m.
            let i = p.pack_current(&s.omega, &vec![d; n]);
            let v = p.pack_voltage(&s.omega, &vec![d; n]);
            assert!((v - (10.0 - 0.02 * i)).abs() < 1e-12);
            assert!(v < 10.0);
        }
    }

    #[test]
    fn charge_used_is_the_integral_of_the_current() {
        // Held at its steady speed, the pack current is constant: charge = I·t.
        let p = propulsion(1, 0.02);
        let w = p.motors[0].steady_omega(0.5 * 10.0, 0.25 * 0.02);
        let mut s = PropulsionState { omega: vec![w], charge_used_c: 0.0 };
        let i = p.pack_current(&s.omega, &[0.5]);
        run(&p, &mut s, &[0.5], 3.0, 1e-3);
        assert!((s.charge_used_c - i * 3.0).abs() < 1e-9 * i * 3.0);
        assert!((s.omega[0] - w).abs() < 1e-9 * w);
    }

    #[test]
    fn a_rotor_at_rest_stays_at_rest_below_the_no_load_current() {
        let p = propulsion(1, 0.02);
        let mut s = p.rest();
        run(&p, &mut s, &[0.004], 0.1, 1e-3);
        assert_eq!(s.omega[0], 0.0);
        run(&p, &mut s, &[0.0], 0.1, 1e-3);
        assert_eq!(s.omega[0], 0.0);
    }

    #[test]
    fn validation_reports_every_problem_with_its_path() {
        let v = vehicle(&["m1", "m2"]);
        let bad = json!({
            "version": 1,
            "motors": [
                {"partId": "m1", "kvRadPerSV": 0, "resistanceOhm": 0.1, "noLoadCurrentA": -1, "thrustCoefNs2": 1e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 1e-5},
                {"partId": "x", "kvRadPerSV": 50, "resistanceOhm": 0.1, "noLoadCurrentA": 0.3, "thrustCoefNs2": 1e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 1e-5}
            ],
            "battery": {"openCircuitVoltageV": 14.8, "internalResistanceOhm": 0, "capacityC": 18720}
        });
        let errors = Propulsion::from_json(bad, &v).unwrap_err();
        let paths: Vec<&str> = errors.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "propulsion.motors[0].kvRadPerSV",
                "propulsion.motors[0].noLoadCurrentA",
                "propulsion.motors[1].partId",
                "propulsion.motors",
                "propulsion.battery.internalResistanceOhm"
            ]
        );
        let unknown = json!({"version": 1, "motors": [], "battery": {"openCircuitVoltageV": 1, "internalResistanceOhm": 1, "capacityC": 1, "x": 1}});
        assert!(Propulsion::from_json(unknown, &v).unwrap_err()[0].message.contains("unknown field"));
        let version = json!({"version": 2, "motors": [], "battery": {"openCircuitVoltageV": 1, "internalResistanceOhm": 1, "capacityC": 1}});
        assert_eq!(Propulsion::from_json(version, &v).unwrap_err()[0].path, "propulsion.version");
    }

    #[test]
    fn effective_duty_interpolates_and_holds_the_ratio_outside() {
        let mut m = MotorModel::new(&motor("m1"));
        assert_eq!(m.effective_duty(0.42), 0.42); // ideal
        m.map = vec![[0.5, 0.45], [1.0, 0.85]];
        assert!((m.effective_duty(0.75) - 0.65).abs() < 1e-15);
        assert!((m.effective_duty(0.25) - 0.225).abs() < 1e-15);
        assert_eq!(m.effective_duty(0.0), 0.0);
        assert_eq!(m.effective_duty(1.5), 0.85);
        m.map = vec![[0.5, 0.6]];
        assert_eq!(m.effective_duty(1.0), 1.0);
    }

    #[test]
    fn steady_sag_with_a_map_matches_the_closed_form_at_the_effective_duty() {
        let mut p = propulsion(2, 0.02);
        for m in &mut p.motors {
            m.map = vec![[0.5, 0.45], [1.0, 0.85]];
        }
        let mut s = p.rest();
        run(&p, &mut s, &[0.75, 0.75], 2.0, 1e-4);
        let e = 0.65;
        let expected = p.motors[0].steady_omega(e * 10.0, 2.0 * e * e * 0.02);
        for w in &s.omega {
            assert!((w - expected).abs() < 1e-6 * expected, "{w} vs {expected}");
        }
    }

    #[test]
    fn throttle_map_validation() {
        let v = vehicle(&["m1"]);
        let base = |map: Value| {
            json!({"version": 1, "motors": [{"partId": "m1", "kvRadPerSV": 50, "resistanceOhm": 0.1, "noLoadCurrentA": 0.3,
                "thrustCoefNs2": 1e-5, "torqueCoefNms2": 1e-7, "inertiaKgM2": 1e-5, "throttleMap": map}],
                "battery": {"openCircuitVoltageV": 14.8, "internalResistanceOhm": 0.01, "capacityC": 18720}})
        };
        assert!(Propulsion::from_json(base(json!([[0.5, 0.48], [1.0, 0.84]])), &v).is_ok());
        for bad in [json!([]), json!([[0.5, 0.6], [1.0, 0.5]]), json!([[1.0, 0.8], [0.5, 0.4]]), json!([[0.5, 1.2]]), json!([[0.0, 0.1]])] {
            let errors = Propulsion::from_json(base(bad.clone()), &v).unwrap_err();
            assert_eq!(errors[0].path, "propulsion.motors[0].throttleMap", "{bad}");
        }
    }

    /// TypeScript and Rust must give the same numbers: the cases were generated by
    /// `steadyState`/`effectiveDuty` in src/domain/propulsion.ts.
    #[test]
    fn matches_the_typescript_model_on_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/propulsion-cases.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-12 * b.abs().max(1.0);
        for c in cases {
            let f = |k: &str| c[k].as_f64().unwrap();
            let map: Vec<[f64; 2]> = serde_json::from_value(c["throttleMap"].clone()).unwrap();
            let kv = f("kvRadPerSV");
            let m = MotorModel { kv, kt: 1.0 / kv, r: f("resistanceOhm"), i0: f("noLoadCurrentA"), k_thrust: 0.0, k_torque: f("torqueCoefNms2"), j: 1.0, map };
            let (v, rs, d) = (f("supplyV"), f("sourceResistanceOhm"), f("throttle"));
            let e = m.effective_duty(d);
            let omega = m.steady_omega(e * v, e * e * rs);
            let i_m = if omega == 0.0 { e * v / (m.r + e * e * rs) } else { m.i0 + m.k_torque * omega * omega / m.kt };
            let x = &c["expected"];
            assert!(close(e, x["effectiveDuty"].as_f64().unwrap()), "{c}");
            assert!(close(omega, x["omega"].as_f64().unwrap()), "{c}: {omega}");
            assert!(close(e * i_m, x["supplyCurrent"].as_f64().unwrap()), "{c}");
        }
    }
}
