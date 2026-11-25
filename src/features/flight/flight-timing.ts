/// <reference lib="dom" />

import { addAfterEffect, useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { DesktopApi, FlightStepInput } from '../../../electron/ipc/contract'
import { registerTestHook, testHooksEnabled } from '../../lib/test-hooks'
import type { TimingCapture, TimingDraw, TimingRequest } from './flight-timing-stats'
import type { FlightFrame } from './frame'

type FlightStep = DesktopApi['engine']['flightStep']

function createFlightTiming() {
  let capture: TimingCapture | null = null
  let capacity = 0

  return {
    // The caller supplies a bound based on refresh frequency and capture duration, including the tail.
    start(limit: number) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid flight timing capacity')
      capacity = limit
      capture = { requests: [], draws: [], overflow: { requests: 0, draws: 0 } }
      return performance.now()
    },
    stop() {
      const result = capture
      capture = null
      return result
    },
    step(api: { flightStep: FlightStep }, steps: number, setpoint: FlightStepInput['setpoint']) {
      if (!capture) return api.flightStep({ steps, setpoint })
      if (capture.requests.length >= capacity) {
        capture.overflow.requests++
        return api.flightStep({ steps, setpoint })
      }
      const sample: TimingRequest = { sentMs: performance.now(), responseMs: null, steps, setpoint, simTimeS: null }
      capture.requests.push(sample)
      return api.flightStep({ steps, setpoint }).then((result) => {
        sample.responseMs = performance.now()
        if (result.ok) sample.simTimeS = result.data.diagnostic.state.timeS
        return result
      }, (error: unknown) => {
        sample.responseMs = performance.now()
        throw error
      })
    },
    draw(frame: FlightFrame) {
      if (!capture) return
      if (capture.draws.length >= capacity) {
        capture.overflow.draws++
        return
      }
      const sample: TimingDraw = {
        drawnMs: performance.now(),
        nextAnimationMs: null,
        simTimeS: frame.timeS,
        altitudeM: frame.positionM[2],
        touching: frame.contacts.some(({ endS }) => endS === null),
        mode: frame.flightLoop?.mode ?? null,
      }
      capture.draws.push(sample)
      requestAnimationFrame((timestamp) => {
        if (timestamp >= sample.drawnMs) sample.nextAnimationMs = timestamp
      })
    },
  }
}

export const flightTiming = typeof window !== 'undefined' && testHooksEnabled() ? createFlightTiming() : null
type FlightTiming = NonNullable<typeof flightTiming>

if (flightTiming) registerTestHook('flightTiming', { start: flightTiming.start, stop: flightTiming.stop })

export function FlightTimingProbe({ timing, frame }: { timing: FlightTiming; frame: FlightFrame }) {
  const rendering = useRef<FlightFrame | null>(null)
  // The Canvas root calls this subscriber with the committed props used by the scene in this frame.
  // The global after-effect consumes that marker only after this root has drawn.
  useFrame(() => { rendering.current = frame })
  useEffect(() => addAfterEffect(() => {
    const drawn = rendering.current
    rendering.current = null
    if (drawn) timing.draw(drawn)
  }), [timing])
  return null
}
