import { useId, useState } from 'react'
import type { DatabaseBackup, DataOverview, DiagnosticsPreview, SystemStatus } from '../../../electron/ipc/contract'
import { Readout, Readouts, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { getApi, unwrap } from '@/services/api'

export type Load<T> = { data: T } | { error: string } | null
export type Feedback = { message: string; error?: boolean }

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useSettingsAction() {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  async function run(failure: string, task: () => string | Promise<string>) {
    setBusy(true)
    setFeedback(null)
    try {
      setFeedback({ message: await task() })
    } catch (error) {
      setFeedback({ message: `${failure} ${errorText(error)}`, error: true })
    } finally {
      setBusy(false)
    }
  }
  return { busy, feedback, run }
}

function ActionFeedback({ feedback }: { feedback: Feedback | null }) {
  return (
    <>
      <p role="status" className="break-words text-fg-muted">{!feedback?.error && feedback?.message}</p>
      {feedback?.error && <p role="alert" className="break-words text-warn">{feedback.message}</p>}
    </>
  )
}

function describe<T>(result: Load<T>, format: (data: T) => string): string {
  if (!result) return 'Loading…'
  return 'error' in result ? 'Unavailable' : format(result.data)
}

function bytes(value: number): string {
  return `${value.toLocaleString()} B`
}

function LoadError({ result, label }: { result: Load<unknown>; label: string }) {
  return result && 'error' in result
    ? <p role="alert" className="break-words text-warn">Could not load {label}. {result.error}</p>
    : null
}

export function DataSection({ overview, recordings, backups }: {
  overview: Load<DataOverview>
  recordings: Load<number>
  backups: Load<DatabaseBackup[]>
}) {
  const action = useSettingsAction()
  return (
    <Section title="Data" className="max-w-prose space-y-2 text-[13px]">
      <dl>
        <dt className="text-fg-muted">Data folder</dt>
        <dd className="break-all">{describe(overview, (data) => data.path)}</dd>
      </dl>
      <Readouts>
        <Readout label="Database file" value={describe(overview, (data) => bytes(data.databaseBytes))} />
        <Readout label="Models" value={describe(overview, (data) => bytes(data.modelBytes))} />
        <Readout label="Terrain" value={describe(overview, (data) => bytes(data.terrainBytes))} />
        <Readout label="Recordings" value={describe(recordings, bytes)} />
        <Readout label="Backups (migration copies)" value={describe(backups, (copies) =>
          bytes(copies.reduce((total, copy) => total + copy.bytes, 0)))} />
      </Readouts>
      <LoadError result={overview} label="the data overview" />
      <LoadError result={recordings} label="the recordings size" />
      <Button type="button" disabled={action.busy} onClick={() => void action.run('Could not open the data folder.', async () => {
        unwrap(await getApi().dataOverview('open-folder'))
        return 'Data folder opened.'
      })}>Open data folder</Button>
      <ActionFeedback feedback={action.feedback} />
    </Section>
  )
}

export function RestoreConfirmation({ backup }: { backup: DatabaseBackup }) {
  return (
    <div className="space-y-2 text-[13px]">
      <p>This will replace the current database with the schema v{backup.version} copy from <time dateTime={backup.time}>{backup.time}</time>.</p>
      <p>The copy contains database rows such as projects, settings stored in the database, and recording entries. Models, terrain and recording files are not in a database copy.</p>
      <p>The app restarts after restore.</p>
    </div>
  )
}

function RestoreCopy({ backup }: { backup: DatabaseBackup }) {
  const action = useSettingsAction()
  const [open, setOpen] = useState(false)
  const [restored, setRestored] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!action.busy && !restored) setOpen(next)
    }}>
      <DialogTrigger asChild>
        <Button type="button" aria-label={`Restore schema v${backup.version} copy from ${backup.time}`}>Restore</Button>
      </DialogTrigger>
      <DialogContent title="Restore database copy?" description="Review what will be restored before continuing.">
        <RestoreConfirmation backup={backup} />
        <ActionFeedback feedback={action.feedback} />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <DialogClose asChild><Button type="button" disabled={action.busy || restored}>Cancel</Button></DialogClose>
          <Button type="button" disabled={action.busy || restored} onClick={() =>
            void action.run('Could not restore the database copy.', async () => {
              unwrap(await getApi().database.restore(backup.id))
              setRestored(true)
              return 'Database restored. Restarting the app…'
            })}>{action.busy ? 'Restoring…' : 'Restore database'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function DatabaseCopiesSection({ backups }: { backups: Load<DatabaseBackup[]> }) {
  return (
    <Section title="Database copies" className="max-w-prose text-[13px]">
      {!backups && <p role="status">Loading database copies…</p>}
      <LoadError result={backups} label="database copies" />
      {backups && 'data' in backups && (backups.data.length === 0
        ? <p>No database copies yet. Copies are created before a database migration.</p>
        : <ul className="divide-y divide-line border-y border-line">
          {backups.data.map((backup) => (
            <li key={backup.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p>Schema v{backup.version} · {bytes(backup.bytes)}</p>
                <time className="text-fg-muted" dateTime={backup.time}>{backup.time}</time>
              </div>
              <RestoreCopy backup={backup} />
            </li>
          ))}
        </ul>)}
    </Section>
  )
}

export function DiagnosticsSection({ preview, includeDatabase, busy, feedback, onPreview, onInclude, onSave }: {
  preview: Load<DiagnosticsPreview>
  includeDatabase: boolean
  busy: boolean
  feedback: Feedback | null
  onPreview: () => void
  onInclude: (enabled: boolean) => void
  onSave: () => void
}) {
  const openLogs = useSettingsAction()
  const previewId = useId()
  return (
    <Section title="Logs and diagnostics" className="max-w-prose text-[13px]">
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={openLogs.busy} onClick={() => void openLogs.run('Could not open the log folder.', async () => {
          unwrap(await getApi().diagnostics.openLogFolder())
          return 'Log folder opened.'
        })}>Open log folder</Button>
        <Button type="button" aria-controls={previewId} aria-disabled={busy}
          onClick={() => { if (!busy) onPreview() }}>Preview diagnostics</Button>
      </div>
      <ActionFeedback feedback={openLogs.feedback} />
      <div id={previewId} className="space-y-2">
        {(preview || busy) && (
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-accent" checked={includeDatabase} disabled={busy}
              onChange={(event) => onInclude(event.target.checked)} />
            Include database
          </label>
        )}
        {busy && !preview && <p role="status">Loading diagnostics contents…</p>}
        <LoadError result={preview} label="diagnostics contents" />
        {preview && 'data' in preview && (
          <>
            <p className="font-medium">Diagnostics contents</p>
            <ul className="list-disc space-y-1 pl-5">
              {preview.data.entries.map(({ name, description }) => (
                <li key={name}><span className="num">{name}</span> <span className="text-fg-muted">— {description}</span></li>
              ))}
            </ul>
            <Button type="button" disabled={busy} onClick={onSave}>{busy ? 'Saving diagnostics…' : 'Save diagnostics'}</Button>
          </>
        )}
        <ActionFeedback feedback={feedback} />
      </div>
    </Section>
  )
}

export function RecordingSection({ enabled, feedback, onChange }: {
  enabled: boolean
  feedback: Feedback | null
  onChange: (enabled: boolean) => void
}) {
  return (
    <Section title="Recording" className="max-w-prose space-y-2 text-[13px]">
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-accent" checked={enabled}
          onChange={(event) => onChange(event.target.checked)} />
        Record runs
      </label>
      <p className="text-fg-muted">Default for flight, scenarios and step tests.</p>
      <ActionFeedback feedback={feedback} />
    </Section>
  )
}

export function AboutSection({ app, engine, error }: {
  app: SystemStatus['app'] | undefined
  engine: SystemStatus['engine'] | null
  error: string | null
}) {
  const action = useSettingsAction()
  return (
    <Section title="About" className="max-w-prose space-y-2 text-[13px]">
      <Readouts>
        <Readout label="App" value={app?.version ?? (error ? 'Unavailable' : 'Loading…')} />
        <Readout label="Engine" value={engine?.engineVersion ?? 'Unavailable'} />
        <Readout label="Protocol" value={engine?.protocolVersion == null ? 'Unavailable' : `v${engine.protocolVersion}`} />
        <Readout label="Electron" value={app?.electron ?? (error ? 'Unavailable' : 'Loading…')} />
      </Readouts>
      {error && <p role="alert" className="break-words text-warn">Could not load version information. {error}</p>}
      <p>All rights reserved</p>
      <Button type="button" disabled={action.busy} onClick={() => void action.run('Could not open third-party notices.', async () => {
        unwrap(await getApi().dataOverview('open-notices'))
        return 'Third-party notices opened.'
      })}>Open third-party notices</Button>
      <ActionFeedback feedback={action.feedback} />
    </Section>
  )
}
