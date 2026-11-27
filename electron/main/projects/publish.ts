import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Db } from '../db/database'
import { recordingFileName, runIdSchema } from '../telemetry/format'

const pending = 'publish.json'
const prefix = '.blazeproj-import-'
const assetName = /^[a-f0-9]{64}\.(asc|glb|gltf)$/
const recordingName = (name: string) => {
  const id = name.split('.')[0]!
  return runIdSchema.safeParse(id).success && name === recordingFileName(id)
}

export type ProjectFolders = { root: string; assets: string; recordings: string }
const fileSchema = z.strictObject({
  staged: z.string().regex(/^(entry|run)-\d+$/),
  directory: z.enum(['assets', 'recordings']),
  name: z.string(),
}).refine(({ directory, name }) => directory === 'assets' ? assetName.test(name) : recordingName(name))
const directories = z.enum(['assets', 'recordings'])
const journalSchema = z.strictObject({ id: z.uuid(), files: z.array(fileSchema), created: z.array(directories) })
export type PendingFile = z.infer<typeof fileSchema>

export function createStaging(root: string): string {
  const path = join(root, prefix + randomUUID())
  mkdirSync(path)
  return path
}

export function publishFiles(
  folders: ProjectFolders, staging: string, id: string, files: PendingFile[], afterFile?: () => void,
): void {
  if (files.length === 0) return
  const draft = join(staging, pending + '.tmp')
  const created = [...new Set(files.map((file) => file.directory))].filter((name) => !existsSync(folders[name]))
  writeFileSync(draft, JSON.stringify({ id, files, created }), { flag: 'wx', flush: true })
  renameSync(draft, join(staging, pending))
  for (const file of files) {
    mkdirSync(folders[file.directory], { recursive: true })
    // A hard link publishes atomically and fails if the target has appeared meanwhile.
    linkSync(join(staging, file.staged), join(folders[file.directory], file.name))
    afterFile?.()
  }
}

export function cleanStaging(db: Db, folders: ProjectFolders, staging: string): void {
  const journal = join(staging, pending)
  if (existsSync(journal)) {
    const { id, files, created } = journalSchema.parse(JSON.parse(readFileSync(journal, 'utf8')))
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) {
      for (const file of files) {
        const target = join(folders[file.directory], file.name)
        if (!existsSync(target)) continue
        const staged = lstatSync(join(staging, file.staged), { bigint: true })
        const published = lstatSync(target, { bigint: true })
        if (staged.dev === published.dev && staged.ino === published.ino) rmSync(target)
      }
      for (const name of created) {
        const directory = folders[name]
        if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory)
      }
    }
    rmSync(journal)
  }
  rmSync(staging, { recursive: true, force: true })
}

export function recoverInterruptedImports(db: Db, folders: ProjectFolders): void {
  for (const entry of readdirSync(folders.root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix) && runIdSchema.safeParse(entry.name.slice(prefix.length)).success) {
      cleanStaging(db, folders, join(folders.root, entry.name))
    }
  }
}
