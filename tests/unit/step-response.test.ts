import { describe, expect, it } from 'vitest'
import {
  RECOMMENDED_STEP_METRICS_OPTIONS as defaults,
  stepMetrics,
  type StepMetricsResult,
  type StepSample,
} from '../../src/domain/step-response'

const unitStep = { t0: 0, y0: 0, y1: 1 }
const sample = (fn: (t: number) => number, end: number, dt: number): StepSample[] =>
  Array.from({ length: Math.round(end / dt) + 1 }, (_, i) => ({ t: i * dt, y: fn(i * dt) }))

function measured(result: StepMetricsResult) {
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(result.status)
  return result
}

// Bisection of an exact curve, independent of the sampled interpolation.
function root(fn: (t: number) => number, left: number, right: number): number {
  const initialSign = Math.sign(fn(left))
  for (let i = 0; i < 60; i++) {
    const mid = (left + right) / 2
    if (Math.sign(fn(mid)) === initialSign) left = mid
    else right = mid
  }
  return (left + right) / 2
}

describe('stepMetrics analytical responses', () => {
  it('first order: rise = tau ln 9, settling = tau ln 50, no overshoot', () => {
    const tau = 0.7
    const dt = 0.001
    const result = measured(stepMetrics(sample((t) => 1 - Math.exp(-t / tau), 7, dt), unitStep, defaults))
    expect(result.overshoot).toEqual({ status: 'no-overshoot' })
    expect(result.riseTime.status).toBe('reached')
    if (result.riseTime.status !== 'reached') throw new Error('rise missing')
    // One sample period bounds crossing interpolation error on this smooth curve.
    expect(Math.abs(result.riseTime.time - tau * Math.log(9))).toBeLessThan(dt)
    expect(result.settlingTime.status).toBe('settled')
    if (result.settlingTime.status !== 'settled') throw new Error('settling missing')
    expect(Math.abs(result.settlingTime.time - tau * Math.log(50))).toBeLessThan(dt)
    // Integral of exp(-t/tau) over the final 10%, divided by its duration.
    const exactMean = tau * (Math.exp(-6.3 / tau) - Math.exp(-7 / tau)) / 0.7
    expect(Math.abs(result.steadyStateError - exactMean)).toBeLessThan(1e-9)
  })

  it.each([1, -3])('underdamped second order, signed amplitude %s and nonzero baseline', (amplitude) => {
    const zeta = 0.4
    const wn = 3
    const wd = wn * Math.sqrt(1 - zeta ** 2)
    const phi = Math.acos(zeta)
    const response = (t: number) => 1 - Math.exp(-zeta * wn * t) / Math.sqrt(1 - zeta ** 2) * Math.sin(wd * t + phi)
    const dt = 0.001
    const t0 = 2
    const y0 = 7
    const samples = sample(response, 10, dt).map((s) => ({ t: s.t + t0, y: y0 + amplitude * s.y }))
    // Large pre-step excursions must not affect any metric.
    samples.unshift({ t: 0, y: 100 })
    const result = measured(stepMetrics(samples, { t0, y0, y1: y0 + amplitude }, defaults))
    const exactPeak = Math.PI / wd
    const exactOvershoot = 100 * Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta ** 2))
    expect(Math.abs(result.peakTime - exactPeak)).toBeLessThanOrEqual(dt / 2)
    expect(result.overshoot.status).toBe('overshoot')
    if (result.overshoot.status !== 'overshoot') throw new Error('overshoot missing')
    // |y''| <= wn^2/sqrt(1-zeta^2); nearest sample <= dt/2 from peak.
    const overshootTolerance = 100 * wn ** 2 / Math.sqrt(1 - zeta ** 2) * dt ** 2 / 8
    expect(Math.abs(result.overshoot.percent - exactOvershoot)).toBeLessThan(overshootTolerance)
    const exactLower = root((t) => response(t) - 0.1, 0, exactPeak)
    const exactUpper = root((t) => response(t) - 0.9, 0, exactPeak)
    expect(result.riseTime.status).toBe('reached')
    if (result.riseTime.status !== 'reached') throw new Error('rise missing')
    expect(Math.abs(result.riseTime.time - (exactUpper - exactLower))).toBeLessThan(dt)

    // The envelope guarantees no departure after envelopeTime. Search backward
    // from there for the last outside point on a dt/10 grid, then solve the exact
    // response's final band entry. This is NOT the approximate 4/(zeta*wn).
    const envelopeTime = -Math.log(defaults.settlingBand * Math.sqrt(1 - zeta ** 2)) / (zeta * wn)
    let inside = envelopeTime
    while (Math.abs(response(inside - dt / 10) - 1) <= defaults.settlingBand) inside -= dt / 10
    const exactSettling = root((t) => Math.abs(response(t) - 1) - defaults.settlingBand, inside - dt / 10, inside)
    expect(result.settlingTime.status).toBe('settled')
    if (result.settlingTime.status !== 'settled') throw new Error('settling missing')
    // Linear interpolation of this smooth final crossing is within one sample.
    expect(Math.abs(result.settlingTime.time - exactSettling)).toBeLessThan(dt)
  })

  it('type-0 plant: the final mean tends to 1/(1 + K)', () => {
    const k = 3
    // G(s)=K/(s+1), unity feedback: y=K/(1+K)*(1-exp(-(1+K)t)).
    const result = measured(stepMetrics(sample((t) => k / (1 + k) * (1 - Math.exp(-(1 + k) * t)), 10, 0.01), unitStep, defaults))
    expect(result.steadyStateError).toBeCloseTo(1 / (1 + k), 12)
    expect(result.settlingTime).toEqual({ status: 'did-not-settle' })
  })
})

describe('stepMetrics sampled definitions', () => {
  it('interpolates both rise crossings within a single segment and accepts editable thresholds', () => {
    const samples = [{ t: 0, y: 4 }, { t: 4, y: 6 }]
    const result = measured(stepMetrics(samples, { t0: 0, y0: 4, y1: 6 }, { riseLower: 0.25, riseUpper: 0.75, settlingBand: 0.125, steadyStateFraction: 0.5 }))
    expect(result.riseTime).toEqual({ status: 'reached', time: 2, lowerTime: 1, upperTime: 3 })
    expect(result.settlingTime).toEqual({ status: 'settled', time: 3.5 })
    expect(result.steadyStateError).toBe(0.5)
  })

  it('clips at an interpolated t0 and time-weights an irregularly sampled final interval', () => {
    // y=t on [0,10], step at 2 toward 10: final half [6,10] has mean error 2.
    const result = measured(stepMetrics([{ t: 0, y: 0 }, { t: 3, y: 3 }, { t: 9, y: 9 }, { t: 10, y: 10 }], { t0: 2, y0: 2, y1: 10 }, { ...defaults, steadyStateFraction: 0.5 }))
    expect(result.steadyStateError).toBeCloseTo(2, 12)
    expect(result.riseTime.status).toBe('reached')
    if (result.riseTime.status !== 'reached') throw new Error('rise missing')
    expect(result.riseTime.time).toBeCloseTo(6.4, 12)
    expect(result.riseTime.lowerTime).toBeCloseTo(0.8, 12)
    expect(result.riseTime.upperTime).toBeCloseTo(7.2, 12)
  })

  it('uses the last band entry, inclusive boundaries, and earliest tied directional peak', () => {
    const result = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: 1.25 }, { t: 2, y: 1 }, { t: 3, y: 0.5 }, { t: 4, y: 1.25 }, { t: 5, y: 1.125 }], unitStep, { ...defaults, settlingBand: 0.125 }))
    expect(result.settlingTime).toEqual({ status: 'settled', time: 5 })
    expect(result.peakTime).toBe(1)
    expect(result.overshoot).toEqual({ status: 'overshoot', percent: 25 })
  })

  it('reports never settling and distinct missing rise thresholds', () => {
    const oscillating = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: 1.2 }, { t: 2, y: 0.8 }, { t: 3, y: 1.2 }], unitStep, defaults))
    expect(oscillating.settlingTime).toEqual({ status: 'did-not-settle' })
    const partial = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: 0.5 }], unitStep, defaults))
    expect(partial.riseTime).toEqual({ status: 'did-not-reach', lowerTime: 0.2, upperTime: null })
    const neither = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: -1 }], unitStep, defaults))
    expect(neither.riseTime).toEqual({ status: 'did-not-reach', lowerTime: null, upperTime: null })
  })

  it('returns zero elapsed times when thresholds and settling are already attained at t0', () => {
    const result = measured(stepMetrics([{ t: 0, y: 1 }, { t: 1, y: 1 }], unitStep, defaults))
    expect(result.riseTime).toEqual({ status: 'reached', time: 0, lowerTime: 0, upperTime: 0 })
    expect(result.settlingTime).toEqual({ status: 'settled', time: 0 })
    expect(result.overshoot).toEqual({ status: 'no-overshoot' })
    expect(result.steadyStateError).toBe(0)
  })

  it('preserves signed steady-state error for a downward step and does not mutate inputs', () => {
    const samples = Object.freeze([Object.freeze({ t: 0, y: 3 }), Object.freeze({ t: 1, y: 2 })])
    const step = Object.freeze({ t0: 0, y0: 3, y1: 1 })
    const result = measured(stepMetrics(samples, step, defaults))
    // Final [0.9,1]: y mean=2.05; reference minus output=-1.05.
    expect(result.steadyStateError).toBeCloseTo(-1.05, 12)
    expect(stepMetrics(samples, step, defaults)).toEqual(result)
    expect(samples).toEqual([{ t: 0, y: 3 }, { t: 1, y: 2 }])
  })

  it('keeps the first rise crossings despite later reversals', () => {
    const result = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: 1 }, { t: 2, y: 0 }, { t: 3, y: 1 }], unitStep, defaults))
    expect(result.riseTime).toEqual({ status: 'reached', time: 0.8, lowerTime: 0.1, upperTime: 0.9 })
    expect(result.settlingTime.status).toBe('settled')
    if (result.settlingTime.status !== 'settled') throw new Error('settling missing')
    expect(result.settlingTime.time).toBeCloseTo(2.98, 12)
  })

  it('allows 0-100% rise and a full-window mean', () => {
    const result = measured(stepMetrics([{ t: 0, y: 0 }, { t: 1, y: 1 }], unitStep, { ...defaults, riseLower: 0, riseUpper: 1, steadyStateFraction: 1 }))
    expect(result.riseTime).toEqual({ status: 'reached', time: 1, lowerTime: 0, upperTime: 1 })
    expect(result.steadyStateError).toBe(0.5)
  })
})

describe('stepMetrics validation', () => {
  const valid = [{ t: 0, y: 0 }, { t: 1, y: 1 }]
  it.each([{ samples: [] }, { samples: [valid[0]!] }])('too few samples: $samples', ({ samples }) => {
    expect(stepMetrics(samples, unitStep, defaults)).toEqual({ status: 'too-few-samples' })
  })
  it('distinguishes a zero step', () => {
    expect(stepMetrics(valid, { ...unitStep, y1: 0 }, defaults)).toEqual({ status: 'zero-step' })
  })
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite input %s in every numeric field', (bad) => {
    for (const field of ['t', 'y'] as const) {
      expect(stepMetrics([{ ...valid[0]!, [field]: bad }, valid[1]!], unitStep, defaults)).toEqual({ status: 'non-finite-input' })
    }
    for (const field of ['t0', 'y0', 'y1'] as const) {
      expect(stepMetrics(valid, { ...unitStep, [field]: bad }, defaults)).toEqual({ status: 'non-finite-input' })
    }
    for (const field of ['riseLower', 'riseUpper', 'settlingBand', 'steadyStateFraction'] as const) {
      expect(stepMetrics(valid, unitStep, { ...defaults, [field]: bad })).toEqual({ status: 'non-finite-input' })
    }
  })
  it.each([
    { riseLower: -0.1 }, { riseUpper: 1.1 }, { riseLower: 0.9 },
    { riseUpper: 0.05 }, { settlingBand: 0 }, { settlingBand: -1 },
    { steadyStateFraction: 0 }, { steadyStateFraction: -1 }, { steadyStateFraction: 1.1 },
  ])('rejects invalid options %j', (options) => {
    expect(stepMetrics(valid, unitStep, { ...defaults, ...options })).toEqual({ status: 'invalid-options' })
  })
  it('rejects duplicate and reversed times without sorting the input', () => {
    expect(stepMetrics([valid[0]!, valid[0]!], unitStep, defaults)).toEqual({ status: 'invalid-times' })
    expect(stepMetrics([...valid].reverse(), unitStep, defaults)).toEqual({ status: 'invalid-times' })
  })
  it.each([-1, 1, 2])('requires coverage of t0=%s and a positive post-step window', (t0) => {
    expect(stepMetrics(valid, { ...unitStep, t0 }, defaults)).toEqual({ status: 'invalid-window' })
  })
  it('reports arithmetic overflow separately from nonfinite input', () => {
    expect(stepMetrics(valid, { t0: 0, y0: -Number.MAX_VALUE, y1: Number.MAX_VALUE }, defaults)).toEqual({ status: 'numeric-overflow' })
    expect(stepMetrics(valid, unitStep, { ...defaults, steadyStateFraction: Number.MIN_VALUE })).toEqual({ status: 'numeric-overflow' })
  })
})
