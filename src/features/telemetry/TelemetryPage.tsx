import { useEffect, useRef, useState } from 'react'
import type { DesktopApi, RecordingRun, RecordingSummary } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { RunGraphs } from './RunGraphs'

function title(run: RecordingRun) {
  return run.title ?? run.projectName
}

function status(run: RecordingRun) {
  return [
    run.open ? 'Recording' : run.status,
    run.incomplete ? 'incomplete' : null,
    run.fileMissing ? 'recording file missing' : null,
  ].filter(Boolean).join(' · ')
}

function bytes(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString()} B`
}

interface RunList {
  runs: RecordingRun[]
  errors: string[]
  total?: number
}

async function loadRuns(api: DesktopApi, list: NonNullable<DesktopApi['runs']['list']>): Promise<RunList> {
  const projects = await api.projects.list()
  if (!projects.ok) return { runs: [], errors: [projects.error.message] }
  const results = await Promise.allSettled(projects.data.map(({ id }) => list(id)))
  const runs: RecordingRun[] = []
  const errors: string[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(String(result.reason))
    else if (result.value.ok) runs.push(...result.value.data)
    else errors.push(result.value.error.message)
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return { runs, errors }
}

function RunDetail({ run: listed, api, onClose }: { run: RecordingRun; api: DesktopApi; onClose: () => void }) {
  const [detail, setDetail] = useState<{ run: RecordingRun; summary?: RecordingSummary; error?: string }>()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    let stale = false
    async function open() {
      let run = listed
      try {
        if (api.runs.get) {
          const result = await api.runs.get(run.id)
          if (stale) return
          if (!result.ok) {
            setDetail({ run, error: result.error.message })
            return
          }
          run = result.data
        }
        if (!run.fileName || run.fileMissing || !api.recording) {
          setDetail({ run })
          return
        }
        const result = await api.recording.summary(run.id)
        if (!stale) setDetail(result.ok ? { run, summary: result.data } : { run, error: result.error.message })
      } catch (error) {
        if (!stale) setDetail({ run, error: String(error) })
      }
    }
    void open()
    return () => { stale = true }
  }, [api, listed])

  const run = detail?.run ?? listed
  const summary = detail?.summary
  const header = summary?.header
  const facts = [
    ['Project', header?.projectName ?? run.projectName],
    ['Kind', header?.kind ?? run.kind],
    ['Started', new Date(header?.startedAt ?? run.startedAt).toLocaleString()],
    ['Duration', `${summary?.end?.elapsedS ?? run.durationS} s`],
    ['Size', bytes(summary?.bytes ?? run.bytes)],
    ['Status', status({ ...run, incomplete: summary?.incomplete || run.incomplete })],
    ['Samples', summary?.sampleCount ?? run.sampleCount],
    ['Engine', header?.engineVersion ?? run.engineVersion],
    ['App', header?.appVersion],
    ['Protocol', header?.protocolVersion],
    ['Sample period', header ? `${header.samplePeriodSteps} steps × ${header.stepLengthS} s` : undefined],
    ['Run ended', summary?.end?.reason ?? run.endReason],
    ['State hash', summary?.end?.finalStateHash ?? run.stateHash],
  ] as const

  return (
    <section aria-label="Selected run" className="grid min-w-0 gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} className="min-w-0 break-words text-base font-semibold">{header?.title ?? title(run)}</h2>
        <Button size="sm" onClick={onClose}>Back to runs</Button>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
        {facts.map(([label, value]) => value != null && (
          <div key={label} className="min-w-0">
            <dt className="text-fg-muted">{label}</dt><dd className="num break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {!detail && <p role="status">Loading recording…</p>}
      {run.fileMissing && <p role="status" className="text-warn">The recording file is missing.</p>}
      {!run.fileName && <p className="text-fg-muted">No recording file was saved for this run.</p>}
      {summary?.incomplete && <p className="text-warn">This recording is incomplete. Available samples are shown.</p>}
      {summary && !header && <p className="text-warn">The recording header is unavailable.</p>}
      {summary?.integrityError && <p role="alert" className="text-warn">{summary.integrityError}</p>}
      {summary?.end?.engineError && <p role="alert" className="text-fault">{summary.end.engineError}</p>}
      {detail?.error && <p role="alert" className="text-fault">{detail.error}</p>}
      {summary && header && api.recording && <RunGraphs id={run.id} api={api.recording} summary={summary} />}
    </section>
  )
}

export default function TelemetryPage() {
  const [list, setList] = useState<RunList>()
  const [openedId, setOpenedId] = useState<string>()
  const returnFocus = useRef<string | undefined>(undefined)
  const opened = list?.runs.find(({ id }) => id === openedId)
  const [deleting, setDeleting] = useState<RecordingRun | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let stale = false
    const api = window.api
    async function refresh() {
      if (!api?.runs.list || !api.recording) {
        setList({ runs: [], errors: ['Recording storage is unavailable.'] })
        return
      }
      const [history, total] = await Promise.allSettled([loadRuns(api, api.runs.list), api.recording.totalSize()])
      if (stale) return
      const next = history.status === 'fulfilled' ? history.value : { runs: [], errors: [String(history.reason)] }
      if (total.status === 'rejected') next.errors.push(String(total.reason))
      else if (!total.value.ok) next.errors.push(total.value.error.message)
      else next.total = total.value.data
      setList(next)
    }
    void refresh()
    return () => { stale = true }
  }, [revision])

  async function deleteRun() {
    const remove = window.api?.runs.delete
    if (!deleting || !remove || deletePending) return
    setDeletePending(true)
    setDeleteError(undefined)
    try {
      const result = await remove(deleting.id)
      if (!result.ok) {
        setDeleteError(result.error.message)
        return
      }
      setDeleting(null)
      setList((previous) => previous && { ...previous, runs: previous.runs.filter(({ id }) => id !== deleting.id) })
      setRevision((value) => value + 1)
    } catch (error) {
      setDeleteError(String(error))
    } finally {
      setDeletePending(false)
    }
  }

  return (
    <>
      <PageHeader title="Telemetry" count={list?.runs.length} actions={
        <Button size="sm" onClick={() => setRevision((value) => value + 1)}>Refresh runs</Button>
      } />
      <div className="mx-auto grid max-w-[1600px] gap-4 px-6 py-4">
        <p className="text-fg-muted">Total on disk · <span className="num text-fg">{bytes(list?.total ?? null)}</span></p>
        {!list && <p role="status">Loading runs…</p>}
        {list?.errors.map((error, i) => <p key={i} role="alert" className="text-fault">{error}</p>)}
        {list?.runs.length === 0 && list.errors.length === 0 && <p className="text-fg-muted">No runs yet.</p>}
        {opened ? <RunDetail key={opened.id} run={opened} api={window.api} onClose={() => {
          returnFocus.current = opened.id
          setOpenedId(undefined)
        }} /> : !!list?.runs.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">Runs across all projects</caption>
              <thead className="border-b border-line text-fg-muted"><tr>
                {['Run', 'Project', 'Kind', 'Started', 'Duration', 'Size', 'Status'].map((label) => (
                  <th key={label} scope="col" className="px-2 py-1 font-medium">{label}</th>
                ))}
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>{list.runs.map((run) => (
                <tr key={run.id} className="border-b border-line">
                  <th scope="row" className="px-2 py-1 font-medium">
                    <button type="button" className="text-left text-accent hover:underline"
                      ref={(node) => {
                        if (node && returnFocus.current === run.id) {
                          returnFocus.current = undefined
                          node.focus()
                        }
                      }} onClick={() => setOpenedId(run.id)}>{title(run)}</button>
                  </th>
                  <td className="px-2">{run.projectName}</td>
                  <td className="px-2">{run.kind ?? '—'}</td>
                  <td className="num px-2">{new Date(run.startedAt).toLocaleString()}</td>
                  <td className="num whitespace-nowrap px-2">{run.durationS} s</td>
                  <td className="num whitespace-nowrap px-2">{bytes(run.bytes)}</td>
                  <td className={`px-2 capitalize ${run.status === 'failed' && !run.open ? 'text-fault' : ''}`}>{status(run)}</td>
                  <td className="px-2 py-1">
                    <Button size="sm" variant="ghost" disabled={run.open}
                      aria-label={`Delete ${title(run)}`} onClick={() => { setDeleteError(undefined); setDeleting(run) }}>Delete</Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {deleting && (
        <Dialog open onOpenChange={(open) => { if (!open && !deletePending) setDeleting(null) }}>
          <DialogContent title={`Delete ${title(deleting)}?`} description="This permanently deletes the saved run and its recording file.">
            {deleteError && <p role="alert" className="text-fault">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <DialogClose asChild><Button disabled={deletePending}>Cancel</Button></DialogClose>
              <Button variant="danger" disabled={deletePending} onClick={() => { void deleteRun() }}>Delete run</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
