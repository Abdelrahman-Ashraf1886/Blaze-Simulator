import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import type { AssemblyDocument, Project } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { runChecks } from '@/domain/checks'
import { propulsionDefinition } from '@/domain/propulsion'
import { useProjects } from '@/stores/projects'
import { useComponents } from '@/stores/components'
import { buildFrame, type FrameGeometry } from '@/three/frame-geometry'
import { useAssembly } from '../workshop/assembly-store'
import { useAssets } from '../workshop/asset-store'
import { useComponentIndex } from '../workshop/component-index'
import { checkInput } from '../workshop/check-input'
import { linkedComponent, resolveLinks, type ComponentIndex } from '../workshop/links'
import { massState, type MassState } from '../workshop/mass-input'
import { useWorkshopView } from '../workshop/view-store'
import { propulsionState } from '../workshop/propulsion-input'
import { DebugPanel, endReason } from './DebugPanel'
import { demoFrame, FakeFlightSource } from './FakeFlightSource'
import { FlightViewport } from './FlightViewport'
import type { FlightFrame, FlightSource } from './frame'
import { collisionIndicator, instabilityIndicator, layoutIndicator, massIndicator, thrustIndicator } from './indicators'
import { mapSticks, STICK_KEYS, updateHeadingHold, type HeadingHold } from './sticks'

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
        <p className="mb-3 text-[12.5px] text-warn">Demo data only. Live engine streaming arrives in Part B.</p>
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
  const [initial] = useState(() => demoFrame(0, mass.motors.length, mass.mp.com ?? [0, 0, 0]))
  // Replace this factory with a FlightSource adapter in Part B. No engine/IPC dependency here.
  const [source] = useState<FlightSource>(() => new FakeFlightSource(Array.from({ length: 201 }, (_, i) => demoFrame(i / 20, mass.motors.length, mass.mp.com ?? [0, 0, 0]))))
  const [frame, setFrame] = useState(initial)
  const latest = useRef(initial)
  const [history, setHistory] = useState<FlightFrame[]>([])
  const [running, setRunning] = useState(false)
  const keys = useRef(new Set<string>())
  const headingHold = useRef<HeadingHold | null>(null)
  const [heldHeading, setHeldHeading] = useState(() => heading(initial))
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set())
  const sticksRegion = useRef<HTMLDivElement>(null)
  const tolerance = useWorkshopView((s) => s.balanceTolerance)
  const clearKeys = () => {
    keys.current.clear()
    headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
    setHeldHeading(headingHold.current.headingRad)
    setPressed(new Set())
  }
  useEffect(() => {
    const held = keys.current
    const unsubscribe = source.subscribe((next) => {
      latest.current = next
      // Part B must throttle setFrame/setHistory to the render rate for 1 kHz streams.
      setFrame(next)
      // Retain time, not a fixed sample count: this also works with 1 kHz engine samples.
      setHistory((h) => [...h.filter((f) => f.timeS >= next.timeS - 2 && f.timeS < next.timeS), next])
      if (next.ended) {
        setRunning(false)
        keys.current.clear()
        setPressed(new Set())
      }
    })
    const blur = () => {
      keys.current.clear()
      headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
      setHeldHeading(headingHold.current.headingRad)
      setPressed(new Set())
    }
    const visibility = () => { if (document.hidden) blur() }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      source.stop()
      unsubscribe()
      held.clear()
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [source])
  const findings = useMemo(() => runChecks(checkInput(doc, geo, components)), [doc, geo, components])
  const thrust = useMemo(() => {
    const propulsion = propulsionState(doc, geo, components)
    const battery = doc.parts.find((p) => p.kind === 'battery')
    const definition = propulsionDefinition(propulsion.motors, battery ? linkedComponent(battery, components) : null)
    return thrustIndicator(definition, propulsion.ready, mass.mp.totalMassKg, !!mass.mp.com && mass.mp.missingMass.length === 0)
  }, [doc, geo, components, mass])
  const indicators = {
    'Unbalanced mass': massIndicator(mass, tolerance),
    'Motor layout': layoutIndicator(findings, mass, doc.parts.filter((p) => p.kind === 'motor').length),
    'Collisions': collisionIndicator(frame),
    'Thrust / weight': thrust,
    'Instability': instabilityIndicator(history),
  }
  const setpoint = mapSticks(pressed, heldHeading)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="flight-test">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
        <h1 className="mr-2 font-semibold">{project.name} · Flight test</h1>
        <span className="text-warn">Demo data</span>
        <Button size="sm" disabled={running} onClick={() => {
          clearKeys(); setHistory([]); setRunning(true)
          headingHold.current = updateHeadingHold(null, keys.current, heading(latest.current))
          setHeldHeading(headingHold.current.headingRad)
          source.start(() => {
            headingHold.current = updateHeadingHold(headingHold.current, keys.current, heading(latest.current))
            setHeldHeading(headingHold.current.headingRad)
            return mapSticks(keys.current, headingHold.current.headingRad)
          })
          sticksRegion.current?.focus()
        }}>Start demo</Button>
        <Button size="sm" disabled={!running} onClick={() => { source.stop(); setRunning(false); clearKeys() }}>Stop</Button>
        <Button size="sm" onClick={() => {
          source.stop(); setRunning(false); clearKeys(); setHistory([]); setFrame(initial); latest.current = initial
          headingHold.current = updateHeadingHold(null, keys.current, heading(initial))
          setHeldHeading(headingHold.current.headingRad)
        }}>Reset</Button>
        <span role="status">{endReason(frame.ended) ?? (running ? 'Running' : 'Stopped')}</span>
        <Link className="ml-auto text-accent" to={`/workshop/${project.id}`}>Workshop</Link>
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
            <FlightViewport frame={frame} doc={display} geo={geo} />
          </div>
          <div className="shrink-0 space-y-1 border-t border-line px-3 py-2 text-[12px] text-fg-muted">
            <p className="text-warn">Scripted demo: motion, forces, battery and saturation are not computed from this build or keyboard input. Ground and obstacles show the project environment.</p>
            <p>Focus the view while running. W / S: climb / descend (±2 m/s); A / D: yaw left / right (±90 deg/s). ↑ / ↓: pitch forward / back; ← / →: roll left / right. Maximum combined tilt: 30°. Release to centre; focus loss clears keys.</p>
            <p className="num">Stick preview: vz {setpoint.verticalVelocityMps.toFixed(1)} m/s · yaw {setpoint.yawRateRadps.toFixed(3)} rad/s · attitude x/y/z/w {setpoint.attitude.map((n) => n.toFixed(3)).join(' / ')}</p>
            <p>Z-up · +X forward · +Y left · body → world quaternion · Demo ends at 10 s with a scripted charge cut-off.</p>
          </div>
        </div>
        <aside aria-label="Physics debug panel" className="w-full shrink-0 overflow-y-auto border-t border-line bg-chrome px-4 py-3 @min-[1000px]:w-[400px] @min-[1000px]:border-l @min-[1000px]:border-t-0">
          <DebugPanel frame={frame} mass={mass.mp} indicators={indicators} />
        </aside>
      </div>
    </div>
  )
}
