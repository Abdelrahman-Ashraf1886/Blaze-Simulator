import { CircleAlert, CircleCheck } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { AssemblyDocument, Project } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { cn } from '@/lib/utils'
import { STANDARD_GRAVITY } from '@/domain/mass'
import type { Finding } from '@/domain/checks'
import type { Calc } from '@/domain/electrical'
import type { ReadyLink } from '@/domain/propulsion'
import { fromSI, type Unit } from '@/domain/units'
import { useProjects } from '@/stores/projects'
import { useComponents } from '@/stores/components'
import { buildFrame } from '@/three/frame-geometry'
import { useAssembly } from '../workshop/assembly-store'
import { useAssets } from '../workshop/asset-store'
import { useComponentIndex } from '../workshop/component-index'
import { useWorkshopView } from '../workshop/view-store'
import type { FlightLink } from '../flight/readiness'
import { analyse, type Analysis } from './analysis'

export default function AnalysisPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)
  useEffect(() => { void useProjects.getState().load() }, [])
  if (!projectId) return <>
    <PageHeader title="Engineering Analysis" />
    <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
      <Section title="Open a project" count={projects.length}>
        {error ? <EmptyState>{error}</EmptyState> : projects.length === 0 ? <EmptyState>{loading ? 'Loading…' : 'No projects yet. Create one on the Dashboard.'}</EmptyState> :
          <ul className="border-t border-line">{projects.map((p) => <li key={p.id} className="border-b border-line/60"><Link to={`/analysis/${p.id}`} className="block py-2 text-[13px] hover:text-accent">{p.name}</Link></li>)}</ul>}
      </Section>
    </div>
  </>
  const project = projects.find((p) => p.id === projectId)
  if (!project) return <EmptyState>{error ?? (loading ? 'Loading…' : 'This project no longer exists.')}</EmptyState>
  return <LoadAnalysis key={project.id} project={project} />
}

function LoadAnalysis({ project }: { project: Project }) {
  const doc = useAssembly((s) => (s.projectId === project.id ? s.doc : null))
  const assemblyError = useAssembly((s) => s.error)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const tolerance = useWorkshopView((s) => s.balanceTolerance)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      // Keep pending workshop edits before the shared assembly store is switched.
      await useAssembly.getState().flush()
      if (useAssembly.getState().projectId !== project.id || !useAssembly.getState().doc) await useAssembly.getState().load(project.id)
      await Promise.all([useComponents.getState().load(), useAssets.getState().load()])
      if (useComponents.getState().error) throw new Error(useComponents.getState().error!)
      if (alive) setReady(true)
    }
    void load().catch((e: unknown) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [project.id])
  const result = useMemo(() => {
    if (!doc) return null
    return analyse(doc, buildFrame(project.frameType, doc.frame, doc.motors), components, assets, tolerance)
  }, [doc, project.frameType, components, assets, tolerance])
  if (error || assemblyError) return <EmptyState>{error ?? assemblyError}</EmptyState>
  if (!ready || !doc || !result) return <EmptyState>Loading analysis…</EmptyState>
  return <AnalysisView project={project} doc={doc} a={result} />
}

// ---- Formatting: the existing unit helpers, one number and its unit -------------------------------------

const num = (si: number, unit: Unit, digits: number) => fromSI(si, unit).toFixed(digits)

/** Focuses `id` once the page that holds it has rendered (a link into another page). */
function focusWhenPresent(id: string, tries = 60) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ block: 'center' })
    el.focus()
  } else if (tries > 0) requestAnimationFrame(() => focusWhenPresent(id, tries - 1))
}

type Target = ReadyLink | FlightLink | { to: 'electrical' }
function useFollow(projectId: string) {
  const navigate = useNavigate()
  return (link: Target) => {
    if (link.to === 'component') return void navigate(`/components?id=${encodeURIComponent(link.componentId)}&field=${encodeURIComponent(link.field)}`)
    if (link.to === 'electrical') return void navigate(`/electrical/${projectId}`)
    if (link.to === 'flight-field') {
      void navigate(`/flight/${projectId}`)
      return focusWhenPresent(link.elementId)
    }
    if (link.to === 'part') useWorkshopView.getState().selectPart(link.partId)
    void navigate(`/workshop/${projectId}`)
    const id = link.to === 'frame-mass' ? 'frame-mass' : link.to === 'body-drag' ? `body-cd-${link.axis}` : link.to === 'environment' ? link.elementId : null
    if (id) focusWhenPresent(id)
  }
}

function LinkButton({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return <button type="button" className="underline hover:text-fg" onClick={onClick} title={title}>{children}</button>
}

function Missing({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="border-t border-line py-2 text-[12px] leading-relaxed text-warn" data-testid={testId}>{children}</p>
}

function Item({ label, detail, onClick, testId, id }: { label: string; detail: string; onClick?: () => void; testId: string; id: string }) {
  const body = (
    <>
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
      <span className="min-w-0">
        <span className="block text-fg">{label}</span>
        <span className="block text-[12px] text-fg-subtle">{detail}</span>
      </span>
    </>
  )
  const cls = 'flex w-full gap-2 py-1.5 text-left text-[12.5px] leading-snug'
  return (
    <li data-testid={testId} data-item={id} className="border-b border-line/60">
      {onClick ? <button type="button" className={cn(cls, 'hover:bg-hover/50')} onClick={onClick} title="Go to the field">{body}</button> : <div className={cls}>{body}</div>}
    </li>
  )
}

function FindingList({ findings, follow, testId }: { findings: readonly Finding[]; follow: (l: Target) => void; testId: string }) {
  if (findings.length === 0) return null
  return (
    <ul className="border-t border-line" data-testid={testId}>
      {findings.map((f) => (
        <li key={f.id} data-severity={f.severity} className="flex items-start gap-2 border-b border-line/60 py-1.5 text-[12px] leading-snug">
          <CircleAlert className={cn('mt-0.5 size-3.5 shrink-0', f.severity === 'error' ? 'text-fault' : 'text-warn')} aria-hidden />
          <span className="min-w-0 text-fg-muted">
            {f.message}
            {f.partIds[0] && !f.partIds[0].startsWith('frame') && <> <LinkButton onClick={() => follow({ to: 'part', partId: f.partIds[0]! })}>Open part</LinkButton></>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A calculated value with its unit and formula, or why there is none. */
function CalcReadout({ label, c, unit, scale = 1, digits = 2, testId }: { label: string; c: Calc; unit: string; scale?: number; digits?: number; testId?: string }) {
  if (c.value === null) return <Readout label={label} value={<span data-testid={testId} data-missing="true" className="text-fg-subtle">not available</span>} title={c.reason} mono={false} />
  return <Readout label={label} value={<span data-testid={testId}>{(c.value * scale).toFixed(digits)}</span>} unit={unit} title={c.formula} />
}

const ELECTRICAL_RULES = new Set(['battery-cells', 'esc-current', 'esc-outputs', 'battery-current'])

function AnalysisView({ project, doc, a }: { project: Project; doc: AssemblyDocument; a: Analysis }) {
  const follow = useFollow(project.id)
  return (
    <div data-testid="analysis-page">
      <PageHeader title={`${project.name} · Engineering Analysis`} />
      <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-3">
        <p className="mb-4 text-[12px] leading-relaxed text-fg-subtle">
          Read-only: every value is worked out from the saved build by the same calculations the workshop, the Electrical Designer and the flight test use. Hover a value for its source or formula.
        </p>
        <div className="grid gap-x-10 gap-y-8 min-[1100px]:grid-cols-2">
          <MassSection a={a} follow={follow} />
          <BalanceSection a={a} />
          <PropulsionSection a={a} follow={follow} />
          <ElectricalSection a={a} follow={follow} />
          <ReadinessSection a={a} follow={follow} />
          <Section title="Scenarios" testId="analysis-scenarios">
            <p className="border-t border-line py-2 text-[12.5px] leading-relaxed text-fg-muted">
              Scenario results are not stored, so none is shown here. Run them on the <Link className="underline hover:text-fg" to={`/scenarios/${project.id}`} data-testid="analysis-scenarios-link">Scenarios page</Link>.
            </p>
          </Section>
        </div>
        <p className="mt-6 text-[11.5px] text-fg-subtle">{doc.parts.length} part{doc.parts.length === 1 ? '' : 's'} in this build · <Link className="underline hover:text-fg" to={`/workshop/${project.id}`}>Open the workshop</Link></p>
      </div>
    </div>
  )
}

// ---- 1. Mass properties --------------------------------------------------------------------------------

function MassSection({ a, follow }: { a: Analysis; follow: (l: Target) => void }) {
  const { mp } = a.mass
  const mm = (m: number) => num(m, 'mm', 1)
  return (
    <Section title="Mass properties" testId="analysis-mass">
      <Readouts>
        <Readout label="Total mass" value={<span data-testid="analysis-mass-total">{num(mp.totalMassKg, 'g', 1)}</span>} unit="g" title="Σ of the mass of every part that has one (massProperties, src/domain/mass.ts)" />
        <Readout label="Weight" value={(mp.totalMassKg * STANDARD_GRAVITY).toFixed(2)} unit="N" title="m × 9.80665 m/s² (standard gravity)" />
      </Readouts>
      {mp.missingMass.length > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-warn" data-testid="analysis-mass-missing">
          Incomplete: no mass for{' '}
          {mp.missingMass.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <LinkButton onClick={() => follow(m.id.startsWith('frame') ? { to: 'frame-mass' } : { to: 'part', partId: m.id })}>{m.name}</LinkButton>
            </span>
          ))}
          . The centre of mass and inertia leave {mp.missingMass.length === 1 ? 'it' : 'them'} out.
        </p>
      )}
      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted">Centre of mass</h3>
      {mp.com && a.comOffsetM !== null ? (
        <Readouts>
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Readout key={axis} label={axis} value={<span data-testid={`analysis-com-${axis.toLowerCase()}`}>{mm(mp.com![i]!)}</span>} unit="mm" title="CoM = Σ mᵢ rᵢ / Σ mᵢ, body axes (X forward, Y left, Z up), origin at the frame centre, bottom of the centre plate" />
          ))}
          <Readout label="Horizontal offset" value={<span data-testid="analysis-com-offset">{mm(a.comOffsetM)}</span>} unit="mm" title="Distance from the frame's vertical axis: √(X² + Y²) (horizontalOffset)" />
        </Readouts>
      ) : (
        <Missing testId="analysis-com-none">Not available: no part has a mass yet. Enter masses in the workshop.</Missing>
      )}
      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted" title="Inertia tensor about the centre of mass, body axes (X forward, Y left, Z up)">
        Inertia about CoM <span className="font-normal text-fg-subtle">kg·m²</span>
      </h3>
      {mp.inertia ? (
        <>
          <table className="num w-full border-t border-line text-right text-[12px]" data-testid="analysis-inertia">
            <tbody>
              {[[mp.inertia[0], mp.inertia[3], mp.inertia[4]], [mp.inertia[3], mp.inertia[1], mp.inertia[5]], [mp.inertia[4], mp.inertia[5], mp.inertia[2]]].map((row, r) => (
                <tr key={r} className="border-b border-line/60">
                  {row.map((v, c) => <td key={c} className={cn('py-1', r === c ? 'text-fg' : 'text-fg-muted')} data-testid={`analysis-inertia-${r}${c}`} title={`Σ [Rᵢ Iᵢ Rᵢᵀ + mᵢ(|dᵢ|² E − dᵢ dᵢᵀ)] about the CoM`}>{v.toFixed(6)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11.5px] leading-relaxed text-fg-subtle" data-testid="analysis-principal-none">
            Principal moments: not available. No calculation of them exists yet; the tensor above is complete.
          </p>
        </>
      ) : (
        <Missing>Not available: needs at least one part with a mass.</Missing>
      )}
    </Section>
  )
}

// ---- 2. Hover balance ----------------------------------------------------------------------------------

function BalanceSection({ a }: { a: Analysis }) {
  const { hover, motors } = a.mass
  return (
    <Section title="Hover balance" testId="analysis-balance">
      {!hover ? (
        <Missing testId="analysis-balance-none">Not available: the centre of mass is unknown until a part has a mass.</Missing>
      ) : !hover.feasible ? (
        <p className="border-t border-line py-2 text-[12px] leading-relaxed text-fault" data-testid="analysis-hover-infeasible">{hover.reason}</p>
      ) : (
        <table className="num w-full border-t border-line text-[12px]" data-testid="analysis-hover-table">
          <tbody>
            {motors.map((m, i) => {
              const over = hover.share[i]! > 1 + a.tolerancePct / 100
              return (
                <tr key={m.partId} className="border-b border-line/60">
                  <td className="py-1 text-fg-muted">{m.name}</td>
                  <td className="py-1 text-right" title="Least-squares thrust with no roll or pitch moment about the CoM (hoverBalance)" data-testid={`analysis-hover-thrust-${i + 1}`}>{num(hover.thrustN[i]!, 'gf', 0)} <span className="text-fg-subtle">gf</span></td>
                  <td className={cn('py-1 text-right', over ? 'text-warn' : 'text-fg')} title="Share of the mean hover thrust" data-testid={`analysis-hover-share-${i + 1}`}>{(hover.share[i]! * 100).toFixed(1)} <span className="text-fg-subtle">%</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <Readouts>
        <Readout label="Tolerance (max over mean)" value={<span data-testid="analysis-tolerance">{a.tolerancePct}</span>} unit="%" title="Your hover-share margin (workshop Mass panel setting): a motor above the mean by more than this is flagged" />
      </Readouts>
      {a.hoverFindings.length === 0 && hover?.feasible && <p className="py-1.5 text-[12px] text-ok" data-testid="analysis-balance-ok">Every motor is within the tolerance.</p>}
      <FindingList findings={a.hoverFindings} follow={() => undefined} testId="analysis-balance-findings" />
    </Section>
  )
}

// ---- 3. Propulsion -------------------------------------------------------------------------------------

function PropulsionSection({ a, follow }: { a: Analysis; follow: (l: Target) => void }) {
  const noAltitude = a.conditions.ambientAltitudeM === null
  return (
    <Section title="Propulsion" testId="analysis-propulsion">
      <Readouts>
        <Readout label="Air density" value={a.airDensityKgM3 === null ? <span className="text-fg-subtle">not available</span> : <span data-testid="analysis-air">{a.airDensityKgM3.toFixed(3)}</span>} unit={a.airDensityKgM3 === null ? undefined : 'kg/m³'} mono={a.airDensityKgM3 !== null} title="Standard atmosphere at the ambient altitude (and air temperature, if entered) of the flight conditions (airDensityFor)" />
      </Readouts>
      {noAltitude && (
        <Missing testId="analysis-altitude-missing">
          Maximum T/W needs the ambient altitude of the flight conditions, which is not entered.{' '}
          <LinkButton onClick={() => follow({ to: 'flight-field', elementId: 'flight-altitude' })}>Enter it under Flight setup</LinkButton>.
        </Missing>
      )}
      <p className={cn('border-b border-line/60 py-1.5 text-[12.5px] leading-relaxed', a.thrust.state === 'warning' ? 'text-warn' : a.thrust.state === 'unknown' ? 'text-fg-subtle' : 'text-fg')} data-testid="analysis-thrust" data-state={a.thrust.state} title="Full throttle, all motors sharing the sagging pack, each motor's thrust scaled from its reference density to the flight's (thrustIndicator, src/features/flight/indicators.ts)">
        {a.thrust.state === 'unknown' ? 'Not available: ' : ''}{a.thrust.detail}
      </p>
      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted">Per motor</h3>
      <p className="mb-1 text-[11.5px] leading-relaxed text-fg-subtle" data-testid="analysis-motor-max-none">
        Maximum thrust and current of each motor: not available. The flight test reports only the summed maximum T/W above.
      </p>
      {a.motorDensities.length === 0 ? (
        <Missing>No motor mounts on this frame.</Missing>
      ) : (
        <table className="w-full border-t border-line text-[12px]" data-testid="analysis-densities">
          <thead>
            <tr className="text-fg-subtle"><th className="py-1 text-left font-normal">Motor</th><th className="py-1 text-right font-normal" title="The air density the motor's thrust data was taken at">Reference density</th></tr>
          </thead>
          <tbody>
            {a.motorDensities.map((m) => (
              <tr key={m.partId} className="border-b border-line/60" data-testid="analysis-density-row">
                <td className="py-1 text-fg-muted">{m.name}</td>
                <td className="py-1 text-right" title={m.density?.source}>
                  {m.density ? (
                    <><span className="num">{m.density.kgM3.toPrecision(4)}</span> <span className="text-fg-subtle">kg/m³ · {m.density.from === 'condition' ? 'named in the data’s condition' : `entered for ${m.density.source}`}</span></>
                  ) : (
                    <span className="text-warn" data-testid="analysis-density-missing">not available: no source states it (see Ready to fly)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ---- 4. Electrical -------------------------------------------------------------------------------------

function ElectricalSection({ a, follow }: { a: Analysis; follow: (l: Target) => void }) {
  const r = a.electrical
  const findings = [...a.wiringFindings, ...a.assemblyFindings.filter((f) => ELECTRICAL_RULES.has(f.rule))]
  const load = a.loadCase
  return (
    <Section title="Electrical" testId="analysis-electrical">
      <p className="mb-1 text-[11.5px] leading-relaxed text-fg-subtle">
        Load case of the Electrical Designer&apos;s start: {load.mode === 'max' ? 'each motor at its stated maximum current' : 'each motor at a set current'}, battery at {load.battery === 'nominal' ? 'nominal voltage' : 'full charge'}, conductors at {load.conductorTempC} °C.{' '}
        <LinkButton onClick={() => follow({ to: 'electrical' })}>Change it in the Electrical Designer</LinkButton>
      </p>
      {r.problem || !r.battery ? (
        <Missing testId="analysis-electrical-none">Not available: {r.problem ?? 'there is no battery in the wiring.'}{' '}<LinkButton onClick={() => follow({ to: 'electrical' })}>Open the Electrical Designer</LinkButton></Missing>
      ) : (
        <Readouts>
          <CalcReadout label={`${r.battery.name}, open circuit`} c={r.battery.openCircuit} unit="V" testId="analysis-voc" />
          <CalcReadout label="Current drawn" c={r.battery.current} unit="A" digits={1} testId="analysis-current" />
          <CalcReadout label="Terminal voltage under load" c={r.battery.terminal} unit="V" testId="analysis-terminal" />
          <CalcReadout label="Total loss (battery and power cables)" c={r.totalLoss} unit="W" digits={1} testId="analysis-loss" />
          {r.ratings.map((x, i) => (
            <Readout key={`${x.partId}-${i}`} label={`${x.name} · ${x.what}`} mono={false} title={x.current.value === null ? x.current.reason : x.rated.value === null ? x.rated.reason : undefined}
              value={<span data-testid="analysis-rating" data-within={String(x.within)} className={cn(x.within === false && 'text-fault')}>{x.current.value === null ? 'not available' : `${x.current.value.toFixed(1)} A`} of {x.rated.value === null ? 'not available' : `${x.rated.value.toFixed(1)} A`}</span>} />
          ))}
        </Readouts>
      )}
      {findings.length === 0 ? <p className="py-1.5 text-[12px] text-ok">No electrical findings.</p> : <FindingList findings={findings} follow={follow} testId="analysis-electrical-findings" />}
    </Section>
  )
}

// ---- 5. Readiness --------------------------------------------------------------------------------------

function ReadinessSection({ a, follow }: { a: Analysis; follow: (l: Target) => void }) {
  const c = a.conditions
  const cutoff = c.cutoffValue === null ? null : `${c.cutoffValue} ${c.cutoffType === 'voltageV' ? 'V' : 'mAh'}`
  return (
    <Section title="Readiness" testId="analysis-readiness" count={a.ready.length + a.conditionBlockers.length}>
      <h3 className="mb-1 text-[12px] font-medium text-fg-muted">Ready to fly</h3>
      {a.ready.length === 0 ? (
        <p className="flex items-center gap-2 border-t border-line py-2 text-[12.5px] text-ok" data-testid="analysis-ready-ok"><CircleCheck className="size-3.5" /> Every value the simulation needs is stated or entered.</p>
      ) : (
        <ul className="border-t border-line" data-testid="analysis-ready-list">
          {a.ready.map((item) => <Item key={item.id} testId="analysis-ready-item" id={item.id} label={item.label} detail={item.detail} onClick={item.link ? () => follow(item.link!) : undefined} />)}
        </ul>
      )}
      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted">Flight conditions</h3>
      <Readouts>
        <Readout label="Ambient altitude" value={c.ambientAltitudeM === null ? <span className="text-fg-subtle">not entered</span> : c.ambientAltitudeM} unit={c.ambientAltitudeM === null ? undefined : 'm'} mono={c.ambientAltitudeM !== null} />
        <Readout label="Air temperature" value={c.temperatureC === null ? <span className="text-fg-subtle">standard atmosphere</span> : c.temperatureC} unit={c.temperatureC === null ? undefined : '°C'} mono={c.temperatureC !== null} />
        <Readout label={`Battery cut-off (${c.cutoffType === 'voltageV' ? 'pack voltage' : 'charge drawn'})`} value={cutoff ?? <span className="text-fg-subtle">not entered</span>} mono={cutoff !== null} />
      </Readouts>
      {a.conditionBlockers.length === 0 ? (
        <p className="flex items-center gap-2 py-1.5 text-[12.5px] text-ok" data-testid="analysis-conditions-ok"><CircleCheck className="size-3.5" /> The flight conditions are entered.</p>
      ) : (
        <ul data-testid="analysis-conditions-missing">
          {a.conditionBlockers.map((item) => <Item key={item.id} testId="analysis-condition-item" id={item.id} label={item.label} detail={item.detail} onClick={item.link ? () => follow(item.link!) : undefined} />)}
        </ul>
      )}
    </Section>
  )
}
