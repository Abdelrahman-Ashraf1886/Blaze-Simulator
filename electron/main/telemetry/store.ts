import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RecordingHeader, RecordingRun } from '../../ipc/contract'
import { NotFoundError, ValidationError, type Repositories } from '../db/repositories'
import { recordingFileName } from './format'
import { RecordingReader, sampleTimeS } from './reader'
import { RecordingWriter, type RecordingWriterOptions } from './writer'

type StoredRun = ReturnType<Repositories['runs']['get']>

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class RecordingStore {
  constructor(private readonly dir: string, private readonly runs: Repositories['runs']) {}

  /** Recording integration supplies an explicit buffer budget and its own sampling metadata. */
  async start(header: RecordingHeader, options: Omit<RecordingWriterOptions, 'onSettled'>): Promise<RecordingWriter | null> {
    try {
      const snapshot = { ...header }
      const fileName = recordingFileName(snapshot.runId)
      this.runs.create(snapshot)
      return await RecordingWriter.start(join(this.dir, fileName), snapshot, {
        ...options,
        onSettled: ({ ownsFile, bytes, sampleCount, end, failure }) => this.runs.finish(snapshot.runId, {
          status: end?.status ?? 'failed',
          durationS: end?.elapsedS ?? (sampleCount > 0 ? sampleTimeS(snapshot, sampleCount - 1) : 0),
          fileName: ownsFile ? fileName : null,
          bytes,
          sampleCount,
          stateHash: end?.finalStateHash ?? null,
          endReason: failure ?? end?.reason ?? null,
          incomplete: end === null,
        }),
      })
    } catch (error) {
      console.error('[recordings] could not start recording', error)
      return null
    }
  }

  private path(run: StoredRun): string | null {
    if (!run.fileName) return null
    if (run.fileName !== recordingFileName(run.id)) throw new ValidationError('Invalid recording file name')
    return join(this.dir, run.fileName)
  }

  private async fileSize(path: string): Promise<number | null> {
    try {
      const stat = await lstat(path)
      return stat.isFile() ? stat.size : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private async withFileStatus(run: StoredRun): Promise<RecordingRun> {
    const path = this.path(run)
    const bytes = path ? await this.fileSize(path) : null
    return { ...run, bytes: bytes ?? run.bytes, fileMissing: path !== null && bytes === null }
  }

  list(projectId: string): Promise<RecordingRun[]> {
    return Promise.all(this.runs.listByProject(projectId).map((run) => this.withFileStatus(run)))
  }

  listRecent(limit: number): Promise<RecordingRun[]> {
    return Promise.all(this.runs.listRecent(limit).map((run) => this.withFileStatus(run)))
  }

  get(id: string): Promise<RecordingRun> {
    return this.withFileStatus(this.runs.get(id))
  }

  delete(id: string): null {
    this.runs.delete(id)
    return null
  }

  async read<T>(id: string, read: (reader: RecordingReader) => Promise<T>): Promise<T> {
    const run = this.runs.get(id)
    const path = this.path(run)
    if (!path) throw new NotFoundError('Run has no recording file')
    try {
      return await read(new RecordingReader(path, run))
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError('Recording file missing')
      throw error
    }
  }

  private async *files(): AsyncGenerator<{ name: string; bytes: number }> {
    let entries
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const bytes = await this.fileSize(join(this.dir, entry.name))
      if (bytes !== null) yield { name: entry.name, bytes }
    }
  }

  async totalSize(): Promise<number> {
    let bytes = 0
    for await (const file of this.files()) bytes += file.bytes
    return bytes
  }

  /** Call before exposing IPC or allowing new recordings. Orphans remain on disk. */
  async recover(): Promise<string[]> {
    for (const run of this.runs.listOpen()) {
      let summary
      let reason = 'Recording interrupted before the run row was closed'
      try {
        summary = await this.read(run.id, (reader) => reader.recover())
        if (summary.integrityError) reason += ` (${summary.integrityError})`
      } catch (error) {
        reason += ` (${error instanceof Error ? error.message : String(error)})`
      }
      const sampleCount = summary?.sampleCount ?? 0
      const durationS = summary?.end?.elapsedS
        ?? (summary?.header && sampleCount > 0 ? sampleTimeS(summary.header, sampleCount - 1) : 0)
      this.runs.finish(run.id, {
        status: 'aborted',
        fileName: run.fileName,
        bytes: summary?.bytes ?? run.bytes,
        sampleCount,
        durationS,
        stateHash: summary?.end?.finalStateHash ?? null,
        endReason: reason,
        incomplete: summary?.incomplete ?? true,
      })
    }
    const known = new Set(this.runs.fileNames())
    const orphans: string[] = []
    for await (const { name } of this.files()) if (!known.has(name)) orphans.push(name)
    return orphans.sort()
  }
}
