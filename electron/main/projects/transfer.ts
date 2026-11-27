import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAsciiGrid } from '../../../src/domain/terrain'
import type { Project } from '../../ipc/contract'
import type { ComponentInput, ComponentOrigin } from '../../ipc/component-fields'
import { componentInputSchema } from '../../ipc/component-schemas'
import { saveAssemblySchema } from '../../ipc/schemas'
import { inspectGltf } from '../assets/gltf'
import type { Db } from '../db/database'
import { ConflictError, ValidationError, type Repositories } from '../db/repositories'
import { recordingFileName } from '../telemetry/format'
import { checked, PROJECT_FILE, readProjectFile, recordingEntry, sha256, writeProjectFile, type EntrySource, type ProjectVersions } from './container'
import {
  archiveComponent, assetEntry, assetFilename, assetReferences, canonical, componentReferences, projectDocumentSchema,
  remapAssembly, validateFills, validateReferences, type ArchivedAsset, type ArchivedComponent, type ArchivedRecording, type ProjectDocument,
} from './document'
import { cleanStaging, createStaging, publishFiles, type PendingFile, type ProjectFolders } from './publish'
import { reidentifyRecording, validateRecording } from './recordings'

type ImportStage = 'import:staged' | 'import:rows' | 'import:file' | 'import:commit'
type Fault = (stage: ImportStage) => void
type StagedAsset = { asset: ArchivedAsset; staged: string }
type StagedRun = { run: ArchivedRecording; staged: string; info: Awaited<ReturnType<typeof validateRecording>> }

function readAsset(db: Db, repos: Repositories, id: string, kind: 'terrain' | 'model'): ArchivedAsset {
  if (kind === 'terrain') {
    const { asset, noDataValue } = repos.terrain.get(id)
    return { ...asset, noDataValue: noDataValue ?? null }
  }
  const row = db.prepare("SELECT * FROM assets WHERE id = ? AND format IN ('glb', 'gltf')").get(id) as {
    filename: string; format: 'glb' | 'gltf'; bytes: number; triangles: number
    bounds_json: string; hull_json: string | null; imported_at: string
  } | undefined
  if (!row) throw new ValidationError(`Missing model ${id}.`)
  return {
    id, filename: row.filename, format: row.format, bytes: row.bytes, triangles: row.triangles,
    bounds: JSON.parse(row.bounds_json), hull: row.hull_json === null ? null : JSON.parse(row.hull_json), importedAt: row.imported_at,
  }
}

function snapshot(db: Db, repos: Repositories, id: string, includeRecordings: boolean): ProjectDocument {
  const project = repos.projects.get(id)
  const stored = db.prepare('SELECT 1 FROM assemblies WHERE project_id = ?').get(id)
  let assembly: ProjectDocument['assembly'] = null
  if (stored) {
    const { revision, updatedAt, ...doc } = repos.assemblies.load(id)
    assembly = { updatedAt, input: { ...doc, baseRevision: revision } }
  }
  const recordings: ProjectDocument['recordings'] = []
  if (includeRecordings) {
    for (const { open, fileName, ...run } of repos.runs.listByProject(id)) {
      if (open) throw new ConflictError('Finish recording before exporting this project with recordings.')
      if (fileName === null) continue
      if (fileName !== recordingFileName(run.id)) throw new ValidationError('Invalid recording file name.')
      recordings.push(checked(projectDocumentSchema.shape.recordings.element.strip(), run, 'Recording'))
    }
  }
  return checked(projectDocumentSchema, {
    project, assembly, tuning: repos.tuning.get(id), recordings,
    components: [...componentReferences(assembly?.input)].map((id) => archiveComponent(repos.components.get(id))),
    assets: [...assetReferences(assembly?.input)].map(([id, kind]) => readAsset(db, repos, id, kind)),
  }, 'Project')
}

function allocateIds(ids: string[], occupied: (id: string) => boolean): Map<string, string> {
  const reserved = new Set(ids.map((id) => id.toLowerCase()))
  return new Map(ids.map((id) => {
    let target = id
    if (occupied(id)) {
      do { target = randomUUID() } while (reserved.has(target) || occupied(target))
      reserved.add(target)
    }
    return [id, target]
  }))
}

function idExists(db: Db, table: 'projects' | 'assembly_parts' | 'components' | 'simulation_runs') {
  const query = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`)
  return (id: string) => query.get(id) !== undefined
}

function validateAsset(asset: ArchivedAsset, bytes: Buffer): void {
  if (asset.format === 'asc') {
    const parsed = parseAsciiGrid(bytes.toString('utf8'), 'm', asset.noDataValue ?? undefined)
    if (!parsed.ok) throw new ValidationError(`Invalid terrain "${asset.filename}" (${parsed.reason}).`)
    return
  }
  try {
    const facts = inspectGltf(bytes, assetFilename(asset))
    if (facts.triangles !== asset.triangles || canonical(facts.bounds) !== canonical(asset.bounds)) {
      throw new Error('Stored model facts do not match the file.')
    }
  } catch (error) {
    throw new ValidationError(`Invalid model "${asset.filename}". ${(error as Error).message}`, { cause: error })
  }
}

function planAssets(db: Db, repos: Repositories, folders: ProjectFolders, assets: StagedAsset[]) {
  const files: PendingFile[] = []
  const inserts: ArchivedAsset[] = []
  for (const { asset, staged } of assets) {
    const name = assetFilename(asset)
    const target = join(folders.assets, name)
    const format = db.prepare('SELECT format FROM assets WHERE id = ?').pluck().get(asset.id)
    if (format !== undefined) {
      const kind = asset.format === 'asc' ? 'terrain' : 'model'
      const local = readAsset(db, repos, asset.id, kind)
      if (canonical({ ...local, importedAt: asset.importedAt, filename: asset.filename }) !== canonical(asset)) {
        throw new ConflictError(`The installed asset "${asset.filename}" has different metadata.`)
      }
    } else inserts.push(asset)
    if (!existsSync(target)) files.push({ staged, directory: 'assets', name })
    else if (!lstatSync(target).isFile() || lstatSync(target).size !== asset.bytes || sha256(readFileSync(target)) !== asset.id) {
      throw new ConflictError(`The installed asset "${asset.filename}" has different file bytes.`)
    }
  }
  return { files, inserts }
}

function insertAssets(db: Db, repos: Repositories, assets: ArchivedAsset[]): void {
  for (const asset of assets) {
    if (asset.format === 'asc') repos.terrain.add(asset, asset.noDataValue ?? undefined)
    else repos.assets.add(asset)
    db.prepare('UPDATE assets SET imported_at = ? WHERE id = ?').run(asset.importedAt, asset.id)
  }
}

type ComponentInsert = {
  id: string
  input: ComponentInput
  origin: ComponentOrigin
  archive?: Exclude<ArchivedComponent, { origin: 'built-in' }>
}

function planComponents(db: Db, repos: Repositories, components: ProjectDocument['components']) {
  const exists = idExists(db, 'components')
  const inserts: ComponentInsert[] = []
  const ids = allocateIds(components.filter((component) => component.origin !== 'built-in').map((component) => component.id), exists)
  const reserved = new Set([...components.map((component) => component.id), ...ids.values()])
  for (const component of components) {
    if (component.origin === 'built-in') {
      if (!exists(component.id)) throw new ValidationError(`Built-in component ${component.id} is unavailable.`)
      const installed = repos.components.get(component.id)
      const reference = archiveComponent(installed)
      if (reference.origin !== 'built-in' || reference.version !== component.version) {
        throw new ValidationError(`The installed catalog has a different version of "${installed.name}".`)
      }
      const fills = validateFills(installed, component.fills)
      if (canonical(fills) === canonical(installed.fills ?? {})) {
        ids.set(component.id, component.id)
      } else {
        // Gap-fills belong to the exporting user's catalog. A project-local copy
        // keeps those values without changing unrelated projects on this install.
        const input: ComponentInput = checked(componentInputSchema, {
          category: installed.category, name: installed.name, manufacturer: installed.manufacturer,
          notes: installed.notes, specs: { ...installed.specs, ...fills },
        }, 'Component')
        let id: string
        do { id = randomUUID() } while (reserved.has(id) || exists(id))
        reserved.add(id)
        ids.set(component.id, id)
        inserts.push({ id, input, origin: 'imported' })
      }
      continue
    }
    inserts.push({ id: ids.get(component.id)!, input: component.input, origin: component.origin, archive: component })
  }
  return { ids, inserts }
}

function insertComponents(db: Db, repos: Repositories, inserts: ComponentInsert[]): void {
  for (const { id, input, origin, archive } of inserts) {
    repos.components.create(input, origin, id)
    if (archive) {
      db.prepare('UPDATE components SET revision = ?, created_at = ?, updated_at = ? WHERE id = ?')
        .run(archive.revision, archive.createdAt, archive.updatedAt, id)
    }
  }
}

export class ProjectTransfer {
  private pendingImport: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: () => Db,
    private readonly repos: Repositories,
    private readonly folders: ProjectFolders,
    private readonly versions: () => ProjectVersions,
  ) {}

  async export(id: string, recordings: boolean, path: string): Promise<void> {
    const db = this.connection()
    const document = db.transaction(() => snapshot(db, this.repos, id, recordings))()
    validateReferences(document)
    const sources: EntrySource[] = [{ name: PROJECT_FILE, bytes: Buffer.from(JSON.stringify(document)) }]
    for (const asset of document.assets) {
      sources.push({
        name: assetEntry(asset), path: join(this.folders.assets, assetFilename(asset)), size: asset.bytes, sha256: asset.id,
      })
    }
    for (const run of document.recordings) {
      const source = join(this.folders.recordings, recordingFileName(run.id))
      if (!lstatSync(source).isFile()) throw new ValidationError('Choose a regular recording file.')
      await validateRecording(source, { ...run, projectId: id })
      sources.push({ name: recordingEntry(run.id), path: source, size: run.bytes })
    }
    await writeProjectFile(path, this.versions(), sources)
  }

  import(path: string, fault?: Fault): Promise<Project> {
    const result = this.pendingImport.then(() => this.importFile(path, fault))
    this.pendingImport = result.then(() => {}, () => {})
    return result
  }

  private async importFile(path: string, fault?: Fault): Promise<Project> {
    const db = this.connection()
    if (db.readonly) throw new ValidationError('Project import requires a writable database.')
    const staging = createStaging(this.folders.root)
    try {
      return await readProjectFile(path, async (reader) => {
        const document = checked(projectDocumentSchema, await reader.metadata(), 'Project')
        validateReferences(document)
        const expected = [
          ...document.assets.map((asset) => ({ name: assetEntry(asset), bytes: asset.bytes, hash: asset.id })),
          ...document.recordings.map((run) => ({ name: recordingEntry(run.id), bytes: run.bytes, hash: undefined })),
        ]
        if (reader.entries.size !== expected.length + 1 || expected.some(({ name, bytes, hash }) => {
          const entry = reader.entries.get(name)
          return !entry || entry.bytes !== bytes || (hash !== undefined && hash !== entry.sha256)
        })) throw new ValidationError('The archive entries do not match the project metadata.')

        const assets: StagedAsset[] = []
        const runs: StagedRun[] = []
        for (const [index, asset] of document.assets.entries()) {
          const staged = `entry-${index}`
          const target = join(staging, staged)
          await reader.extract(assetEntry(asset), target)
          validateAsset(asset, await readFile(target))
          assets.push({ asset, staged })
        }
        for (const [index, run] of document.recordings.entries()) {
          const staged = `entry-${assets.length + index}`
          const target = join(staging, staged)
          await reader.extract(recordingEntry(run.id), target)
          const info = await validateRecording(target, { ...run, projectId: document.project.id })
          runs.push({ run, staged, info })
        }
        fault?.('import:staged')
        if (db !== this.connection() || !db.open) throw new ConflictError('The database changed during import. Retry the import.')
        const projectId = allocateIds([document.project.id], idExists(db, 'projects')).get(document.project.id)!
        const runExists = idExists(db, 'simulation_runs')
        const runIds = allocateIds(runs.map(({ run }) => run.id), (id) =>
          runExists(id) || existsSync(join(this.folders.recordings, recordingFileName(id))))
        const preparedRuns = await this.prepareRuns(staging, runs, runIds, projectId)
        if (db !== this.connection() || !db.open) throw new ConflictError('The database changed during import. Retry the import.')

        return db.transaction(() => {
          const project = { ...document.project, id: projectId }
          const assetPlan = planAssets(db, this.repos, this.folders, assets)
          const componentPlan = planComponents(db, this.repos, document.components)
          const assembly = document.assembly
          const parts = allocateIds(assembly?.input.parts.map((part) => part.id) ?? [], idExists(db, 'assembly_parts'))
          const remapped = assembly && checked(saveAssemblySchema, remapAssembly(assembly.input, projectId, parts, componentPlan.ids), 'Assembly')
          db.prepare('INSERT INTO projects (id, name, frame_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(project.id, project.name, project.frameType, project.createdAt, project.updatedAt)
          insertAssets(db, this.repos, assetPlan.inserts)
          insertComponents(db, this.repos, componentPlan.inserts)
          const files = assetPlan.files
          if (assembly && remapped) {
            this.repos.assemblies.save(remapped)
            db.prepare('UPDATE assemblies SET revision = ?, updated_at = ? WHERE project_id = ?')
              .run(assembly.input.baseRevision, assembly.updatedAt, projectId)
            db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(project.updatedAt, projectId)
          }
          this.repos.tuning.set(projectId, document.tuning)
          for (const { run, staged } of preparedRuns) {
            const name = recordingFileName(run.id)
            db.prepare(`INSERT INTO simulation_runs
              (id, project_id, started_at, duration_s, status, kind, title, file_name, bytes, sample_count,
               engine_version, state_hash, end_reason, incomplete, recording_open)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
              .run(run.id, projectId, run.startedAt, run.durationS, run.status, run.kind, run.title, name,
                run.bytes, run.sampleCount, run.engineVersion, run.stateHash, run.endReason, Number(run.incomplete))
            files.push({ staged, directory: 'recordings', name })
          }
          fault?.('import:rows')
          publishFiles(this.folders, staging, projectId, files, () => fault?.('import:file'))
          fault?.('import:commit')
          return project
        }).immediate()
      })
    } finally {
      try {
        cleanStaging(db, this.folders, staging)
      } catch (error) {
        console.error('[projects] import cleanup will be retried at startup', error)
      }
    }
  }

  private async prepareRuns(staging: string, runs: StagedRun[], ids: Map<string, string>, projectId: string) {
    const output: { run: ArchivedRecording; staged: string }[] = []
    for (const [index, { run, staged, info }] of runs.entries()) {
      const id = ids.get(run.id)!
      if (id === run.id && projectId === info.header.projectId) {
        output.push({ run, staged })
      } else {
        const target = `run-${index}`
        const bytes = await reidentifyRecording(join(staging, staged), join(staging, target), info, id, projectId)
        output.push({ run: { ...run, id, bytes }, staged: target })
      }
    }
    return output
  }
}
