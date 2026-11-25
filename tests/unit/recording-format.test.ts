import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingEnd, RecordingHeader, RecordingPoint } from '../../electron/ipc/contract'
import { minMaxBuckets } from '../../electron/main/telemetry/decimation'
import { FLOAT_BYTES, FRAME_BYTES, MAGIC, PREAMBLE_BYTES, ROW_COUNT_BYTES, VERSION } from '../../electron/main/telemetry/format'
import { RecordingReader } from '../../electron/main/telemetry/reader'
import { RecordingWriter, type RecordingOutput } from '../../electron/main/telemetry/writer'

const header: RecordingHeader = {
  runId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  projectName: 'Recording project',
  kind: 'flight',
  title: 'Format fixture',
  startedAt: '2026-11-25T12:00:00.000Z',
  appVersion: 'test-app',
  engineVersion: 'test-engine',
  protocolVersion: 1,
  samplePeriodSteps: 4,
  stepLengthS: 0.001,
  firstSampleStep: 4,
  channels: [
    { name: 'x', label: 'X', unit: 'm' },
    { name: 'y', label: 'Y', unit: 'm' },
  ],
  vehicleLoad: '{"mass":1.0000000000000000}',
  startRequest: '{"period":4,"bias":-0.0}',
}
const end: RecordingEnd = {
  status: 'completed', reason: 'Finished', elapsedS: 0.008, finalStateHash: 'hash', engineError: null,
}
const line = '\uFEFF{"input":0.10000000000000001,"name":"µ","vec":[-0.0]}\r\n'
let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blaze-recording-format-'))
  path = join(dir, 'test.blzr')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<Buffer> {
  const writer = await RecordingWriter.start(path, header, { maxPendingBytes: 4096, onSettled: vi.fn() })
  expect(writer).not.toBeNull()
  expect(writer!.appendRequest(line)).toBe(true)
  expect(writer!.appendSamples([[-0, null], [Math.PI, Number.MIN_VALUE]])).toBe(true)
  expect(await writer!.finish(end)).toMatchObject({ failure: null, sampleCount: 2, end })
  return readFile(path)
}

describe('recording file format', () => {
  it('round trips doubles, signed zero, missing values and exact replay text', async () => {
    const file = await fixture()
    const reader = new RecordingReader(path)
    expect(await reader.header()).toEqual(header)
    expect(await reader.summary()).toEqual({
      header, end, bytes: file.length, sampleCount: 2, requestCount: 1, incomplete: false, integrityError: null,
    })
    expect(await reader.readRequests()).toEqual({ lines: [line], integrityError: null })
    expect((await reader.readSamples({ channels: ['y', 'x'] })).series).toEqual([
      { channel: 'y', points: [{ timeS: 0.004, value: null }, { timeS: 0.008, value: Number.MIN_VALUE }] },
      { channel: 'x', points: [{ timeS: 0.004, value: -0 }, { timeS: 0.008, value: Math.PI }] },
    ])
    expect((await reader.readSamples({ channels: ['x'], fromS: 0.008, toS: 0.008 })).series).toEqual([
      { channel: 'x', points: [{ timeS: 0.008, value: Math.PI }] },
    ])
    expect((await reader.readSamples({ channels: ['x'], fromS: 1 })).series).toEqual([{ channel: 'x', points: [] }])
  })

  it('opens every byte prefix at its last whole frame', async () => {
    const file = await fixture()
    const next = (offset: number) => offset + FRAME_BYTES + file.readUInt32LE(offset + 1)
    const headerEnd = next(PREAMBLE_BYTES)
    const requestEnd = next(headerEnd)
    const samplesEnd = next(requestEnd)
    for (let cut = 0; cut < file.length; cut++) {
      await writeFile(path, file.subarray(0, cut))
      expect(await new RecordingReader(path).summary(), `cut at byte ${cut}`).toEqual({
        header: cut >= headerEnd ? header : null,
        end: null,
        bytes: cut,
        sampleCount: cut >= samplesEnd ? 2 : 0,
        requestCount: Number(cut >= requestEnd),
        incomplete: true,
        integrityError: null,
      })
    }
  })

  it('refuses bad magic, unknown versions and an invalid header', async () => {
    const file = await fixture()
    const reader = new RecordingReader(path)
    const headerPayload = PREAMBLE_BYTES + FRAME_BYTES
    const changed = Buffer.from(file)
    changed.writeUInt32LE(VERSION + 1, MAGIC.length)
    await writeFile(path, changed)
    await expect(reader.summary()).rejects.toThrow(/unsupported recording version/i)

    for (const [at, error] of [
      [0, /bad recording magic/i],
      [headerPayload, /payload CRC-32 mismatch/],
    ] as const) {
      const changed = Buffer.from(file)
      changed[at] = changed[at]! ^ 1
      await writeFile(path, changed)
      await expect(reader.summary()).rejects.toThrow(error)
      await expect(reader.readRequests()).rejects.toThrow(error)
      await expect(reader.readSamples({ channels: ['x'] })).rejects.toThrow(error)
    }
  })

  it('keeps the verified prefix after a flipped byte in any data or end chunk, or a zero-filled tail', async () => {
    const file = await fixture()
    const next = (offset: number) => offset + FRAME_BYTES + file.readUInt32LE(offset + 1)
    const request = next(PREAMBLE_BYTES)
    const samples = next(request)
    const end = next(samples)
    for (const [offset, requestCount, sampleCount] of [[request, 0, 0], [samples, 1, 0], [end, 1, 2]] as const) {
      for (const byte of [offset + 1, offset + FRAME_BYTES]) {
        const changed = Buffer.from(file)
        changed[byte] = changed[byte]! ^ 1
        await writeFile(path, changed)
        const reader = new RecordingReader(path)
        const summary = await reader.summary()
        expect(summary).toMatchObject({ header, end: null, requestCount, sampleCount, incomplete: true, integrityError: expect.stringContaining('CRC-32 mismatch') })
        expect(await reader.readRequests()).toEqual({ lines: requestCount ? [line] : [], integrityError: summary.integrityError })
        const saved = await reader.readSamples({ channels: ['x'] })
        expect(saved.integrityError).toBe(summary.integrityError)
        expect(saved.series[0]!.points).toHaveLength(sampleCount)
      }
    }
    const interrupted = Buffer.from(file)
    interrupted.fill(0, end)
    await writeFile(path, interrupted)
    const reader = new RecordingReader(path)
    await expect(reader.summary()).resolves.toMatchObject({ sampleCount: 2, requestCount: 1, incomplete: true, integrityError: expect.stringContaining('CRC-32 mismatch') })
  })

  it('invalidates the verified index as the same file grows', async () => {
    const file = await fixture()
    const request = PREAMBLE_BYTES + FRAME_BYTES + file.readUInt32LE(PREAMBLE_BYTES + 1)
    await writeFile(path, file.subarray(0, request))
    const reader = new RecordingReader(path)
    expect((await reader.readSamples({ channels: ['x'] })).series[0]!.points).toHaveLength(0)
    await appendFile(path, file.subarray(request))
    expect((await new RecordingReader(path).readSamples({ channels: ['x'] })).series[0]!.points).toHaveLength(2)
    await expect(reader.summary()).resolves.toMatchObject({ bytes: file.length, incomplete: false })
  })

  it('writes many small appends in order and snapshots mutable input rows', async () => {
    const count = 1000
    const writer = (await RecordingWriter.start(path, header, { maxPendingBytes: 64 * count, onSettled: vi.fn() }))!
    const row = [0, 0]
    const requests = Array.from({ length: count }, (_, i) => `{"seq":${i}}\n`)
    requests.forEach((request, index) => {
      row[0] = index
      expect(writer.appendSamples([row])).toBe(true)
      expect(writer.appendRequest(request)).toBe(true)
    })
    expect(await writer.finish(end)).toMatchObject({ failure: null, sampleCount: count })
    const reader = new RecordingReader(path)
    expect((await reader.readRequests()).lines).toEqual(requests)
    const { series: [series] } = await reader.readSamples({ channels: ['x'] })
    expect(series!.points.map((p) => p.value)).toEqual(requests.map((_, i) => i))
  })

  it('bounds queued bytes including a stalled write and keeps accepted rows', async () => {
    const rowFrameBytes = FRAME_BYTES + ROW_COUNT_BYTES + header.channels.length * FLOAT_BYTES
    const maxPendingBytes = PREAMBLE_BYTES + FRAME_BYTES + Buffer.byteLength(JSON.stringify(header))
    const accepted = Math.floor(maxPendingBytes / rowFrameBytes)
    let release!: () => void
    let notifyEntered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve })
    const onSettled = vi.fn()
    let writes = 0
    const file: RecordingOutput = {
      async write(_data, _offset, length) {
        if (++writes === 3) {
          notifyEntered()
          await gate
        }
        return { bytesWritten: length }
      },
      async sync() {},
      async close() {},
    }
    const writer = (await RecordingWriter.start(path, header, { maxPendingBytes, openFile: async () => file, onSettled }))!
    expect(writer.appendSamples([[0, 0]])).toBe(true)
    await entered
    try {
      for (let i = 1; i < accepted; i++) expect(writer.appendSamples([[i, i]])).toBe(true)
      expect(writer.appendSamples([[accepted, accepted]])).toBe(false)
      expect(writer.appendRequest('later')).toBe(false)
    } finally {
      release()
    }
    expect(await writer.finish(end)).toMatchObject({ sampleCount: accepted, end: null, failure: expect.stringMatching(/byte budget/) })
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})

describe('recording min/max decimation', () => {
  it('keeps peaks and a brief mixed-bucket gap in order, plus an all-missing bucket', async () => {
    const source = [8, null, -3, 2, null, null, null, null]
    async function* rows(): AsyncGenerator<RecordingPoint[]> {
      for (const [timeS, value] of source.entries()) yield [{ timeS, value }]
    }
    expect(await minMaxBuckets(rows(), source.length, 1, 5)).toEqual([
      [{ timeS: 0, value: 8 }, { timeS: 1, value: null }, { timeS: 2, value: -3 }, { timeS: 4, value: null }],
    ])
    expect(await minMaxBuckets(rows(), source.length, 1, 2)).toEqual([[{ timeS: 1, value: null }, { timeS: 2, value: -3 }]])
    expect(await minMaxBuckets(rows(), source.length, 1, 1)).toEqual([[{ timeS: 0, value: 8 }]])
  })
})
