import type { ResponseStep, StepSample } from '../../domain/step-response'

// Coordinates are percentages of the plotted sample window and signal extent.
export function responsePlot(samples: readonly StepSample[], { t0, y0, y1 }: ResponseStep) {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last || ![t0, y0, y1].every(Number.isFinite)) return null

  const targetAt = (t: number) => t < t0 ? y0 : y1
  let low = Math.min(targetAt(first.t), targetAt(last.t))
  let high = Math.max(targetAt(first.t), targetAt(last.t))
  for (const [index, sample] of samples.entries()) {
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.y) || (index > 0 && sample.t <= samples[index - 1]!.t)) return null
    low = Math.min(low, sample.y)
    high = Math.max(high, sample.y)
  }

  const duration = last.t - first.t
  const span = high - low
  if (!Number.isFinite(duration) || !Number.isFinite(span)) return null
  const x = (t: number) => duration === 0 ? 50 : (t - first.t) / duration * 100
  const y = (value: number) => span === 0 ? 50 : (high - value) / span * 100

  const startTarget = y(targetAt(first.t))
  const endTarget = y(targetAt(last.t))
  const setpoint = [`${x(first.t)},${startTarget}`]
  if (first.t < t0 && t0 <= last.t) {
    setpoint.push(`${x(t0)},${startTarget}`, `${x(t0)},${endTarget}`)
  }
  setpoint.push(`${x(last.t)},${endTarget}`)

  return {
    start: first.t, end: last.t, low, high,
    setpoint: setpoint.join(' '),
    state: samples.map((sample) => `${x(sample.t)},${y(sample.y)}`).join(' '),
    firstPoint: { x: x(first.t), y: y(first.y), targetY: startTarget },
  }
}
