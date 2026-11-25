import type { FlightStepInput } from '../../../electron/ipc/contract'
import type { FlightFrame } from './frame'

export interface TimingRequest {
  sentMs: number
  responseMs: number | null
  steps: number
  setpoint: FlightStepInput['setpoint']
  simTimeS: number | null
}

export interface TimingDraw {
  drawnMs: number
  nextAnimationMs: number | null
  simTimeS: number
  altitudeM: number
  touching: boolean
  mode: NonNullable<FlightFrame['flightLoop']>['mode'] | null
}

export interface StickFlip {
  atMs: number
  yawRight: number
}

export interface TimingCapture {
  requests: TimingRequest[]
  draws: TimingDraw[]
  overflow: { requests: number; draws: number }
}

/** Nearest rank. null represents an empty sample or an unobserved value at that rank. */
export function percentile(samples: readonly number[], fraction: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const value = sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
  return value !== undefined && Number.isFinite(value) ? value : null
}

function distribution(samples: readonly number[]) {
  return { median: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: percentile(samples, 1) }
}

/** Arrays are in capture order. Once a stick value is superseded, it cannot start a match. */
export function matchStickFlips(
  flips: readonly StickFlip[], requests: readonly TimingRequest[], draws: readonly TimingDraw[],
) {
  const dropped = { request: 0, response: 0, draw: 0, nextAnimationFrame: 0 }
  const drawDelaysMs: number[] = []
  const nextAnimationDelaysMs: number[] = []
  flips.forEach((flip, index) => {
    const nextFlipMs = flips[index + 1]?.atMs ?? Infinity
    const request = requests.find(({ sentMs, setpoint }) =>
      sentMs >= flip.atMs && sentMs < nextFlipMs && setpoint.sticks?.yawRight === flip.yawRight)
    const response = request?.responseMs
    const simTime = request?.simTimeS
    const draw = response != null && simTime != null
      ? draws.find(({ drawnMs, simTimeS }) => drawnMs >= response && simTimeS >= simTime)
      : undefined
    if (!request) dropped.request++
    else if (response == null || simTime == null) dropped.response++
    else if (!draw) dropped.draw++
    else if (draw.nextAnimationMs === null) dropped.nextAnimationFrame++
    drawDelaysMs.push(draw ? draw.drawnMs - flip.atMs : Infinity)
    nextAnimationDelaysMs.push(draw?.nextAnimationMs != null ? draw.nextAnimationMs - flip.atMs : Infinity)
  })
  return { dropped, drawDelaysMs, nextAnimationDelaysMs }
}

export function summarizeFlightTiming(
  capture: TimingCapture, flips: readonly StickFlip[], startMs: number, endMs: number, periodMs: number,
) {
  const requests = capture.requests.filter(({ sentMs }) => sentMs >= startMs && sentMs < endMs)
  const draws = capture.draws.filter(({ drawnMs }) => drawnMs >= startMs && drawnMs < endMs)
  const intervals = draws.slice(1).map((draw, index) => draw.drawnMs - draws[index]!.drawnMs)
  const first = draws[0]
  const last = draws.at(-1)
  const matches = matchStickFlips(flips, capture.requests, capture.draws)
  return {
    draws: draws.length,
    requests: requests.length,
    flips: flips.length,
    dropped: {
      ...matches.dropped,
      requestRoundTrips: requests.filter(({ responseMs }) => responseMs === null).length,
      requestResults: requests.filter(({ simTimeS }) => simTimeS === null).length,
      overflow: capture.overflow,
    },
    frameIntervalMs: distribution(intervals),
    framesOverTwoPeriods: intervals.filter((ms) => ms > 2 * periodMs).length,
    requestRoundTripMs: distribution(requests.map(({ sentMs, responseMs }) =>
      responseMs === null ? Infinity : responseMs - sentMs)),
    stepsPerRequest: distribution(requests.map(({ steps }) => steps)),
    stickToDrawMs: distribution(matches.drawDelaysMs),
    stickToNextAnimationFrameMs: distribution(matches.nextAnimationDelaysMs),
    simulatedTimePerWallTime: first && last && last.drawnMs > first.drawnMs
      ? (last.simTimeS - first.simTimeS) * 1000 / (last.drawnMs - first.drawnMs)
      : null,
  }
}
