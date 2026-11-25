import { useEffect, useMemo, useState } from 'react'
import type { DesktopApi, RecordingRun, RecordingSampleQuery, RecordingSeries, RecordingSummary } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { readTelemetryLayout, writeTelemetryLayout } from '@/lib/prefs'
import { ChannelPicker, fieldClass } from './ChannelPicker'
import { describeChannel, groupAxes, MAX_AXES, STARTER_LAYOUTS, starterLayout, type PlotChannel, type TelemetryGraphLayout, type TelemetryLayout } from './layout'
import { comparisonOffset, intersectRanges, recordingRange, sampleQuery, shiftedRange, type TimeRange } from './samples'
import { comparisonChannelName, createGraphCursor, TelemetryGraph } from './TelemetryGraph'
import { ReplayPanel } from './ReplayPanel'
import { VerifyPanel } from './VerifyPanel'

type RecordingApi = NonNullable<DesktopApi['recording']>

// Match the existing debounced scheduling interval (workshop/assembly-store.ts:49).
const ZOOM_DEBOUNCE_MS = 500

interface Comparison {
  id: string
  range: TimeRange
  offset: number
  channels: readonly PlotChannel[]
}

interface RecordedGraphProps {
  id: string
  title: string
  channels: readonly PlotChannel[]
  cursor: ReturnType<typeof createGraphCursor>
  fullRange?: TimeRange
  primaryRange?: TimeRange
  primaryChannels: readonly PlotChannel[]
  comparison?: Comparison
  api: RecordingApi
}

function RecordedGraph({ id, title, channels, cursor, fullRange, primaryRange, primaryChannels, comparison, api }: RecordedGraphProps) {
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<TimeRange>()
  const visible = zoom && fullRange ? intersectRanges(zoom, fullRange) ?? fullRange : fullRange
  const primary = useMemo(() => channels.filter((channel) => primaryChannels.some(({ name }) => name === channel.name)), [channels, primaryChannels])
  const overlay = useMemo(() => channels.filter((channel) => comparison?.channels.some(
    ({ name, unit }) => name === channel.name && unit === channel.unit,
  )), [channels, comparison])
  const query = useMemo(() => {
    const range = zoom && primaryRange ? intersectRanges(zoom, primaryRange) : primaryRange
    return range && sampleQuery(id, primary.map(({ name }) => name), width, range)
  }, [id, primary, primaryRange, width, zoom])
  const comparisonQuery = useMemo(() => {
    if (!comparison) return
    const range = zoom ? intersectRanges(shiftedRange(zoom, -comparison.offset), comparison.range) : comparison.range
    return range && sampleQuery(comparison.id, overlay.map(({ name }) => name), width, range)
  }, [comparison, overlay, width, zoom])

  const result = useRecordingQuery(api, query, !!zoom)
  const compared = useRecordingQuery(api, comparisonQuery, !!zoom)
  const offset = comparison?.offset ?? 0
  const series = useMemo(() => [...(result?.series ?? []), ...(compared?.series ?? []).map(({ channel, points }) => ({
    channel: comparisonChannelName(channel),
    points: points.map(({ timeS, value }) => ({ timeS: timeS + offset, value })),
  }))], [compared, offset, result])

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
      <TelemetryGraph title={title} channels={channels} comparison={overlay} cursor={cursor} series={series}
        range={visible} zoomed={!!zoom} onZoom={fullRange ? changeZoom : undefined} onWidth={setWidth} />
      {zoom && <p className="num text-fg-muted" aria-label="Visible time range">{zoom.fromS}–{zoom.toS} s</p>}
      {result?.error && <p role="alert" className="text-fault">{result.error}</p>}
      {compared?.error && <p role="alert" className="text-fault">Comparison · {compared.error}</p>}
      {compared?.integrityError && <p className="text-warn">Comparison · {compared.integrityError}</p>}
      {(query && !result || comparisonQuery && !compared) && <p role="status" className="text-fg-muted">Loading samples…</p>}
      {series.length > 0 && series.every(({ points }) => !points.length) && <p className="text-fg-muted">No samples in this range.</p>}
    </>
  )
}

function useRecordingQuery(api: RecordingApi, query: RecordingSampleQuery | undefined, zoomed: boolean) {
  const [result, setResult] = useState<{ query: RecordingSampleQuery; series?: RecordingSeries[]; integrityError?: string | null; error?: string }>()
  useEffect(() => {
    if (!query) return
    let stale = false
    const timer = setTimeout(() => {
      void api.readSamples(query).then(
        (answer) => { if (!stale) setResult(answer.ok ? { query, ...answer.data } : { query, error: answer.error.message }) },
        (error: unknown) => { if (!stale) setResult({ query, error: String(error) }) },
      )
    }, zoomed ? ZOOM_DEBOUNCE_MS : 0)
    return () => { stale = true; clearTimeout(timer) }
  }, [api, query, zoomed])
  return result?.query === query ? result : undefined
}

function GraphEditor({ id, graph, index, api, available, cursor, fullRange, primaryRange, primaryChannels, comparison, onChannels, onRemove }: {
  id: string
  graph: TelemetryGraphLayout
  index: number
  api: RecordingApi
  available: readonly PlotChannel[]
  cursor: RecordedGraphProps['cursor']
  fullRange?: TimeRange
  primaryRange?: TimeRange
  primaryChannels: readonly PlotChannel[]
  comparison?: Comparison
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
        <RecordedGraph id={id} api={api} title={title} channels={selected} cursor={cursor} fullRange={fullRange}
          primaryRange={primaryRange} primaryChannels={primaryChannels} comparison={comparison} />
      )}
      {missing.length > 0 && <p className="break-words text-warn">Not in this run · {missing.join(', ')}</p>}
      <ChannelPicker available={available} selected={graph.channels} onChange={onChannels} />
      <Button size="sm" variant="ghost" className="justify-self-start" onClick={onRemove}>Remove graph</Button>
    </article>
  )
}

export function RunGraphs({ id, summary, api, runs }: { id: string; summary: RecordingSummary; api: RecordingApi; runs: readonly RecordingRun[] }) {
  const header = summary.header
  const primary = useMemo(() => header?.channels.map(describeChannel) ?? [], [header])
  const primaryRange = useMemo(() => header ? recordingRange(header, summary.sampleCount) : undefined, [header, summary.sampleCount])
  const [cursor] = useState(() => {
    const cursor = createGraphCursor(true)
    if (primaryRange) cursor.set(primaryRange.fromS)
    return cursor
  })
  const [layout, setLayout] = useState(() => readTelemetryLayout() ?? starterLayout(0, primary))
  const [comparisonId, setComparisonId] = useState('')
  const [compared, setCompared] = useState<{ id: string; summary?: RecordingSummary; error?: string }>()
  const [alignMoments, setAlignMoments] = useState(false)
  const [primaryMoment, setPrimaryMoment] = useState<number>()
  const [comparisonMoment, setComparisonMoment] = useState<number>()

  useEffect(() => {
    if (!comparisonId) return
    let current = true
    void api.summary(comparisonId).then(
      (answer) => {
        if (current) setCompared(answer.ok ? { id: comparisonId, summary: answer.data } : { id: comparisonId, error: answer.error.message })
      },
      (error: unknown) => { if (current) setCompared({ id: comparisonId, error: String(error) }) },
    )
    return () => { current = false }
  }, [api, comparisonId])

  const peer = compared?.id === comparisonId ? compared.summary : undefined
  const peerRange = useMemo(() => peer?.header ? recordingRange(peer.header, peer.sampleCount) : undefined, [peer])
  const peerChannels = useMemo(() => peer?.header?.channels.map(describeChannel) ?? [], [peer])
  const comparison = useMemo(() => {
    if (!peerRange || !primaryRange) return
    const anchors = alignMoments ? { primaryS: primaryMoment ?? primaryRange.fromS, comparisonS: comparisonMoment ?? peerRange.fromS } : undefined
    return { id: comparisonId, range: peerRange, offset: comparisonOffset(primaryRange, peerRange, anchors), channels: peerChannels }
  }, [alignMoments, comparisonId, comparisonMoment, peerChannels, peerRange, primaryMoment, primaryRange])
  const fullRange = useMemo(() => {
    if (!comparison || !primaryRange) return primaryRange
    const shifted = shiftedRange(comparison.range, comparison.offset)
    return { fromS: Math.min(primaryRange.fromS, shifted.fromS), toS: Math.max(primaryRange.toS, shifted.toS) }
  }, [comparison, primaryRange])
  const available = useMemo(() => [...primary, ...peerChannels.filter((channel) => !primary.some(({ name }) => name === channel.name))], [peerChannels, primary])
  const missing = (from: PlotChannel[], other: PlotChannel[]) => from.filter(
    (channel) => !other.some(({ name, unit }) => name === channel.name && unit === channel.unit),
  ).map(({ name }) => name).join(', ')

  function update(next: TelemetryLayout) {
    setLayout(next)
    writeTelemetryLayout(next)
  }

  return (
    <>
    {header && <ReplayPanel id={id} header={header} count={summary.sampleCount} api={api} cursor={cursor} />}
    <VerifyPanel id={id} api={api} />
    <section aria-label="Telemetry layout" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Graphs</h2>
        <select aria-label="Starting layout" className={fieldClass} value="" onChange={(event) => {
          if (event.target.value !== '') {
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
      <div className="grid gap-2">
        <label className="flex flex-wrap items-center gap-2">Compare with
          <select className={fieldClass} value={comparisonId} onChange={(event) => {
            setComparisonId(event.target.value)
            setPrimaryMoment(undefined)
            setComparisonMoment(undefined)
          }}>
            <option value="">Choose another run</option>
            {runs.filter((run) => run.id !== id && run.fileName && !run.fileMissing && !run.open).map((run) =>
              <option key={run.id} value={run.id}>{run.title ?? run.projectName} · {new Date(run.startedAt).toLocaleString()}</option>,
            )}
          </select>
        </label>
        {comparisonId && compared?.id !== comparisonId && <p role="status">Loading comparison…</p>}
        {compared?.id === comparisonId && compared.error && <p role="alert" className="text-fault">{compared.error}</p>}
        {peer && !peerRange && <p className="text-warn">The comparison run has no samples.</p>}
        {comparison && primaryRange && peerRange && <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-wrap items-center gap-2">Align by
              <select className={fieldClass} value={alignMoments ? 'moments' : 'start'} onChange={(event) => setAlignMoments(event.target.value === 'moments')}>
                <option value="start">Run start</option>
                <option value="moments">Selected moments</option>
              </select>
            </label>
            {alignMoments && <>
              <Moment label="Primary moment (s)" range={primaryRange} value={primaryMoment} change={setPrimaryMoment} />
              <Moment label="Comparison moment (s)" range={peerRange} value={comparisonMoment} change={setComparisonMoment} />
            </>}
          </div>
          <p className="break-words text-fg-muted">Missing from primary · {missing(peerChannels, primary) || 'None'}</p>
          <p className="break-words text-fg-muted">Missing from comparison · {missing(primary, peerChannels) || 'None'}</p>
        </>}
      </div>
      {!fullRange && <p className="text-fg-muted">This recording has no samples.</p>}
      {layout.graphs.map((graph, index) => (
        <GraphEditor key={graph.id} id={id} index={index} graph={graph} api={api} available={available} cursor={cursor} fullRange={fullRange}
          primaryRange={primaryRange} primaryChannels={primary} comparison={comparison}
          onChannels={(channels) => update({ graphs: layout.graphs.map((item) => item === graph ? { ...item, channels } : item) })}
          onRemove={() => update({ graphs: layout.graphs.filter((item) => item !== graph) })} />
      ))}
    </section>
    </>
  )
}

function Moment({ label, range, value, change }: { label: string; range: TimeRange; value?: number; change(value: number): void }) {
  return <label className="flex flex-wrap items-center gap-2">{label}
    <input className={fieldClass} type="range" min={range.fromS} max={range.toS} step="any" value={value ?? range.fromS}
      onChange={(event) => change(Number(event.target.value))} />
    <output className="num">{(value ?? range.fromS).toFixed(3)}</output>
  </label>
}
