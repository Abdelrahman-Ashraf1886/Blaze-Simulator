/**
 * Migration order and the repair of development databases that ran the first,
 * unshipped version of 0010 (see `repairUnshippedMigrations`).
 */
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase, repairUnshippedMigrations, schemaVersion } from '../../electron/main/db/database'
import { STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'

const dir = join(__dirname, '../../database/migrations')
const dbDir = mkdtempSync(join(tmpdir(), 'blaze-migrations-'))
afterAll(() => rmSync(dbDir, { recursive: true, force: true }))

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migration order', () => {
  it('files are numbered 0001… without gaps, and MIGRATIONS runs them in that order', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    files.forEach((f, i) => expect(f.slice(0, 4), f).toBe(String(i + 1).padStart(4, '0')))
    expect(MIGRATIONS).toHaveLength(files.length)
    // Line endings may differ between the checkout and the bundled string.
    const norm = (s: string) => s.replace(/\r\n/g, '\n')
    files.forEach((f, i) => expect(norm(MIGRATIONS[i]!), `MIGRATIONS[${i}] is ${f}`).toBe(norm(readFileSync(join(dir, f), 'utf8'))))
  })
})

describe('terrain asset migration', () => {
  it('upgrades v13, preserves models and their checks, and permits terrain without model metadata', () => {
    const path = join(dbDir, 'old-v13.db')
    const old = new Database(path)
    for (const m of MIGRATIONS.slice(0, 13)) old.exec(m)
    old.pragma('user_version = 13')
    const modelId = 'a'.repeat(64)
    const terrainId = 'b'.repeat(64)
    const bounds = { min: [0, 0, 0], max: [1, 2, 3] }
    const hull = { points: [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3]] }
    const importedAt = '2026-01-01T00:00:00.000Z'
    old.prepare(`INSERT INTO assets (id, filename, format, bytes, triangles, bounds_json, hull_json, imported_at)
      VALUES (?, 'model.glb', 'glb', 100, 4, ?, ?, ?)`)
      .run(modelId, JSON.stringify(bounds), JSON.stringify(hull), importedAt)
    old.close()

    const db = openDatabase(path)
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length)
      const repos = createRepositories(db)
      expect(repos.assets.list()).toEqual([{ id: modelId, filename: 'model.glb', format: 'glb', bytes: 100, triangles: 4, bounds, hull, importedAt, warnings: [] }])
      const update = (assignment: string) => db.prepare(`UPDATE assets SET ${assignment} WHERE id = ?`).run(modelId)
      for (const assignment of [
        'triangles = NULL', 'triangles = -1', 'bounds_json = NULL', "bounds_json = 'bad JSON'",
        "hull_json = 'bad JSON'", "format = 'obj'", 'bytes = 0', "filename = ''", "id = 'short'",
        'imported_at = NULL', 'terrain_nodata_value = -42',
      ]) expect(() => update(assignment), assignment).toThrow(/constraint/i)
      expect(repos.terrain.add({ id: terrainId, filename: 'terrain.asc', bytes: 80 }, -42)).toMatchObject({ format: 'asc' })
      expect(db.prepare('SELECT triangles, bounds_json, hull_json FROM assets WHERE id = ?').get(terrainId))
        .toEqual({ triangles: null, bounds_json: null, hull_json: null })
      expect(() => db.prepare('UPDATE assets SET triangles = 1 WHERE id = ?').run(terrainId)).toThrow(/constraint/i)
    } finally {
      db.close()
    }
  })
})

describe('the unshipped 0010', () => {
  it('a database that ran the first 0010 (interference_json only) gets the new columns and keeps its data', () => {
    const path = join(dbDir, 'old-v10.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.slice(0, 9)) old.exec(m)
    // The first version of 0010, as it ran on development machines.
    old.exec('ALTER TABLE assemblies ADD COLUMN interference_json TEXT CHECK (interference_json IS NULL OR json_valid(interference_json));')
    old.pragma('user_version = 10')
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', 'Dev', 'quad-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old
      .prepare("INSERT INTO assemblies (project_id, revision, frame_json, interference_json, updated_at) VALUES ('p1', 3, ?, ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify(STARTING_FRAME['quad-x']), JSON.stringify({ toleranceM: 0.001, allowedPairs: [] }))
    expect(columns(old, 'assemblies')).not.toContain('environment_json')
    old.close()

    const db = openDatabase(path)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(columns(db, 'assemblies')).toEqual(expect.arrayContaining(['interference_json', 'environment_json']))
    expect(columns(db, 'assets')).toContain('hull_json')
    const loaded = createRepositories(db).assemblies.load('p1')
    expect(loaded.revision).toBe(3)
    expect(loaded.interference).toEqual({ toleranceM: 0.001, allowedPairs: [] })
    // Idempotent: a second run adds nothing.
    expect(repairUnshippedMigrations(db)).toEqual([])
    // The repaired columns carry the same constraint as a fresh database.
    expect(() => db.prepare("UPDATE assemblies SET environment_json = 'not json'").run()).toThrow()
    db.close()
  })

  it('a fresh database has every 0010 column and nothing to repair', () => {
    const db = openDatabase(join(dbDir, 'fresh.db'))
    expect(columns(db, 'assemblies')).toEqual(expect.arrayContaining(['interference_json', 'environment_json']))
    expect(columns(db, 'assets')).toContain('hull_json')
    expect(repairUnshippedMigrations(db)).toEqual([])
    db.close()
  })
})
