import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { inspectGltf } from '../../electron/main/assets/gltf'
import { importTerrainFile } from '../../electron/main/assets/terrain-store'
import { parsePack } from '../../electron/main/components/pack'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories, ValidationError } from '../../electron/main/db/repositories'
import { validateRecording } from '../../electron/main/projects/recordings'
import { ProjectTransfer } from '../../electron/main/projects/transfer'
import { RecordingReader } from '../../electron/main/telemetry/reader'

const root = resolve(import.meta.dirname, '../fixtures/hostile')
const fixtures = existsSync(root)
  ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name)).filter((path) => !/\.md$/i.test(path))
  : []

if (!fixtures.length) {
  it.skip('refuses hostile input fixtures', () => {})
}

// Use the same disposable database setup as tests/unit/project-transfer.test.ts:35–53.
async function withDatabase<T>(work: (transfer: ProjectTransfer, repos: ReturnType<typeof createRepositories>, assets: string) => Promise<T>) {
  const folder = mkdtempSync(join(tmpdir(), 'blaze-hostile-'))
  try {
    const folders = { root: folder, assets: join(folder, 'assets'), recordings: join(folder, 'recordings') }
    const db = openDatabase(join(folder, 'blaze-uav.db'))
    try {
      const repos = createRepositories(db, undefined, folders.recordings)
      const version = JSON.parse(readFileSync(resolve(root, '../../../package.json'), 'utf8')).version
      const transfer = new ProjectTransfer(() => db, repos, folders, () => ({ appVersion: version, engineVersion: version }))
      return await work(transfer, repos, folders.assets)
    } finally {
      db.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

async function checkRecording(path: string) {
  const { header, sampleCount, integrityError } = await new RecordingReader(path).summary()
  if (integrityError) throw new ValidationError(integrityError)
  if (!header) throw new ValidationError('Recording header is missing')
  await validateRecording(path, { id: header.runId, projectId: header.projectId, incomplete: false, sampleCount })
}

for (const path of fixtures) {
  const name = relative(root, path)
  it(`refuses ${name} with a message`, async () => {
    switch (extname(name).toLowerCase()) {
      case '.gltf':
      case '.glb': expect(() => inspectGltf(readFileSync(path), name)).toThrow(/\S/); break
      case '.asc': {
        const result = await withDatabase(async (_transfer, repos, assets) =>
          importTerrainFile(path, assets, repos, { verticalUnit: 'm' }))
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION')
          expect(result.error.message).toMatch(/\S/)
        }
        break
      }
      case '.json':
      case '.blazepack': expect(() => parsePack(readFileSync(path, 'utf8'))).toThrow(/\S/); break
      case '.blzr': await expect(checkRecording(path)).rejects.toThrow(/\S/); break
      case '.blazeproj':
        await withDatabase(async (transfer, repos) => {
          await expect(transfer.import(path)).rejects.toThrow(/\S/)
          expect(repos.projects.list()).toEqual([])
        })
        break
      default: throw new Error(`Unmapped hostile fixture: ${name}`)
    }
  })
}
