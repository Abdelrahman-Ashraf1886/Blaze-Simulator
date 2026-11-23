import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase, schemaVersion, type Db } from '../../electron/main/db/database'
import { NotFoundError, TuningValidationError, ValidationError, createRepositories } from '../../electron/main/db/repositories'

let dir: string
let db: Db
let repos: ReturnType<typeof createRepositories>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blazeuav-tuning-'))
  db = openDatabase(join(dir, 'test.db'))
  repos = createRepositories(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const rows = () => db.prepare('SELECT * FROM controller_tuning ORDER BY project_id, param_name').all()
const newProject = (name: string) => repos.projects.create({ name, frameType: 'quad-x' })

describe('migration 0013', () => {
  it('upgrades a v12 database with its data to the latest schema', () => {
    const path = join(dir, 'old-v12.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.slice(0, 12)) old.exec(m)
    old.pragma('user_version = 12')
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', 'Dev', 'quad-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.close()

    const upgraded = openDatabase(path)
    expect(schemaVersion(upgraded)).toBe(MIGRATIONS.length)
    const r = createRepositories(upgraded)
    expect(r.tuning.get('p1')).toEqual({})
    expect(r.tuning.set('p1', { MC_ROLL_P: 7 })).toEqual({ MC_ROLL_P: 7 })
    upgraded.close()
  })

  it("deleting a project deletes its overrides and no other project's", () => {
    const a = newProject('A')
    const b = newProject('B')
    repos.tuning.set(a.id, { MC_ROLL_P: 7, MPC_THR_HOVER: 0.6 })
    repos.tuning.set(b.id, { MC_ROLL_P: 5 })
    expect(rows()).toHaveLength(3)
    db.prepare('DELETE FROM projects WHERE id = ?').run(a.id)
    expect(rows()).toMatchObject([{ project_id: b.id, param_name: 'MC_ROLL_P', value: 5 }])
  })

  it('the table refuses a row for a project that does not exist and a non-finite value', () => {
    const p = newProject('A')
    const insert = db.prepare("INSERT INTO controller_tuning VALUES (?, 'MC_ROLL_P', ?, 't')")
    expect(() => insert.run('missing', 1)).toThrow()
    expect(() => insert.run(p.id, Infinity)).toThrow()
    expect(() => insert.run(p.id, NaN)).toThrow()
  })
})

describe('tuning repository', () => {
  it('a project with nothing saved has no overrides', () => {
    expect(repos.tuning.get(newProject('A').id)).toEqual({})
  })

  it('round-trips overrides, and a second save replaces the first (nothing carries over)', () => {
    const p = newProject('A')
    const first = { MC_ROLL_P: 7.25, MPC_TILTMAX_AIR: 30, MC_AIRMODE: 1 }
    expect(repos.tuning.set(p.id, first)).toEqual(first)
    expect(repos.tuning.get(p.id)).toEqual(first)
    repos.tuning.set(p.id, { MC_PITCH_P: 5 })
    expect(repos.tuning.get(p.id)).toEqual({ MC_PITCH_P: 5 })
  })

  it("keeps each project's overrides apart", () => {
    const a = newProject('A')
    const b = newProject('B')
    repos.tuning.set(a.id, { MC_ROLL_P: 7 })
    expect(repos.tuning.get(b.id)).toEqual({})
  })

  it('stores only the overrides, not the PX4 defaults', () => {
    const p = newProject('A')
    repos.tuning.set(p.id, { MC_ROLL_P: 7 })
    expect(rows()).toHaveLength(1)
  })

  it('clear removes the overrides; saving an empty set does the same', () => {
    const p = newProject('A')
    repos.tuning.set(p.id, { MC_ROLL_P: 7 })
    repos.tuning.clear(p.id)
    expect(repos.tuning.get(p.id)).toEqual({})
    repos.tuning.set(p.id, { MC_ROLL_P: 7 })
    repos.tuning.set(p.id, {})
    expect(rows()).toEqual([])
  })

  it('refuses an invalid set, names every parameter, and leaves the saved set untouched', () => {
    const p = newProject('A')
    repos.tuning.set(p.id, { MC_ROLL_P: 7 })
    let caught: unknown
    try {
      repos.tuning.set(p.id, { MC_PITCH_P: 5, MPC_TILTMAX_AIR: 5, NOT_A_PARAM: 1, MPC_THR_MIN: 0.9 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TuningValidationError)
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as TuningValidationError).errors.map((e) => e.name).sort()).toEqual(['MPC_THR_MIN', 'MPC_TILTMAX_AIR', 'NOT_A_PARAM'])
    expect(repos.tuning.get(p.id)).toEqual({ MC_ROLL_P: 7 })
  })

  it('an invalid first write stores nothing', () => {
    const p = newProject('A')
    expect(() => repos.tuning.set(p.id, { MC_ROLL_P: Infinity })).toThrow(TuningValidationError)
    expect(() => repos.tuning.set(p.id, 'MC_ROLL_P')).toThrow(TuningValidationError)
    expect(rows()).toEqual([])
  })

  it('an unknown project is not found', () => {
    expect(() => repos.tuning.get('nope')).toThrow(NotFoundError)
    expect(() => repos.tuning.set('nope', {})).toThrow(NotFoundError)
    expect(() => repos.tuning.clear('nope')).toThrow(NotFoundError)
  })
})
