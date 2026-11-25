import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { DesktopApi, RecordingHeader, RecordingSampleWindow } from '../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import { FlightViewport } from '../flight/FlightViewport'
import { recordedBuild, replayFrame, replayIndexAt, replayTimeAt, replayWindowAt, REPLAY_POSE_CHANNELS } from '../flight/replay-frame'
import { fieldClass } from './ChannelPicker'
import type { createGraphCursor } from './TelemetryGraph'
import { ReplayEnvironment, ReplayModel } from './ReplayScene'

const SPEEDS = [0.25, 0.5, 1, 2, 4]
type RecordingApi = NonNullable<DesktopApi['recording']>

export function ReplayPanel({ id, header, count, api, cursor }: {
  id: string; header: RecordingHeader; count: number; api: RecordingApi; cursor: ReturnType<typeof createGraphCursor>
}) {
  const cursorTime = useSyncExternalStore(cursor.subscribe, cursor.get)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loaded, setLoaded] = useState<{ first: number; data?: RecordingSampleWindow; error?: string }>()
  const build = useMemo(() => {
    try {
      return recordedBuild(header)
    } catch {
      return undefined
    }
  }, [header])
  const scene = useMemo(() => {
    if (!build) return
    const { vehicle, environment } = build
    // Same framing as flight/camera-view.ts:24–26, using the recorded motor radii.
    const distanceM = Math.max(1.2, ...vehicle.motors.map(({ position: [x, y] }) => 6 * Math.hypot(x, y)))
    return {
      model: <ReplayModel vehicle={vehicle} />, environment: <ReplayEnvironment environment={environment} />,
      follow: { distanceM, heightM: distanceM * 0.7, fovDeg: 45 },
    }
  }, [build])
  const hasPose = REPLAY_POSE_CHANNELS.every((name) => header.channels.some((channel) => channel.name === name))
  const firstS = replayTimeAt(header, 0)
  const lastS = replayTimeAt(header, Math.max(0, count - 1))
  const timeS = Math.min(lastS, Math.max(firstS, cursorTime ?? firstS))
  const index = replayIndexAt(header, count, timeS)
  const { first, fromS, toS } = replayWindowAt(header, count, index)

  useEffect(() => {
    if (!count || !scene || !hasPose) return
    let current = true
    void api.readSamples({ id, channels: REPLAY_POSE_CHANNELS, fromS, toS }).then(
      (answer) => {
        if (current) setLoaded(answer.ok ? { first, data: answer.data } : { first, error: answer.error.message })
      },
      (error: unknown) => { if (current) setLoaded({ first, error: String(error) }) },
    )
    return () => { current = false }
  }, [api, count, first, fromS, hasPose, id, scene, toS])

  useEffect(() => {
    if (!playing) return
    let frame: number
    let lastMs = performance.now()
    function tick(now: number) {
      const at = Math.min(lastS, Math.max(firstS, cursor.get() ?? firstS))
      const next = Math.min(lastS, at + (now - lastMs) / 1000 * speed)
      lastMs = now
      cursor.set(next)
      if (next >= lastS) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [cursor, firstS, lastS, playing, speed])

  function skip(by: number) {
    setPlaying(false)
    cursor.set(replayTimeAt(header, Math.max(0, Math.min(count - 1, index + by))))
  }

  const series = loaded?.data?.series
  const row = loaded && series ? Math.max(0, Math.min(index - loaded.first, (series[0]?.points.length ?? 0) - 1)) : 0
  const frame = build && series ? replayFrame(series, row, build.vehicle) : undefined
  const transportReady = count > 0

  return <section aria-label="Recording replay" className="grid gap-2">
    <h3 className="font-semibold">Replay</h3>
    {scene && frame && <div className="h-80 overflow-hidden rounded-md border border-line">
      <FlightViewport frame={frame} replay={scene} running={playing} />
    </div>}
    {!scene ? <p className="text-warn">The recorded vehicle build is unavailable.</p>
      : !hasPose || !count ? <p className="text-fg-muted">This run has no recorded 3D pose samples.</p>
      : !frame && !loaded?.error && <p role="status" className="text-fg-muted">{loaded ? 'No recorded pose at this sample.' : 'Loading replay pose…'}</p>}
    {loaded?.error && <p role="alert" className="text-fault">{loaded.error}</p>}
    {loaded?.data?.integrityError && <p className="text-warn">Replay ends at the last intact sample.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={count < 2} onClick={() => {
        if (playing) setPlaying(false)
        else {
          if (cursorTime === null || timeS >= lastS) cursor.set(firstS)
          setPlaying(true)
        }
      }}>{playing ? 'Pause' : 'Play'}</Button>
      <Button size="sm" disabled={!transportReady || index === 0} onClick={() => skip(-1)}>Previous sample</Button>
      <Button size="sm" disabled={!transportReady || index >= count - 1} onClick={() => skip(1)}>Next sample</Button>
      <label className="flex items-center gap-2">Speed
        <select className={fieldClass} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <output className="num" aria-label="Replay time">{timeS.toFixed(3)} s</output>
    </div>
    <input type="range" className="w-full" aria-label="Replay position" min={firstS} max={lastS} step="any" value={timeS}
      disabled={count < 2} onChange={(event) => { setPlaying(false); cursor.set(Number(event.target.value)) }} />
    {transportReady && <p className="text-fg-muted">
      Replay holds each sample until the next ({Number((1 / (header.samplePeriodSteps * header.stepLengthS)).toPrecision(6))} Hz).
      {scene && hasPose && ' The saved build contains collision shapes, so the viewport uses those for its parts.'}
    </p>}
  </section>
}
