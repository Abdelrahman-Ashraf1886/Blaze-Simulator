import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Channels, type IpcResult, type Project } from '../../electron/ipc/contract'
import { createHandlers, createRecordingHandlers, createTerrainHandlers } from '../../electron/ipc/handlers'
import { RecordingStore } from '../../electron/main/telemetry/store'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'

let handlers: Record<string, (payload: unknown) => IpcResult<unknown> | Promise<IpcResult<unknown>>>

beforeEach(() => {
  const repos = createRepositories(openDatabase(':memory:'))
  handlers = { ...createHandlers(repos, () => ({
    engine: {
      state: 'connected',
      engineVersion: '0.1.0',
      protocolVersion: 1,
      threads: 4,
      latencyMs: 0.2,
      lastError: null,
      restarts: 0,
      revision: 7,
    },
    database: { path: ':memory:', schemaVersion: 1 },
    app: { version: '0.1.0', electron: 'x', chrome: 'x', node: 'x', platform: 'test' },
  })), ...createTerrainHandlers(repos, __dirname), ...createRecordingHandlers(new RecordingStore(__dirname, repos.runs)) }
})

const call = <T>(channel: string, payload?: unknown) => handlers[channel]!(payload) as IpcResult<T>

describe('IPC handlers', () => {
  it('creates a project with a trimmed name', () => {
    const r = call<Project>(Channels.projectsCreate, { name: '  Survey quad  ', frameType: 'quad-x' })
    expect(r).toMatchObject({ ok: true, data: { name: 'Survey quad', frameType: 'quad-x' } })
  })

  it.each([
    [{ name: '', frameType: 'quad-x' }],
    [{ name: '   ', frameType: 'quad-x' }],
    [{ name: 'x'.repeat(81), frameType: 'quad-x' }],
    [{ name: 'ok', frameType: 'tri-y' }],
    [{ name: 'ok' }],
    [null],
    ['DROP TABLE projects'],
  ])('rejects invalid create payload %j', (payload) => {
    expect(call(Channels.projectsCreate, payload)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  })

  it('rejects non-uuid ids', () => {
    expect(call(Channels.projectsDelete, { id: "1' OR 1=1" })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    })
  })

  it('maps missing rows to NOT_FOUND', () => {
    expect(call(Channels.projectsDelete, { id: '00000000-0000-4000-8000-000000000000' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  it('bounds the run history limit', async () => {
    expect(await handlers[Channels.runsListRecent]!({ limit: 0 })).toMatchObject({ ok: false })
    expect(await handlers[Channels.runsListRecent]!({ limit: 10 })).toEqual({ ok: true, data: [] })
  })

  it('reports system status with the real component count', () => {
    expect(call(Channels.systemStatus)).toMatchObject({ ok: true, data: { componentCount: 0 } })
  })

  it('has a handler for every request channel', () => {
    // The push channel is main → renderer; the sync save is bound with ipcMain.on to the same handler;
    // the import and the image save need native file dialogs, so main binds them
    // (their logic is tested in assets.test.ts and screenshot.test.ts); the drop test needs the
    // engine supervisor, so main binds it (drop-test.ts, tested in environment and supervisor tests);
    // so do the live flight channels (flight-session.ts, tested in flight-live.test.ts), and the scenario run (scenario-run.ts, tested in scenario-protocol.test.ts).
    const mainOnly: string[] = [
      Channels.engineDropTest,
      Channels.engineFlightStart,
      Channels.engineFlightStep,
      Channels.engineFlightEnd,
      Channels.engineScenarioRun,
      Channels.engineStepTest,
      Channels.engineStatusChanged,
      Channels.assemblySaveSync,
      Channels.assetsImport,
      Channels.terrainImport,
      Channels.viewportSavePng,
      Channels.componentsExportPack,
      Channels.recordingExportCsv,
      Channels.componentsImportPack,
    ]
    const requestChannels = Object.values(Channels).filter((c) => !mainOnly.includes(c))
    expect(Object.keys(handlers).sort()).toEqual([...requestChannels].sort())
    for (const channel of [Channels.tuningGet, Channels.tuningSet, Channels.tuningReset]) {
      expect(requestChannels).toContain(channel)
      expect(handlers[channel]).toBeTypeOf('function')
    }
  })

  it('preload uses exactly the contract channel names', () => {
    const preload = readFileSync(join(__dirname, '../../electron/preload/index.ts'), 'utf8')
    for (const channel of Object.values(Channels)) expect(preload).toContain(`'${channel}'`)
  })
})
