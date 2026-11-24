import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import type { AssemblyDocument, Project } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { effectiveParams, type TuningOverrides } from '@/domain/controller-params'
import { runChecks } from '@/domain/checks'
import { getApi } from '@/services/api'
import { useProjects } from '@/stores/projects'
import { useComponents } from '@/stores/components'
import { useSystem } from '@/stores/system'
import { buildFrame, type FrameGeometry } from '@/three/frame-geometry'
import { useAssembly } from '../workshop/assembly-store'
import { useAssets } from '../workshop/asset-store'
import { useComponentIndex } from '../workshop/component-index'
import { checkInput } from '../workshop/check-input'
import { resolveLinks, type ComponentIndex } from '../workshop/links'
import { massState, type MassState } from '../workshop/mass-input'
import { useWorkshopView } from '../workshop/view-store'
import { DebugPanel, endReason } from './DebugPanel'
import { EngineFlightSource, idleFrame } from './EngineFlightSource'
import { FlightSetup } from './FlightSetup'
import { FlightViewport } from './FlightViewport'
import type { FlightFrame, FlightMode } from './frame'
import { FLIGHT_MODE_LABELS, flightStartWithTuning } from './flight-mode'
import { FlightModeStatus } from './FlightModeStatus'
import { assemblyThrust, collisionIndicator, instabilityIndicator, layoutIndicator, massIndicator } from './indicators'
import { conditionsOf, EMPTY_CONDITIONS, enginePayload, flightGate, type FlightConditions } from './readiness'
import { mapPx4Sticks, mapSticks, STICK_KEYS, updateHeadingHold, type HeadingHold } from './sticks'

export default function FlightPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)
  useEffect(() => { void useProjects.getState().load() }, [])
  if (!projectId) return <>
    <PageHeader title="Flight test" />
    <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
      <Section title="Open a project" count={projects.length}>
        {error ? <EmptyState>{error}</EmptyState> : projects.length === 0 ? <EmptyState>{loading ? 'Loading…' : 'No projects yet. Create one on the Dashboard.'}</EmptyState> :
          <ul className="border-t border-line">{projects.map((p) => <li key={p.id} className="border-b border-line/60"><Link to={`/flight/${p.id}`} className="block py-2 text-[13px] hover:text-accent">{p.name}</Link></li>)}</ul>}
      </Section>
    </div>
  </>
  const project = projects.find((p) => p.id === projectId)
  if (!project) return <EmptyState>{error ?? (loading ? 'Loading…' : 'This project no longer exists.')}</EmptyState>
  return <LoadFlight key={project.id} project={project} />
}

function LoadFlight({ project }: { project: Project }) {
  const doc = useAssembly((s) => s.projectId === project.id ? s.doc : null)
  const assemblyError = useAssembly((s) => s.error)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      // Preserve pending workshop edits before switching the shared assembly store.
      await useAssembly.getState().flush()
      if (useAssembly.getState().projectId !== project.id || !useAssembly.getState().doc) await useAssembly.getState().load(project.id)
      await Promise.all([useComponents.getState().load(), useAssets.getState().load()])
      if (useComponents.getState().error) throw new Error(useComponents.getState().error!)
      if (alive) setReady(true)
    }
    void load().catch((e: unknown) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [project.id])
  const geo = useMemo(() => doc ? buildFrame(project.frameType, doc.frame, doc.motors) : null, [doc, project.frameType])
  const mass = useMemo(() => doc && geo ? massState(doc, geo, components, assets) : null, [doc, geo, components, assets])
  const display = useMemo(() => doc ? resolveLinks(doc, components) : null, [doc, components])
  if (error || assemblyError) return <EmptyState>{error ?? assemblyError}</EmptyState>
  if (!ready || !doc || !display || !geo || !mass) return <EmptyState>Loading flight build…</EmptyState>
  return <FlightRun project={project} doc={doc} display={display} geo={geo} mass={mass} components={components} />
}

function heading(frame: FlightFrame) {
  const [x, y, z, w] = frame.quaternion
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

function FlightRun({ project, doc, display, geo, mass, components }: {
  project: Project; doc: AssemblyDocument; display: AssemblyDocument; geo: FrameGeometry; mass: MassState; components: ComponentIndex
}) {
  const assets = useAssets((s) => s.assets)
  const engineState = useSystem((s) => s.engine?.state)
  const conditions = conditionsOf(doc)
  const setConditions = (label: string, patch: Partial<FlightConditions>) =>
    useAssembly.getState().edit(label, (d) => ({ ...d, flight: { ...(d.flight ?? EMPTY_CONDITIONS), ...patch } }))
  // The assembly's engine payload (or what is still missing), then the user's flight conditions on top.
  const payload = useMemo(() => enginePayload(doc, geo, components, assets), [doc, geo, components, assets])
  const gate = useMemo(() => flightGate(payload, conditions), [payload, conditions])
  const engineBlock = engineState === 'connected' ? null : 'The engine is not connected.'
  const idle = useMemo(
    () => idleFrame(mass.motors.length, payload.ok ? payload.payload.startPositionM : [0, 0, 0], mass.mp.com ?? [0, 0, 0]),
    [mass, payload],
  )
  const [frame, setFrame] = useState(idle)
  const latest = useRef(idle)
  const historyRef = useRef<FlightFrame[]>([])
  const [history, setHistory] = useState<FlightFrame[]>([])
  const [mode, setMode] = useState<FlightMode>('attitudeHold')
  const selectedMode = useRef<FlightMode>('attitudeHold')
  const [saved, setSaved] = useState<TuningOverrides | null>(null)
  const [tuningError, setTuningError] = useState<string | null>(null)
  const [tuningAttempt, setTuningAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const result = await getApi().tuning.get(project.id)
        if (!alive) return
        if (result.ok) setSaved(result.data.overrides)
        else setTuningError(result.error.message)
      } catch (error) {
        if (alive) setTuningError((error as Error).message)
      }
    }
    void load()
    return () => { alive = false }
  }, [project.id, tuningAttempt])
  const tuning = saved === null ? null : flightStartWithTuning(mode, saved)
  const linearThrottle = saved !== null && effectiveParams(saved).MPC_THR_CURVE === 1
  const [running, setRunning] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const source = useRef<EngineFlightSource | null>(null)
  const teardown = useRef<(() => void) | null>(null)
  const flushHandle = useRef<number | null>(null)
  const keys = useRef(new Set<string>())
  const headingHold = useRef<HeadingHold | null>(null)
  const [heldHeading, setHeldHeading] = useState(() => heading(idle))
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set())
  const sticksRegion = useRef<HTMLDivElement>(null)
  const tolerance = useWorkshopView((s) => s.balanceTolerance)
  const clearKeys = () => {
    keys.current.clear()
    headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
    setHeldHeading(headingHold.current.headingRad)
    setPressed(new Set())
  }
  // The source publishes at most one frame per animation frame; React state follows at the render rate, once.
  const flush = () => {
    flushHandle.current = null
    setFrame(latest.current)
    setHistory(historyRef.current)
  }
  const onFrame = (next: FlightFrame) => {
    latest.current = next
    // Retain time, not a fixed sample count.
    historyRef.current = [...historyRef.current.filter((f) => f.timeS >= next.timeS - 2 && f.timeS < next.timeS), next]
    if (next.ended) {
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current)
      flush()
      setRunning(false)
      keys.current.clear()
      setPressed(new Set())
    } else if (flushHandle.current === null) flushHandle.current = requestAnimationFrame(flush)
  }
  const stopSource = () => {
    source.current?.stop()
    source.current = null
    teardown.current?.()
    teardown.current = null
  }
  useEffect(() => {
    const held = keys.current
    const blur = () => {
      keys.current.clear()
      headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
      setHeldHeading(headingHold.current.headingRad)
      setPressed(new Set())
    }
    const visibility = () => { if (document.hidden) blur() }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    // The flight conditions are saved with the project: like the workshop, save pending edits when
    // leaving (the workshop reloads the assembly on entry) and synchronously when the window closes.
    const onUnload = () => useAssembly.getState().flushSync()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void useAssembly.getState().flush()
      source.current?.stop()
      teardown.current?.()
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current)
      held.clear()
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  const start = () => {
    if (!gate.ok || engineBlock || !tuning || running) return
    stopSource()
    const next = new EngineFlightSource(getApi().engine, { ...gate.input, ...tuning.session })
    const unsubscribe = [
      next.subscribe(onFrame),
      next.onError((message) => {
        setEngineError(message)
        setRunning(false)
        clearKeys()
      }),
    ]
    source.current = next
    teardown.current = () => unsubscribe.forEach((u) => u())
    clearKeys()
    historyRef.current = []
    latest.current = idle
    setHistory([])
    setFrame(idle)
    setEngineError(null)
    setRunning(true)
    headingHold.current = updateHeadingHold(null, keys.current, heading(idle))
    setHeldHeading(headingHold.current.headingRad)
    next.start(() => {
      const currentMode = selectedMode.current
      if (currentMode !== 'attitudeHold') return { mode: currentMode, sticks: mapPx4Sticks(keys.current) }
      headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
      setHeldHeading(headingHold.current.headingRad)
      return mapSticks(keys.current, headingHold.current.headingRad)
    })
    sticksRegion.current?.focus()
  }
  const findings = useMemo(() => runChecks(checkInput(doc, geo, components)), [doc, geo, components])
  const thrust = useMemo(() => assemblyThrust(doc, geo, components, mass, conditions).indicator, [doc, geo, components, mass, conditions])
  const indicators = {
    'Unbalanced mass': massIndicator(mass, tolerance),
    'Motor layout': layoutIndicator(findings, mass, doc.parts.filter((p) => p.kind === 'motor').length),
    'Collisions': collisionIndicator(frame),
    'Thrust / weight': thrust,
    'Instability': instabilityIndicator(history),
  }
  const setpoint = mapSticks(pressed, heldHeading)
  const sticks = mapPx4Sticks(pressed)
  const blockers = gate.ok ? [] : gate.blockers
  const reason = endReason(frame.ended)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="flight-test">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
        <h1 className="mr-2 font-semibold">{project.name} · Flight test</h1>
        <label className="flex items-center gap-2">
          Mode
          <select data-testid="flight-mode" className="h-7 rounded-sm border border-line-strong bg-chrome px-2" value={mode}
            disabled={running && mode === 'attitudeHold'}
            onChange={(event) => {
              const next = event.target.value as FlightMode
              if (running && next === 'attitudeHold') return
              selectedMode.current = next
              setMode(next)
            }}>
            {(Object.keys(FLIGHT_MODE_LABELS) as FlightMode[]).map((option) => (
              <option key={option} value={option} disabled={running && option === 'attitudeHold'}>{FLIGHT_MODE_LABELS[option]}</option>
            ))}
          </select>
        </label>
        <Button size="sm" data-testid="flight-start" disabled={running || !gate.ok || engineBlock !== null || tuning === null} title={engineBlock ?? (gate.ok ? undefined : 'Enter the missing values first (Flight setup).')} onClick={start}>Start</Button>
        <Button size="sm" data-testid="flight-stop" disabled={!running} onClick={() => { stopSource(); setRunning(false); clearKeys() }}>Stop</Button>
        <Button size="sm" data-testid="flight-reset" onClick={() => {
          stopSource(); setRunning(false); clearKeys(); historyRef.current = []; setHistory([]); setFrame(idle); latest.current = idle; setEngineError(null)
          headingHold.current = updateHeadingHold(null, keys.current, heading(idle))
          setHeldHeading(headingHold.current.headingRad)
        }}>Reset</Button>
        <span role="status" data-testid="flight-status">{reason ? `Run ended: ${reason} at ${frame.timeS.toFixed(3)} s` : running ? 'Running' : 'Stopped'}</span>
        {engineError && <span role="alert" className="text-fault" data-testid="flight-error">Engine: {engineError}</span>}
        <Link className="ml-auto text-accent" to={`/workshop/${project.id}`}>Workshop</Link>
      </div>
      <div className="shrink-0 space-y-1 border-b border-line px-3 py-2 text-[12px] text-fg-muted">
        <FlightModeStatus frame={frame} linearThrottle={linearThrottle} />
        {tuningError ? <p role="alert" className="text-fault">Saved tuning: {tuningError}{' '}
          <button className="text-accent" type="button" onClick={() => { setTuningError(null); setTuningAttempt(tuningAttempt + 1) }}>Retry</button>
        </p> : tuning === null ? <p role="status">Loading saved tuning…</p> : null}
        {tuning && tuning.unsupported.length > 0 && (
          <p className="text-warn" role="status">Attitude hold cannot use these saved overrides: {tuning.unsupported.join(', ')}. Choose a PX4 mode to apply them.</p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto @min-[1000px]:flex-row">
        <div className="flex min-h-[320px] min-w-0 flex-1 flex-col">
          <div ref={sticksRegion} tabIndex={0} aria-label="Keyboard sticks: W S vertical, A D yaw, arrow keys pitch and roll" className="min-h-[240px] flex-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
            onBlur={clearKeys}
            onKeyDown={(event) => {
              if (!running || !STICK_KEYS.includes(event.code) || event.ctrlKey || event.metaKey || event.altKey) return
              event.preventDefault(); keys.current.add(event.code); setPressed(new Set(keys.current))
              headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
              setHeldHeading(headingHold.current.headingRad)
            }}
            onKeyUp={(event) => {
              if (!STICK_KEYS.includes(event.code)) return
              event.preventDefault(); keys.current.delete(event.code); setPressed(new Set(keys.current))
              headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
              setHeldHeading(headingHold.current.headingRad)
            }}>
            <FlightViewport frame={frame} doc={display} geo={geo} projectId={project.id} running={running} />
          </div>
          <div className="shrink-0 space-y-1 border-t border-line px-3 py-2 text-[12px] text-fg-muted">
            <p>Live engine: this build&apos;s mass, motors, battery and drag, flown by the PX4-style controller. It starts on the ground; ground and obstacles are the project environment.</p>
            <p>Focus the view while running. W / S: throttle up / down. A / D: yaw left / right. ↑ / ↓: forward / back. ← / →: left / right. Release to centre. Focus loss clears keys.</p>
            {mode === 'attitudeHold' ? <>
              <p>Limits: ±2 m/s climb, ±90 deg/s yaw, 30° combined tilt. Centred throttle targets zero vertical speed. Attitude hold uses fixed MPC_THR_HOVER.</p>
              <p className="num">Stick preview: vz {setpoint.verticalVelocityMps.toFixed(1)} m/s · yaw {setpoint.yawRateRadps.toFixed(3)} rad/s · attitude x/y/z/w {setpoint.attitude.map((n) => n.toFixed(3)).join(' / ')}</p>
            </> : <>
              <p>PX4 parameters set the stick response and limits.</p>
              <p className="num">Stick preview: forward {sticks.forward} · right {sticks.right} · yaw right {sticks.yawRight} · throttle {sticks.throttle}</p>
            </>}
            <p>Z-up · +X forward · +Y left · body → world quaternion · The run ends at your battery cut-off.</p>
          </div>
        </div>
        <aside aria-label="Physics debug panel" className="w-full shrink-0 overflow-y-auto border-t border-line bg-chrome px-4 py-3 @min-[1000px]:w-[400px] @min-[1000px]:border-l @min-[1000px]:border-t-0">
          <div className="mb-5">
            <FlightSetup projectId={project.id} conditions={conditions} onChange={setConditions} blockers={blockers} engineBlock={engineBlock} locked={running} />
          </div>
          <DebugPanel frame={frame} mass={mass.mp} indicators={indicators} source="live" />
        </aside>
      </div>
    </div>
  )
}
