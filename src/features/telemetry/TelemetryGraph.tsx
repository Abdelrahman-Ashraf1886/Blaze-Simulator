import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent } from 'react'
import uPlot from 'uplot'
import type { RecordingSeries } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { groupAxes, MAX_AXES, type PlotChannel } from './layout'
import { alignSamples, pointAt, valueLabel, type TimeRange } from './samples'

type Listener = () => void

export interface LiveGraphSource {
  subscribe(listener: Listener): () => void
  read(names: readonly string[], fromS: number): RecordingSeries[]
}

export function createGraphCursor() {
  let time: number | null = null
  const listeners = new Set<(source?: uPlot) => void>()
  return {
    get: () => time,
    set(next: number | null, source?: uPlot) {
      if (time === next) return
      time = next
      listeners.forEach((listener) => listener(source))
    },
    subscribe(listener: (source?: uPlot) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function seriesStyles(channels: readonly PlotChannel[]) {
  const palette = ['fg', 'accent', 'fg-muted']
  let setpoints = 0
  let measurements = 0
  return channels.map(({ name }) => {
    const target = name.startsWith('setpoint.')
    const i = target ? setpoints++ : measurements++
    // Setpoints use magenta (DESIGN.md:18). Dash patterns distinguish series sharing a colour.
    const dash = target ? i + 1 : Math.floor(i / palette.length)
    return { token: `--color-${target ? 'setpoint' : palette[i % palette.length]!}`, dash }
  })
}

function plotOptions(
  node: HTMLElement,
  channels: readonly PlotChannel[],
  width: number,
  height: number,
  hooks: uPlot.Options['hooks'],
): uPlot.Options {
  const style = getComputedStyle(node)
  const color = (name: string) => style.getPropertyValue(`--color-${name}`).trim()
  const font = `${style.fontSize} ${style.getPropertyValue('--font-mono').trim()}`
  const axis = { stroke: color('fg-muted'), font, labelFont: font, ticks: { stroke: color('line-strong') } }
  const grid = { stroke: color('line') }
  const axes = [...groupAxes(channels)]
  const scale = (unit: string) => `unit-${axes.findIndex(([key]) => key === unit)}`
  const styles = seriesStyles(channels)
  return {
    width, height, hooks,
    scales: { x: { time: false } },
    axes: [
      { ...axis, label: 'Time (s)', grid },
      ...axes.map(([unit, signals], i): uPlot.Axis => {
        const signal = signals.length === 1 ? signals[0] : undefined
        const categorical = signal && signal.kind !== 'number' ? signal : undefined
        return {
          ...axis, scale: scale(unit), side: i === 0 ? 3 : 1, label: unit, grid: { ...grid, show: i === 0 },
          values: categorical ? (_plot, ticks) => ticks.map((tick) => Number.isInteger(tick) ? valueLabel(categorical, tick) : '') : undefined,
        }
      }),
    ],
    legend: { show: false },
    cursor: {
      y: false,
      points: { show: false },
      drag: { x: true, y: false },
      bind: { dblclick: () => null },
    },
    series: [{}, ...channels.map((channel, index): uPlot.Series => {
      const { token, dash } = styles[index]!
      return {
        label: channel.label,
        scale: scale(channel.unit),
        stroke: style.getPropertyValue(token).trim(),
        dash: dash ? [dash, dash] : undefined,
        spanGaps: false,
        paths: channel.kind === 'number' ? undefined : uPlot.paths.stepped!({ align: 1 }),
      }
    })],
  }
}

interface GraphProps {
  title: string
  channels: readonly PlotChannel[]
  cursor: ReturnType<typeof createGraphCursor>
  series?: readonly RecordingSeries[]
  live?: LiveGraphSource
  range?: TimeRange
  zoomed?: boolean
  onWidth?: (width: number) => void
  onZoom?: (range?: TimeRange) => void
}

interface GraphRuntime {
  draw(series: readonly RecordingSeries[], range?: TimeRange): void
  times(): readonly number[]
}

const emptySeries: RecordingSeries[] = []

export function TelemetryGraph(props: GraphProps) {
  if (groupAxes(props.channels).size > MAX_AXES) {
    return <p role="status" className="text-warn">Move channels using a third unit to another graph.</p>
  }
  return <GraphPlot {...props} />
}

function GraphPlot({ title, channels, cursor, series = emptySeries, live, range, zoomed, onWidth, onZoom }: GraphProps) {
  const heading = useId()
  const instructions = useId()
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<GraphRuntime | null>(null)
  const anchor = useRef<number | null>(null)
  const [readout, setReadout] = useState<{ time: number; values: string[] } | null>(null)
  const reportWidth = useEffectEvent((width: number) => onWidth?.(width))
  const reportZoom = useEffectEvent((next: TimeRange) => onZoom?.(next))

  useEffect(() => {
    const node = host.current!
    let chart: uPlot | undefined
    let ordered = emptySeries
    let data = alignSamples([])
    let drawnRange: TimeRange | undefined

    function refresh(source?: uPlot) {
      if (!chart) return
      const time = cursor.get()
      const scale = chart.scales.x!
      const visible = time !== null && scale.min != null && scale.max != null && time >= scale.min && time <= scale.max
      if (source !== chart) chart.setCursor({ left: visible ? chart.valToPos(time, 'x') : -1, top: -1 }, false)
      setReadout(time === null ? null : {
        time,
        values: channels.map((channel, index) =>
          valueLabel(channel, visible ? pointAt(ordered[index]?.points ?? [], time, channel.kind !== 'number') : null)),
      })
    }

    function applyData() {
      if (!chart) return
      chart.batch(() => {
        chart!.setData(data)
        if (drawnRange && drawnRange.fromS < drawnRange.toS) {
          chart!.setScale('x', { min: drawnRange.fromS, max: drawnRange.toS })
        }
      })
      refresh()
    }

    runtime.current = {
      draw(next, visible) {
        const byName = new Map(next.map((item) => [item.channel, item]))
        ordered = channels.map(({ name }) => byName.get(name) ?? { channel: name, points: [] })
        data = alignSamples(ordered)
        drawnRange = visible
        applyData()
      },
      times: () => data[0],
    }

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry!.contentRect.width)
      const height = Math.floor(entry!.contentRect.height)
      if (width < 1 || height < 1) return
      if (chart) {
        if (chart.width !== width || chart.height !== height) {
          chart.setSize({ width, height })
          refresh()
        }
      } else {
        chart = new uPlot(plotOptions(node, channels, width, height, {
          setCursor: [(plot) => {
            const left = plot.cursor.left
            const next = left === undefined || left < 0 ? null : Math.max(0, plot.posToVal(left, 'x'))
            cursor.set(next !== null && Number.isFinite(next) ? next : null, plot)
          }],
          setSelect: [(plot) => {
            const { left, width: selected } = plot.select
            const fromS = Math.max(0, plot.posToVal(left, 'x'))
            const toS = plot.posToVal(left + selected, 'x')
            if (selected > 0 && Number.isFinite(fromS) && Number.isFinite(toS) && fromS < toS) reportZoom({ fromS, toS })
          }],
        }), data, node)
        applyData()
      }
      reportWidth(width)
    })
    observer.observe(node)
    const unsubscribe = cursor.subscribe(refresh)
    return () => {
      unsubscribe()
      observer.disconnect()
      chart?.destroy()
      runtime.current = null
    }
  }, [channels, cursor])

  useEffect(() => {
    if (!live) {
      runtime.current?.draw(series, range)
      return
    }
    const names = channels.map(({ name }) => name)
    let frame: number | undefined
    function schedule() {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        runtime.current?.draw(live!.read(names, range?.fromS ?? 0), range)
      })
    }
    const unsubscribe = live.subscribe(schedule)
    schedule()
    return () => {
      unsubscribe()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [channels, cursor, live, range, series])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const times = runtime.current?.times() ?? []
    const time = cursor.get()
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = time === null ? times[0] : event.key === 'ArrowRight'
        ? times.find((t) => t > time) : times.findLast((t) => t < time)
      if (next !== undefined) cursor.set(next)
    } else if (event.key === 'Enter' && onZoom && time !== null) {
      event.preventDefault()
      if (anchor.current === null) anchor.current = time
      else {
        const fromS = Math.min(anchor.current, time)
        const toS = Math.max(anchor.current, time)
        anchor.current = null
        if (fromS < toS) onZoom({ fromS, toS })
      }
    } else if (event.key === 'Escape') {
      anchor.current = null
      cursor.set(null)
    }
  }

  return (
    <section aria-labelledby={heading} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={heading} className="font-medium">{title}</h3>
        {onZoom && <Button size="sm" disabled={!zoomed} onClick={() => { anchor.current = null; onZoom() }}>Reset zoom</Button>}
      </div>
      <p id={instructions} className="sr-only">
        Use the left and right arrow keys to move the cursor.
        {onZoom && ' Press Enter at both ends of a time range to zoom.'}
      </p>
      <div ref={host} tabIndex={0} role="group" aria-labelledby={heading} aria-describedby={instructions}
        onKeyDown={onKeyDown} className="telemetry-plot h-64 w-full min-w-0 text-xs" />
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-x-4 gap-y-1 text-fg-muted">
        <div className="flex flex-wrap justify-between gap-x-2">
          <dt>Cursor time</dt><dd className="num text-fg">{readout ? `${readout.time} s` : '—'}</dd>
        </div>
        {seriesStyles(channels).map(({ token, dash }, i) => {
          const channel = channels[i]!
          const color = `var(${token})`
          const background = dash
            ? `repeating-linear-gradient(to right, ${color} 0 ${dash}px, transparent ${dash}px ${dash * 2}px)` : color
          return (
            <div key={channel.name} className="flex flex-wrap justify-between gap-x-2">
              <dt className="flex items-baseline gap-2">
                <span aria-hidden="true" className="h-px w-6 shrink-0 self-center" style={{ background }} />
                <span>{channel.label} ({channel.unit})</span>
              </dt>
              <dd className="num text-fg">{readout?.values[i] ?? '—'}</dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}
