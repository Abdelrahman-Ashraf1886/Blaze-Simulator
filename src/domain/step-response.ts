/**
 * Sampled step-response metrics. Pure data in/data out (ADR 0008).
 *
 * Source: Ogata, Modern Control Engineering, 5th ed. (2010), section 5-3,
 * "Definitions of Transient-Response Specifications", p. 170: fractional rise,
 * peak, percent overshoot and entry into a band that is never subsequently left.
 * Section 5-8, p. 226 defines error as reference minus output and its steady-state
 * limit. (Section and page checked against the 5th edition text when this was
 * written; re-check against your own copy if the edition differs.)
 *
 * D12 conventions: normalize by the commanded step (not an estimated asymptote),
 * use the largest directional peak in the window (Ogata uses the first peak),
 * and estimate steady-state error with a final-window mean, not an infinite-time
 * limit. This estimate does not imply that the response has settled.
 * The signal is piecewise linear; unobserved inter-sample oscillations and future
 * departures from the settling band cannot be detected. No thresholds are implicit.
 */

export interface StepSample {
  readonly t: number
  readonly y: number
}

export interface ResponseStep {
  readonly t0: number
  readonly y0: number
  readonly y1: number
}

export interface StepMetricsOptions {
  /** Fractions of the signed step, 0 <= lower < upper <= 1. */
  readonly riseLower: number
  readonly riseUpper: number
  /** Inclusive half-width as a fraction of |y1 - y0|, strictly positive. */
  readonly settlingBand: number
  /** Fraction of the duration [t0, last sample] to average, in (0, 1]. */
  readonly steadyStateFraction: number
}

/** D12 recommendations, not PX4 values or acceptance criteria. Pass explicitly. */
export const RECOMMENDED_STEP_METRICS_OPTIONS = Object.freeze({
  riseLower: 0.1,
  riseUpper: 0.9,
  settlingBand: 0.02,
  steadyStateFraction: 0.1,
} satisfies StepMetricsOptions)

export type RiseTimeResult =
  | { status: 'reached'; time: number; lowerTime: number; upperTime: number }
  | { status: 'did-not-reach'; lowerTime: number | null; upperTime: number | null }

export type SettlingTimeResult = { status: 'settled'; time: number } | { status: 'did-not-settle' }
export type OvershootResult = { status: 'overshoot'; percent: number } | { status: 'no-overshoot' }

export type StepMetricsResult =
  | {
      status: 'ok'
      riseTime: RiseTimeResult
      /** Earliest occurrence of the largest directional value, elapsed from t0. */
      peakTime: number
      overshoot: OvershootResult
      settlingTime: SettlingTimeResult
      /** Signed, in y units; time-weighted mean of y1 - y over the final interval. */
      steadyStateError: number
    }
  | { status: 'zero-step' }
  | { status: 'too-few-samples' }
  | { status: 'non-finite-input' }
  | { status: 'invalid-options' }
  | { status: 'invalid-times' }
  | { status: 'invalid-window' }
  | { status: 'numeric-overflow' }

/**
 * Requires strictly increasing sample times, at least two samples, and coverage
 * of t0 with a positive duration afterward. Pre-step data is ignored except for
 * interpolating at t0; no synthetic sample at y0 and no extrapolation are used.
 * All returned times are elapsed from t0 (rise time is upperTime - lowerTime).
 * A threshold already attained at t0 has crossing time zero. Band boundaries
 * count as inside, including an entry at the last sample. Input is never mutated.
 */
export function stepMetrics(
  samples: readonly StepSample[],
  step: ResponseStep,
  options: StepMetricsOptions,
): StepMetricsResult {
  if (![step.t0, step.y0, step.y1, options.riseLower, options.riseUpper, options.settlingBand, options.steadyStateFraction].every(Number.isFinite)
    || samples.some((s) => !Number.isFinite(s.t) || !Number.isFinite(s.y))) return { status: 'non-finite-input' }
  if (!(0 <= options.riseLower && options.riseLower < options.riseUpper && options.riseUpper <= 1
    && options.settlingBand > 0 && options.steadyStateFraction > 0 && options.steadyStateFraction <= 1)) return { status: 'invalid-options' }
  if (samples.length < 2) return { status: 'too-few-samples' }
  if (samples.some((s, i) => i > 0 && s.t <= samples[i - 1]!.t)) return { status: 'invalid-times' }
  if (step.y0 === step.y1) return { status: 'zero-step' }
  const end = samples[samples.length - 1]!.t
  if (samples[0]!.t > step.t0 || end <= step.t0) return { status: 'invalid-window' }
  const amplitude = step.y1 - step.y0
  const duration = end - step.t0
  // Normalize direction so downward steps use exactly the same crossing rules.
  const points = samples.map((s) => ({ t: s.t - step.t0, y: (s.y - step.y0) / amplitude }))
  if (!Number.isFinite(amplitude) || !Number.isFinite(duration)
    || points.some((p, i) => !Number.isFinite(p.t) || !Number.isFinite(p.y)
      || (i > 0 && !Number.isFinite(p.t - points[i - 1]!.t)))) return { status: 'numeric-overflow' }
  const start = points.findIndex((p) => p.t >= 0)
  const window = points.slice(start)
  if (window[0]!.t > 0) {
    const a = points[start - 1]!
    const b = window[0]!
    window.unshift({ t: 0, y: interpolate(a, b, 0) })
  }
  const crossing = (fraction: number): number | null => {
    if (window[0]!.y >= fraction) return 0
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1]!
      const b = window[i]!
      if (a.y < fraction && b.y >= fraction) return a.t + (b.t - a.t) * ((fraction - a.y) / (b.y - a.y))
    }
    return null
  }
  const lowerTime = crossing(options.riseLower)
  const upperTime = crossing(options.riseUpper)
  let peak = window[0]!
  let lastOutside = -1
  for (let i = 0; i < window.length; i++) {
    const p = window[i]!
    if (p.y > peak.y) peak = p
    if (Math.abs(p.y - 1) > options.settlingBand) lastOutside = i
  }
  let settlingTime: SettlingTimeResult
  if (lastOutside === window.length - 1) settlingTime = { status: 'did-not-settle' }
  else if (lastOutside === -1) settlingTime = { status: 'settled', time: 0 }
  else {
    const a = window[lastOutside]!
    const b = window[lastOutside + 1]!
    const boundary = a.y > 1 ? 1 + options.settlingBand : 1 - options.settlingBand
    settlingTime = { status: 'settled', time: a.t + (b.t - a.t) * ((boundary - a.y) / (b.y - a.y)) }
  }
  const tailDuration = duration * options.steadyStateFraction
  const tailStart = duration - tailDuration
  if (tailDuration <= 0 || tailStart >= duration) return { status: 'numeric-overflow' }
  let meanError = 0
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1]!
    const b = window[i]!
    if (b.t <= tailStart) continue
    const left = Math.max(a.t, tailStart)
    // Trapezoidal integration is exact for the piecewise-linear signal.
    meanError += ((1 - interpolate(a, b, left)) / 2 + (1 - b.y) / 2) * ((b.t - left) / tailDuration)
  }
  const steadyStateError = meanError * amplitude
  const percent = (peak.y - 1) * 100
  if (![steadyStateError, percent, tailDuration].every(Number.isFinite) || tailDuration <= 0) return { status: 'numeric-overflow' }
  return {
    status: 'ok',
    riseTime: lowerTime === null || upperTime === null
      ? { status: 'did-not-reach', lowerTime, upperTime }
      : { status: 'reached', time: upperTime - lowerTime, lowerTime, upperTime },
    peakTime: peak.t,
    overshoot: peak.y > 1 ? { status: 'overshoot', percent } : { status: 'no-overshoot' },
    settlingTime,
    steadyStateError,
  }
}

function interpolate(a: StepSample, b: StepSample, t: number): number {
  const fraction = (t - a.t) / (b.t - a.t)
  return (1 - fraction) * a.y + fraction * b.y
}
