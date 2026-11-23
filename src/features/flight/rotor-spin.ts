import type { Spin } from '../../../electron/ipc/contract'

export const ROTOR_TAU = 2 * Math.PI

// Display convention, not a PX4/physics parameter: at 60 display frames/s a
// two-bladed prop reaches Nyquist at 30 blade passages/s, i.e. 15 rev/s (900 rpm).
// Use a disc by then; slower displays or more blades can require it sooner.
export const ROTOR_BLUR_THRESHOLD_RADPS = Math.PI * 60 / 2

export function wrapRotorAngle(angle: number): number {
  return ((angle % ROTOR_TAU) + ROTOR_TAU) % ROTOR_TAU
}

/** Right-hand rotation about +thrust: CCW positive, CW negative, viewed above. */
export function integrateRotorAngle(angle: number, omegaRadps: number, dtS: number, spin: Spin): number {
  if (!Number.isFinite(omegaRadps) || !Number.isFinite(dtS) || dtS <= 0) return angle
  return wrapRotorAngle(angle + (spin === 'cw' ? -1 : 1) * omegaRadps * dtS)
}

/** Nyquist: blade phase must advance less than pi radians per display sample. */
export function rotorIsBlurred(omegaRadps: number, dtS: number, blades: number): boolean {
  const samplingLimit = dtS > 0 && blades > 0 ? Math.PI / (dtS * blades) : Infinity
  return Math.abs(omegaRadps) >= Math.min(ROTOR_BLUR_THRESHOLD_RADPS, samplingLimit)
}
