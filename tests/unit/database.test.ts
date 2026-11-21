import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate, openDatabase, schemaVersion, type Db } from '../../electron/main/db/database'
import { NotFoundError, createRepositories } from '../../electron/main/db/repositories'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blazeuav-db-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('brings a new database to the latest schema version', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  })

  it('is idempotent across reopen', () => {
    migrate(db)
    db.close()
    db = openDatabase(join(dir, 'test.db'))
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  })

  it('refuses a database from a newer app version', () => {
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    expect(() => migrate(db)).toThrow(/newer than this app supports/)
  })

  it('enforces foreign keys', () => {
    expect(() =>
      db
        .prepare('INSERT INTO simulation_runs VALUES (?, ?, ?, ?, ?)')
        .run('r1', 'missing-project', new Date().toISOString(), 1, 'completed'),
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('project repository', () => {
  it('creates, lists (most recent first), renames and deletes', () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    const repos = createRepositories(db, () => new Date((t += 1000)))

    const a = repos.projects.create({ name: 'Alpha', frameType: 'quad-x' })
    const b = repos.projects.create({ name: 'Bravo', frameType: 'hex-x' })
    expect(repos.projects.list().map((p) => p.name)).toEqual(['Bravo', 'Alpha'])

    const renamed = repos.projects.rename({ id: a.id, name: 'Alpha 2' })
    expect(renamed.name).toBe('Alpha 2')
    expect(renamed.updatedAt > renamed.createdAt).toBe(true)
    expect(repos.projects.list()[0]!.id).toBe(a.id)

    repos.projects.delete(b.id)
    expect(repos.projects.list()).toHaveLength(1)
  })

  it('throws NotFoundError for unknown ids', () => {
    const repos = createRepositories(db)
    const id = '00000000-0000-4000-8000-000000000000'
    expect(() => repos.projects.rename({ id, name: 'x' })).toThrow(NotFoundError)
    expect(() => repos.projects.delete(id)).toThrow(NotFoundError)
  })

  it('cascades project deletion to simulation runs', () => {
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'P', frameType: 'octo-x' })
    db.prepare('INSERT INTO simulation_runs VALUES (?, ?, ?, ?, ?)').run(
      'r1',
      p.id,
      new Date().toISOString(),
      12.5,
      'completed',
    )
    expect(repos.runs.listRecent(10)).toMatchObject([{ projectName: 'P', durationS: 12.5 }])
    repos.projects.delete(p.id)
    expect(repos.runs.listRecent(10)).toEqual([])
  })

  it('rejects invalid frame types at the schema level', () => {
    expect(() =>
      db
        .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)')
        .run('x', 'n', 'tri-y', new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/CHECK/)
  })

  it('counts components', () => {
    expect(createRepositories(db).components.count()).toBe(0)
  })
})
