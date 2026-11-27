import { lstat, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DiagnosticsPreview, GpuPreference } from '../../ipc/contract'
import { RECORDING_EXTENSION } from '../telemetry/format'
import type { Logger } from './logger'
import { writeZip } from './zip'

const logsEntry = {
  name: 'logs/main.log',
  description: 'Application logs, oldest first, including rotated logs. Logs may contain user file paths.',
}
const systemEntry = {
  name: 'system.json',
  description: 'App, engine and Electron versions, operating system, GPU information, graphics preference, and database schema version and file size.',
}
const recordingsEntry = {
  name: 'recordings.json',
  description: 'Recording filenames and sizes.',
}
const databaseEntry = {
  name: 'blaze-uav.db',
  description: 'A snapshot of the project database, including project data.',
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function listRecordings(directory: string) {
  const filenames = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const recordings: { name: string; bytes: number }[] = []
  for (const name of filenames.sort()) {
    if (!name.endsWith(RECORDING_EXTENSION)) continue
    const entry = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (entry?.isFile()) recordings.push({ name, bytes: entry.size })
  }
  return recordings
}

export function createDiagnostics(options: {
  logger: Pick<Logger, 'readLogs'>
  recordingsDirectory: string
  databasePath: string
  schemaVersion: () => number
  backupDatabase: (path: string) => Promise<unknown>
  versions: () => { app: string; engine: string | null; electron: string }
  os: () => { platform: string; arch: string; release: string }
  graphicsPreference: () => GpuPreference
  gpuInfo: () => Promise<unknown>
}) {
  function entries(includeDatabase: boolean, staging: string) {
    return [
      { entry: logsEntry, read: () => options.logger.readLogs() },
      { entry: systemEntry, read: async () => json({
        versions: options.versions(),
        os: options.os(),
        graphicsPreference: options.graphicsPreference(),
        gpu: await options.gpuInfo().catch((error: unknown) => ({ unavailable: String(error) })),
        database: { schemaVersion: options.schemaVersion(), bytes: (await stat(options.databasePath)).size },
      }) },
      { entry: recordingsEntry, read: async () => json(await listRecordings(options.recordingsDirectory)) },
      ...(includeDatabase ? [{ entry: databaseEntry, read: async () => {
        const path = join(staging, databaseEntry.name)
        await options.backupDatabase(path)
        return path
      } }] : []),
    ]
  }

  return {
    preview(includeDatabase: boolean): DiagnosticsPreview {
      return { entries: entries(includeDatabase, '').map(({ entry }) => entry) }
    },
    async save(path: string, includeDatabase: boolean): Promise<{ path: string }> {
      const staging = await mkdtemp(join(dirname(path), '.blaze-diagnostics-'))
      try {
        const archive = join(staging, 'diagnostics.zip')
        const files = []
        for (const { entry, read } of entries(includeDatabase, staging)) {
          files.push({ name: entry.name, data: await read() })
        }
        await writeZip(archive, files)
        await rename(archive, path)
        return { path }
      } finally {
        await rm(staging, { force: true, recursive: true }).catch((error: unknown) => {
          console.warn('Could not remove diagnostics temporary files', error)
        })
      }
    },
  }
}
