import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent } from 'react'
import uPlot from 'uplot'
import type { RecordingSeries } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { groupAxes, MAX_AXES, type PlotChannel } from './layout'
import type { LiveData } from './live-buffer'
import { alignSamples, livePointIndex, pointAt, sampleValue, valueLabel, type TimeRange } from './samples'
import type { LiveGraphSource } from './use-live-telemetry'

export function createGraphCursor(retainOnLeave = false) {
  let time: number | null = null
  const listeners = new Set<(source?: uPlot) => void>()
  return {
    get: () => time,
    set(next: number | null, source?: uPlot) {
      if (retainOnLeave && next === null && source) return
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

export const comparisonChannelName = (name: string) => `comparison:${name}`

function seriesStyles(channels: readonly PlotChannel[], comparison: readonly PlotChannel[]) {
  const palette = ['fg', 'accent', 'fg-muted']
  let setpoints = 0
  let measurements = 0
  const primary = channels.map(({ name }) => {
    const target = name.startsWith('setpoint.')
    const i = target ? setpoints++ : measurements++
    // Setpoints use magenta (DESIGN.md:18). Dash patterns distinguish series sharing a colour.
    const dash = target ? i + 1 : Math.floor(i / palette.length)
    return { token: `--color-${target ? 'setpoint' : palette[i % palette.length]!}`, dash }
  })
  return [...primary, ...comparison.map(({ name }) => {
    const style = primary[channels.findIndex((channel) => channel.name === name)]!
    return { ...style, dash: style.dash + 2 }
  })]
}

function plotOptions(
  node: HTMLElement,
  channels: readonly PlotChannel[],
  comparison: readonly PlotChannel[],
  drawn: readonly PlotChannel[],
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
  const styles = seriesStyles(channels, comparison)
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
    series: [{}, ...drawn.map((channel, index): uPlot.Series => {
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
  comparison?: readonly PlotChannel[]
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
  times(): GraphTimes
}

interface GraphTimes {
  readonly [index: number]: number
  find(predicate: (time: number) => boolean): number | undefined
  findLast(predicate: (time: number) => boolean): number | undefined
}

type Readout = { time: number; values: string[] }
const emptySeries: RecordingSeries[] = []
const emptyChannels: PlotChannel[] = []

export function TelemetryGraph(props: GraphProps) {
  if (groupAxes(props.channels).size > MAX_AXES) {
    return <p role="status" className="text-warn">Move channels using a third unit to another graph.</p>
  }
  return <GraphPlot {...props} />
}

function GraphPlot({ title, channels, comparison = emptyChannels, cursor, series = emptySeries, live, range, zoomed, onWidth, onZoom }: GraphProps) {
  const heading = useId()
  const instructions = useId()
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<GraphRuntime | null>(null)
  const anchor = useRef<number | null>(null)
  const [readout, setReadout] = useState<Readout | null>(null)
  const lastLiveReadout = useRef<Readout | null>(null)
  const reportWidth = useEffectEvent((width: number) => onWidth?.(width))
  const reportZoom = useEffectEvent((next: TimeRange) => onZoom?.(next))

  useEffect(() => {
    const node = host.current!
    const drawn = [...channels, ...comparison.map((channel) => ({
      ...channel, name: comparisonChannelName(channel.name), label: `${channel.label} · comparison`,
    }))]
    const hasStepped = live && drawn.some(({ kind }) => kind !== 'number')
    let chart: uPlot | undefined
    let ordered = emptySeries
    let data: ReturnType<typeof alignSamples> = [[]]
    let drawnRange: TimeRange | undefined
    let liveData: LiveData | undefined
    let drawingLive = false

    function refresh(source?: uPlot) {
      if (!chart) return
      const time = cursor.get()
      const scale = chart.scales.x!
      const visible = time !== null && scale.min != null && scale.max != null && time >= scale.min && time <= scale.max
      if (source !== chart) {
        const left = visible ? chart.valToPos(time, 'x') : -1
        if (!live || chart.cursor.left !== left) chart.setCursor({ left, top: -1 }, false)
      }
      if (live) {
        const previous = lastLiveReadout.current
        if (time === null) {
          if (previous) setReadout(lastLiveReadout.current = null)
          return
        }
        const times = liveData?.[0]
        const nearest = visible && times ? livePointIndex(times, time, false) : -1
        const stepped = hasStepped && visible && times ? livePointIndex(times, time, true) : -1
        let values = previous?.values
        if (values?.length !== drawn.length) values = new Array<string>(drawn.length)
        for (let i = 0; i < drawn.length; i++) {
          const channel = drawn[i]!
          const index = channel.kind === 'number' ? nearest : stepped
          const value = valueLabel(channel, sampleValue(liveData?.[i + 1]?.[index]))
          if (values[i] === value) continue
          if (values === previous?.values) values = values.slice()
          values[i] = value
        }
        if (time !== previous?.time || values !== previous.values) {
          setReadout(lastLiveReadout.current = { time, values })
        }
        return
      }
      setReadout(time === null ? null : {
        time,
        values: drawn.map((channel, index) =>
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
        ordered = drawn.map(({ name }) => byName.get(name) ?? { channel: name, points: [] })
        data = alignSamples(ordered)
        drawnRange = visible
        applyData()
      },
      times: () => liveData?.[0] ?? data[0],
    }

    let width = 0
    let height = 0
    let hasLatest = false
    const bounds = { min: 0, max: 0 }
    const size = { width: 0, height: 0 }
    function applyLiveData(plot: uPlot) {
      if (plot.width !== width || plot.height !== height) {
        size.width = width
        size.height = height
        plot.setSize(size)
      }
      plot.setData(liveData!, !hasLatest)
      if (hasLatest) plot.setScale('x', bounds)
    }

    function createChart(bounds?: { min: number; max: number }) {
      const options = plotOptions(node, channels, comparison, drawn, width, height, {
        ready: live ? [() => {
          drawingLive = false
          refresh()
        }] : undefined,
        setCursor: [(plot) => {
          if (drawingLive) return
          const left = plot.cursor.left
          const next = left === undefined || left < 0 ? null : plot.posToVal(left, 'x')
          cursor.set(next !== null && Number.isFinite(next) ? next : null, plot)
        }],
        setSelect: [(plot) => {
          const { left, width: selected } = plot.select
          const fromS = plot.posToVal(left, 'x')
          const toS = plot.posToVal(left + selected, 'x')
          if (selected > 0 && Number.isFinite(fromS) && Number.isFinite(toS) && fromS < toS) reportZoom({ fromS, toS })
        }],
      })
      if (live) {
        Object.assign(options.scales!.x!, bounds)
        options.cursor!.drag = { x: false, y: false }
      }
      return new uPlot(options, liveData ?? data, node)
    }

    const readLive = live?.createReader(drawn.map(({ name }) => name))
    const subscription = live?.subscribe(() => {
      if (!readLive || document.hidden || !node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return
      liveData = readLive()
      const latest = liveData[0].at(-1)
      hasLatest = latest !== undefined
      if (latest !== undefined) {
        bounds.min = latest - live.durationS
        bounds.max = latest
      }
      drawingLive = true
      if (!chart) {
        chart = createChart(hasLatest ? bounds : undefined)
        return
      }
      chart.batch(applyLiveData)
      drawingLive = false
      refresh()
    })
    const updateVisibility = () => subscription?.setVisible(!document.hidden && width > 0 && height > 0)
    if (subscription) document.addEventListener('visibilitychange', updateVisibility)

    const observer = new ResizeObserver(([entry]) => {
      width = Math.floor(entry!.contentRect.width)
      height = Math.floor(entry!.contentRect.height)
      if (subscription) {
        updateVisibility()
        if (width < 1 || height < 1) return
      } else if (width < 1 || height < 1) return
      else if (chart) {
        if (chart.width !== width || chart.height !== height) {
          chart.setSize({ width, height })
          refresh()
        }
      } else {
        chart = createChart()
        applyData()
      }
      reportWidth(width)
    })
    observer.observe(node)
    const unsubscribe = cursor.subscribe(refresh)
    return () => {
      unsubscribe()
      subscription?.unsubscribe()
      if (subscription) document.removeEventListener('visibilitychange', updateVisibility)
      observer.disconnect()
      chart?.destroy()
      runtime.current = null
    }
  }, [channels, comparison, cursor, live])

  useEffect(() => {
    if (!live) runtime.current?.draw(series, range)
  }, [channels, comparison, cursor, live, range, series])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const times: GraphTimes = runtime.current?.times() ?? []
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
        {seriesStyles(channels, comparison).map(({ token, dash }, i) => {
          const channel = i < channels.length ? channels[i]! : comparison[i - channels.length]!
          const color = `var(${token})`
          const background = dash
            ? `repeating-linear-gradient(to right, ${color} 0 ${dash}px, transparent ${dash}px ${dash * 2}px)` : color
          return (
            <div key={i < channels.length ? channel.name : comparisonChannelName(channel.name)} className="flex flex-wrap justify-between gap-x-2">
              <dt className="flex items-baseline gap-2">
                <span aria-hidden="true" className="h-px w-6 shrink-0 self-center" style={{ background }} />
                <span>{channel.label}{i >= channels.length && ' · comparison'} ({channel.unit})</span>
              </dt>
              <dd className="num text-fg">{readout?.values[i] ?? '—'}</dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}
