import { useEffect, useMemo, useState } from 'react'
import type { DesktopApi, RecordingSeries, RecordingSummary } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { readTelemetryLayout, writeTelemetryLayout } from '@/lib/prefs'
import { ChannelPicker, fieldClass } from './ChannelPicker'
import { describeChannel, groupAxes, MAX_AXES, STARTER_LAYOUTS, starterLayout, type PlotChannel, type TelemetryGraphLayout, type TelemetryLayout } from './layout'
import { recordingRange, sampleQuery, type TimeRange } from './samples'
import { createGraphCursor, TelemetryGraph } from './TelemetryGraph'

type RecordingApi = NonNullable<DesktopApi['recording']>

// Match the existing debounced scheduling interval (workshop/assembly-store.ts:49).
const ZOOM_DEBOUNCE_MS = 500

interface RecordedGraphProps {
  id: string
  title: string
  channels: readonly PlotChannel[]
  cursor: ReturnType<typeof createGraphCursor>
  fullRange?: TimeRange
  api: RecordingApi
}

function RecordedGraph({ id, title, channels, cursor, fullRange, api }: RecordedGraphProps) {
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<TimeRange>()
  const [result, setResult] = useState<{ series?: RecordingSeries[]; error?: string }>()
  const query = useMemo(() => fullRange && sampleQuery(id, channels.map(({ name }) => name), width, zoom),
    [id, channels, width, fullRange, zoom])

  useEffect(() => {
    if (!query) return
    let stale = false
    const timer = setTimeout(() => {
      api.readSamples(query).then(
        (answer) => {
          if (stale) return
          setResult(answer.ok ? { series: answer.data } : { error: answer.error.message })
        },
        (error: unknown) => { if (!stale) setResult({ error: String(error) }) },
      )
    }, zoom ? ZOOM_DEBOUNCE_MS : 0)
    return () => { stale = true; clearTimeout(timer) }
  }, [api, query, zoom])

  function changeZoom(next?: TimeRange) {
    if (!next) {
      setZoom(undefined)
      return
    }
    if (!fullRange) return
    const fromS = Math.max(fullRange.fromS, next.fromS)
    const toS = Math.min(fullRange.toS, next.toS)
    if (fromS < toS) setZoom({ fromS, toS })
  }

  return (
    <>
      <TelemetryGraph title={title} channels={channels} cursor={cursor} series={result?.series}
        range={zoom ?? fullRange} zoomed={!!zoom} onZoom={fullRange ? changeZoom : undefined} onWidth={setWidth} />
      {zoom && <p className="num text-fg-muted" aria-label="Visible time range">{zoom.fromS}–{zoom.toS} s</p>}
      {result?.error && <p role="alert" className="text-fault">{result.error}</p>}
      {fullRange && !result && <p role="status" className="text-fg-muted">Loading samples…</p>}
      {result?.series?.every(({ points }) => !points.length) && <p className="text-fg-muted">No samples in this range.</p>}
    </>
  )
}

function GraphEditor({ id, graph, index, api, available, cursor, fullRange, onChannels, onRemove }: {
  id: string
  graph: TelemetryGraphLayout
  index: number
  api: RecordingApi
  available: readonly PlotChannel[]
  cursor: RecordedGraphProps['cursor']
  fullRange?: TimeRange
  onChannels: (channels: string[]) => void
  onRemove: () => void
}) {
  const selected = useMemo(() => {
    const byName = new Map(available.map((channel) => [channel.name, channel]))
    return graph.channels.flatMap((name) => byName.get(name) ?? [])
  }, [available, graph.channels])
  const missing = graph.channels.filter((name) => !selected.some((channel) => channel.name === name))
  const title = `Graph ${index + 1}`
  return (
    <article aria-label={title} className="grid min-w-0 gap-3 rounded-md border border-line bg-raised p-3">
      {selected.length === 0 ? (
        <div><h3 className="font-medium">{title}</h3><p className="text-fg-muted">Choose channels to plot.</p></div>
      ) : groupAxes(selected).size > MAX_AXES ? (
        <div><h3 className="font-medium">{title}</h3><p role="status" className="text-warn">Move channels using a third unit to another graph.</p></div>
      ) : (
        <RecordedGraph id={id} api={api} title={title} channels={selected} cursor={cursor} fullRange={fullRange} />
      )}
      {missing.length > 0 && <p className="break-words text-warn">Not in this run · {missing.join(', ')}</p>}
      <ChannelPicker available={available} selected={graph.channels} onChange={onChannels} />
      <Button size="sm" variant="ghost" className="justify-self-start" onClick={onRemove}>Remove graph</Button>
    </article>
  )
}

export function RunGraphs({ id, summary, api }: { id: string; summary: RecordingSummary; api: RecordingApi }) {
  const [cursor] = useState(createGraphCursor)
  const header = summary.header
  const available = useMemo(() => header?.channels.map(describeChannel) ?? [], [header])
  const fullRange = useMemo(() => header ? recordingRange(header, summary.sampleCount) : undefined, [header, summary.sampleCount])
  const [layout, setLayout] = useState(() => readTelemetryLayout() ?? starterLayout(0, available))

  function update(next: TelemetryLayout) {
    setLayout(next)
    writeTelemetryLayout(next)
  }

  return (
    <section aria-label="Telemetry layout" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Graphs</h2>
        <select aria-label="Starting layout" className={fieldClass} value="" onChange={(event) => {
          if (event.target.value !== '') {
            cursor.set(null)
            update(starterLayout(Number(event.target.value), available))
          }
        }}>
          <option value="">Choose a starting layout</option>
          {STARTER_LAYOUTS.map(({ name }, i) => <option key={name} value={i}>{name}</option>)}
        </select>
        <Button size="sm" onClick={() => update({ graphs: [...layout.graphs, { id: crypto.randomUUID(), channels: [] }] })}>
          Add graph
        </Button>
      </div>
      {!fullRange && <p className="text-fg-muted">This recording has no samples.</p>}
      {layout.graphs.map((graph, index) => (
        <GraphEditor key={graph.id} id={id} index={index} graph={graph} api={api} available={available} cursor={cursor} fullRange={fullRange}
          onChannels={(channels) => update({ graphs: layout.graphs.map((item) => item === graph ? { ...item, channels } : item) })}
          onRemove={() => update({ graphs: layout.graphs.filter((item) => item !== graph) })} />
      ))}
    </section>
  )
}
