import { mkdtemp, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultHighWaterMark } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingEnd, RecordingHeader } from '../../electron/ipc/contract'
import { createRecordingCsvHandler } from '../../electron/ipc/handlers'
import { createRecordingCsvExporter } from '../../electron/main/telemetry/csv'
import { FLOAT_BYTES, FRAME_BYTES } from '../../electron/main/telemetry/format'
import { RecordingReader, sampleTimeS } from '../../electron/main/telemetry/reader'
import { RecordingWriter } from '../../electron/main/telemetry/writer'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const header: RecordingHeader = {
  runId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  projectName: 'Recording project',
  kind: 'flight',
  title: 'Survey / Flight',
  startedAt: '2026-11-25T12:00:00.000Z',
  appVersion: 'test-app',
  engineVersion: 'test-engine',
  protocolVersion: 1,
  samplePeriodSteps: 4,
  stepLengthS: 0.001,
  firstSampleStep: 4,
  channels: [
    { name: 'wind, "east"', label: 'Wind', unit: 'm/s' },
    { name: 'time', label: 'Simulated time', unit: 's' },
    { name: 'state.groundContact', label: 'Contact', unit: '1' },
  ],
  vehicleLoad: '{}',
  startRequest: '{}',
}
const end: RecordingEnd = {
  status: 'completed', reason: 'Finished', elapsedS: 0.008, finalStateHash: 'hash', engineError: null,
}
const query = { id: header.runId }
let dir: string
let source: string
let target: string
let reader: RecordingReader
let exporter: ReturnType<typeof createRecordingCsvExporter>
let handle: ReturnType<typeof createRecordingCsvHandler>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blaze-recording-csv-'))
  source = join(dir, 'run.blzr')
  target = join(dir, 'run.csv')
  reader = new RecordingReader(source, { id: header.runId, projectId: header.projectId })
  exporter = createRecordingCsvExporter({ read: async (_id, read) => read(reader) })
  handle = createRecordingCsvHandler(exporter)
})

afterEach(async () => {
  await exporter.shutdown()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function fixture(incomplete = false, rows = [[-0, 0.004, null], [1e21, 0.008, Number.MIN_VALUE]]) {
  const maxPendingBytes = getDefaultHighWaterMark(false) + rows.length * header.channels.length * FLOAT_BYTES
  const writer = await RecordingWriter.start(source, header, { maxPendingBytes, onSettled: vi.fn() })
  expect(writer).not.toBeNull()
  expect(writer!.appendSamples(rows)).toBe(true)
  const result = await writer!.finish(end)
  expect(result).toMatchObject({ failure: null, sampleCount: rows.length })
  if (incomplete) {
    const endBytes = FRAME_BYTES + Buffer.byteLength(JSON.stringify(end))
    await truncate(source, result.bytes - endBytes)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('recording CSV export', () => {
  it('exports stored time first, recorded units and full precision, and replaces an existing file', async () => {
    await fixture()
    await writeFile(target, 'old export')
    const pick = vi.fn(async () => target)
    expect(await handle(query, pick)).toEqual({ ok: true, data: { path: target } })
    expect(pick).toHaveBeenCalledWith('Survey Flight · 2026-11-25T12 00 00.000Z.csv')
    expect(await readFile(target, 'utf8')).toBe(
      'time [s],"wind, ""east"" [m/s]",state.groundContact [1]\r\n0.004,-0,\r\n0.008,1e+21,5e-324\r\n',
    )
    expect((await readdir(dir)).sort()).toEqual(['run.blzr', 'run.csv'])
  })

  it('exports a single row at inclusive bounds in the requested order', async () => {
    await fixture()
    const selection = { ...query, channels: ['state.groundContact', 'time', 'wind, "east"'], fromS: 0.008, toS: 0.008 }
    expect(await handle(selection, async () => target)).toEqual({ ok: true, data: { path: target } })
    expect(await readFile(target, 'utf8')).toBe(
      'time [s],state.groundContact [1],"wind, ""east"" [m/s]"\r\n0.008,5e-324,1e+21\r\n',
    )
  })

  it('exports every sample once across batch boundaries', async () => {
    const batchRows = Math.floor(getDefaultHighWaterMark(false) / (header.channels.length * FLOAT_BYTES))
    const rows = Array.from({ length: batchRows + 1 }, (_, i) => [i, sampleTimeS(header, i), i])
    await fixture(false, rows)
    const read = vi.spyOn(reader, 'readSamples')
    expect(await handle(query, async () => target)).toEqual({ ok: true, data: { path: target } })
    expect(read).toHaveBeenCalledTimes(2)
    const csv = await readFile(target, 'utf8')
    expect(csv.split('\r\n').slice(1, -1)).toEqual(rows.map(([wind, time, contact]) => `${time},${wind},${contact}`))
  })

  it('writes a header for a range without samples', async () => {
    await fixture()
    expect(await handle({ ...query, channels: ['time'], fromS: 1 }, async () => target)).toEqual({ ok: true, data: { path: target } })
    expect(await readFile(target, 'utf8')).toBe('time [s]\r\n')
  })

  it('rejects unknown channels and renderer paths before opening the dialog', async () => {
    await fixture()
    const pick = vi.fn()
    expect(await handle({ ...query, channels: ['unknown'] }, pick)).toEqual({
      ok: false, error: { code: 'VALIDATION', message: 'Unknown recording channel: unknown' },
    })
    expect(await handle({ ...query, path: target }, pick)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(pick).not.toHaveBeenCalled()
  })

  it('exports complete samples from an incomplete recording and marks it in the comments', async () => {
    await fixture(true)
    expect(await handle({ ...query, comments: true, bom: true }, async () => target)).toEqual({ ok: true, data: { path: target } })
    const csv = await readFile(target, 'utf8')
    expect(csv.startsWith('\uFEFF# Run title: "Survey / Flight"\r\n')).toBe(true)
    expect(csv).toContain('# Final hash: null\r\n# Incomplete: true\r\n')
    expect(csv.endsWith('0.004,-0,\r\n0.008,1e+21,5e-324\r\n')).toBe(true)
  })

  it('returns a disk error, preserves the old file and removes temporary output', async () => {
    await fixture()
    await writeFile(target, 'old export')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await handle(query, async () => target)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(log).toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('old export')
    expect((await readdir(dir)).sort()).toEqual(['run.blzr', 'run.csv'])
  })

  it('leaves the filesystem untouched when the dialog is cancelled', async () => {
    await fixture()
    expect(await handle(query, async () => null)).toEqual({ ok: true, data: null })
    expect(await readdir(dir)).toEqual(['run.blzr'])
  })

  it('supersedes a pending export when a new request arrives', async () => {
    await fixture()
    const opened = deferred<void>()
    const picked = deferred<string>()
    const first = handle(query, () => {
      opened.resolve()
      return picked.promise
    })
    await opened.promise
    expect(await handle(query, async () => null)).toEqual({ ok: true, data: null })
    expect(await first).toEqual({ ok: true, data: null })
    picked.resolve(target)
    expect(await readdir(dir)).toEqual(['run.blzr'])
  })

  it('cancels a write on shutdown and waits for temporary output to be removed', async () => {
    await fixture()
    await writeFile(target, 'old export')
    const reading = deferred<void>()
    const batch = deferred<Awaited<ReturnType<RecordingReader['readSamples']>>>()
    vi.spyOn(reader, 'readSamples').mockImplementation(() => {
      reading.resolve()
      return batch.promise
    })
    const pending = handle(query, async () => target)
    await reading.promise
    const shutdown = exporter.shutdown()
    batch.resolve([])
    await shutdown
    expect(await pending).toEqual({ ok: true, data: null })
    expect(await readFile(target, 'utf8')).toBe('old export')
    expect((await readdir(dir)).sort()).toEqual(['run.blzr', 'run.csv'])
  })
})
