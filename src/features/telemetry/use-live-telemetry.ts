import { useMemo } from 'react'
import { createLiveBuffer } from './live-buffer'

// 10 Hz is enough to watch trends while the flight view stays at frame rate.
export const LIVE_GRAPH_INTERVAL_MS = 100

function createDrawScheduler() {
  type Plot = { draw: () => void; nextDraw: number; visible: boolean }
  const plots = new Set<Plot>()
  const pending = new Set<Plot>()
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule() {
    if (frame !== undefined || timer !== undefined || !pending.size) return
    let next = Infinity
    for (const plot of pending) next = Math.min(next, plot.nextDraw)
    const delay = next - performance.now()
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined
        schedule()
      }, Math.ceil(delay))
      return
    }
    frame = requestAnimationFrame(() => {
      frame = undefined
      // Let the frame's other animation callbacks, including the 3D draw, run first.
      timer = setTimeout(drawOne, 0)
    })
  }

  function drawOne() {
    timer = undefined
    const now = performance.now()
    for (const plot of pending) {
      if (plot.nextDraw > now) continue
      pending.delete(plot)
      plot.nextDraw = now + LIVE_GRAPH_INTERVAL_MS
      plot.draw()
      break
    }
    schedule()
  }

  function cancel(plot: Plot) {
    pending.delete(plot)
    if (pending.size) return
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
    frame = timer = undefined
  }

  return {
    subscribe(draw: () => void) {
      const plot: Plot = { draw, nextDraw: -Infinity, visible: false }
      plots.add(plot)
      return {
        setVisible(visible: boolean) {
          if (!plots.has(plot)) return
          plot.visible = visible
          if (visible) {
            pending.add(plot)
            schedule()
          } else cancel(plot)
        },
        unsubscribe() {
          plots.delete(plot)
          cancel(plot)
        },
      }
    },
    invalidate() {
      for (const plot of plots) if (plot.visible) pending.add(plot)
      schedule()
    },
  }
}

export function createLiveTelemetry(durationS: number, capacity: number) {
  const buffer = createLiveBuffer(durationS, capacity)
  const draws = createDrawScheduler()
  return {
    source: { createReader: buffer.createReader, subscribe: draws.subscribe, durationS },
    begin(channels: Parameters<typeof buffer.begin>[0]) {
      buffer.begin(channels)
      draws.invalidate()
    },
    append(rows: Parameters<typeof buffer.append>[0]) {
      if (buffer.append(rows)) draws.invalidate()
    },
    reset() {
      buffer.reset()
      draws.invalidate()
    },
  }
}

export type LiveGraphSource = ReturnType<typeof createLiveTelemetry>['source']

export function useLiveTelemetry(durationS: number, capacity: number) {
  return useMemo(() => createLiveTelemetry(durationS, capacity), [durationS, capacity])
}
