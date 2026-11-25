import { useState } from 'react'
import { telemetryChannels } from '../../domain/telemetry-channels'
import { createGraphCursor, TelemetryGraph, type LiveGraphSource } from './TelemetryGraph'

// A display choice: long enough to see a manoeuvre and its recovery in one view.
export const LIVE_WINDOW_S = 10
// D11 (phase-7-telemetry.md:47) records at 250 Hz; one more row for the window's far end.
export const LIVE_CAPACITY = 250 * LIVE_WINDOW_S + 1

const channels = telemetryChannels(0, 'attitudeHold')
const altitude = channels.filter(({ name }) => name === 'state.position.z')
const bodyRates = channels.filter(({ name }) => /^(state\.bodyRates|setpoint\.rates)\./.test(name))
const battery = channels.filter(({ name }) => name === 'pack.voltage' || name === 'pack.current')

export function LiveGraphs({ source, needsNewFlight }: { source: LiveGraphSource; needsNewFlight: boolean }) {
  const [cursor] = useState(createGraphCursor)
  return <section id="flight-live-telemetry" aria-label="Live telemetry"
    className="grid min-w-0 gap-3 rounded-md border border-line bg-raised p-3">
    {needsNewFlight
      ? <p className="text-warn">Start a flight with this panel open to sample without recording.</p>
      : <p className="text-fg-muted">Latest {LIVE_WINDOW_S} seconds of simulated time.</p>}
    <TelemetryGraph title="Altitude" channels={altitude} cursor={cursor} live={source} />
    <TelemetryGraph title="Body rates" channels={bodyRates} cursor={cursor} live={source} />
    <TelemetryGraph title="Battery" channels={battery} cursor={cursor} live={source} />
  </section>
}
