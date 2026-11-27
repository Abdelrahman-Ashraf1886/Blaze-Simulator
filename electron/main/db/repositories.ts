import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { recordingFileName } from '../telemetry/format'
import { TRIANGLE_WARNING } from '../../ipc/contract'
import { validateOverrides, type ParamError, type TuningOverrides } from '../../../src/domain/controller-params'
import {
  COMPONENT_SCHEMA_VERSION,
  fieldDef,
  isOverridable,
  type Component,
  type ComponentCategory,
  type ComponentInput,
  type ComponentOrigin,
  type SpecValue,
} from '../../ipc/component-fields'
import type {
  AssetInfo,
  TerrainAssetInfo,
  Bounds3,
  Assembly,
  AssemblyPart,
  CreateProjectInput,
  FrameParams,
  EnvironmentDoc,
  FlightConditionsDoc,
  FrameType,
  InterferenceSettingsDoc,
  ModelHull,
  MotorMount,
  PartKind,
  Project,
  RenameProjectInput,
  RecordingHeader,
  RecordingKind,
  RecordingRun,
  RunStatus,
  SaveAssemblyInput,
  SaveAssemblyResult,
} from '../../ipc/contract'
import type { Db } from './database'

/**
 * Starting frame dimensions for a new assembly, chosen per layout so the first
 * view looks plausible. These are editable design parameters, not component
 * specifications; the workshop labels them as starting values.
 */
export const STARTING_FRAME: Record<FrameType, FrameParams> = {
  'quad-x': { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 },
  'hex-x': { motorDiagonal: 0.55, armWidth: 0.02, armThickness: 0.004, plateSize: 0.15 },
  'octo-x': { motorDiagonal: 0.8, armWidth: 0.022, armThickness: 0.005, plateSize: 0.2 },
}

interface PartRow {
  id: string
  parent_id: string | null
  mount_id: string | null
  kind: PartKind
  name: string
  shape_json: string
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  mass_kg: number | null
  mass_source: 'user' | null
  component_id: string | null
  inertia_json: string | null
  overrides_json?: string | null
  camera_fov_deg?: number | null
}

const toPart = (r: PartRow): AssemblyPart => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  shape: JSON.parse(r.shape_json) as AssemblyPart['shape'],
  parentId: r.parent_id,
  mountId: r.mount_id,
  position: [r.px, r.py, r.pz],
  rotation: [r.qx, r.qy, r.qz, r.qw],
  mass: r.mass_kg !== null && r.mass_source ? { valueKg: r.mass_kg, source: r.mass_source } : null,
  // Omitted when unlinked, so documents without links round-trip unchanged.
  ...(r.component_id ? { componentId: r.component_id } : {}),
  // Omitted when not set, so documents without an override round-trip unchanged.
  ...(r.inertia_json ? { inertia: JSON.parse(r.inertia_json) as AssemblyPart['inertia'] } : {}),
  // Omitted when there are none (schema v11).
  ...(r.overrides_json ? { overrides: JSON.parse(r.overrides_json) as AssemblyPart['overrides'] } : {}),
  // Omitted when not set (schema v14).
  ...(r.camera_fov_deg != null ? { cameraFovDeg: r.camera_fov_deg } : {}),
})

const wiringFields = (w: Pick<Assembly, 'wires' | 'schematic'>) => ({
  ...(w.wires?.length ? { wires: w.wires } : {}),
  ...(w.schematic && Object.keys(w.schematic).length ? { schematic: w.schematic } : {}),
})

/** A save was based on an older revision than the one stored. */
export class ConflictError extends Error {}
/** Input passed schema validation but contradicts stored data. */
export class ValidationError extends Error {}

interface ComponentRow {
  id: string
  category: ComponentCategory
  name: string
  manufacturer: string | null
  notes: string | null
  spec_json: string
  origin: ComponentOrigin
  schema_version: number
  revision: number
  created_at: string
  updated_at: string
}

const toComponent = (r: ComponentRow): Component => ({
  id: r.id,
  category: r.category,
  name: r.name,
  manufacturer: r.manufacturer,
  notes: r.notes,
  specs: JSON.parse(r.spec_json) as Component['specs'],
  origin: r.origin,
  schemaVersion: r.schema_version,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const READ_ONLY =
  'Built-in components cannot be changed or deleted. Duplicate it to make your own version.'

interface AssetRow {
  id: string
  filename: string
  format: 'glb' | 'gltf'
  bytes: number
  triangles: number
  bounds_json: string
  hull_json: string | null
  imported_at: string
}

const toAsset = (r: AssetRow): AssetInfo => ({
  id: r.id,
  filename: r.filename,
  format: r.format,
  bytes: r.bytes,
  triangles: r.triangles,
  bounds: JSON.parse(r.bounds_json) as Bounds3,
  hull: r.hull_json === null ? null : (JSON.parse(r.hull_json) as ModelHull),
  importedAt: r.imported_at,
  warnings:
    r.triangles > TRIANGLE_WARNING
      ? [`${r.triangles.toLocaleString('en-US')} triangles; above ${TRIANGLE_WARNING.toLocaleString('en-US')} the viewport may slow down.`]
      : [],
})

interface TerrainAssetRow {
  id: string
  filename: string
  format: 'asc'
  bytes: number
  imported_at: string
  terrain_nodata_value: number | null
}

const toTerrainAsset = (r: TerrainAssetRow): TerrainAssetInfo => ({
  id: r.id,
  filename: r.filename,
  format: r.format,
  bytes: r.bytes,
  importedAt: r.imported_at,
})

interface ProjectRow {
  id: string
  name: string
  frame_type: FrameType
  created_at: string
  updated_at: string
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  frameType: r.frame_type,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class NotFoundError extends Error {}

/** Tuning overrides refused by `validateOverrides`; `errors` names every parameter at fault. */
export class TuningValidationError extends ValidationError {
  constructor(readonly errors: ParamError[]) {
    super(errors.map((e) => e.message).join('; '))
  }
}

interface RunRow {
  id: string
  project_id: string
  project_name: string
  started_at: string
  duration_s: number
  status: RunStatus
  kind: RecordingKind | null
  title: string | null
  file_name: string | null
  bytes: number | null
  sample_count: number | null
  engine_version: string | null
  state_hash: string | null
  end_reason: string | null
  incomplete: number | null
  recording_open: number | null
}

type StoredRun = Omit<RecordingRun, 'fileMissing'>

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    startedAt: row.started_at,
    durationS: row.duration_s,
    status: row.status,
    kind: row.kind,
    title: row.title,
    fileName: row.file_name,
    bytes: row.bytes,
    sampleCount: row.sample_count,
    engineVersion: row.engine_version,
    stateHash: row.state_hash,
    endReason: row.end_reason,
    incomplete: row.incomplete === null ? null : row.incomplete === 1,
    open: row.recording_open === 1,
  }
}

export function createRepositories(source: Db | (() => Db), now: () => Date = () => new Date(), recordingsDir?: string) {
  // A failed live restore may reopen the original connection while these repositories are in use.
  const connection = typeof source === 'function' ? source : () => source
  const db = {
    prepare: (sql: string) => connection().prepare(sql),
    transaction: <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
      (...args: Args) => connection().transaction(fn)(...args),
  }
  const getProject = (id: string): Project => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) throw new NotFoundError(`Project ${id} not found`)
    return toProject(row)
  }

  const selectRuns = 'SELECT r.*, p.name AS project_name FROM simulation_runs r JOIN projects p ON p.id = r.project_id'
  const getRun = (id: string): StoredRun => {
    const row = db.prepare(`${selectRuns} WHERE r.id = ?`).get(id) as RunRow | undefined
    if (!row) throw new NotFoundError(`Run ${id} not found`)
    return toRun(row)
  }
  const projectRuns = (id: string): StoredRun[] => {
    getProject(id)
    return (db.prepare(`${selectRuns} WHERE r.project_id = ? ORDER BY r.started_at DESC, r.id`).all(id) as RunRow[]).map(toRun)
  }
  const removeRunFiles = (runs: StoredRun[]): void => {
    if (connection().readonly) throw new ValidationError('Data recovery mode is read-only.')
    const paths = runs.flatMap((run) => {
      if (run.open) throw new ConflictError(`Run ${run.id} is still recording`)
      if (run.fileName === null) return []
      if (!recordingsDir || run.fileName !== recordingFileName(run.id)) throw new ValidationError('Invalid recording file name')
      return [join(recordingsDir, run.fileName)]
    })
    // Explicit deletions are cold-path operations. Keep the rows if unlink fails.
    for (const path of paths) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  /** The saved gain overrides of a project (schema v13), name → value. */
  const tuningOf = (projectId: string): TuningOverrides => {
    getProject(projectId)
    const rows = db.prepare('SELECT param_name, value FROM controller_tuning WHERE project_id = ? ORDER BY param_name').all(projectId) as {
      param_name: string
      value: number
    }[]
    return Object.fromEntries(rows.map((r) => [r.param_name, r.value]))
  }

  const getComponent = (id: string): Component => {
    const row = db.prepare('SELECT * FROM components WHERE id = ?').get(id) as ComponentRow | undefined
    if (!row) throw new NotFoundError(`Component ${id} not found`)
    return withFills(toComponent(row), fillsOf(id))
  }

  /** Catalog gap-fills (schema v11) of one component, or of all when `id` is omitted. */
  function fillsOf(id: string): Record<string, SpecValue> | undefined
  function fillsOf(): Map<string, Record<string, SpecValue>>
  function fillsOf(id?: string) {
    const rows = (
      id === undefined
        ? db.prepare('SELECT component_id, field_key, spec_json FROM component_fills ORDER BY field_key').all()
        : db.prepare('SELECT component_id, field_key, spec_json FROM component_fills WHERE component_id = ? ORDER BY field_key').all(id)
    ) as { component_id: string; field_key: string; spec_json: string }[]
    const all = new Map<string, Record<string, SpecValue>>()
    for (const r of rows) all.set(r.component_id, { ...all.get(r.component_id), [r.field_key]: JSON.parse(r.spec_json) as SpecValue })
    return id === undefined ? all : all.get(id)
  }
  const withFills = (c: Component, fills: Record<string, SpecValue> | undefined): Component => (fills ? { ...c, fills } : c)

  /** Inserts a validated record. `origin` is 'user' unless an import or the seed loader says otherwise. */
  const createComponent = (input: ComponentInput, origin: ComponentOrigin = 'user', id: string = randomUUID()): Component => {
    const ts = now().toISOString()
    db.prepare(
      `INSERT INTO components (id, category, name, manufacturer, notes, spec_json, origin, schema_version, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, input.category, input.name, input.manufacturer, input.notes, JSON.stringify(input.specs), origin, COMPONENT_SCHEMA_VERSION, ts, ts)
    return getComponent(id)
  }

  return {
    /** Runs `fn` in one SQLite transaction (all or nothing). */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
    projects: {
      list(): Project[] {
        const rows = db
          .prepare('SELECT * FROM projects ORDER BY updated_at DESC, name ASC')
          .all() as ProjectRow[]
        return rows.map(toProject)
      },
      get: getProject,
      create(input: CreateProjectInput): Project {
        const id = randomUUID()
        const ts = now().toISOString()
        db.prepare(
          'INSERT INTO projects (id, name, frame_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run(id, input.name, input.frameType, ts, ts)
        return getProject(id)
      },
      rename(input: RenameProjectInput): Project {
        const info = db
          .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
          .run(input.name, now().toISOString(), input.id)
        if (info.changes === 0) throw new NotFoundError(`Project ${input.id} not found`)
        return getProject(input.id)
      },
      delete(id: string): void {
        removeRunFiles(projectRuns(id))
        db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      },
    },
    runs: {
      create(header: RecordingHeader): void {
        const fileName = recordingFileName(header.runId)
        db.prepare(`
          INSERT INTO simulation_runs
            (id, project_id, started_at, duration_s, status, kind, title, file_name,
             bytes, sample_count, engine_version, incomplete, recording_open)
          VALUES (?, ?, ?, 0, 'aborted', ?, ?, ?, 0, 0, ?, 1, 1)
        `).run(header.runId, header.projectId, header.startedAt, header.kind, header.title, fileName, header.engineVersion)
      },
      finish(id: string, result: Pick<StoredRun, 'status' | 'durationS' | 'fileName' | 'bytes' |
        'sampleCount' | 'stateHash' | 'endReason' | 'incomplete'>): void {
        const info = db.prepare(`
          UPDATE simulation_runs SET status = @status, duration_s = @durationS, file_name = @fileName,
            bytes = @bytes, sample_count = @sampleCount, state_hash = @stateHash, end_reason = @endReason,
            incomplete = @incomplete, recording_open = 0 WHERE id = @id AND recording_open = 1
        `).run({ ...result, id, incomplete: Number(result.incomplete) })
        if (info.changes === 0) throw new ConflictError(`Run ${id} is no longer open`)
      },
      listByProject: projectRuns,
      get: getRun,
      listRecent(limit: number): StoredRun[] {
        return (db.prepare(`${selectRuns} ORDER BY r.started_at DESC, r.id LIMIT ?`).all(limit) as RunRow[]).map(toRun)
      },
      listOpen(): StoredRun[] {
        return (db.prepare(`${selectRuns} WHERE r.recording_open = 1`).all() as RunRow[]).map(toRun)
      },
      fileNames(): string[] {
        return (db.prepare('SELECT file_name FROM simulation_runs WHERE file_name IS NOT NULL').pluck().all() as string[])
      },
      delete(id: string): void {
        removeRunFiles([getRun(id)])
        db.prepare('DELETE FROM simulation_runs WHERE id = ?').run(id)
      },
    },
    components: {
      count(): number {
        return (db.prepare('SELECT COUNT(*) AS n FROM components').get() as { n: number }).n
      },
      list(category?: ComponentCategory): Component[] {
        const rows = (
          category
            ? db.prepare('SELECT * FROM components WHERE category = ? ORDER BY name COLLATE NOCASE, id').all(category)
            : db.prepare('SELECT * FROM components ORDER BY category, name COLLATE NOCASE, id').all()
        ) as ComponentRow[]
        const fills = fillsOf()
        return rows.map((r) => withFills(toComponent(r), fills.get(r.id)))
      },
      /**
       * Sets (or, with null, removes) a catalog gap-fill on a built-in component: only a
       * quantity or integer field the record leaves empty, with source 'measured' or
       * 'user'. The seed record itself is never changed. `spec` is validated by the caller
       * (`userSpecSchema`); the rules that need the record are checked here.
       */
      setFill: db.transaction((id: string, key: string, spec: SpecValue | null): Component => {
        const c = getComponent(id)
        if (c.origin !== 'built-in') throw new ValidationError('Edit your own components directly; gap-fills are for built-in records.')
        const f = fieldDef(c.category, key)
        if (!isOverridable(f)) throw new ValidationError(`"${key}" is not a single value of a ${c.category}.`)
        if (spec === null) {
          db.prepare('DELETE FROM component_fills WHERE component_id = ? AND field_key = ?').run(id, key)
          return getComponent(id)
        }
        if (c.specs[key] && !c.fills?.[key]) throw new ValidationError(`${c.name} already states ${f.label.toLowerCase()}; override it on a part instead.`)
        db.prepare(
          `INSERT INTO component_fills (component_id, field_key, spec_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (component_id, field_key) DO UPDATE SET spec_json = excluded.spec_json, updated_at = excluded.updated_at`,
        ).run(id, key, JSON.stringify(spec), now().toISOString())
        return getComponent(id)
      }),
      get: getComponent,
      create: createComponent,
      exists(id: string): boolean {
        return db.prepare('SELECT 1 FROM components WHERE id = ?').get(id) !== undefined
      },
      update: db.transaction((id: string, baseRevision: number, input: ComponentInput): Component => {
        const cur = getComponent(id)
        if (cur.origin === 'built-in') throw new ValidationError(READ_ONLY)
        if (cur.category !== input.category) throw new ValidationError('A component cannot change category.')
        if (cur.revision !== baseRevision) {
          throw new ConflictError(`The component was changed elsewhere (revision ${cur.revision}, edit based on ${baseRevision}).`)
        }
        db.prepare(
          `UPDATE components SET name = ?, manufacturer = ?, notes = ?, spec_json = ?, schema_version = ?, revision = revision + 1,
             updated_at = ? WHERE id = ?`,
        ).run(input.name, input.manufacturer, input.notes, JSON.stringify(input.specs), COMPONENT_SCHEMA_VERSION, now().toISOString(), id)
        return getComponent(id)
      }),
      /** Seed loader only: updates a built-in record in place (users cannot). */
      replaceBuiltIn(id: string, input: ComponentInput): Component {
        if (getComponent(id).origin !== 'built-in') throw new ValidationError('Not a built-in component.')
        db.prepare(
          `UPDATE components SET category = ?, name = ?, manufacturer = ?, notes = ?, spec_json = ?, schema_version = ?,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(input.category, input.name, input.manufacturer, input.notes, JSON.stringify(input.specs), COMPONENT_SCHEMA_VERSION, now().toISOString(), id)
        return getComponent(id)
      },
      delete(id: string): void {
        if (getComponent(id).origin === 'built-in') throw new ValidationError(READ_ONLY)
        const users = db
          .prepare(
            `SELECT p.name AS project, COUNT(*) AS n FROM assembly_parts a JOIN projects p ON p.id = a.project_id
             WHERE a.component_id = ? GROUP BY p.id ORDER BY p.name`,
          )
          .all(id) as { project: string; n: number }[]
        if (users.length > 0) {
          const total = users.reduce((s, u) => s + u.n, 0)
          throw new ValidationError(
            `Used by ${total} part${total === 1 ? '' : 's'} in ${users.map((u) => `"${u.project}"`).join(', ')}. Unlink ${total === 1 ? 'it' : 'them'} in the workshop first.`,
          )
        }
        db.prepare('DELETE FROM components WHERE id = ?').run(id)
      },
      /** A user-owned copy; the way to change a built-in record. Provenance is copied unchanged. */
      duplicate(id: string): Component {
        const c = getComponent(id)
        return createComponent(
          // Gap-fills become the copy's own values, keeping their provenance.
          { category: c.category, name: `${c.name} (copy)`.slice(0, 120), manufacturer: c.manufacturer, notes: c.notes, specs: { ...c.specs, ...c.fills } },
          'user',
        )
      },
    },
    assemblies: {
      /** Returns the project's assembly, creating it with starting values on first access. */
      load: db.transaction((projectId: string): Assembly => {
        const project = getProject(projectId)
        let row = db.prepare('SELECT * FROM assemblies WHERE project_id = ?').get(projectId) as
          | {
              revision: number
              frame_json: string
              motors_json: string
              wiring_json: string
              frame_mass_kg: number | null
              frame_mass_source: 'user' | null
              interference_json: string | null
              environment_json: string | null
              flight_json?: string | null
              body_cd_x?: number | null
              body_cd_y?: number | null
              body_cd_z?: number | null
              body_cd_source?: 'user' | null
              updated_at: string
            }
          | undefined
        if (!row) {
          row = {
            revision: 0,
            frame_json: JSON.stringify(STARTING_FRAME[project.frameType]),
            motors_json: '{}',
            wiring_json: '{}',
            frame_mass_kg: null,
            frame_mass_source: null,
            interference_json: null,
            environment_json: null,
            updated_at: now().toISOString(),
          }
          if (!connection().readonly) {
            db.prepare('INSERT INTO assemblies (project_id, revision, frame_json, updated_at) VALUES (?, ?, ?, ?)').run(
              projectId,
              row.revision,
              row.frame_json,
              row.updated_at,
            )
          }
        }
        const parts = db
          .prepare('SELECT * FROM assembly_parts WHERE project_id = ? ORDER BY sort_index')
          .all(projectId) as PartRow[]
        return {
          projectId,
          revision: row.revision,
          updatedAt: row.updated_at,
          frame: JSON.parse(row.frame_json) as FrameParams,
          motors: JSON.parse(row.motors_json) as Record<string, MotorMount>,
          parts: parts.map(toPart),
          // Omitted when not set, so documents saved before schema v8 round-trip unchanged.
          ...(row.frame_mass_kg !== null && row.frame_mass_source !== null
            ? { frameMass: { valueKg: row.frame_mass_kg, source: row.frame_mass_source } }
            : {}),
          // Omitted when not set, so documents saved before schema v10 round-trip unchanged.
          ...(row.interference_json !== null ? { interference: JSON.parse(row.interference_json) as InterferenceSettingsDoc } : {}),
          ...(row.environment_json !== null ? { environment: JSON.parse(row.environment_json) as EnvironmentDoc } : {}),
          // Omitted when not set (schema v12), like the environment.
          ...(row.flight_json != null ? { flight: JSON.parse(row.flight_json) as FlightConditionsDoc } : {}),
          // Omitted when not set (schema v11), like the frame mass.
          ...(row.body_cd_source != null
            ? { bodyDrag: { cd: [row.body_cd_x ?? null, row.body_cd_y ?? null, row.body_cd_z ?? null], source: row.body_cd_source } }
            : {}),
          // Omitted when empty, so documents without wiring round-trip unchanged.
          ...wiringFields(JSON.parse(row.wiring_json) as Pick<Assembly, 'wires' | 'schematic'>),
        }
      }),

      /**
       * Replaces the whole assembly atomically. Rejected with ConflictError when the
       * stored revision is not the one the edit was based on.
       */
      save: db.transaction((input: SaveAssemblyInput): SaveAssemblyResult => {
        getProject(input.projectId)
        const row = db.prepare('SELECT revision FROM assemblies WHERE project_id = ?').get(input.projectId) as
          | { revision: number }
          | undefined
        const stored = row?.revision ?? 0
        if (stored !== input.baseRevision) {
          throw new ConflictError(
            `The assembly was changed elsewhere (revision ${stored}, edit based on ${input.baseRevision}).`,
          )
        }
        const hasModel = db.prepare("SELECT 1 FROM assets WHERE id = ? AND format IN ('glb', 'gltf')")
        const terrainId = input.environment?.terrain?.assetId
        if (terrainId != null && !db.prepare("SELECT 1 FROM assets WHERE id = ? AND format = 'asc'").get(terrainId)) {
          throw new ValidationError('The selected terrain grid is missing from the asset store.')
        }
        for (const obstacle of input.environment?.obstacles ?? []) {
          if (obstacle.type === 'hull' && obstacle.assetId !== null && !hasModel.get(obstacle.assetId)) {
            throw new ValidationError(`Obstacle "${obstacle.name}" uses a model that is not in the asset store.`)
          }
        }
        const hasComponent = db.prepare('SELECT 1 FROM components WHERE id = ?')
        for (const p of input.parts) {
          if (p.shape.type === 'model' && !hasModel.get(p.shape.assetId)) {
            throw new ValidationError(`Part "${p.name}" uses a model that is not in the asset store.`)
          }
          if (p.componentId && !hasComponent.get(p.componentId)) {
            throw new ValidationError(`Part "${p.name}" is linked to a component that is no longer in the library.`)
          }
        }
        const revision = stored + 1
        const ts = now().toISOString()
        db.prepare(
          `INSERT INTO assemblies (project_id, revision, frame_json, motors_json, wiring_json, frame_mass_kg, frame_mass_source,
             interference_json, environment_json, flight_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET revision = excluded.revision, frame_json = excluded.frame_json,
             motors_json = excluded.motors_json, wiring_json = excluded.wiring_json,
             frame_mass_kg = excluded.frame_mass_kg, frame_mass_source = excluded.frame_mass_source,
             interference_json = excluded.interference_json, environment_json = excluded.environment_json,
             flight_json = excluded.flight_json, updated_at = excluded.updated_at`,
        ).run(
          input.projectId,
          revision,
          JSON.stringify(input.frame),
          JSON.stringify(input.motors),
          JSON.stringify(wiringFields(input)),
          input.frameMass?.valueKg ?? null,
          input.frameMass?.source ?? null,
          input.interference ? JSON.stringify(input.interference) : null,
          input.environment ? JSON.stringify(input.environment) : null,
          input.flight ? JSON.stringify(input.flight) : null,
          ts,
        )
        // Separate statement so the columns of schema v11 stay apart from the upsert above.
        const cd = input.bodyDrag?.cd ?? [null, null, null]
        db.prepare('UPDATE assemblies SET body_cd_x = ?, body_cd_y = ?, body_cd_z = ?, body_cd_source = ? WHERE project_id = ?').run(
          cd[0],
          cd[1],
          cd[2],
          input.bodyDrag?.source ?? null,
          input.projectId,
        )
        db.prepare('DELETE FROM assembly_parts WHERE project_id = ?').run(input.projectId)
        const insert = db.prepare(
          `INSERT INTO assembly_parts (id, project_id, sort_index, parent_id, mount_id, kind, name, shape_json,
             px, py, pz, qx, qy, qz, qw, mass_kg, mass_source, component_id, inertia_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        input.parts.forEach((p, i) =>
          insert.run(
            p.id,
            input.projectId,
            i,
            p.parentId,
            p.mountId,
            p.kind,
            p.name,
            JSON.stringify(p.shape),
            ...p.position,
            ...p.rotation,
            p.mass?.valueKg ?? null,
            p.mass?.source ?? null,
            p.componentId ?? null,
            p.inertia ? JSON.stringify(p.inertia) : null,
          ),
        )
        // Separate statement so the schema v11 column stays apart from the insert above.
        const setOverrides = db.prepare('UPDATE assembly_parts SET overrides_json = ? WHERE id = ? AND project_id = ?')
        for (const p of input.parts) {
          if (p.overrides && Object.keys(p.overrides).length > 0) setOverrides.run(JSON.stringify(p.overrides), p.id, input.projectId)
        }
        // Schema v14, kept apart for the same reason.
        const setFov = db.prepare('UPDATE assembly_parts SET camera_fov_deg = ? WHERE id = ? AND project_id = ?')
        for (const p of input.parts) if (p.cameraFovDeg !== undefined) setFov.run(p.cameraFovDeg, p.id, input.projectId)
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, input.projectId)
        return { revision, updatedAt: ts }
      }),
    },
    /** Per-project controller gain overrides (schema v13). Only overrides are stored; the PX4 defaults are not. */
    tuning: {
      /** The project's overrides, name → value; empty when none are saved. */
      get: (projectId: string): TuningOverrides => tuningOf(projectId),
      /** Replaces the project's overrides. Validated first: an invalid set throws and nothing is stored. */
      set(projectId: string, overrides: unknown): TuningOverrides {
        getProject(projectId)
        const result = validateOverrides(overrides)
        if (!result.ok) throw new TuningValidationError(result.errors)
        const ts = now().toISOString()
        db.transaction(() => {
          db.prepare('DELETE FROM controller_tuning WHERE project_id = ?').run(projectId)
          const insert = db.prepare('INSERT INTO controller_tuning (project_id, param_name, value, updated_at) VALUES (?, ?, ?, ?)')
          for (const [name, value] of Object.entries(overrides as TuningOverrides)) insert.run(projectId, name, value, ts)
        })()
        return tuningOf(projectId)
      },
      /** "Reset to PX4 defaults": removes every override of the project. */
      clear(projectId: string): void {
        getProject(projectId)
        db.prepare('DELETE FROM controller_tuning WHERE project_id = ?').run(projectId)
      },
    },
    assets: {
      list(): AssetInfo[] {
        return (db.prepare("SELECT * FROM assets WHERE format IN ('glb', 'gltf') ORDER BY imported_at, id").all() as AssetRow[]).map(toAsset)
      },
      /** Records an imported file; re-importing identical bytes keeps the first record. */
      add(a: Omit<AssetInfo, 'importedAt' | 'warnings'>): AssetInfo {
        db.prepare(
          `INSERT INTO assets (id, filename, format, bytes, triangles, bounds_json, hull_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        ).run(a.id, a.filename, a.format, a.bytes, a.triangles, JSON.stringify(a.bounds), a.hull ? JSON.stringify(a.hull) : null, now().toISOString())
        const row = db.prepare("SELECT * FROM assets WHERE id = ? AND format IN ('glb', 'gltf')").get(a.id) as AssetRow | undefined
        if (!row) throw new ValidationError('These bytes are already stored as a terrain grid.')
        return toAsset(row)
      },
      /** Stores the hull of an asset imported before hulls were computed (startup back-fill). */
      setHull(id: string, hull: ModelHull): void {
        db.prepare('UPDATE assets SET hull_json = ? WHERE id = ?').run(JSON.stringify(hull), id)
      },
      /**
       * Removes assets no project uses and returns their ids, so main can delete the
       * files. Run at startup only: undo history (which may restore a reference) is
       * in memory and does not survive a restart.
       */
      collectGarbage: db.transaction((): string[] => {
        const unused = (
          db
            .prepare(
              `SELECT id FROM assets AS asset WHERE
                 (format = 'asc' AND NOT EXISTS (
                   SELECT 1 FROM assemblies WHERE json_extract(environment_json, '$.terrain.assetId') = asset.id
                 )) OR (format IN ('glb', 'gltf') AND NOT EXISTS (
                   SELECT 1 FROM assembly_parts
                   WHERE json_extract(shape_json, '$.type') = 'model'
                     AND json_extract(shape_json, '$.assetId') = asset.id
                 ) AND NOT EXISTS (
                   SELECT 1 FROM assemblies, json_each(environment_json, '$.obstacles') AS obstacle
                   WHERE json_extract(obstacle.value, '$.type') = 'hull'
                     AND json_extract(obstacle.value, '$.assetId') = asset.id
                 ))`,
            )
            .all() as { id: string }[]
        ).map((r) => r.id)
        const del = db.prepare('DELETE FROM assets WHERE id = ?')
        for (const id of unused) del.run(id)
        return unused
      }),
    },
    terrain: {
      list(): TerrainAssetInfo[] {
        return (db.prepare("SELECT * FROM assets WHERE format = 'asc' ORDER BY imported_at, id").all() as TerrainAssetRow[]).map(toTerrainAsset)
      },
      get(id: string): { asset: TerrainAssetInfo; noDataValue: number | undefined } {
        const row = db.prepare("SELECT * FROM assets WHERE id = ? AND format = 'asc'").get(id) as TerrainAssetRow | undefined
        if (!row) throw new NotFoundError('The terrain grid is missing from the asset store.')
        return { asset: toTerrainAsset(row), noDataValue: row.terrain_nodata_value ?? undefined }
      },
      add(a: Omit<TerrainAssetInfo, 'importedAt' | 'format'>, noDataValue: number | undefined): TerrainAssetInfo {
        db.prepare(
          `INSERT INTO assets (id, filename, format, bytes, imported_at, terrain_nodata_value)
           VALUES (?, ?, 'asc', ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        ).run(a.id, a.filename, a.bytes, now().toISOString(), noDataValue ?? null)
        return this.get(a.id).asset
      },
    },
  }
}

export type Repositories = ReturnType<typeof createRepositories>
