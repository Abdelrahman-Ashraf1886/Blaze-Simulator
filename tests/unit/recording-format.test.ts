import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    expect(await reader.readRequests()).toEqual([line])
    expect(await reader.readSamples({ channels: ['y', 'x'] })).toEqual([
      { channel: 'y', points: [{ timeS: 0.004, value: null }, { timeS: 0.008, value: Number.MIN_VALUE }] },
      { channel: 'x', points: [{ timeS: 0.004, value: -0 }, { timeS: 0.008, value: Math.PI }] },
    ])
    expect(await reader.readSamples({ channels: ['x'], fromS: 0.008, toS: 0.008 })).toEqual([
      { channel: 'x', points: [{ timeS: 0.008, value: Math.PI }] },
    ])
    expect(await reader.readSamples({ channels: ['x'], fromS: 1 })).toEqual([{ channel: 'x', points: [] }])
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

  it('refuses bad magic, unknown versions and changed replay bytes or frame lengths', async () => {
    const file = await fixture()
    const reader = new RecordingReader(path)
    const headerPayload = PREAMBLE_BYTES + FRAME_BYTES
    const request = headerPayload + file.readUInt32LE(PREAMBLE_BYTES + 1)
    const changed = Buffer.from(file)
    changed.writeUInt32LE(VERSION + 1, MAGIC.length)
    await writeFile(path, changed)
    await expect(reader.summary()).rejects.toThrow(/unsupported recording version/i)

    for (const [at, error] of [
      [0, /bad recording magic/i],
      [headerPayload, /payload CRC-32 mismatch/],
      [request + 1, /header CRC-32 mismatch/],
      [request + FRAME_BYTES, /payload CRC-32 mismatch/],
    ] as const) {
      const changed = Buffer.from(file)
      changed[at] = changed[at]! ^ 1
      await writeFile(path, changed)
      await expect(reader.summary()).rejects.toThrow(error)
      await expect(reader.readRequests()).rejects.toThrow(error)
    }
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
    expect(await reader.readRequests()).toEqual(requests)
    const [series] = await reader.readSamples({ channels: ['x'] })
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
  it('keeps peaks and chronological order, retaining a marker for an all-missing bucket', async () => {
    const source = [null, 8, -3, 2, null, null, null, null]
    async function* rows(): AsyncGenerator<RecordingPoint[]> {
      for (const [timeS, value] of source.entries()) yield [{ timeS, value }]
    }
    expect(await minMaxBuckets(rows(), source.length, 1, 5)).toEqual([
      [{ timeS: 1, value: 8 }, { timeS: 2, value: -3 }, { timeS: 4, value: null }],
    ])
    expect(await minMaxBuckets(rows(), source.length, 1, 1)).toEqual([[{ timeS: 0, value: null }]])
  })
})
