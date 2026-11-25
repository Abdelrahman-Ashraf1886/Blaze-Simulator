import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Channels, type RecordingEnd, type RecordingHeader } from '../../electron/ipc/contract'
import { createHandlers, createRecordingHandlers } from '../../electron/ipc/handlers'
import { MIGRATIONS, openDatabase, schemaVersion, type Db } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { recordingFileName } from '../../electron/main/telemetry/format'
import { RecordingStore } from '../../electron/main/telemetry/store'
import { RecordingWriter } from '../../electron/main/telemetry/writer'

let dir: string
let dbPath: string
let db: Db
let repos: ReturnType<typeof createRepositories>
let store: RecordingStore
const options = { maxPendingBytes: 4096 }
const end: RecordingEnd = {
  status: 'completed', reason: 'Finished', elapsedS: 0.008, finalStateHash: 'hash', engineError: null,
}

function loadStore() {
  db = openDatabase(dbPath)
  repos = createRepositories(db, undefined, join(dir, 'recordings'))
  store = new RecordingStore(join(dir, 'recordings'), repos.runs)
}

function createRun(): RecordingHeader {
  const project = repos.projects.create({ name: 'Aircraft', frameType: 'quad-x' })
  return {
    runId: randomUUID(), projectId: project.id, projectName: project.name,
    kind: 'scenario', title: 'Scenario', startedAt: project.createdAt,
    appVersion: 'test-app', engineVersion: 'test-engine', protocolVersion: 1,
    firstSampleStep: 4, samplePeriodSteps: 4, stepLengthS: 0.001,
    channels: [{ name: 'v', label: 'Velocity', unit: 'm/s' }],
    vehicleLoad: '{"mass":2.000}', startRequest: '{"duration":0.0080}',
  }
}

const filePath = (id: string) => join(dir, 'recordings', recordingFileName(id))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blaze-recording-store-'))
  dbPath = join(dir, 'test.db')
  loadStore()
})

afterEach(async () => {
  if (db.open) db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('recording persistence', () => {
  it('upgrades a 0015 database with existing runs and preserves the original constraints', () => {
    const oldPath = join(dir, 'v15.db')
    const old = new Database(oldPath)
    for (const migration of MIGRATIONS.slice(0, 15)) old.exec(migration)
    old.pragma('user_version = 15')
    const projectId = randomUUID()
    const id = randomUUID()
    const stamp = '2026-11-25T12:00:00.000Z'
    old.prepare('INSERT INTO projects (id, name, frame_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, 'Legacy', 'quad-x', stamp, stamp)
    old.prepare('INSERT INTO simulation_runs (id, project_id, started_at, duration_s, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, stamp, 1, 'completed')
    old.close()

    const upgraded = openDatabase(oldPath)
    try {
      expect(schemaVersion(upgraded)).toBe(16)
      expect(createRepositories(upgraded).runs.get(id)).toMatchObject({
        id, projectId, startedAt: stamp, durationS: 1, status: 'completed', kind: null, fileName: null, open: false,
      })
      expect(() => upgraded.prepare("UPDATE simulation_runs SET status = 'open' WHERE id = ?").run(id)).toThrow(/CHECK/)
      expect(() => upgraded.prepare('UPDATE simulation_runs SET duration_s = -1 WHERE id = ?').run(id)).toThrow(/CHECK/)
    } finally {
      upgraded.close()
    }
  })

  it('lists, gets and deletes owned files, retaining rows for missing files until explicit deletion', async () => {
    const header = createRun()
    const missing = { ...header, runId: randomUUID() }
    const sibling = { ...header, runId: randomUUID() }
    const writer = (await store.start(header, options))!
    expect(await store.get(header.runId)).toMatchObject({ open: true })
    expect(() => store.delete(header.runId)).toThrow(/still recording/)
    expect(() => repos.projects.delete(header.projectId)).toThrow(/still recording/)
    writer.appendSamples([[1]])
    await writer.finish(end)
    const missingWriter = (await store.start(missing, options))!
    await missingWriter.abort({ ...end, reason: 'Stopped' })
    const siblingWriter = (await store.start(sibling, options))!
    await siblingWriter.finish(end)
    const realBytes = (await readFile(filePath(header.runId))).length
    const siblingBytes = (await readFile(filePath(sibling.runId))).length
    await unlink(filePath(missing.runId))

    expect(await store.totalSize()).toBe(realBytes + siblingBytes)
    expect(await store.list(header.projectId)).toHaveLength(3)
    expect(await store.listRecent(3)).toContainEqual(expect.objectContaining({
      id: missing.runId, status: 'aborted', fileMissing: true,
    }))
    expect(await store.get(header.runId)).toMatchObject({
      status: 'completed', bytes: realBytes, sampleCount: 1, stateHash: 'hash', endReason: 'Finished', incomplete: false,
    })
    expect(store.delete(header.runId)).toBeNull()
    await expect(readFile(filePath(header.runId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => repos.runs.get(header.runId)).toThrow(/not found/)
    const projectDelete = createHandlers(repos, () => { throw new Error('unused') })[Channels.projectsDelete]!
    expect(projectDelete({ id: header.projectId })).toEqual({ ok: true, data: null })
    await expect(readFile(filePath(sibling.runId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(repos.runs.listRecent(10)).toEqual([])
    expect(await store.totalSize()).toBe(0)
  })

  it('marks an injected disk-full write as failed and preserves the preceding complete frames', async () => {
    const header = createRun()
    let writes = 0
    const writer = (await store.start(header, {
      ...options,
      openFile: async (path, flags) => {
        const file = await open(path, flags)
        return {
          async write(buffer, offset, length) {
            writes++
            if (writes === 5) throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' })
            return file.write(buffer, offset, writes === 4 ? 1 : length)
          },
          sync: () => file.sync(),
          close: () => file.close(),
        }
      },
    }))!
    expect(writer.appendSamples([[7]])).toBe(true)
    expect(writer.appendSamples([[9]])).toBe(true)
    expect(await writer.finish(end)).toMatchObject({ failure: 'ENOSPC: disk full', sampleCount: 1, end: null })
    expect(writer.appendRequest('later')).toBe(false)
    expect(await store.get(header.runId)).toMatchObject({
      status: 'failed', endReason: 'ENOSPC: disk full', sampleCount: 1, incomplete: true, open: false,
    })
    await expect(store.read(header.runId, (reader) => reader.summary())).resolves.toMatchObject({
      sampleCount: 1, incomplete: true,
    })
  })

  it('recovers open rows on restart and reports orphan files without deleting them', async () => {
    const partial = createRun()
    const complete = { ...partial, runId: randomUUID() }
    const missing = { ...partial, runId: randomUUID() }
    const orphan = { ...partial, runId: randomUUID() }
    const work = { ...options, onSettled() {} }
    for (const header of [partial, complete, missing]) repos.runs.create(header)
    for (const header of [partial, complete, orphan]) {
      const writer = (await RecordingWriter.start(filePath(header.runId), header, work))!
      writer.appendSamples([[1], [2]])
      await writer.finish(end)
    }
    const full = await readFile(filePath(partial.runId))
    await truncate(filePath(partial.runId), full.length - 1)
    const orphanBefore = await readFile(filePath(orphan.runId))
    db.close()
    loadStore()

    expect(await store.recover()).toEqual([recordingFileName(orphan.runId)])
    expect(await store.get(partial.runId)).toMatchObject({ status: 'aborted', sampleCount: 2, incomplete: true, durationS: 0.008 })
    expect(await store.get(complete.runId)).toMatchObject({ status: 'aborted', sampleCount: 2, incomplete: false, stateHash: 'hash' })
    expect(await store.get(missing.runId)).toMatchObject({ status: 'aborted', sampleCount: 0, incomplete: true, fileMissing: true })
    expect(repos.runs.listOpen()).toEqual([])
    expect(await readFile(filePath(orphan.runId))).toEqual(orphanBefore)
    await expect(store.start(orphan, options)).resolves.toBeNull()
    expect(await readFile(filePath(orphan.runId))).toEqual(orphanBefore)
    expect(await store.recover()).toEqual([recordingFileName(orphan.runId)])
  })
})

describe('recording IPC', () => {
  it('refuses traversal, unknown channels and inverted ranges, and reports corrupt recordings', async () => {
    const header = createRun()
    const writer = (await store.start(header, options))!
    writer.appendSamples([[5]])
    await writer.finish(end)
    const handlers = createRecordingHandlers(store)
    const invalid = { ok: false, error: { code: 'VALIDATION' } }
    const traversal = { id: '../outside.blzr' }
    for (const channel of [Channels.runsGet, Channels.runsDelete, Channels.recordingSummary, Channels.recordingReadRequests] as const) {
      expect(await handlers[channel](traversal)).toMatchObject(invalid)
    }
    expect(await handlers[Channels.recordingReadSamples]({ ...traversal, channels: ['v'] })).toMatchObject(invalid)
    const query = { id: header.runId, channels: ['v'] }
    await expect(handlers[Channels.recordingReadSamples]({ ...query, channels: ['unknown'] })).resolves.toMatchObject({
      ...invalid, error: { ...invalid.error, message: 'Unknown recording channel: unknown' },
    })
    await expect(handlers[Channels.recordingReadSamples]({ ...query, fromS: 1, toS: 0 })).resolves.toMatchObject({
      ...invalid, error: { ...invalid.error, message: 'Inverted recording time range' },
    })
    await expect(handlers[Channels.recordingReadSamples](query)).resolves.toEqual({
      ok: true, data: [{ channel: 'v', points: [{ timeS: 0.004, value: 5 }] }],
    })
    const file = await readFile(filePath(header.runId))
    file[file.length - 1] = file[file.length - 1]! ^ 1
    await writeFile(filePath(header.runId), file)
    await expect(handlers[Channels.recordingSummary]({ id: header.runId })).resolves.toMatchObject({
      ...invalid, error: { ...invalid.error, message: expect.stringMatching(/CRC-32 mismatch/) },
    })
  })
})
