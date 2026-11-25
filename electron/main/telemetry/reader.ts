import { lstat, open, type FileHandle } from 'node:fs/promises'
import { getDefaultHighWaterMark } from 'node:stream'
import { crc32 } from 'node:zlib'
import type {
  RecordingHeader, RecordingPoint, RecordingRequestLog, RecordingSampleQuery, RecordingSampleWindow, RecordingSummary, SimulationRun,
} from '../../ipc/contract'
import { minMaxBuckets } from './decimation'
import {
  endSchema, FLOAT_BYTES, Frame, FRAME_BYTES, headerSchema, MAGIC, parseJson,
  PREAMBLE_BYTES, RecordingFormatError, ROW_COUNT_BYTES, VERSION,
} from './format'

export class RecordingQueryError extends Error {}

class RecordingCrcError extends RecordingFormatError {}

type RunIdentity = Pick<SimulationRun, 'id' | 'projectId'>

interface Chunk {
  type: number
  offset: number
  length: number
  rows: number
  header: RecordingHeader | null
}

interface SampleChunk extends Chunk {
  firstRow: number
}

interface ChunkIndex {
  summary: RecordingSummary
  samples: SampleChunk[]
  requests: Chunk[]
}

// D19 (phase-7-telemetry.md:55) displays at most two recordings together.
const cachedIndexes = new Map<string, { key: string; index: Promise<ChunkIndex> }>()
const INDEX_CACHE_RUNS = 2

const decodeText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function readInto(file: FileHandle, buffer: Buffer, offset: number): Promise<void> {
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, offset + filled)
    if (bytesRead === 0) throw new RecordingFormatError('Recording changed while it was being read')
    filled += bytesRead
  }
}

async function read(file: FileHandle, length: number, offset: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  await readInto(file, buffer, offset)
  return buffer
}

async function* chunks(file: FileHandle, bytes: number, expected?: RunIdentity): AsyncGenerator<Chunk> {
  const prefix = await read(file, Math.min(bytes, PREAMBLE_BYTES), 0)
  if (prefix.length >= MAGIC.length && !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new RecordingFormatError('Bad recording magic')
  }
  if (prefix.length < PREAMBLE_BYTES) return
  const version = prefix.readUInt32LE(MAGIC.length)
  if (version !== VERSION) throw new RecordingFormatError(`Unsupported recording version ${version}`)

  const buffer = Buffer.allocUnsafe(Math.max(ROW_COUNT_BYTES, getDefaultHighWaterMark(false)))
  let next = PREAMBLE_BYTES
  let header: RecordingHeader | null = null
  while (bytes - next >= FRAME_BYTES) {
    const prefix = await read(file, FRAME_BYTES, next)
    if (crc32(prefix.subarray(0, 5)) !== prefix.readUInt32LE(5)) {
      throw new RecordingCrcError(`Recording frame header CRC-32 mismatch at byte ${next}`)
    }
    const type = prefix.readUInt8()
    const length = prefix.readUInt32LE(1)
    const offset = next + FRAME_BYTES
    if (length > bytes - offset) return

    let checksum = 0
    let rows = 0
    for (let consumed = 0; consumed < length;) {
      const block = buffer.subarray(0, Math.min(buffer.length, length - consumed))
      await readInto(file, block, offset + consumed)
      if (consumed === 0 && type === Frame.samples && length >= ROW_COUNT_BYTES) rows = block.readUInt32LE()
      checksum = crc32(block, checksum)
      consumed += block.length
    }
    if (checksum !== prefix.readUInt32LE(9)) {
      throw new RecordingCrcError(`Recording payload CRC-32 mismatch at byte ${next}`)
    }

    if (!header && type !== Frame.header) throw new RecordingFormatError('Recording header must come first')
    switch (type) {
      case Frame.header:
        if (header) throw new RecordingFormatError('Duplicate recording header')
        header = parseJson(await read(file, length, offset), headerSchema, 'header')
        if (expected && (header.runId !== expected.id || header.projectId !== expected.projectId)) {
          throw new RecordingFormatError('Recording header does not match its run')
        }
        break
      case Frame.samples:
        if (!header || rows === 0 || length !== ROW_COUNT_BYTES + rows * header.channels.length * FLOAT_BYTES) {
          throw new RecordingFormatError('Invalid recording sample frame size')
        }
        break
      case Frame.request:
      case Frame.end:
        break
      default:
        throw new RecordingFormatError(`Unknown recording frame type ${type}`)
    }
    next = offset + length
    if (type === Frame.end && next !== bytes) throw new RecordingFormatError('Unexpected bytes after recording end')
    yield { type, offset, length, rows, header }
  }
}

async function inspect(file: FileHandle, bytes: number, expected?: RunIdentity, salvage = false): Promise<ChunkIndex> {
  const summary: RecordingSummary = {
    header: null, end: null, bytes, sampleCount: 0, requestCount: 0, incomplete: true, integrityError: null,
  }
  const samples: SampleChunk[] = []
  const requests: Chunk[] = []
  try {
    for await (const chunk of chunks(file, bytes, expected)) {
      switch (chunk.type) {
        case Frame.header:
          summary.header = chunk.header
          break
        case Frame.samples:
          samples.push({ ...chunk, firstRow: summary.sampleCount })
          summary.sampleCount += chunk.rows
          break
        case Frame.request:
          requests.push(chunk)
          summary.requestCount++
          break
        case Frame.end:
          summary.end = parseJson(await read(file, chunk.length, chunk.offset), endSchema, 'end')
          summary.incomplete = false
          break
      }
    }
  } catch (error) {
    if (!(salvage && error instanceof RecordingFormatError) && !(summary.header && error instanceof RecordingCrcError)) throw error
    summary.integrityError = error.message
  }
  return { summary, samples, requests }
}

export function sampleTimeS(header: RecordingHeader, index: number): number {
  return (header.firstSampleStep + index * header.samplePeriodSteps) * header.stepLengthS
}

/** Find the first row at or after a lower bound, or strictly after an upper bound. */
function bound(header: RecordingHeader, count: number, timeS: number, upper: boolean): number {
  let first = 0
  while (first < count) {
    const mid = first + Math.floor((count - first) / 2)
    const time = sampleTimeS(header, mid)
    if (time < timeS || (upper && time === timeS)) first = mid + 1
    else count = mid
  }
  return first
}

async function* sampleRows(
  file: FileHandle, samples: SampleChunk[], header: RecordingHeader, columns: number[], first: number, stop: number,
): AsyncGenerator<RecordingPoint[]> {
  const stride = header.channels.length * FLOAT_BYTES
  const rowsPerBlock = Math.max(1, Math.floor(getDefaultHighWaterMark(false) / stride))
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const chunk = samples[mid]!
    if (chunk.firstRow + chunk.rows <= first) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < samples.length; i++) {
    const chunk = samples[i]!
    const index = chunk.firstRow
    if (index >= stop) break
    const start = Math.max(0, first - index)
    const end = Math.min(chunk.rows, stop - index)
    for (let row = start; row < end;) {
      const count = Math.min(rowsPerBlock, end - row)
      const data = await read(file, count * stride, chunk.offset + ROW_COUNT_BYTES + row * stride)
      for (let i = 0; i < count; i++) {
        const timeS = sampleTimeS(header, index + row + i)
        yield columns.map((column) => {
          const value = data.readDoubleLE(i * stride + column * FLOAT_BYTES)
          if (Number.isNaN(value)) return { timeS, value: null }
          if (!Number.isFinite(value)) throw new RecordingFormatError('Invalid recording sample value')
          return { timeS, value }
        })
      }
      row += count
    }
  }
}

export class RecordingReader {
  constructor(private readonly path: string, private readonly expected?: RunIdentity) {}

  private async openFile(): Promise<FileHandle> {
    if (!(await lstat(this.path)).isFile()) throw new RecordingFormatError('Recording path is not a regular file')
    return open(this.path, 'r')
  }

  private async usingFile<T>(fn: (file: FileHandle) => Promise<T>): Promise<T> {
    const file = await this.openFile()
    try {
      return await fn(file)
    } finally {
      await file.close()
    }
  }

  private async index(file: FileHandle): Promise<ChunkIndex> {
    const stat = await file.stat({ bigint: true })
    const key = [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':')
    const cached = cachedIndexes.get(this.path)
    const entry = cached?.key === key ? cached : { key, index: inspect(file, Number(stat.size)) }
    cachedIndexes.delete(this.path)
    cachedIndexes.set(this.path, entry)
    if (cachedIndexes.size > INDEX_CACHE_RUNS) cachedIndexes.delete(cachedIndexes.keys().next().value!)
    let index
    try {
      index = await entry.index
    } catch (error) {
      if (cachedIndexes.get(this.path) === entry) cachedIndexes.delete(this.path)
      throw error
    }
    const { header } = index.summary
    if (header && this.expected && (header.runId !== this.expected.id || header.projectId !== this.expected.projectId)) {
      throw new RecordingFormatError('Recording header does not match its run')
    }
    return index
  }

  header(): Promise<RecordingHeader | null> {
    return this.usingFile(async (file) => {
      for await (const chunk of chunks(file, (await file.stat()).size, this.expected)) return chunk.header
      return null
    })
  }

  /** Verify the CRCs and count frames without decoding any samples. */
  summary(): Promise<RecordingSummary> {
    return this.usingFile(async (file) => (await this.index(file)).summary)
  }

  recover(): Promise<RecordingSummary> {
    return this.usingFile(async (file) => (await inspect(file, (await file.stat()).size, this.expected, true)).summary)
  }

  async readSamples(query: Omit<RecordingSampleQuery, 'id'>): Promise<RecordingSampleWindow> {
    return this.usingFile(async (file) => {
      const { channels, fromS, toS, maxPoints } = query
      if (fromS !== undefined && toS !== undefined && fromS > toS) throw new RecordingQueryError('Inverted recording time range')
      if (maxPoints !== undefined && (!Number.isSafeInteger(maxPoints) || maxPoints < 1)) {
        throw new RecordingQueryError('Invalid recording point budget')
      }

      const { summary: { header, sampleCount, integrityError }, samples } = await this.index(file)
      if (!header) throw new RecordingQueryError('Recording header is incomplete')
      const columns = channels.map((name) => {
        const index = header.channels.findIndex((channel) => channel.name === name)
        if (index < 0) throw new RecordingQueryError(`Unknown recording channel: ${name}`)
        return index
      })
      const first = fromS === undefined ? 0 : bound(header, sampleCount, fromS, false)
      const stop = toS === undefined ? sampleCount : bound(header, sampleCount, toS, true)
      const count = stop - first
      const points = await minMaxBuckets(
        sampleRows(file, samples, header, columns, first, stop), count, columns.length, maxPoints ?? count,
      )
      return { series: channels.map((channel, i) => ({ channel, points: points[i]! })), integrityError }
    })
  }

  /** Used by Verify to compare every stored row without loading the recording into memory. */
  async *sampleValues(): AsyncGenerator<(number | null)[]> {
    const file = await this.openFile()
    try {
      const { summary: { header, sampleCount }, samples } = await this.index(file)
      if (!header) return
      for await (const row of sampleRows(file, samples, header, header.channels.map((_, index) => index), 0, sampleCount)) {
        yield row.map(({ value }) => value)
      }
    } finally {
      await file.close()
    }
  }

  readRequests(): Promise<RecordingRequestLog> {
    return this.usingFile(async (file) => {
      const { summary: { integrityError }, requests } = await this.index(file)
      const lines: string[] = []
      for (const chunk of requests) {
        try {
          lines.push(decodeText.decode(await read(file, chunk.length, chunk.offset)))
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          throw new RecordingFormatError('Invalid UTF-8 recording request')
        }
      }
      return { lines, integrityError }
    })
  }
}
