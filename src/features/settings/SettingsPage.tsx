import { useEffect, useState } from 'react'
import type {
  DatabaseBackup, DataOverview, DiagnosticsPreview, GraphicsCommand, GraphicsStatus, IpcResult,
} from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { readPref, readRecordRuns, writeRecordRuns } from '@/lib/prefs'
import { getApi, unwrap } from '@/services/api'
import { useSystem } from '@/stores/system'
import { GraphicsSection } from './GraphicsSection'
import {
  AboutSection, DataSection, DatabaseCopiesSection, DiagnosticsSection, RecordingSection,
  errorText, useSettingsAction, type Feedback, type Load,
} from './SettingsSections'
import { getDrawingRenderer } from './drawing-renderer'

async function load<T>(request: () => Promise<IpcResult<T>>): Promise<NonNullable<Load<T>>> {
  try {
    return { data: unwrap(await request()) }
  } catch (error) {
    return { error: errorText(error) }
  }
}

export function SettingsPage() {
  const [status, setStatus] = useState<GraphicsStatus | null>(null)
  const [onBattery, setOnBattery] = useState<boolean | null>(null)
  const [renderer, setRenderer] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [graphicsFeedback, setGraphicsFeedback] = useState<string>()
  const [overview, setOverview] = useState<Load<DataOverview>>(null)
  const [recordings, setRecordings] = useState<Load<number>>(null)
  const [backups, setBackups] = useState<Load<DatabaseBackup[]>>(null)
  const [includeDatabase, setIncludeDatabase] = useState(false)
  const [preview, setPreview] = useState<Load<DiagnosticsPreview>>(null)
  const diagnostics = useSettingsAction()
  const [recordRuns, setRecordRuns] = useState(readRecordRuns)
  const [recordingFeedback, setRecordingFeedback] = useState<Feedback | null>(null)
  const app = useSystem((system) => system.status?.app)
  const engine = useSystem((system) => system.engine)
  const systemError = useSystem((system) => system.error)

  useEffect(() => {
    const probeFrame = requestAnimationFrame(() => setRenderer(getDrawingRenderer()))
    const api = getApi()
    const graphics = api.graphics
    const unsubscribe = graphics.onPowerChange(setOnBattery)
    let active = true
    void load(() => api.dataOverview('read')).then((result) => { if (active) setOverview(result) })
    void load(() => api.database.listBackups()).then((result) => { if (active) setBackups(result) })
    void load(() => {
      if (!api.recording) throw new Error('Recording storage is unavailable.')
      return api.recording.totalSize()
    }).then((result) => { if (active) setRecordings(result) })
    void graphics.status().then((result) => {
      if (active) setStatus(unwrap(result))
    }).catch((error: unknown) => {
      if (active) setError(`Could not load the graphics preference. ${errorText(error)}`)
    })
    return () => {
      active = false
      cancelAnimationFrame(probeFrame)
      unsubscribe()
    }
  }, [])

  async function command(input: GraphicsCommand) {
    setBusy(true)
    setError(null)
    setGraphicsFeedback(undefined)
    try {
      unwrap(await getApi().graphics.command(input))
      if (input.action === 'set') {
        const preference = input.preference
        setStatus((current) => current && { ...current, preference })
        setGraphicsFeedback('Preference saved.')
        setBusy(false)
      } else {
        setGraphicsFeedback('Restarting the app…')
      }
    } catch (error) {
      const message = input.action === 'set' ? 'Could not save the graphics preference.' : 'Could not restart the app.'
      setError(`${message} ${errorText(error)}`)
      setBusy(false)
    }
  }

  async function previewDiagnostics(enabled: boolean) {
    setIncludeDatabase(enabled)
    setPreview(null)
    await diagnostics.run('Could not preview diagnostics.', async () => {
      const result = await load(() => getApi().diagnostics.save({ action: 'preview', includeDatabase: enabled }))
      setPreview(result)
      return 'data' in result ? 'Diagnostics contents ready.' : ''
    })
  }

  function saveDiagnostics() {
    if (!preview || !('data' in preview) || diagnostics.busy) return
    void diagnostics.run('Could not save diagnostics.', async () => {
      const saved = unwrap(await getApi().diagnostics.save({ action: 'save', includeDatabase }))
      return saved ? `Diagnostics saved to ${saved.path}` : 'Diagnostics save canceled.'
    })
  }

  function updateRecording(enabled: boolean) {
    writeRecordRuns(enabled)
    // The shared writer suppresses storage errors. Check the saved value without its default.
    if (readPref<boolean | null>('record-runs', null) !== enabled) {
      setRecordingFeedback({ message: 'Could not save the recording preference.', error: true })
      return
    }
    setRecordRuns(enabled)
    setRecordingFeedback({ message: enabled ? 'Recording is on by default.' : 'Recording is off by default.' })
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="mx-auto grid max-w-[1600px] items-start gap-x-10 gap-y-6 px-6 py-5 @min-[880px]:grid-cols-2">
        <DataSection overview={overview} recordings={recordings} backups={backups} />
        <DatabaseCopiesSection backups={backups} />
        <DiagnosticsSection preview={preview} includeDatabase={includeDatabase} busy={diagnostics.busy}
          feedback={diagnostics.feedback} onPreview={() => void previewDiagnostics(includeDatabase)}
          onInclude={(enabled) => void previewDiagnostics(enabled)} onSave={saveDiagnostics} />
        <GraphicsSection
          status={status && { ...status, onBattery: onBattery ?? status.onBattery }}
          renderer={renderer}
          busy={busy}
          error={error}
          feedback={graphicsFeedback}
          onSelect={(preference) => void command({ action: 'set', preference })}
          onRestart={() => void command({ action: 'restart' })}
        />
        <RecordingSection enabled={recordRuns} feedback={recordingFeedback} onChange={updateRecording} />
        <AboutSection app={app} engine={engine} error={systemError} />
      </div>
    </>
  )
}
