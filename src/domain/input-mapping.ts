export interface AxisCalibration {
  readonly min: number
  readonly trim: number
  readonly max: number
  readonly reverse: boolean
  readonly deadZone: number
}

export type CalibrationIssue = 'non-finite' | 'invalid-range' | 'trim-outside-range' | 'invalid-dead-zone'

export function validateAxisCalibration({ min, trim, max, deadZone }: AxisCalibration): CalibrationIssue | undefined {
  if (![min, trim, max, deadZone, max - min].every(Number.isFinite)) return 'non-finite'
  if (min >= max) return 'invalid-range'
  if (trim < min || trim > max) return 'trim-outside-range'
  if (deadZone < 0 || (trim > min && deadZone >= trim - min) || (trim < max && deadZone >= max - trim)) {
    return 'invalid-dead-zone'
  }
}

/** Measure the endpoints from a sweep and trim from a sample taken at rest. */
export function captureAxisCalibration(
  sweep: readonly number[],
  trimSample: number,
  reverse: boolean,
): { calibration: AxisCalibration } | { reason: CalibrationIssue | 'no-samples' } {
  const first = sweep[0]
  if (first === undefined) return { reason: 'no-samples' }
  let min = first
  let max = first
  for (const sample of sweep) {
    min = Math.min(min, sample)
    max = Math.max(max, sample)
  }
  // Phase 6 plan:243–248 starts the extra dead zone at zero.
  const calibration = { min, trim: trimSample, max, reverse, deadZone: 0 }
  const reason = validateAxisCalibration(calibration)
  return reason === undefined ? { calibration } : { reason }
}

/** PX4 v1.13.3 modules/rc_update/rc_update.cpp:449–494. Pass a validated calibration. */
export function mapAxis(sample: number, { min, trim, max, deadZone, reverse }: AxisCalibration): number {
  const value = Math.min(max, Math.max(min, sample))
  let stick = 0
  if (value > trim + deadZone) {
    stick = (value - trim - deadZone) / (max - trim - deadZone)
  } else if (value < trim - deadZone) {
    stick = (value - trim + deadZone) / (trim - min - deadZone)
  }

  if (!Number.isFinite(stick) || stick === 0) return 0
  return reverse ? -stick : stick
}

/** Apply the standard Gamepad signs after calibrating raw axes. Phase 6 plan:238–241. */
export function applyGamepadAxisSign(stick: number, axisIndex: number, mapping: '' | 'standard'): number {
  return mapping === 'standard' && (axisIndex === 1 || axisIndex === 3) && stick !== 0 ? -stick : stick
}
