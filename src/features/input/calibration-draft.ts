import { validateAxisCalibration } from '../../domain/input-mapping'
import { isAxisSample, stickNames, type AxisBinding, type DeviceCalibration, type Stick } from './calibration'
import type { InputDevice } from './gamepads'

type Range = { min: number; max: number }
export interface AxisDraft {
  axis: number | null
  range: Range | null
  trim: number | null
  trimMethod: '' | 'centre' | 'midpoint'
  reverse: boolean
  deadZone: string
}

export type CalibrationDraft = Record<Stick, AxisDraft>

export function createDraft(saved?: DeviceCalibration): CalibrationDraft {
  function axisDraft(stick: Stick): AxisDraft {
    const binding = saved?.[stick]
    return {
      axis: binding?.axis ?? null,
      range: binding ? { min: binding.min, max: binding.max } : null,
      trim: binding?.trim ?? null,
      trimMethod: stick === 'throttle' ? '' : 'centre',
      reverse: binding?.reverse ?? false,
      // Phase 6 plan:245–250. Empty also means the optional dead zone is off.
      deadZone: String(binding?.deadZone ?? 0),
    }
  }
  return { forward: axisDraft('forward'), right: axisDraft('right'), yawRight: axisDraft('yawRight'), throttle: axisDraft('throttle') }
}

export function checkAxis(drafts: CalibrationDraft, stick: Stick, axisCount: number) {
  const draft = drafts[stick]
  const { axis, range, reverse } = draft
  const trim = draft.trimMethod === 'midpoint' && range ? (range.min + range.max) / 2 : draft.trim
  const enteredDeadZone = draft.deadZone.trim()
  const deadZone = enteredDeadZone === '' || /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(enteredDeadZone)
    ? Number(enteredDeadZone)
    : NaN
  const errors: Partial<Record<'axis' | 'range' | 'trim' | 'deadZone', string>> = {}
  if (axis === null || axis >= axisCount) errors.axis = 'Choose an available axis.'
  else if (stickNames.some((other) => other !== stick && drafts[other].axis === axis)) errors.axis = 'Choose a different axis for each stick.'
  if (!range || range.min >= range.max) errors.range = 'Measure two distinct endpoints.'
  if (trim === null || (range && (trim < range.min || trim > range.max))) {
    errors.trim = stick === 'throttle' && !draft.trimMethod
      ? 'Choose how to set throttle trim.'
      : 'Set trim within the measured endpoints.'
  }
  if (!Number.isFinite(deadZone) || deadZone < 0) errors.deadZone = 'Enter a finite, non-negative dead zone.'
  if (axis === null || !range || trim === null || Object.keys(errors).length) return { errors, trim }

  const binding: AxisBinding = { axis, ...range, trim, reverse, deadZone }
  if (validateAxisCalibration(binding)) {
    errors.deadZone = 'Use a dead zone smaller than the distance from trim to each distinct endpoint.'
    return { errors, trim }
  }
  return { binding, errors, trim }
}

export function createAxisSweep(device: InputDevice, axis: number) {
  let range: Range | null = null
  return {
    add(sample: InputDevice) {
      if (sample.connection !== device.connection) return
      const value = sample.axes[axis]
      if (!isAxisSample(value)) return
      range = range ? { min: Math.min(range.min, value), max: Math.max(range.max, value) } : { min: value, max: value }
    },
    finish: () => range,
  }
}
