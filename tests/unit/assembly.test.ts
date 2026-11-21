import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssemblyPart, SaveAssemblyInput } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { MIGRATIONS, openDatabase, schemaVersion, type Db } from '../../electron/main/db/database'
import { ConflictError, STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blazeuav-asm-'))
  db = openDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const part = (over: Partial<AssemblyPart> = {}): AssemblyPart => ({
  id: randomUUID(),
  name: 'Motor 1',
  kind: 'motor',
  shape: { type: 'cylinder', radius: 0.014, height: 0.03 },
  parentId: null,
  mountId: null,
  position: [0.1, 0.1, 0.004],
  rotation: [0, 0, 0, 1],
  mass: null,
  ...over,
})

describe('migration 0002', () => {
  it('upgrades a v1 database without touching existing projects', () => {
    const path = join(dir, 'v1.db')
    const v1 = new Database(path)
    v1.exec(MIGRATIONS[0]!)
    v1.pragma('user_version = 1')
    v1.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
      'p1',
      'Legacy quad',
      'quad-x',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    )
    v1.close()

    const upgraded = openDatabase(path)
    expect(schemaVersion(upgraded)).toBe(MIGRATIONS.length)
    expect(createRepositories(upgraded).projects.list().map((p) => p.name)).toEqual(['Legacy quad'])
    upgraded.close()
  })
})

describe('assembly repository', () => {
  it('creates the assembly with starting values for the frame layout on first load', () => {
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Hex', frameType: 'hex-x' })
    const a = repos.assemblies.load(p.id)
    expect(a).toMatchObject({ projectId: p.id, revision: 0, parts: [], frame: STARTING_FRAME['hex-x'] })
    expect(repos.assemblies.load(p.id).revision).toBe(0) // idempotent
  })

  it('saves frame and parts, bumps the revision and the project modified time', () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    const repos = createRepositories(db, () => new Date((t += 1000)))
    const p = repos.projects.create({ name: 'Quad', frameType: 'quad-x' })
    repos.assemblies.load(p.id)
    const frame = { ...STARTING_FRAME['quad-x'], motorDiagonal: 0.5 }
    const parent = part({ name: 'Plate', kind: 'custom', shape: { type: 'box', size: [0.1, 0.1, 0.004] } })
    // Child listed before its parent: the deferred foreign key must accept it.
    const child = part({ parentId: parent.id, mountId: 'motor-1', mass: { valueKg: 0.052, source: 'user' } })

    const r = repos.assemblies.save({ projectId: p.id, baseRevision: 0, frame, motors: {}, parts: [child, parent] })
    expect(r.revision).toBe(1)
    const loaded = repos.assemblies.load(p.id)
    expect(loaded.frame).toEqual(frame)
    expect(loaded.parts).toEqual([child, parent])
    expect(repos.projects.get(p.id).updatedAt).toBe(r.updatedAt)

    repos.assemblies.save({ projectId: p.id, baseRevision: 1, frame, motors: {}, parts: [parent] })
    expect(repos.assemblies.load(p.id).parts).toEqual([parent])
  })

  it('rejects a save based on a stale revision and keeps the stored data', () => {
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Quad', frameType: 'quad-x' })
    const base = repos.assemblies.load(p.id)
    repos.assemblies.save({ projectId: p.id, baseRevision: 0, frame: base.frame, motors: {}, parts: [part()] })
    expect(() =>
      repos.assemblies.save({ projectId: p.id, baseRevision: 0, frame: base.frame, motors: {}, parts: [] }),
    ).toThrow(ConflictError)
    expect(repos.assemblies.load(p.id)).toMatchObject({ revision: 1, parts: [{ name: 'Motor 1' }] })
  })

  it('stores per-motor spin and tilt overrides', () => {
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Quad', frameType: 'quad-x' })
    const a = repos.assemblies.load(p.id)
    expect(a.motors).toEqual({})
    const motors = { 'motor-1': { spin: 'cw' as const, tilt: 0.1 } }
    repos.assemblies.save({ projectId: p.id, baseRevision: 0, frame: a.frame, motors, parts: [] })
    expect(repos.assemblies.load(p.id).motors).toEqual(motors)
  })

  it('deletes the assembly with its project', () => {
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Quad', frameType: 'quad-x' })
    const a = repos.assemblies.load(p.id)
    repos.assemblies.save({ projectId: p.id, baseRevision: 0, frame: a.frame, motors: {}, parts: [part()] })
    repos.projects.delete(p.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM assembly_parts').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM assemblies').get()).toEqual({ n: 0 })
  })
})

describe('assembly validation', () => {
  const valid = (): SaveAssemblyInput => ({
    projectId: randomUUID(),
    baseRevision: 0,
    frame: STARTING_FRAME['quad-x'],
    motors: {},
    parts: [part()],
  })
  const errors = (input: unknown) => {
    const r = saveAssemblySchema.safeParse(input)
    return r.success ? [] : r.error.issues.map((i) => i.message)
  }

  it('accepts a valid document', () => {
    expect(errors(valid())).toEqual([])
  })

  it('enforces frame limits and plate < diagonal', () => {
    const v = valid()
    expect(errors({ ...v, frame: { ...v.frame, motorDiagonal: 0.01 } }).join()).toMatch(/at least 50 mm/)
    expect(errors({ ...v, frame: { ...v.frame, plateSize: 0.5, motorDiagonal: 0.45 } }).join()).toMatch(
      /smaller than the motor-to-motor diagonal/,
    )
  })

  it.each([
    ['non-unit quaternion', { rotation: [0, 0, 0, 2] }],
    ['NaN position', { position: [Number.NaN, 0, 0] }],
    ['position outside 20 m cube', { position: [11, 0, 0] }],
    ['zero mass', { mass: { valueKg: 0, source: 'user' } }],
    ['unsourced mass', { mass: { valueKg: 1, source: 'manufacturer' } }],
    ['bad asset id', { shape: { type: 'model', assetId: '../../etc/passwd' } }],
    ['unknown kind', { kind: 'rocket' }],
  ])('rejects %s', (_label, over) => {
    const v = valid()
    expect(errors({ ...v, parts: [{ ...v.parts[0], ...over }] }).length).toBeGreaterThan(0)
  })

  it('rejects dangling parents, cycles and duplicate ids', () => {
    const a = part()
    const b = part({ parentId: a.id })
    expect(errors({ ...valid(), parts: [part({ parentId: randomUUID() })] }).join()).toMatch(/does not exist/)
    expect(errors({ ...valid(), parts: [{ ...a, parentId: b.id }, b] }).join()).toMatch(/loop/)
    expect(errors({ ...valid(), parts: [a, { ...a }] }).join()).toMatch(/unique/)
  })

  it('validates motor overrides', () => {
    const v = valid()
    expect(errors({ ...v, motors: { 'motor-3': { spin: 'ccw', tilt: 0.2 } } })).toEqual([])
    expect(errors({ ...v, motors: { 'motor-9': { spin: 'cw', tilt: 0 } } }).join()).toMatch(/Unknown motor mount/)
    expect(errors({ ...v, motors: { 'motor-1': { spin: 'up', tilt: 0 } } }).length).toBeGreaterThan(0)
    expect(errors({ ...v, motors: { 'motor-1': { spin: 'cw', tilt: 1 } } }).join()).toMatch(/±30°/)
  })

  it('caps the number of parts', () => {
    const parts = Array.from({ length: 501 }, () => part())
    expect(errors({ ...valid(), parts }).join()).toMatch(/at most 500 parts/)
  })
})
