import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { GPU_PREFERENCES, type DatabaseBackup, type DiagnosticsPreview, type GraphicsStatus, type SystemStatus } from '../../electron/ipc/contract'
import { readRecordRuns } from '../../src/lib/prefs'

type Load<T> = { data: T } | { error: string } | null
type Feedback = { message: string; error?: boolean }
let server: ViteDevServer
let sections: Awaited<ReturnType<ViteDevServer['ssrLoadModule']>>
let SettingsPage: ComponentType
let GraphicsSection: ComponentType<{
  status: GraphicsStatus | null
  renderer: string | null | undefined
  busy: boolean
  error: string | null
  onSelect: () => void
  onRestart: () => void
}>

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-settings-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  const [graphicsModule, sectionsModule, pageModule] = await Promise.all([
    server.ssrLoadModule('/src/features/settings/GraphicsSection.tsx'),
    server.ssrLoadModule('/src/features/settings/SettingsSections.tsx'),
    server.ssrLoadModule('/src/features/settings/SettingsPage.tsx'),
  ])
  GraphicsSection = graphicsModule.GraphicsSection as typeof GraphicsSection
  sections = sectionsModule
  SettingsPage = pageModule.SettingsPage as typeof SettingsPage
})

afterAll(async () => server?.close())

function render(status: GraphicsStatus | null, renderer: string | null | undefined, error: string | null = null) {
  return renderToStaticMarkup(createElement(GraphicsSection, {
    status,
    renderer,
    busy: false,
    error,
    onSelect: () => {},
    onRestart: () => {},
  }))
}

it.each(GPU_PREFERENCES)('renders %s as the selected preference on battery', (preference) => {
  const markup = render({ preference, startupPreference: 'high-performance', onBattery: true }, 'NVIDIA GeForce GTX 1650')
  expect(markup).toContain('Graphics')
  expect(markup).toContain('NVIDIA GeForce GTX 1650')
  expect(markup).toContain('>Battery<')
  expect(markup).toContain(`checked="" value="${preference}"`)
  if (preference === 'high-performance') {
    expect(markup).toContain('while you’re on battery')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Restart now/)
  } else {
    expect(markup).not.toContain('while you’re on battery')
    expect(markup).toContain('Preference saved.')
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Restart now/)
  }
})

it('shows plugged-in power and an unavailable renderer without a battery note', () => {
  const markup = render({ preference: 'high-performance', startupPreference: 'system', onBattery: false }, null)
  expect(markup).toContain('>Plugged in<')
  expect(markup).toContain('>Unavailable<')
  expect(markup).not.toContain('while you’re on battery')
})

it('renders the pending and error states without a selected preference', () => {
  expect(render(null, undefined)).toContain('Detecting…')
  const markup = render(null, null, 'Could not load the graphics preference.')
  expect(markup).toContain('>Unknown<')
  expect(markup).toContain('Could not load the graphics preference.')
  expect(markup).toMatch(/<fieldset[^>]*disabled=""/)
  expect(markup).not.toContain('checked=""')
})

const backup: DatabaseBackup = { id: 'migration-copy.db', version: 1, time: '2026-11-26T12:00:00.000Z', bytes: 512 }
const failed = { error: 'Access denied.' }
const noop = () => {}

it('renders all sections with the existing recording default on first load', () => {
  const markup = renderToStaticMarkup(createElement(SettingsPage))
  for (const heading of ['Data', 'Database copies', 'Logs and diagnostics', 'Graphics', 'Recording', 'About']) {
    expect(markup).toContain(`>${heading}</h2>`)
  }
  expect(markup).toContain('Loading database copies')
  expect(markup).toContain('Loading…')
  expect(markup.includes('checked=""')).toBe(readRecordRuns())
  expect(markup).not.toContain('Include database')
  expect(markup).not.toContain('Save diagnostics')
})

it('shows the data folder and exact byte counts, including zero', () => {
  const markup = renderToStaticMarkup(createElement(sections.DataSection, {
    overview: { data: { path: 'C:\\Blaze UAV', databaseBytes: 640, modelBytes: 128, terrainBytes: 0 } },
    recordings: { data: 256 },
    backups: { data: [backup, { ...backup, bytes: 64 }] },
  }))
  for (const text of ['C:\\Blaze UAV', '640 B', '128 B', '0 B', '256 B', '576 B', 'Open data folder']) {
    expect(markup).toContain(text)
  }
})

it('reports unavailable storage instead of displaying invented byte counts', () => {
  const markup = renderToStaticMarkup(createElement(sections.DataSection, {
    overview: failed,
    recordings: failed,
    backups: null,
  }))
  expect(markup).toContain('Could not load the data overview. Access denied.')
  expect(markup).toContain('Could not load the recordings size. Access denied.')
  expect(markup).not.toContain('0 B')
})

it('renders empty, failed and populated copy lists', () => {
  const renderCopies = (backups: Load<DatabaseBackup[]>) =>
    renderToStaticMarkup(createElement(sections.DatabaseCopiesSection, { backups }))
  expect(renderCopies({ data: [] })).toContain('No database copies yet')
  expect(renderCopies(failed)).toContain('Could not load database copies. Access denied.')
  const markup = renderCopies({ data: [backup] })
  expect(markup).toContain('Schema v1')
  expect(markup).toContain(backup.time)
  expect(markup).toContain('512 B')
  expect(markup).toContain('>Restore</button>')
})

it('spells out the restore scope, exclusions and restart in the confirmation', () => {
  const markup = renderToStaticMarkup(createElement(sections.RestoreConfirmation, { backup }))
  expect(markup).toContain('replace the current database with the schema v1 copy')
  expect(markup).toContain('database rows such as projects')
  expect(markup).toContain('Models, terrain and recording files are not in a database copy.')
  expect(markup).toContain('The app restarts after restore.')
})

it('requires a loaded contents list before offering diagnostics save', () => {
  const props = { includeDatabase: false, busy: false, feedback: null, onPreview: noop, onInclude: noop, onSave: noop }
  const renderDiagnostics = (preview: Load<DiagnosticsPreview>,
    overrides: Partial<typeof props> = {}) =>
    renderToStaticMarkup(createElement(sections.DiagnosticsSection, { ...props, ...overrides, preview }))
  expect(renderDiagnostics(null, { busy: true })).toContain('Loading diagnostics contents')
  expect(renderDiagnostics(failed)).toContain('Could not load diagnostics contents. Access denied.')
  expect(renderDiagnostics(failed)).not.toContain('Save diagnostics')
  const entries = [{ name: 'system.json', description: 'System information' }]
  const ready = renderDiagnostics({ data: { entries } })
  expect(ready).toContain('Include database')
  expect(ready).not.toContain('checked=""')
  expect(ready).toContain('System information')
  expect(ready.indexOf('system.json')).toBeLessThan(ready.indexOf('Save diagnostics'))
  expect(ready).toContain('Save diagnostics')
  const withDatabase = renderDiagnostics({ data: { entries: [...entries, {
    name: 'blaze-uav.db', description: 'Project database',
  }] } }, { includeDatabase: true, busy: true })
  expect(withDatabase).toContain('checked=""')
  expect(withDatabase).toContain('Project database')
  expect(withDatabase).toMatch(/<button[^>]*disabled=""[^>]*>Saving diagnostics/)
})

it('renders recording on and off and announces save success or failure', () => {
  const renderRecording = (enabled: boolean, feedback: Feedback) =>
    renderToStaticMarkup(createElement(sections.RecordingSection, { enabled, feedback, onChange: noop }))
  const enabled = renderRecording(true, { message: 'Recording is on by default.' })
  expect(enabled).toContain('checked=""')
  expect(enabled).toContain('Recording is on by default.')
  const disabled = renderRecording(false, { message: 'Could not save the recording preference.', error: true })
  expect(disabled).not.toContain('checked=""')
  expect(disabled).toMatch(/role="alert"[^>]*>Could not save the recording preference/)
})

it('shows the reported versions, licence and notices action, with an unavailable state', () => {
  const app: SystemStatus['app'] = { version: 'test-app', electron: 'test-electron', chrome: '', node: '', platform: '' }
  const engine: SystemStatus['engine'] = {
    state: 'connected', engineVersion: 'test-engine', protocolVersion: 4, threads: null, latencyMs: null,
    lastError: null, restarts: 0, revision: 1,
  }
  const markup = renderToStaticMarkup(createElement(sections.AboutSection, { app, engine, error: null }))
  for (const text of ['test-app', 'test-electron', 'test-engine', '>v4<', 'All rights reserved', 'Open third-party notices']) {
    expect(markup).toContain(text)
  }
  const unavailable = renderToStaticMarkup(createElement(sections.AboutSection, {
    app: undefined, engine: null, error: failed.error,
  }))
  expect(unavailable).toContain('Could not load version information. Access denied.')
  expect(unavailable.match(/>Unavailable</g)).toHaveLength(4)
})
