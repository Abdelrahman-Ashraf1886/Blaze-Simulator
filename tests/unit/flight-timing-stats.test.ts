import { describe, expect, it } from 'vitest'
import {
  matchStickFlips, percentile, summarizeFlightTiming, type TimingDraw, type TimingRequest,
} from '../../src/features/flight/flight-timing-stats'

const request = (sentMs: number, responseMs: number | null, simTimeS: number | null, yawRight: number): TimingRequest => ({
  sentMs, responseMs, simTimeS, steps: 10,
  setpoint: { mode: 'position', sticks: { forward: 0, right: 0, throttle: 0, yawRight } },
})

const draw = (drawnMs: number, nextAnimationMs: number | null, simTimeS: number): TimingDraw => ({
  drawnMs, nextAnimationMs, simTimeS, altitudeM: 0, touching: true, mode: 'position',
})

describe('flight timing statistics', () => {
  it('uses nearest-rank percentiles without mutating samples', () => {
    const data = [20, 1, 9, 2]
    expect(percentile(data, 0.5)).toBe(2)
    expect(percentile(data, 0.95)).toBe(20)
    expect(percentile(data, 1)).toBe(20)
    expect(data).toEqual([20, 1, 9, 2])
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([1, 2, Infinity], 0.95)).toBeNull()
  })

  it('matches the first request and the first draw including its simulated time', () => {
    const result = matchStickFlips(
      [{ atMs: 12, yawRight: 1 }, { atMs: 40, yawRight: -1 }],
      [request(11, 13, 0.01, 1), request(15, 18, 0.02, -1), request(20, 22, 0.03, 1),
        request(32, 34, 0.04, 1), request(41, 45, 0.05, -1)],
      [draw(21, 26, 0.02), draw(26, 30, 0.02), draw(30, 40, 0.03), draw(47, 56, 0.06)],
    )
    expect(result).toEqual({
      dropped: { request: 0, response: 0, draw: 0, nextAnimationFrame: 0 },
      drawDelaysMs: [18, 7],
      nextAnimationDelaysMs: [28, 16],
    })
  })

  it('counts each missing stage and does not match a value after it was superseded', () => {
    const result = matchStickFlips(
      [{ atMs: 10, yawRight: 1 }, { atMs: 20, yawRight: -1 },
        { atMs: 30, yawRight: 1 }, { atMs: 40, yawRight: -1 }],
      [request(22, 25, null, -1), request(31, 34, 0.05, 1), request(41, 43, 0.04, -1)],
      [draw(42, 43, 0.04), draw(48, null, 0.04)],
    )
    expect(result).toEqual({
      dropped: { request: 1, response: 1, draw: 1, nextAnimationFrame: 1 },
      drawDelaysMs: [Infinity, Infinity, Infinity, 8],
      nextAnimationDelaysMs: [Infinity, Infinity, Infinity, Infinity],
    })
  })

  it('excludes tail frames from cadence, includes them in latency, and reports overflow and pending requests', () => {
    const result = summarizeFlightTiming({
      requests: [request(10, 12, 0.01, 1), request(20, 22, 0.02, 1),
        request(49, 51, 0.03, -1), request(50, null, null, -1), request(61, 62, 0.04, -1)],
      draws: [draw(12, 18, 0.01), draw(20, 50, 0.01), draw(50, 63, 0.02), draw(63, 70, 0.04)],
      overflow: { requests: 2, draws: 3 },
    }, [{ atMs: 45, yawRight: -1 }], 10, 60, 10)
    expect(result).toEqual({
      requests: 4, draws: 3, flips: 1,
      dropped: { request: 0, response: 0, draw: 0, nextAnimationFrame: 0, requestRoundTrips: 1,
        requestResults: 1, overflow: { requests: 2, draws: 3 } },
      frameIntervalMs: { median: 8, p95: 30, max: 30 },
      framesOverTwoPeriods: 1,
      requestRoundTripMs: { median: 2, p95: null, max: null },
      stepsPerRequest: { median: 10, p95: 10, max: 10 },
      stickToDrawMs: { median: 18, p95: 18, max: 18 },
      stickToNextAnimationFrameMs: { median: 25, p95: 25, max: 25 },
      simulatedTimePerWallTime: 10 / 38,
    })
  })
})
