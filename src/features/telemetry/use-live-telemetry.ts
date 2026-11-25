import { useMemo } from 'react'
import { createLiveBuffer } from './live-buffer'
import type { LiveGraphSource } from './TelemetryGraph'

/** Supply the run's retention policy and pass this source to TelemetryGraph.
 * Mutations publish invalidations. Each graph reads and draws once per frame. */
export function useLiveTelemetry(durationS: number, capacity: number) {
  return useMemo(() => {
    const buffer = createLiveBuffer(durationS, capacity)
    const listeners = new Set<() => void>()
    const notify = () => listeners.forEach((listener) => listener())
    const source: LiveGraphSource = {
      read: buffer.read,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    return {
      source,
      begin(channels: Parameters<typeof buffer.begin>[0]) {
        buffer.begin(channels)
        notify()
      },
      append(rows: Parameters<typeof buffer.append>[0]) {
        if (!rows.length) return
        buffer.append(rows)
        notify()
      },
      end() {
        buffer.end()
        notify()
      },
    }
  }, [durationS, capacity])
}
