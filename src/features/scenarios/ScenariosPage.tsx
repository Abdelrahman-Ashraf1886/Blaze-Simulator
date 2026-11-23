import { CircleAlert, CircleCheck, CircleX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { AssemblyDocument, Project, ScenarioRunOutput } from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { fromSI, toSI } from '@/domain/units'
import { cn } from '@/lib/utils'
import { getApi } from '@/services/api'
import { useComponents } from '@/stores/components'
import { useProjects } from '@/stores/projects'
import { useSystem } from '@/stores/system'
import { buildFrame } from '@/three/frame-geometry'
import { useAssembly } from '../workshop/assembly-store'
import { useAssets } from '../workshop/asset-store'
import { useComponentIndex } from '../workshop/component-index'
import { useWorkshopView } from '../workshop/view-store'
import { airDensityFor, conditionsOf, enginePayload, flightGate, type FlightBlocker, type FlightConditions, type FlightGate, type FlightLink, type PayloadResult } from '../flight/readiness'
import { checkRows, fmt, modificationRows, summaryRows } from './report'
import { BUILTINS, missingEntry, NO_ENTRIES, scenarioRunInput, type BuiltinInfo, type ScenarioEntries } from './scenarios'

export default function ScenariosPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)
  useEffect(() => { void useProjects.getState().load() }, [])
  if (!projectId) return <>
    <PageHeader title="Scenarios" />
    <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
      <Section title="Open a project" count={projects.length}>
        {error ? <EmptyState>{error}</EmptyState> : projects.length === 0 ? <EmptyState>{loading ? 'Loading…' : 'No projects yet. Create one on the Dashboard.'}</EmptyState> :
          <ul className="border-t border-line">{projects.map((p) => <li key={p.id} className="border-b border-line/60"><Link to={`/scenarios/${p.id}`} className="block py-2 text-[13px] hover:text-accent">{p.name}</Link></li>)}</ul>}
      </Section>
    </div>
  </>
  const project = projects.find((p) => p.id === projectId)
  if (!project) return <EmptyState>{error ?? (loading ? 'Loading…' : 'This project no longer exists.')}</EmptyState>
  return <LoadScenarios key={project.id} project={project} />
}

function LoadScenarios({ project }: { project: Project }) {
  const doc = useAssembly((s) => s.projectId === project.id ? s.doc : null)
  const assemblyError = useAssembly((s) => s.error)
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
  if (error || assemblyError) return <EmptyState>{error ?? assemblyError}</EmptyState>
  if (!ready || !doc) return <EmptyState>Loading build…</EmptyState>
  return <Scenarios project={project} doc={doc} />
}

/** Focuses `id` once the page that holds it has rendered (a link into the workshop or the flight page). */
function focusWhenPresent(id: string, tries = 60) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ block: 'center' })
    el.focus()
  } else if (tries > 0) requestAnimationFrame(() => focusWhenPresent(id, tries - 1))
}

/** Each checklist item links to its field: the flight conditions live on the flight page, the rest in the workshop. */
function useFollow(projectId: string) {
  const navigate = useNavigate()
  return (link: FlightLink) => {
    if (link.to === 'flight-field') {
      void navigate(`/flight/${projectId}`)
      return focusWhenPresent(link.elementId)
    }
    if (link.to === 'component') return void navigate(`/components?id=${encodeURIComponent(link.componentId)}&field=${encodeURIComponent(link.field)}`)
    if (link.to === 'part') useWorkshopView.getState().selectPart(link.partId)
    void navigate(`/workshop/${projectId}`)
    const id = link.to === 'frame-mass' ? 'frame-mass' : link.to === 'body-drag' ? `body-cd-${link.axis}` : link.to === 'environment' ? link.elementId : null
    if (id) focusWhenPresent(id)
  }
}

const NO_RUNS: Record<string, RunState> = {}
type RunState = { status: 'running' } | { status: 'done'; result: ScenarioRunOutput } | { status: 'error'; message: string }

function Scenarios({ project, doc }: { project: Project; doc: AssemblyDocument }) {
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const engineState = useSystem((s) => s.engine?.state)
  const follow = useFollow(project.id)
  const geo = useMemo(() => buildFrame(project.frameType, doc.frame, doc.motors), [doc, project.frameType])
  const conditions = conditionsOf(doc)
  const payload = useMemo(() => enginePayload(doc, geo, components, assets), [doc, geo, components, assets])
  const gate = useMemo(() => flightGate(payload, conditions), [payload, conditions])
  const engineBlock = engineState === 'connected' ? null : 'The engine is not connected.'
  const [entries, setEntries] = useState<ScenarioEntries>(NO_ENTRIES)
  // A result belongs to the build and conditions it was flown with (`gate`): once they change, it is not shown.
  const [flown, setFlown] = useState<{ gate: FlightGate | null; byName: Record<string, RunState> }>({ gate: null, byName: {} })
  const runs = flown.gate === gate ? flown.byName : NO_RUNS
  const [runningAll, setRunningAll] = useState(false)
  const alive = useRef(true)
  const current = useRef(gate)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => { current.current = gate }, [gate])

  const busy = runningAll || Object.values(runs).some((r) => r.status === 'running')
  const canRun = (info: BuiltinInfo) => scenarioRunInput(gate, info, entries) !== null && engineBlock === null

  const runOne = async (info: BuiltinInfo) => {
    const input = scenarioRunInput(gate, info, entries)
    if (!input) return
    const set = (state: RunState) => {
      if (alive.current && current.current === gate) setFlown((prev) => ({ gate, byName: { ...(prev.gate === gate ? prev.byName : {}), [info.name]: state } }))
    }
    set({ status: 'running' })
    try {
      const r = await getApi().engine.scenarioRun(input)
      set(r.ok ? { status: 'done', result: r.data } : { status: 'error', message: r.error.message })
    } catch (e) {
      set({ status: 'error', message: (e as Error).message })
    }
  }
  const runAll = async () => {
    setRunningAll(true)
    try {
      for (const info of BUILTINS) if (alive.current && canRun(info)) await runOne(info)
    } finally {
      if (alive.current) setRunningAll(false)
    }
  }

  const blockers = gate.ok ? [] : gate.blockers
  return (
    <div data-testid="scenarios-page">
      <PageHeader
        title={`${project.name} · Scenarios`}
        actions={
          <>
            <Link className="text-[12.5px] text-accent" to={`/flight/${project.id}`}>Flight test</Link>
            <Link className="text-[12.5px] text-accent" to={`/workshop/${project.id}`}>Workshop</Link>
            <Button size="sm" variant="primary" data-testid="scenario-run-all" disabled={busy || engineBlock !== null || !BUILTINS.some(canRun)} onClick={() => void runAll()}>
              Run all
            </Button>
          </>
        }
      />
      <div className="mx-auto w-full max-w-[1100px] space-y-6 px-6 pb-10 pt-5">
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          Scripted runs of this build on the flight engine: the PX4-style controller (default settings, as in the flight test) flies the build’s own motors, battery and drag, in free space. Each scenario states what it checks; the measured values and limits come from the engine.
        </p>
        <Conditions conditions={conditions} gateOk={gate.ok} payload={payload} blockers={blockers} engineBlock={engineBlock} follow={follow} projectId={project.id} />
        <Section title="Built-in scenarios" count={BUILTINS.length}>
          <ul className="border-t border-line" data-testid="scenario-list">
            {BUILTINS.map((info) => (
              <ScenarioCard
                key={info.name}
                info={info}
                entries={entries}
                onEntries={(patch) => setEntries((e) => ({ ...e, ...patch }))}
                payload={payload}
                run={runs[info.name]}
                runnable={canRun(info)}
                busy={busy}
                gateOk={gate.ok}
                onRun={() => void runOne(info)}
              />
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}

/** The flight conditions in use (read-only here), and until the build can fly, the checklist of what is missing. */
function Conditions({ conditions: c, gateOk, payload, blockers, engineBlock, follow, projectId }: {
  conditions: FlightConditions
  gateOk: boolean
  payload: PayloadResult
  blockers: readonly FlightBlocker[]
  engineBlock: string | null
  follow: (link: FlightLink) => void
  projectId: string
}) {
  return (
    <Section title="Conditions" count={blockers.length}>
      {c.ambientAltitudeM !== null && (
        <p className="border-t border-line py-2 text-[12.5px] text-fg-muted" data-testid="scenarios-conditions">
          Air density {airDensityFor(c.ambientAltitudeM, c.temperatureC).toFixed(3)} kg/m³ at {c.ambientAltitudeM} m
          {c.temperatureC === null ? ' (standard atmosphere)' : `, ${c.temperatureC} °C`}
          {c.cutoffValue !== null && <> · battery cut-off at {c.cutoffValue} {c.cutoffType === 'voltageV' ? 'V' : 'mAh'}</>}
          {' · '}
          <Link className="text-accent" to={`/flight/${projectId}`}>Change under Flight setup</Link>
        </p>
      )}
      {gateOk ? (
        <p className="flex items-center gap-2 border-t border-line py-2 text-[12.5px] text-ok" data-testid="scenarios-ready">
          <CircleCheck className="size-3.5" /> Ready to fly: every value the simulation needs is stated or entered.
        </p>
      ) : (
        <div data-testid="scenarios-blockers">
          <p className="border-t border-line pt-2 text-[12px] leading-relaxed text-fg-subtle">
            No source states these for this build. A scenario will not run until each is entered{payload.ok ? '' : ' (the build is not complete)'}.
          </p>
          <ul className="mt-1 border-t border-line">
            {blockers.map((item) => {
              const body = (
                <>
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-fg">{item.label}</span>
                    <span className="block text-[12px] text-fg-subtle">{item.detail}</span>
                  </span>
                </>
              )
              const cls = 'flex w-full gap-2 py-1.5 text-left text-[12.5px] leading-snug'
              return (
                <li key={item.id} data-testid="scenarios-blocker" data-item={item.id} className="border-b border-line/60">
                  {item.link ? (
                    <button type="button" className={cn(cls, 'hover:bg-hover/50')} onClick={() => follow(item.link!)} title="Go to the field">{body}</button>
                  ) : (
                    <div className={cls}>{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {engineBlock && <p className="mt-2 text-[12.5px] text-warn" data-testid="scenarios-engine-block">{engineBlock}</p>}
    </Section>
  )
}

const MASS_UNIT = 'g'
const OFFSET_UNIT = 'mm'
const show = (v: number | null, unit: 'g' | 'mm') => (v === null ? '' : String(Math.round(fromSI(v, unit) * 1e6) / 1e6))

function ScenarioCard({ info, entries, onEntries, payload, run, runnable, busy, gateOk, onRun }: {
  info: BuiltinInfo
  entries: ScenarioEntries
  onEntries: (patch: Partial<ScenarioEntries>) => void
  payload: PayloadResult
  run: RunState | undefined
  runnable: boolean
  busy: boolean
  gateOk: boolean
  onRun: () => void
}) {
  const need = missingEntry(info, entries)
  const vehicle = payload.ok ? payload.payload.vehicle : null
  const arm = vehicle ? Math.max(...vehicle.motors.map((m) => Math.abs(m.position[0]))) : null
  return (
    <li className="border-b border-line/60 py-3" data-testid={`scenario-${info.name}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium">{info.title} <span className="num font-normal text-fg-subtle">{info.name}</span></h3>
          <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-fg-muted">{info.tests}</p>
          {info.expectsFailure && <p className="mt-1 text-[12px] text-fg-subtle">This scenario passes when the vehicle fails the way the engine predicts; a pass is not a flight that holds.</p>}
        </div>
        <Button size="sm" data-testid={`scenario-run-${info.name}`} disabled={!runnable || busy} title={!gateOk ? 'Enter the missing values first (Conditions).' : (need ?? undefined)} onClick={onRun}>
          {run?.status === 'running' ? 'Running…' : 'Run'}
        </Button>
      </div>
      {info.entry === 'payloadMassKg' && (
        <div className="mt-2 max-w-[420px]">
          <NumberField
            key={`mass:${entries.payloadMassKg}`}
            id="scenario-payload-mass"
            label="Payload mass"
            unit={MASS_UNIT}
            placeholder="not set"
            initial={show(entries.payloadMassKg, MASS_UNIT)}
            parse={(text) => text.trim() === '' ? { ok: true, value: null } : mapOk(numberParser(1, 100_000, MASS_UNIT, 1)(text), (g) => toSI(g, MASS_UNIT))}
            onCommit={(v) => onEntries({ payloadMassKg: v })}
          />
          {vehicle && <p className="mt-1 text-[11.5px] text-fg-subtle">The build weighs {fmt(vehicle.totalMassKg * 1000)} g.</p>}
        </div>
      )}
      {info.entry === 'comOffsetM' && (
        <div className="mt-2 max-w-[420px]">
          <NumberField
            key={`offset:${entries.comOffsetM}`}
            id="scenario-com-offset"
            label="Centre-of-mass offset (forward)"
            unit={OFFSET_UNIT}
            placeholder="not set"
            initial={show(entries.comOffsetM, OFFSET_UNIT)}
            parse={(text) => text.trim() === '' ? { ok: true, value: null } : mapOk(numberParser(-1000, 1000, OFFSET_UNIT, 0.1)(text), (v) => toSI(v, OFFSET_UNIT))}
            onCommit={(v) => onEntries({ comOffsetM: v })}
          />
          {arm !== null && <p className="mt-1 text-[11.5px] text-fg-subtle">The outermost motor is {fmt(arm * 1000)} mm from the body origin along the forward axis.</p>}
        </div>
      )}
      {need && <p className="mt-1 text-[12px] text-warn" data-testid={`scenario-need-${info.name}`}>{need}</p>}
      {run?.status === 'error' && <p role="alert" className="mt-2 text-[12.5px] text-fault" data-testid={`scenario-error-${info.name}`}>The engine did not run this scenario: {run.message}</p>}
      {run?.status === 'done' && <Result info={info} result={run.result} />}
    </li>
  )
}

function mapOk<T, U>(r: { ok: true; value: T } | { ok: false; message: string }, f: (v: T) => U): { ok: true; value: U } | { ok: false; message: string } {
  return r.ok ? { ok: true, value: f(r.value) } : r
}

function Result({ info, result }: { info: BuiltinInfo; result: ScenarioRunOutput }) {
  const { report, scenario } = result
  const rows = checkRows(report)
  const changed = modificationRows(scenario)
  const passed = report.passed
  const Icon = passed ? CircleCheck : CircleX
  return (
    <div className="mt-3" data-testid={`scenario-result-${info.name}`}>
      <p className={cn('flex items-center gap-2 text-[13px] font-medium', passed ? 'text-ok' : 'text-fault')} data-testid={`scenario-verdict-${info.name}`} data-passed={passed}>
        <Icon className="size-4" aria-hidden />
        {passed ? (info.expectsFailure ? 'Pass: the predicted failure happened' : 'Pass') : 'Fail'}
      </p>
      {report.endReason !== 'duration' && (
        <p className="mt-1 text-[12.5px] text-warn">The run stopped early at your battery cut-off, so it did not pass; checks that were not reached have no value.</p>
      )}
      {changed.length > 0 && (
        <ul className="mt-2 text-[12.5px] text-fg-muted" data-testid={`scenario-changes-${info.name}`}>
          {changed.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      <table className="mt-2 w-full border-t border-line text-[12.5px]" data-testid={`scenario-checks-${info.name}`}>
        <thead className="text-left text-[11.5px] text-fg-subtle">
          <tr><th className="py-1.5 pr-3 font-normal">Check</th><th className="py-1.5 pr-3 font-normal">Measured</th><th className="py-1.5 pr-3 font-normal">Limit</th><th className="py-1.5 font-normal">Result</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-line/60 align-top" data-testid={`scenario-check-${info.name}`} data-passed={row.passed}>
              <td className="py-1.5 pr-3 text-fg">{row.label}</td>
              <td className="num py-1.5 pr-3">{row.measured}</td>
              <td className="num py-1.5 pr-3 text-fg-muted">{row.limit}</td>
              <td className={cn('py-1.5', row.passed ? 'text-ok' : 'text-fault')}>{row.passed ? 'Pass' : 'Fail'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-3 border-t border-line" data-testid={`scenario-summary-${info.name}`}>
        {summaryRows(report).map((row) => (
          <div key={row.label} className="flex min-w-0 items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
            <dt className="shrink-0 text-[12.5px] text-fg-muted">{row.label}</dt>
            <dd className="num min-w-0 break-words text-right text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
