import type { Finding } from '../../domain/checks'
import { horizontalOffset, massFindings, STANDARD_GRAVITY } from '../../domain/mass'
import { IDEAL_MAP, steadyState, type PropulsionDefinition, type ReadyItem } from '../../domain/propulsion'
import type { MassState } from '../workshop/mass-input'
import type { FlightFrame } from './frame'

// Physical hover floor: maximum thrust must at least equal weight.
export const MIN_THRUST_TO_WEIGHT = 1
export const SATURATION_HOLD_S = 1
// A gap over 2 nominal demo samples breaks continuity; don't infer sustained saturation across missing data.
export const MAX_DIAGNOSTIC_GAP_S = 0.1
export interface Indicator { state: 'ok' | 'warning' | 'unknown'; detail: string }
const result = (warning: boolean, detail: string): Indicator => ({ state: warning ? 'warning' : 'ok', detail })

export function massIndicator(mass: MassState, tolerancePct: number): Indicator {
  const { mp, motors, hover } = mass
  if (!mp.com || mp.missingMass.length) return { state: 'unknown', detail: 'Mass incomplete; CoM and hover balance cannot be confirmed.' }
  const findings = massFindings(mp, motors, hover, tolerancePct)
  const offset = horizontalOffset(mp.com)
  return result(findings.length > 0,
    `Horizontal CoM offset ${(offset * 1000).toFixed(1)} mm. ${findings.map((f) => f.message).join(' ') || `Hover share within ${tolerancePct} % margin.`}`)
}

/** Reuse workshop motor-count / prop handedness rules and mass.ts's geometry feasibility. */
export function layoutIndicator(findings: readonly Finding[], mass: MassState, mountedMotors: number): Indicator {
  const problems = findings.filter((f) => f.rule === 'motor-count' || f.rule === 'prop-hand')
  if (mountedMotors === 0) return result(true, 'No motors are mounted.')
  if (problems.length) return { state: problems.some((f) => f.severity !== 'cannot-check') ? 'warning' : 'unknown', detail: problems.map((f) => f.message).join(' ') }
  if (!mass.hover || mass.mp.missingMass.length) return { state: 'unknown', detail: 'Complete mass needed to check motor support geometry.' }
  return result(!mass.hover.feasible, mass.hover.reason ?? 'Motor count, handedness and hover support geometry pass.')
}

export function collisionIndicator(frame: FlightFrame): Indicator {
  const active = frame.contacts.filter((c) => c.startS <= frame.timeS && (c.endS === null || c.endS > frame.timeS))
  return result(active.length > 0, `${active.length} active contact(s).`)
}

/** Full-throttle steady-state capability with all motors sharing the sagging pack. */
export function thrustIndicator(propulsion: PropulsionDefinition | null, ready: readonly ReadyItem[], massKg: number, complete: boolean, airKgM3: number | null): Indicator {
  // Mass, body drag and surface coefficients have separate checks. All remaining
  // Ready-to-fly items concern propulsion (including rotor/prop inertia and capacity).
  const missing = ready.filter((item) => item.id !== 'frame-mass' && !item.id.startsWith('part-mass:') && item.link?.to !== 'body-drag' && item.link?.to !== 'environment')
  if (missing.length) return { state: 'unknown', detail: missing.map((item) => `${item.label}: ${item.detail}`).join(' ') }
  if (!propulsion || !propulsion.motors.length) return { state: 'unknown', detail: 'Complete motor, propeller and battery data needed for maximum T/W.' }
  if (!complete || !(massKg > 0)) return { state: 'unknown', detail: 'Complete mass needed for T/W.' }
  // The engine flies each motor's k_T and k_Q scaled by ρ / ρ_ref,i (flight.rs `scale_to_air_density`), with ρ_ref,i
  // the air density that motor's data was taken at (in the propulsion definition): so does this.
  if (airKgM3 === null) return { state: 'unknown', detail: 'Enter the ambient altitude (Flight setup): thrust and torque scale with the air density of the flight relative to the density of the propeller data.' }
  const { battery, motors } = propulsion
  const models = motors.map((m) => ({
    electrical: { kv: m.kvRadPerSV, kt: 1 / m.kvRadPerSV, resistance: m.resistanceOhm, noLoadCurrent: m.noLoadCurrentA, noLoadCondition: null },
    kT: m.thrustCoefNs2 * (airKgM3 / m.referenceDensityKgM3),
    kQ: m.torqueCoefNms2 * (airKgM3 / m.referenceDensityKgM3),
    map: m.throttleMap ? { ...IDEAL_MAP, points: m.throttleMap.map(([throttle, effectiveDuty]) => ({ throttle, effectiveDuty })) } : IDEAL_MAP,
  }))
  const atVoltage = (voltage: number) => models.map((m) => steadyState(m.electrical, m.kQ, voltage, 1, 0, m.map))
  // Solve V + R_pack * sum(I_supply(V)) = V_oc. Independent per-motor
  // sag would underestimate the shared pack's drop, especially on mixed builds.
  let low = 0
  let high = battery.openCircuitVoltageV
  for (let i = 0; i < 80; i++) {
    const voltage = (low + high) / 2
    const current = atVoltage(voltage).reduce((sum, s) => sum + s.supplyCurrent, 0)
    if (voltage + battery.internalResistanceOhm * current > battery.openCircuitVoltageV) high = voltage
    else low = voltage
  }
  const maxThrustN = atVoltage((low + high) / 2).reduce((sum, s, i) => sum + models[i]!.kT * s.omega ** 2, 0)
  const ratio = maxThrustN / (massKg * STANDARD_GRAVITY)
  return result(ratio < MIN_THRUST_TO_WEIGHT, `Maximum T/W ${ratio.toFixed(2)} at full throttle with pack voltage sag, air density ${airKgM3.toFixed(3)} kg/m³ (physical hover floor ${MIN_THRUST_TO_WEIGHT.toFixed(1)}; below this cannot hover).`)
}

/** Warning iff any allocation axis is saturated continuously for >=1 s.
 * The saturated axis may change. Null control, a clear sample, backwards time,
 * or a gap >100 ms breaks the interval. This is a diagnostic, not proof of loss of control.
 */
export function instabilityIndicator(history: readonly FlightFrame[]): Indicator {
  let since: number | null = null
  let previous: number | null = null
  for (const frame of history) {
    if (previous !== null && (frame.timeS <= previous || frame.timeS - previous > MAX_DIAGNOSTIC_GAP_S + 1e-9)) since = null
    const s = frame.control?.saturation
    if (s && [...s.positive, ...s.negative].some(Boolean)) since ??= frame.timeS
    else since = null
    previous = frame.timeS
  }
  const last = history.at(-1)
  if (!last?.control) return { state: 'unknown', detail: 'Controller diagnostics unavailable.' }
  return result(since !== null && last.timeS - since >= SATURATION_HOLD_S - 1e-9, 'Allocator saturation warning after 1 s continuous saturation (all axes, either sign).')
}
