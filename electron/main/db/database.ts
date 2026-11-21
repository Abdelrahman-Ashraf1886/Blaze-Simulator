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

export type Db = Database.Database

/** Ordered list of migrations. Append only; never edit a shipped migration. */
export const MIGRATIONS: readonly string[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009]

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
}
