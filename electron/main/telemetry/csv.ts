import { addAbortListener } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDefaultHighWaterMark } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { telemetryCsv } from '../../../src/domain/telemetry-csv'
import type { RecordingCsvQuery, RecordingHeader } from '../../ipc/contract'
import { safeFileName } from '../screenshot'
import { FLOAT_BYTES, RecordingFormatError } from './format'
import { RecordingQueryError, sampleTimeS } from './reader'
import type { RecordingStore } from './store'

export type PickCsvPath = (suggestedName: string) => Promise<string | null>

// Match the recording reader's inclusive time range (reader.ts:132–145,221–223).
function sampleBound(header: RecordingHeader, count: number, timeS: number, upper: boolean): number {
  let first = 0
  while (first < count) {
    const mid = first + Math.floor((count - first) / 2)
    const time = sampleTimeS(header, mid)
    if (time < timeS || (upper && time === timeS)) first = mid + 1
    else count = mid
  }
  return first
}

async function pickCsvPath(pickPath: PickCsvPath, name: string, signal: AbortSignal): Promise<string | null> {
  let subscription: ReturnType<typeof addAbortListener> | undefined
  const cancelled = new Promise<null>((resolve) => {
    subscription = addAbortListener(signal, () => resolve(null))
  })
  try {
    return await Promise.race([pickPath(name), cancelled])
  } finally {
    subscription?.[Symbol.dispose]()
  }
}

async function writeCsv(path: string, chunks: AsyncIterable<string>, signal: AbortSignal): Promise<void> {
  // A private directory beside the target keeps the final rename on one filesystem.
  const tempDir = await mkdtemp(join(dirname(path), '.blaze-csv-'))
  const tempPath = join(tempDir, 'recording.csv')
  try {
    await pipeline(chunks, createWriteStream(tempPath, { flags: 'wx', encoding: 'utf8' }), { signal })
    signal.throwIfAborted()
    await rename(tempPath, path)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
      console.error('[recordings] CSV temporary directory cleanup failed', error)
    })
  }
}

async function prepareCsv(store: Pick<RecordingStore, 'read'>, query: RecordingCsvQuery, signal: AbortSignal) {
  const { header: recordedHeader, end, incomplete, sampleCount } = await store.read(query.id, (reader) => reader.summary())
  signal.throwIfAborted()
  if (!recordedHeader) throw new RecordingQueryError('Recording header is incomplete')
  const header = recordedHeader
  const byName = new Map(header.channels.map((channel) => [channel.name, channel]))
  const selected = (query.channels ?? header.channels.map(({ name }) => name)).map((name) => {
    const channel = byName.get(name)
    if (!channel) throw new RecordingQueryError(`Unknown recording channel: ${name}`)
    return channel
  })
  // The canonical clock channel is defined at src/domain/telemetry-channels.ts:36.
  const time = byName.get('time')
  const recordedColumns = time && !selected.includes(time) ? [...selected, time] : selected
  const columns = time ? recordedColumns : [{ name: 'time', unit: 's' }, ...recordedColumns]
  const names = recordedColumns.map(({ name }) => name)
  const csv = telemetryCsv(columns, { ...header, finalStateHash: end?.finalStateHash ?? null, incomplete }, query)
  const first = query.fromS === undefined ? 0 : sampleBound(header, sampleCount, query.fromS, false)
  const stop = query.toS === undefined ? sampleCount : sampleBound(header, sampleCount, query.toS, true)
  // Use the reader's block budget (reader.ts:151–152). Its public API materializes
  // a range and verifies the file on every call (reader.ts:206-227).
  const rowsPerBatch = Math.max(1, Math.floor(getDefaultHighWaterMark(false) / (columns.length * FLOAT_BYTES)))

  async function* chunks(): AsyncGenerator<string> {
    yield csv.header
    for (let start = first; start < stop;) {
      signal.throwIfAborted()
      const fromS = sampleTimeS(header, start)
      const toS = sampleTimeS(header, Math.min(stop, start + rowsPerBatch) - 1)
      // Keep equal float64 times together at batch boundaries.
      const next = sampleBound(header, stop, toS, true)
      const series = names.length === 0 ? [] : await store.read(query.id, (reader) =>
        reader.readSamples({ channels: names, fromS, toS }),
      )
      signal.throwIfAborted()
      if (series.some(({ points }) => points.length !== next - start)) {
        throw new RecordingFormatError('Recording changed during CSV export')
      }
      for (let i = 0; i < next - start; i++) {
        const values = series.map(({ points }) => points[i]!.value)
        if (!time) values.unshift(sampleTimeS(header, start + i))
        yield csv.row(values)
      }
      start = next
    }
  }

  return { suggestedName: `${safeFileName(`${header.title} · ${header.startedAt}`)}.csv`, chunks }
}

export function createRecordingCsvExporter(store: Pick<RecordingStore, 'read'>) {
  let active: AbortController | undefined
  let closed = false
  const writes = new Set<Promise<void>>()
  return {
    async shutdown(): Promise<void> {
      closed = true
      active?.abort()
      await Promise.allSettled(writes)
    },
    async export(query: RecordingCsvQuery, pickPath: PickCsvPath): Promise<{ path: string } | null> {
      if (closed) return null
      active?.abort()
      const controller = new AbortController()
      active = controller
      const { signal } = controller
      try {
        const { suggestedName, chunks } = await prepareCsv(store, query, signal)
        const path = await pickCsvPath(pickPath, suggestedName, signal)
        signal.throwIfAborted()
        if (!path) return null
        const writing = writeCsv(path, chunks(), signal)
        writes.add(writing)
        try {
          await writing
          return { path }
        } finally {
          writes.delete(writing)
        }
      } catch (error) {
        if (signal.aborted) return null
        throw error
      } finally {
        if (active === controller) active = undefined
      }
    },
  }
}
