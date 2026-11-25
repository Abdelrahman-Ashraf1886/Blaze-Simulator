import { useEffect } from 'react'
import { Link } from 'react-router'
import { FRAME_SPECS } from '../../../electron/ipc/contract'
import { EngineState } from '@/components/engine-state'
import { FrameGlyph } from '@/components/frame-glyph'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { Table, Td, Th } from '@/components/table'
import { cn, formatTimestamp } from '@/lib/utils'
import { useProjects } from '@/stores/projects'
import { useSystem } from '@/stores/system'
import { CreateProjectDialog } from '../projects/CreateProjectDialog'

const RECENT_LIMIT = 8

export function DashboardPage() {
  const projects = useProjects((s) => s.projects)
  const projectsError = useProjects((s) => s.error)
  const status = useSystem((s) => s.status)
  const engine = useSystem((s) => s.engine)
  const runs = useSystem((s) => s.runs)
  const systemError = useSystem((s) => s.error)

  useEffect(() => {
    void useProjects.getState().load()
    void useSystem.getState().refresh()
  }, [])

  const recent = projects.slice(0, RECENT_LIMIT)
  const connected = engine?.state === 'connected'
  const latency = connected ? (engine?.latencyMs ?? null) : null

  return (
    <>
      <PageHeader title="Dashboard" actions={<CreateProjectDialog />} />

      <div className="mx-auto grid w-full max-w-[1600px] gap-x-10 gap-y-8 px-6 pb-10 pt-5 @min-[880px]:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
        <div className="min-w-0 space-y-8">
          <Section
            title="Recent projects"
            count={projects.length}
            testId="recent-projects"
            actions={
              projects.length > RECENT_LIMIT ? (
                <Link to="/projects" className="text-[12.5px] text-accent hover:underline">
                  View all
                </Link>
              ) : undefined
            }
          >
            {projectsError ? (
              <EmptyState>Could not load projects: {projectsError}</EmptyState>
            ) : recent.length === 0 ? (
              <EmptyState>No projects yet.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th className="w-full">Name</Th>
                    <Th className="hidden @min-[440px]:table-cell">Frame</Th>
                    <Th>Modified</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id} data-testid="project-row">
                      <Td className="max-w-0">
                        <Link
                          to={`/workshop/${p.id}`}
                          className="flex min-w-0 items-center gap-2.5 hover:text-accent"
                          title={`Open ${p.name} in the workshop`}
                        >
                          <FrameGlyph type={p.frameType} className="size-4 shrink-0 text-fg-subtle" />
                          <span className="truncate">{p.name}</span>
                        </Link>
                      </Td>
                      <Td className="hidden text-fg-muted @min-[440px]:table-cell">{FRAME_SPECS[p.frameType].name}</Td>
                      <Td className="num text-fg-muted">{formatTimestamp(p.updatedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          <Section title="Simulation history" testId="simulation-history">
            {runs.length === 0 ? (
              <EmptyState>No simulation runs yet. Recording flights comes with telemetry (Phase 7).</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th className="w-full">Project</Th>
                    <Th>Started</Th>
                    <Th className="text-right">Duration</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <Td className="max-w-0 truncate" title={r.projectName}>
                        {r.projectName}
                      </Td>
                      <Td className="num text-fg-muted">{formatTimestamp(r.startedAt)}</Td>
                      <Td className="num text-right">
                        {r.durationS.toFixed(1)}
                        <span className="ml-1 text-fg-subtle">s</span>
                      </Td>
                      <Td className="text-fg-muted">{r.status}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </div>

        <aside
          data-testid="system-status"
          aria-label="System status"
          className="min-w-0 space-y-8 @min-[880px]:border-l @min-[880px]:border-line @min-[880px]:pl-8"
        >
          <Section title="Simulation engine">
            {systemError && <p className="pb-2 text-[12.5px] text-fault">{systemError}</p>}
            <Readouts>
              <Readout label="State" mono={false} value={engine ? <EngineState state={engine.state} /> : '—'} />
              <Readout
                label="Round trip"
                value={latency !== null ? latency.toFixed(2) : '—'}
                unit={latency !== null ? 'ms' : undefined}
                title="Round trip of the last health ping between the app and the engine process"
              />
              <Readout label="Version" value={engine?.engineVersion ?? '—'} />
              <Readout label="Protocol" value={engine?.protocolVersion != null ? `v${engine.protocolVersion}` : '—'} />
              <Readout label="Threads" value={engine?.threads ?? '—'} />
              <Readout label="Restarts" value={engine?.restarts ?? 0} />
            </Readouts>
            {engine?.lastError && !connected && (
              <p
                className={cn('mt-2 break-words text-[12px]', engine.state === 'failed' ? 'text-fault' : 'text-warn')}
                data-selectable
              >
                {engine.lastError}
              </p>
            )}
          </Section>

          <Section title="Workspace">
            <Readouts>
              <Readout label="Projects" value={projects.length} />
              <Readout label="Components" value={status?.componentCount ?? '—'} />
              <Readout label="Schema" value={status ? `v${status.database.schemaVersion}` : '—'} />
            </Readouts>
            {status && (
              <p
                className="num mt-2 truncate text-[11.5px] text-fg-subtle"
                title={status.database.path}
                data-selectable
              >
                {status.database.path}
              </p>
            )}
          </Section>
        </aside>
      </div>
    </>
  )
}
