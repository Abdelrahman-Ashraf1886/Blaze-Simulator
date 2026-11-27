import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDiagnosticsHandlers } from '../../electron/ipc/handlers'
import { createDiagnostics } from '../../electron/main/logging/diagnostics'
import { createLogger } from '../../electron/main/logging/logger'
import { recordingFileName } from '../../electron/main/telemetry/format'

function readStoredZip(zip: Buffer) {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const entries = new Map<string, Buffer>()
  let central = zip.readUInt32LE(end + 16)
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    expect(zip.readUInt32LE(central)).toBe(0x02014b50)
    const length = zip.readUInt16LE(central + 28)
    const name = zip.toString('utf8', central + 46, central + 46 + length)
    const local = zip.readUInt32LE(central + 42)
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    expect(zip.readUInt16LE(local + 8)).toBe(0) // stored
    expect(zip.toString('utf8', local + 30, local + 30 + length)).toBe(name)
    const start = local + 30 + length + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + zip.readUInt32LE(central + 20))
    expect(crc32(data)).toBe(zip.readUInt32LE(central + 16))
    expect(zip.readUInt32LE(start + data.length)).toBe(0x08074b50)
    entries.set(name, data)
    central += 46 + length + zip.readUInt16LE(central + 30) + zip.readUInt16LE(central + 32)
  }
  expect(central).toBe(end)
  return entries
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'blaze-diagnostics-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it.each([false, true])('zips only the previewed entries with includeDatabase=%s', async (includeDatabase) => {
  const databasePath = join(root, 'blaze-uav.db')
  const recordingsDirectory = join(root, 'recordings')
  const database = Buffer.from('private project database')
  const recording = recordingFileName('00000000-0000-4000-8000-000000000000')
  await mkdir(recordingsDirectory)
  await Promise.all([
    writeFile(databasePath, database),
    writeFile(join(recordingsDirectory, recording), 'samples'),
    writeFile(join(recordingsDirectory, 'unrelated.txt'), 'unrelated'),
  ])
  const logger = createLogger(join(root, 'logs'))
  const userPath = 'C:\\Users\\Example\\project'
  logger.write('info', 'main', userPath)
  const backupDatabase = vi.fn((path: string) => writeFile(path, database))
  const versions = { app: 'app-version', engine: 'engine-version', electron: 'electron-version' }
  const os = { platform: 'win32', arch: 'x64', release: 'test-release' }
  const gpu = { gpuDevice: [{ active: true }] }
  const diagnostics = createDiagnostics({
    logger, databasePath, recordingsDirectory, backupDatabase,
    schemaVersion: () => 16, versions: () => versions, os: () => os,
    graphicsPreference: () => 'system', gpuInfo: async () => gpu,
  })
  const preview = diagnostics.preview(includeDatabase)
  const path = join(root, 'save.zip')
  await diagnostics.save(path, includeDatabase)
  const entries = readStoredZip(await readFile(path))
  expect([...entries.keys()]).toEqual(preview.entries.map((entry) => entry.name))
  expect(preview.entries[0]?.description).toMatch(/user file paths/)
  expect(JSON.parse(entries.get('logs/main.log')!.toString()).message).toBe(userPath)
  expect(JSON.parse(entries.get('recordings.json')!.toString())).toEqual([{ name: recording, bytes: Buffer.byteLength('samples') }])
  expect(JSON.parse(entries.get('system.json')!.toString())).toEqual({
    versions, os, graphicsPreference: 'system', gpu, database: { schemaVersion: 16, bytes: database.length },
  })
  expect(entries.get('blaze-uav.db')).toEqual(includeDatabase ? database : undefined)
  expect(backupDatabase).toHaveBeenCalledTimes(includeDatabase ? 1 : 0)
})

it('validates diagnostics requests and opens a save dialog only for a save request', async () => {
  const preview = vi.fn(() => ({ entries: [] }))
  const save = vi.fn(async (path: string) => {
    await writeFile(path, 'diagnostics fixture')
    return { path }
  })
  const openLogFolder = vi.fn(async () => {})
  const handlers = createDiagnosticsHandlers({ preview, save, openLogFolder, logRendererError: vi.fn() })
  const pick = vi.fn(async (): Promise<string | undefined> => undefined)
  expect(await handlers.openLogFolder({ path: root })).toMatchObject({ ok: false })
  expect(await handlers.openLogFolder(undefined)).toEqual({ ok: true, data: null })
  expect(openLogFolder).toHaveBeenCalledTimes(1)
  expect(await handlers.save({ action: 'save' }, pick)).toMatchObject({ ok: false })
  expect(await handlers.save({ action: 'preview', includeDatabase: false }, pick)).toEqual({ ok: true, data: { entries: [] } })
  expect(pick).not.toHaveBeenCalled()
  expect(await handlers.save({ action: 'save', includeDatabase: false }, pick)).toEqual({ ok: true, data: null })
  expect(save).not.toHaveBeenCalled()
  pick.mockResolvedValueOnce(join(root, 'archive'))
  expect(await handlers.save({ action: 'save', includeDatabase: true }, pick)).toEqual({
    ok: true, data: { path: join(root, 'archive.zip') },
  })
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/output\.zip$/), true)
})

it('rate limits valid renderer messages without letting invalid messages consume the allowance', () => {
  let now = 0
  const logRendererError = vi.fn()
  const handlers = createDiagnosticsHandlers({
    preview: () => ({ entries: [] }), save: async (path) => ({ path }),
    openLogFolder: async () => {}, logRendererError, now: () => now,
  })
  handlers.rendererError({ message: 'invalid' })
  handlers.rendererError('first')
  now = 999
  handlers.rendererError('dropped')
  now = 1000
  handlers.rendererError('next')
  expect(logRendererError.mock.calls).toEqual([['first'], ['next']])
})
