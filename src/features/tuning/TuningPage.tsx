import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { AssemblyDocument, Project } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { useComponents } from '@/stores/components'
import { useProjects } from '@/stores/projects'
import { useSystem } from '@/stores/system'
import { buildFrame } from '@/three/frame-geometry'
import { useAssembly } from '../workshop/assembly-store'
import { useAssets } from '../workshop/asset-store'
import { useComponentIndex } from '../workshop/component-index'
import { focusWhenPresent, useFollow } from '../flight/FlightSetup'
import { conditionsOf, enginePayload, flightGate } from '../flight/readiness'
import { StepTestPanel } from './StepTestPanel'
import { TuningPanel } from './TuningPanel'

export default function TuningPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)
  useEffect(() => { void useProjects.getState().load() }, [])
  if (!projectId) return <>
    <PageHeader title="Tuning" />
    <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
      <Section title="Open a project" count={projects.length}>
        {error ? <EmptyState>{error}</EmptyState> : projects.length === 0 ? <EmptyState>{loading ? 'Loading…' : 'No projects yet. Create one on the Dashboard.'}</EmptyState> :
          <ul className="border-t border-line">{projects.map((p) => <li key={p.id} className="border-b border-line/60"><Link to={`/tuning/${p.id}`} className="block py-2 text-[13px] hover:text-accent">{p.name}</Link></li>)}</ul>}
      </Section>
    </div>
  </>
  const project = projects.find((p) => p.id === projectId)
  if (!project) return <EmptyState>{error ?? (loading ? 'Loading…' : 'This project no longer exists.')}</EmptyState>
  return <LoadTuning key={project.id} project={project} />
}

function LoadTuning({ project }: { project: Project }) {
  const doc = useAssembly((s) => s.projectId === project.id ? s.doc : null)
  const assemblyError = useAssembly((s) => s.projectId === project.id ? s.error : null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    async function load() {
      await useAssembly.getState().flush()
      if (!alive) return
      if (useAssembly.getState().projectId !== project.id || !useAssembly.getState().doc) await useAssembly.getState().load(project.id)
      if (!alive) return
      await Promise.all([useComponents.getState().load(), useAssets.getState().load()])
      if (!alive) return
      const componentError = useComponents.getState().error
      if (componentError) throw new Error(componentError)
      setReady(true)
    }
    void load().catch((e: unknown) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [project.id])

  if (error || assemblyError) return <EmptyState>{error ?? assemblyError}</EmptyState>
  if (!ready || !doc) return <EmptyState>Loading build…</EmptyState>
  return <ProjectTuning project={project} doc={doc} />
}

function ProjectTuning({ project, doc }: { project: Project; doc: AssemblyDocument }) {
  const navigate = useNavigate()
  const follow = useFollow(project.id)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const engineReady = useSystem((s) => s.engine?.state === 'connected')
  const geo = useMemo(() => buildFrame(project.frameType, doc.frame, doc.motors), [doc, project.frameType])
  const gate = useMemo(() => flightGate(enginePayload(doc, geo, components, assets), conditionsOf(doc)), [doc, geo, components, assets])

  return <>
    <PageHeader title={`${project.name} · Tuning`} />
    <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
      <TuningPanel projectId={project.id} gainsAffectFlights renderStepTest={(tuning) => (
        <div className="space-y-3">
          <Section title="Step test readiness">
            {gate.ok ? <Readouts>
              <Readout label="Air density" value={gate.input.airDensityKgM3} unit="kg/m³" />
              <Readout label="Battery cut-off" value={gate.input.cutoff.value} unit={gate.input.cutoff.type === 'voltageV' ? 'V' : 'mAh'} />
            </Readouts> : (
              <ul className="border-t border-line text-[12.5px]">
                {gate.blockers.map(({ id, label, detail, link }) => (
                  <li key={id} className="border-b border-line/60 py-2">
                    {link ? <button type="button" className="text-left text-accent" onClick={() => {
                      if (link.to === 'flight-field') {
                        void navigate(`/flight/${project.id}`)
                        focusWhenPresent(link.elementId)
                      } else follow(link)
                    }}>{label}</button> : label}
                    <p className="text-fg-muted">{detail}</p>
                  </li>
                ))}
              </ul>
            )}
            {!engineReady && <p className="pt-2 text-[12.5px] text-warn">The engine is not connected.</p>}
          </Section>
          <StepTestPanel gate={gate} engineReady={engineReady} {...tuning} />
        </div>
      )} />
    </div>
  </>
}
