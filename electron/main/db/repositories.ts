import { randomUUID } from 'node:crypto'
import { TRIANGLE_WARNING } from '../../ipc/contract'
import {
  COMPONENT_SCHEMA_VERSION,
  type Component,
  type ComponentCategory,
  type ComponentInput,
  type ComponentOrigin,
} from '../../ipc/component-fields'
import type {
  AssetInfo,
  Bounds3,
  Assembly,
  AssemblyPart,
  CreateProjectInput,
  FrameParams,
  FrameType,
  MotorMount,
  PartKind,
  Project,
  RenameProjectInput,
  RunStatus,
  SaveAssemblyInput,
  SaveAssemblyResult,
  SimulationRun,
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
  imported_at: string
}

const toAsset = (r: AssetRow): AssetInfo => ({
  id: r.id,
  filename: r.filename,
  format: r.format,
  bytes: r.bytes,
  triangles: r.triangles,
  bounds: JSON.parse(r.bounds_json) as Bounds3,
  importedAt: r.imported_at,
  warnings:
    r.triangles > TRIANGLE_WARNING
      ? [`${r.triangles.toLocaleString('en-US')} triangles; above ${TRIANGLE_WARNING.toLocaleString('en-US')} the viewport may slow down.`]
      : [],
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

export function createRepositories(db: Db, now: () => Date = () => new Date()) {
  const getProject = (id: string): Project => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) throw new NotFoundError(`Project ${id} not found`)
    return toProject(row)
  }

  const getComponent = (id: string): Component => {
    const row = db.prepare('SELECT * FROM components WHERE id = ?').get(id) as ComponentRow | undefined
    if (!row) throw new NotFoundError(`Component ${id} not found`)
    return toComponent(row)
  }

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
        const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
        if (info.changes === 0) throw new NotFoundError(`Project ${id} not found`)
      },
    },
    runs: {
      listRecent(limit: number): SimulationRun[] {
        const rows = db
          .prepare(
            `SELECT r.id, r.project_id, p.name AS project_name, r.started_at, r.duration_s, r.status
             FROM simulation_runs r JOIN projects p ON p.id = r.project_id
             ORDER BY r.started_at DESC LIMIT ?`,
          )
          .all(limit) as {
          id: string
          project_id: string
          project_name: string
          started_at: string
          duration_s: number
          status: RunStatus
        }[]
        return rows.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          projectName: r.project_name,
          startedAt: r.started_at,
          durationS: r.duration_s,
          status: r.status,
        }))
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
        return rows.map(toComponent)
      },
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
          { category: c.category, name: `${c.name} (copy)`.slice(0, 120), manufacturer: c.manufacturer, notes: c.notes, specs: c.specs },
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
            updated_at: now().toISOString(),
          }
          db.prepare('INSERT INTO assemblies (project_id, revision, frame_json, updated_at) VALUES (?, ?, ?, ?)').run(
            projectId,
            row.revision,
            row.frame_json,
            row.updated_at,
          )
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
        const hasAsset = db.prepare('SELECT 1 FROM assets WHERE id = ?')
        const hasComponent = db.prepare('SELECT 1 FROM components WHERE id = ?')
        for (const p of input.parts) {
          if (p.shape.type === 'model' && !hasAsset.get(p.shape.assetId)) {
            throw new ValidationError(`Part "${p.name}" uses a model that is not in the asset store.`)
          }
          if (p.componentId && !hasComponent.get(p.componentId)) {
            throw new ValidationError(`Part "${p.name}" is linked to a component that is no longer in the library.`)
          }
        }
        const revision = stored + 1
        const ts = now().toISOString()
        db.prepare(
          `INSERT INTO assemblies (project_id, revision, frame_json, motors_json, wiring_json, frame_mass_kg, frame_mass_source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET revision = excluded.revision, frame_json = excluded.frame_json,
             motors_json = excluded.motors_json, wiring_json = excluded.wiring_json,
             frame_mass_kg = excluded.frame_mass_kg, frame_mass_source = excluded.frame_mass_source,
             updated_at = excluded.updated_at`,
        ).run(
          input.projectId,
          revision,
          JSON.stringify(input.frame),
          JSON.stringify(input.motors),
          JSON.stringify(wiringFields(input)),
          input.frameMass?.valueKg ?? null,
          input.frameMass?.source ?? null,
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
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, input.projectId)
        return { revision, updatedAt: ts }
      }),
    },
    assets: {
      list(): AssetInfo[] {
        return (db.prepare('SELECT * FROM assets ORDER BY imported_at, id').all() as AssetRow[]).map(toAsset)
      },
      /** Records an imported file; re-importing identical bytes keeps the first record. */
      add(a: Omit<AssetInfo, 'importedAt' | 'warnings'>): AssetInfo {
        db.prepare(
          `INSERT INTO assets (id, filename, format, bytes, triangles, bounds_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        ).run(a.id, a.filename, a.format, a.bytes, a.triangles, JSON.stringify(a.bounds), now().toISOString())
        return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(a.id) as AssetRow)
      },
      /**
       * Removes assets no part uses and returns their ids, so main can delete the
       * files. Run at startup only: undo history (which may re-add a part) is
       * in memory and does not survive a restart.
       */
      collectGarbage: db.transaction((): string[] => {
        const unused = (
          db
            .prepare(
              `SELECT id FROM assets WHERE id NOT IN (
                 SELECT json_extract(shape_json, '$.assetId') FROM assembly_parts
                 WHERE json_extract(shape_json, '$.type') = 'model')`,
            )
            .all() as { id: string }[]
        ).map((r) => r.id)
        const del = db.prepare('DELETE FROM assets WHERE id = ?')
        for (const id of unused) del.run(id)
        return unused
      }),
    },
  }
}

export type Repositories = ReturnType<typeof createRepositories>
