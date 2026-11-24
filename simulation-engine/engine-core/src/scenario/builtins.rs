use super::*;
use crate::{controller::Allocator, vehicle::Spin};


fn allocator(v: &Vehicle, p: &Propulsion) -> Result<Allocator, String> {
    // The yaw ratio `closed_loop` gives the controller: mean k_Q/k_T.
    Allocator::new(&v.definition.motors, p.yaw_ratio())
}
fn validate_models(v: &Vehicle, p: &Propulsion) -> Result<(), String> {
    Propulsion::from_definition(p.definition.clone(), &v.definition)
        .map_err(|e| format!("propulsion: {e:?}"))?;
    if v.definition
        .motors
        .iter()
        .any(|m| m.thrust_axis != [0.0, 0.0, 1.0])
    {
        return Err("built-in hover predictions require vertical motors".into());
    }
    Ok(())
}
/// Equal-command steady total thrust, including mapped duty and shared battery
/// sag. `p` is the propulsion at the flight's air density (`scaled_propulsion`).
/// Bisection solves V + Rint sum(e Im(steady_omega(e V))) = Voc.
pub fn steady_thrust(v: &Vehicle, p: &Propulsion, throttle: f64) -> Result<f64, String> {
    validate_models(v, p)?;
    if !throttle.is_finite() || !(0.0..=1.0).contains(&throttle) {
        return Err("throttle must be in [0,1]".into());
    }
    let (mut lo, mut hi) = (0.0, p.battery.open_circuit_voltage_v);
    for _ in 0..80 {
        let voltage = (lo + hi) / 2.0;
        let current = p
            .motors
            .iter()
            .map(|m| {
                let e = m.effective_duty(throttle);
                let w = m.steady_omega(e * voltage, 0.0);
                e * m.motor_current(w, e * voltage).max(0.0)
            })
            .sum::<f64>();
        if voltage + p.battery.internal_resistance_ohm * current > p.battery.open_circuit_voltage_v
        {
            hi = voltage;
        } else {
            lo = voltage;
        }
    }
    Ok(p.motors
        .iter()
        .map(|m| m.thrust(m.steady_omega(m.effective_duty(throttle) * (lo + hi) / 2.0, 0.0)))
        .sum())
}
/// Inverts the 4.5 steady-state solver, not a sqrt(throttle) approximation.
pub fn predicted_hover_throttle(v: &Vehicle, p: &Propulsion, mass_kg: f64) -> Result<f64, String> {
    if !positive(mass_kg) {
        return Err("hover mass must be positive and finite".into());
    }
    if steady_thrust(v, p, 1.0)? < mass_kg * G {
        return Err("weight exceeds full-throttle steady thrust".into());
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..60 {
        let u = (lo + hi) / 2.0;
        if steady_thrust(v, p, u)? < mass_kg * G {
            lo = u;
        } else {
            hi = u;
        }
    }
    Ok((lo + hi) / 2.0)
}
/// A 20 s run holding level at the nominal CoM's starting height (free space
/// starts at the world origin, so the target is the CoM's own z: no climb).
fn base(name: &str, v: &Vehicle) -> Scenario {
    Scenario {
        name: name.into(),
        duration_s: 20.0,
        flight_script: None,
        modifications: vec![],
        script: vec![Segment {
            from_s: 0.0,
            attitude: Attitude::Euler {
                roll: 0.0,
                pitch: 0.0,
                yaw: 0.0,
            },
            yaw_rate_radps: 0.0,
            z_m: Some(v.totals.com[2]),
            z_velocity_mps: 0.0,
        }],
        checks: vec![
            // Last second of a 20s cold-start run: 2cm position and .01rad
            // attitude settling budget, shared with flight/tests.rs area8.
            Check::Altitude {
                after_s: 19.0,
                tolerance_m: 0.02,
            },
            Check::Attitude {
                after_s: 19.0,
                max_deg: 0.01_f64.to_degrees(),
            },
            // At most 10 consecutive 1ms saturated steps in the settled window.
            Check::NoSustainedSaturation {
                after_s: 19.0,
                max_duration_s: 0.01,
            },
        ],
    }
}
fn throttle_check(s: &mut Scenario, v: &Vehicle, p: &Propulsion, mass: f64) -> Result<(), String> {
    let u = predicted_hover_throttle(v, p, mass)?;
    // Absolute .005 command budget for finite integral settling, not motor data.
    s.checks.push(Check::HoverThrottle {
        after_s: 19.0,
        min: (u - 0.005).max(0.0),
        max: (u + 0.005).min(1.0),
    });
    Ok(())
}
/// Centred, equal-command hover. Refuses a nominal CoM off the thrust centre.
pub fn balanced_hover(v: &Vehicle, p: &Propulsion, config: &ScenarioConfig) -> Result<Scenario, String> {
    let p = &scaled_propulsion(v, p, config.air_density_kg_m3)?;
    let mut s = base("balanced_hover", v);
    let centre: [f64; 2] = std::array::from_fn(|i| {
        v.definition
            .motors
            .iter()
            .map(|m| m.position[i])
            .sum::<f64>()
            / v.definition.motors.len() as f64
    });
    if (0..2).any(|i| (centre[i] - v.totals.com[i]).abs() > 1e-9) {
        return Err("balanced_hover requires centred nominal CoM".into());
    }
    throttle_check(&mut s, v, p, v.totals.mass_kg)?;
    Ok(s)
}
/// Adds centred mass. The controller retains the same nominal hover setting;
/// the altitude integrator must recover the higher solved hover command.
pub fn payload(v: &Vehicle, p: &Propulsion, config: &ScenarioConfig, mass_kg: f64) -> Result<Scenario, String> {
    if !positive(mass_kg) {
        return Err("payload mass must be finite and positive".into());
    }
    let p = &scaled_propulsion(v, p, config.air_density_kg_m3)?;
    let mut s = base("payload", v);
    let mut id = "scenario:payload".to_string();
    while v.definition.parts.iter().any(|part| part.part_id == id) {
        id.push('_');
    }
    s.modifications.push(Modification::Payload {
        part_id: id,
        mass_kg,
        position_m: v.totals.com,
        box_size_m: None,
    });
    throttle_check(&mut s, v, p, v.totals.mass_kg + mass_kg)?;
    Ok(s)
}
/// Weight is twice max(Voc, full-duty, zero-sag) thrust, a conservative upper
/// bound even during spin-up. Thus upward acceleration is impossible at rest.
pub fn overweight_payload(v: &Vehicle, p: &Propulsion, config: &ScenarioConfig) -> Result<Scenario, String> {
    let p = &scaled_propulsion(v, p, config.air_density_kg_m3)?;
    validate_models(v, p)?;
    let upper = p
        .motors
        .iter()
        .map(|m| {
            m.thrust(m.steady_omega(
                m.effective_duty(1.0) * p.battery.open_circuit_voltage_v,
                0.0,
            ))
        })
        .sum::<f64>();
    let mass = (2.0 * upper / G).max(2.0 * v.totals.mass_kg) - v.totals.mass_kg;
    // Build without requiring hover to be feasible.
    let mut s = base("overweight_payload", v);
    let mut id = "scenario:payload".to_string();
    while v.definition.parts.iter().any(|part| part.part_id == id) {
        id.push('_');
    }
    s.modifications.push(Modification::Payload {
        part_id: id,
        mass_kg: mass,
        position_m: v.totals.com,
        box_size_m: None,
    });
    s.checks = vec![Check::CannotClimb {
        after_s: 1.0,
        min_throttle: config.gains.mpc_thr_max,
    }];
    Ok(s)
}

/// Hand prediction for vertical, identical-motor geometry. General geometry:
/// solve A F=[mg*c_y,-mg*c_x,0,mg], A_i=[y_i,-x_i,s_i*kQ/kT,1].
/// A+ gives the minimum-norm static thrust; positive/headroom feasibility must
/// also be checked. An X quad at +/-arm gives Ffront-Frear=mg*d/arm.
/// Convert each F to omega, Im and Vm, solve V²-Voc V+Rint sum(Vm Im)=0,
/// invert the duty map; normalized B times these commands predicts PID trim.
pub fn com_offset(v: &Vehicle, p: &Propulsion, config: &ScenarioConfig, offset_m: f64) -> Result<Scenario, String> {
    let p = &scaled_propulsion(v, p, config.air_density_kg_m3)?;
    validate_models(v, p)?;
    if !offset_m.is_finite() {
        return Err("CoM offset must be finite".into());
    }
    if p.motors.windows(2).any(|w| w[0] != w[1]) {
        return Err("trim prediction requires identical motor models".into());
    }
    let mut s = base("com_offset", v);
    let part = v
        .definition
        .parts
        .iter()
        .filter(|part| {
            !v.definition
                .motors
                .iter()
                .any(|m| m.part_id == part.part_id)
        })
        .max_by(|a, b| a.mass_kg.total_cmp(&b.mass_kg))
        .ok_or("CoM scenario needs a movable non-motor part")?;
    s.modifications.push(Modification::ShiftPart {
        part_id: part.part_id.clone(),
        delta_m: [offset_m * v.totals.mass_kg / part.mass_kg, 0.0, 0.0],
    });
    let alloc = allocator(v, p)?;
    let ratio = p.motors[0].k_torque / p.motors[0].k_thrust;
    let raw: Vec<[f64; 4]> = v
        .definition
        .motors
        .iter()
        .map(|m| {
            [
                m.position[1],
                -m.position[0],
                if m.spin == Spin::Cw { ratio } else { -ratio },
                1.0,
            ]
        })
        .collect();
    let scale: [f64; 4] = std::array::from_fn(|a| {
        raw.iter()
            .zip(alloc.effectiveness())
            .find(|(r, _)| r[a].abs() > 1e-12)
            .map_or(1.0, |(r, b)| b[a] / r[a])
    });
    let mg = v.totals.mass_kg * G;
    let demand = [
        mg * v.totals.com[1] * scale[0],
        -mg * (v.totals.com[0] + offset_m) * scale[1],
        0.0,
        mg * scale[3],
    ];
    let forces: Vec<f64> = alloc
        .pseudo_inverse()
        .iter()
        .map(|r| r.iter().zip(demand).map(|(x, y)| x * y).sum())
        .collect();
    let motor = &p.motors[0];
    let electrical: Vec<(f64, f64)> = forces
        .iter()
        .map(|f| {
            let w = (f / motor.k_thrust).sqrt();
            let i = motor.i0 + motor.k_torque * w * w / motor.kt;
            (w / motor.kv + motor.r * i, i)
        })
        .collect();
    if forces.iter().any(|f| !f.is_finite() || *f < 0.0) {
        return Err("offset requires negative rotor thrust".into());
    }
    let power = electrical.iter().map(|(vm, i)| vm * i).sum::<f64>();
    let discriminant =
        p.battery.open_circuit_voltage_v.powi(2) - 4.0 * p.battery.internal_resistance_ohm * power;
    if discriminant < 0.0 {
        return Err("offset exceeds electrical authority".into());
    }
    let voltage = (p.battery.open_circuit_voltage_v + discriminant.sqrt()) / 2.0;
    let commands: Vec<f64> = electrical
        .iter()
        .map(|(vm, _)| {
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..60 {
                let u = (lo + hi) / 2.0;
                if motor.effective_duty(u) < vm / voltage {
                    lo = u;
                } else {
                    hi = u;
                }
            }
            (lo + hi) / 2.0
        })
        .collect();
    if electrical
        .iter()
        .any(|(vm, _)| vm / voltage > motor.effective_duty(1.0))
    {
        return Err("offset exceeds thrust headroom".into());
    }
    for axis in 0..2 {
        let expected = alloc
            .effectiveness()
            .iter()
            .zip(&commands)
            .map(|(b, u)| b[axis] * u)
            .sum::<f64>();
        s.checks.push(Check::RateTrim {
            after_s: 19.0,
            axis,
            expected,
            tolerance: 0.001,
        });
    }
    // Signed x moments sum(x_i F_i)=mg*c_x, divided by arm to express N.
    // For an X quad this is front/rear force difference, with .02N budget.
    let arm = v
        .definition
        .motors
        .iter()
        .map(|m| m.position[0].abs())
        .fold(0.0, f64::max);
    let weights = v.definition.motors.iter().map(|m| m.position[0] / arm).collect();
    s.checks.push(Check::ThrustBalance {
        after_s: 19.0,
        weights,
        expected_n: mg * (v.totals.com[0] + offset_m) / arm,
        tolerance_n: 0.02,
    });
    Ok(s)
}
/// Exceeds both the static positive-thrust support polygon and the equivalent
/// pitch-integrator command authority. Let D be max(pitch mix)-min(pitch mix)
/// (sqrt(2) for an X quad). Choose arm*(1+D*Ilim/min(u_hover,1-u_hover)),
/// beyond the outermost thrust point; there is no positive-thrust static trim.
/// The extra displacement scales with integral authority / command headroom;
/// the support-polygon violation, not a linearized motor model, proves failure.
/// 30deg (pi/6) marks loss of attitude, matching flight area8's ~29deg test.
pub fn com_offset_beyond_authority(v: &Vehicle, p: &Propulsion, config: &ScenarioConfig) -> Result<Scenario, String> {
    let p = &scaled_propulsion(v, p, config.air_density_kg_m3)?;
    let u = predicted_hover_throttle(v, p, v.totals.mass_kg)?;
    let arm = v
        .definition
        .motors
        .iter()
        .map(|m| m.position[0].abs())
        .fold(0.0, f64::max);
    if !positive(arm) {
        return Err("pitch authority needs a nonzero arm".into());
    }
    let alloc = allocator(v, p)?;
    let min_mix = alloc
        .pseudo_inverse()
        .iter()
        .map(|r| r[1])
        .fold(f64::INFINITY, f64::min);
    let max_mix = alloc
        .pseudo_inverse()
        .iter()
        .map(|r| r[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let offset = arm
        * (1.0
            + (max_mix - min_mix) * config.gains.mc_pr_int_lim
                / u.min(1.0 - u).max(f64::EPSILON));
    let part = v
        .definition
        .parts
        .iter()
        .filter(|part| {
            !v.definition
                .motors
                .iter()
                .any(|m| m.part_id == part.part_id)
        })
        .max_by(|a, b| a.mass_kg.total_cmp(&b.mass_kg))
        .ok_or("CoM scenario needs a movable non-motor part")?;
    let mut s = base("com_offset_beyond_authority", v);
    s.duration_s = 5.0;
    s.modifications.push(Modification::ShiftPart {
        part_id: part.part_id.clone(),
        delta_m: [
            (offset - v.totals.com[0]) * v.totals.mass_kg / part.mass_kg,
            0.0,
            0.0,
        ],
    });
    s.checks = vec![
        Check::SaturationObserved { after_s: 0.0 },
        Check::AttitudeLost {
            after_s: 0.0,
            above_deg: 30.0,
        },
    ];
    Ok(s)
}
