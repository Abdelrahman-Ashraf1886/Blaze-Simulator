import type { RecordingChannel, RecordingSeries } from '../../../../electron/ipc/contract'
import { reportGraphWidth, reportPlots } from './report-data'

export function reportNumber(value: number) {
  // Match the instrument numeric typography in DESIGN.md:20–22.
  return new Intl.NumberFormat('en', { maximumSignificantDigits: 6 }).format(value)
}

type Signal = RecordingSeries & RecordingChannel

function Plot({ title, series }: { title: string; series: Signal[] }) {
  const width = reportGraphWidth
  const height = width / 4
  const points = series.flatMap((line) => line.points)
  const valid = points.filter(({ value }) => value !== null && Number.isFinite(value))
  if (!valid.length) return null
  const minT = Math.min(...points.map(({ timeS }) => timeS))
  const maxT = Math.max(...points.map(({ timeS }) => timeS))
  const minY = Math.min(...valid.map(({ value }) => value!))
  const maxY = Math.max(...valid.map(({ value }) => value!))
  const scale = (v: number, min: number, max: number) =>
    min === max ? 0.5 : Number.isFinite(max - min) ? (v - min) / (max - min) : (v / 2 - min / 2) / (max / 2 - min / 2)
  return (
    <figure className="report-figure">
      <figcaption className="font-medium">{title} ({series[0]!.unit})</figcaption>
      <div className="report-chart-edge num"><span>{reportNumber(maxY)}</span><span>{reportNumber(minY)}</span></div>
      <svg className="report-plot" viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label={title + ' over simulated time'}>
        {series.map(({ channel, points: line }) => {
          let connected = false
          const target = channel.startsWith('setpoint.') || channel === 'stepTest.setpoint'
          const coordinates = line.map(({ timeS, value }) => {
            if (value === null || !Number.isFinite(value)) {
              connected = false
              return null
            }
            const x = scale(timeS, minT, maxT) * width
            const y = (1 - scale(value, minY, maxY)) * height
            const point = { timeS, x, y, command: connected ? 'L' : 'M' }
            connected = true
            return point
          })
          const path = coordinates.flatMap((p) => p ? [p.command + p.x + ' ' + p.y] : []).join(' ')
          return (
            <g key={channel} className={target ? 'report-target' : undefined} fill="none" stroke="currentColor">
              <path d={path} vectorEffect="non-scaling-stroke" />
              {coordinates.map((p, i) => p && p.command === 'M' && coordinates[i + 1]?.command !== 'L'
                ? <circle key={p.timeS} cx={p.x} cy={p.y} r={2} fill="currentColor" /> : null)}
            </g>
          )
        })}
      </svg>
      <div className="report-chart-time num"><span>{reportNumber(minT)} s</span><span>{reportNumber(maxT)} s</span></div>
      <ul className="report-legend">
        {series.map(({ name, label }) => <li key={name}>{label}</li>)}
      </ul>
    </figure>
  )
}

export function ReportGraphs({ channels, graphs }: { channels: readonly RecordingChannel[]; graphs: RecordingSeries[] }) {
  const signals = new Map(graphs.flatMap((series) => {
    const channel = channels.find(({ name }) => name === series.channel)
    return channel ? [[channel.name, { ...channel, ...series }] as const] : []
  }))
  const available = reportPlots.flatMap(([title, ...names]) => {
    const series = names.flatMap((name) => {
      const signal = signals.get(name)
      return signal?.points.some(({ value }) => value !== null && Number.isFinite(value)) ? [signal] : []
    })
    return series.length ? [{ title, series }] : []
  })
  return available.length ? (
    <div className="report-figures">{available.map((plot) => <Plot key={plot.title} {...plot} />)}</div>
  ) : <p>No graph samples recorded for these signals.</p>
}
