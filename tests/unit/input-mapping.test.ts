import { describe, expect, it } from 'vitest'
import { applyGamepadAxisSign, captureAxisCalibration, mapAxis, validateAxisCalibration } from '../../src/domain/input-mapping'

// Binary-fraction fixture and endpoint assertions use exact equality. Tolerance: zero.
const calibration = { min: -1, trim: 0.5, max: 1, deadZone: 0, reverse: false }

describe('PX4 axis calibration', () => {
  it('captures the measured endpoints and rest sample with the extra dead zone off', () => {
    expect(captureAxisCalibration([0, 1, 0.25, -1], 0.5, false)).toEqual({ calibration })
    expect(captureAxisCalibration([], 0, false)).toEqual({ reason: 'no-samples' })
    expect(captureAxisCalibration([0, NaN, 1], 0.5, false)).toEqual({ reason: 'non-finite' })
  })

  it('reports invalid calibrations and accepts trim at either endpoint', () => {
    expect(validateAxisCalibration({ ...calibration, max: Infinity })).toBe('non-finite')
    expect(validateAxisCalibration({ ...calibration, max: -1 })).toBe('invalid-range')
    expect(validateAxisCalibration({ ...calibration, trim: 2 })).toBe('trim-outside-range')
    expect(validateAxisCalibration({ ...calibration, deadZone: -0.5 })).toBe('invalid-dead-zone')
    expect(validateAxisCalibration({ ...calibration, deadZone: 0.5 })).toBe('invalid-dead-zone')
    expect(validateAxisCalibration({ ...calibration, trim: -1 })).toBeUndefined()
    expect(validateAxisCalibration({ ...calibration, trim: 1 })).toBeUndefined()
  })

  it('clamps and scales each side of trim independently', () => {
    expect([-2, -1, -0.25, 0.5, 0.75, 1, 2].map((value) => mapAxis(value, calibration)))
      .toEqual([-1, -1, -0.5, 0, 0.5, 1, 1])
    expect(mapAxis(-1, { ...calibration, reverse: true })).toBe(1)
    expect(mapAxis(1, { ...calibration, reverse: true })).toBe(-1)
  })

  it('joins both linear ramps continuously at the dead-zone edges', () => {
    const settings = { ...calibration, trim: 0, deadZone: 0.5 }
    for (const edge of [-0.5, 0.5]) {
      expect(mapAxis(edge, settings)).toBe(0)
      const step = Math.sign(edge) / 1024
      expect(mapAxis(edge + step, settings)).toBe(2 * step)
      expect(mapAxis(edge - step, settings)).toBe(0)
    }
  })

  it('scales a one-sided range without NaN', () => {
    expect([-1, 0, 1].map((value) => mapAxis(value, { ...calibration, trim: -1 }))).toEqual([0, 0.5, 1])
    expect([-1, 0, 1].map((value) => mapAxis(value, { ...calibration, trim: 1 }))).toEqual([-1, -0.5, 0])
    expect(mapAxis(NaN, calibration)).toBe(0)
  })

  it('makes standard forward and up positive while preserving an unknown layout', () => {
    expect([0, 1, 2, 3].map((index) => applyGamepadAxisSign(-1, index, 'standard'))).toEqual([-1, 1, -1, 1])
    expect(applyGamepadAxisSign(-1, 1, '')).toBe(-1)
    expect(applyGamepadAxisSign(-1, 3, '')).toBe(-1)
  })
})
