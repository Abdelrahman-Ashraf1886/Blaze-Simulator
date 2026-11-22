import Database from 'better-sqlite3'
import m0001 from '../../../database/migrations/0001_initial.sql?raw'
import m0002 from '../../../database/migrations/0002_assembly.sql?raw'
import m0003 from '../../../database/migrations/0003_motor_mounts.sql?raw'
import m0004 from '../../../database/migrations/0004_assets.sql?raw'
import m0005 from '../../../database/migrations/0005_component_library.sql?raw'
import m0006 from '../../../database/migrations/0006_part_components.sql?raw'
import m0007 from '../../../database/migrations/0007_wiring.sql?raw'
import m0008 from '../../../database/migrations/0008_frame_mass.sql?raw'
import m0009 from '../../../database/migrations/0009_part_kinds_inertia.sql?raw'
import m0010 from '../../../database/migrations/0010_collisions.sql?raw'
import m0011 from '../../../database/migrations/0011_physics_inputs.sql?raw'

export type Db = Database.Database

/** Ordered list of migrations. Append only; never edit a shipped migration. */
export const MIGRATIONS: readonly string[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011]

/**
 * Open (or create) the database and bring it to the latest schema version.
 * Uses SQLite's `user_version` pragma as the schema version counter.
 */
export function openDatabase(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function migrate(db: Db): void {
  const current = schemaVersion(db)
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${MIGRATIONS.length}).`,
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  repairUnshippedMigrations(db)
}

/**
 * Columns a migration added after a first version of it had already run on development
 * databases. 0010 was extended (environment_json, hull_json) before it shipped; a database
 * that ran the first 0010 (interference_json only) is at v10 without them. Adding a missing
 * column with the same definition makes it identical to a fresh v10 database. Remove an
 * entry once its migration has shipped; never use this for shipped migrations.
 */
const UNSHIPPED_COLUMNS: readonly { version: number; table: string; column: string; definition: string }[] = [
  { version: 10, table: 'assemblies', column: 'interference_json', definition: 'TEXT CHECK (interference_json IS NULL OR json_valid(interference_json))' },
  { version: 10, table: 'assemblies', column: 'environment_json', definition: 'TEXT CHECK (environment_json IS NULL OR json_valid(environment_json))' },
  { version: 10, table: 'assets', column: 'hull_json', definition: 'TEXT CHECK (hull_json IS NULL OR json_valid(hull_json))' },
]

export function repairUnshippedMigrations(db: Db): string[] {
  const added: string[] = []
  const version = schemaVersion(db)
  db.transaction(() => {
    for (const c of UNSHIPPED_COLUMNS) {
      if (version < c.version) continue
      const cols = db.prepare(`PRAGMA table_info(${c.table})`).all() as { name: string }[]
      if (cols.some((x) => x.name === c.column)) continue
      db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.definition}`)
      added.push(`${c.table}.${c.column}`)
    }
  })()
  return added
}
