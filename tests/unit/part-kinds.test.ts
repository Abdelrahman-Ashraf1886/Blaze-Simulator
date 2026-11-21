/**
 * Phase 4.2: the new part kinds, the per-part inertia override (validation, storage,
 * use in the mass properties) and resizing an envelope.
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssemblyPart } from '../../electron/ipc/contract'
import { inertiaProblem } from '../../electron/ipc/inertia'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import { STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'
import { resizable, scaledShape } from '../../src/features/workshop/assembly-ops'
import { massProperties, shapeInertia, type BodyInput } from '../../src/domain/mass'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blazeuav-kinds-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const part = (over: Partial<AssemblyPart> = {}): AssemblyPart => ({
  id: randomUUID(),
  name: 'Part',
  kind: 'custom',
  shape: { type: 'box', size: [0.05, 0.05, 0.05] },
  parentId: null,
  mountId: null,
  position: [0, 0, 0.03],
  rotation: [0, 0, 0, 1],
  mass: null,
  ...over,
})

describe('inertia validity', () => {
  it('accepts a real body and the limit of a flat plate (Izz = Ixx + Iyy)', () => {
    expect(inertiaProblem(shapeInertia({ type: 'box', halfExtents: [0.07, 0.02, 0.01] }, 0.5, 'solid'))).toBeNull()
    expect(inertiaProblem([1, 2, 3, 0, 0, 0])).toBeNull()
  })

  it('refuses non-positive moments, the triangle inequality broken, and products too large', () => {
    expect(inertiaProblem([0, 1, 1, 0, 0, 0])).toMatch(/positive/)
    expect(inertiaProblem([1, 1, 3, 0, 0, 0])).toMatch(/sum of the other two/)
    // Ixx Iyy − Ixy² = 1 − 1.21 < 0
    expect(inertiaProblem([1, 1, 1.5, 1.1, 0, 0])).toMatch(/positive definite/)
    expect(inertiaProblem([1, 1, Number.NaN, 0, 0, 0])).toMatch(/finite/)
  })

  it('the save schema refuses an impossible tensor and accepts a valid one', () => {
    const doc = (inertia: AssemblyPart['inertia']) => ({
      projectId: randomUUID(),
      baseRevision: 0,
      frame: STARTING_FRAME['quad-x'],
      motors: {},
      parts: [part({ inertia })],
    })
    expect(saveAssemblySchema.safeParse(doc({ inertia: [1e-4, 1e-4, 3e-4, 0, 0, 0], comOffset: [0, 0, 0], source: 'user' })).success).toBe(false)
    expect(saveAssemblySchema.safeParse(doc({ inertia: [1e-4, 2e-4, 2.5e-4, 0, 0, 0], comOffset: [0.001, 0, 0], source: 'user' })).success).toBe(true)
    expect(saveAssemblySchema.safeParse(doc(null)).success).toBe(true)
  })
})

describe('inertia override in the mass properties', () => {
  it('replaces the shape inertia, and its CoM offset turns with the part', () => {
    // Part turned 90° about Z: its +X offset of 10 mm points along body +Y.
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
    const body: BodyInput = {
      id: 'p',
      name: 'p',
      massKg: 0.2,
      model: 'solid',
      shape: { type: 'box', halfExtents: [0.05, 0.02, 0.01] },
      position: [0.1, 0, 0],
      quaternion: q,
      override: { inertia: [1e-4, 3e-4, 3.5e-4, 0, 0, 0], comOffset: [0.01, 0, 0] },
    }
    const mp = massProperties([body])
    expect(mp.com![0]).toBeCloseTo(0.1, 12)
    expect(mp.com![1]).toBeCloseTo(0.01, 12)
    // Ixx and Iyy swap under the 90° turn; a single body's inertia about its own CoM is its own.
    expect(mp.inertia![0]).toBeCloseTo(3e-4, 15)
    expect(mp.inertia![1]).toBeCloseTo(1e-4, 15)
    expect(mp.inertia![2]).toBeCloseTo(3.5e-4, 15)
  })
})

describe('resize', () => {
  it('scales a box per axis, keeps a cylinder round, rounds to 0.1 mm and clamps', () => {
    expect(scaledShape({ type: 'box', size: [0.1, 0.05, 0.02] }, [2, 1, 0.5])).toEqual({ type: 'box', size: [0.2, 0.05, 0.01] })
    expect(scaledShape({ type: 'cylinder', radius: 0.01, height: 0.02 }, [1.5, 1.2, 2])).toEqual({ type: 'cylinder', radius: 0.015, height: 0.04 })
    expect(scaledShape({ type: 'box', size: [0.1, 0.1, 0.1] }, [1e-6, 100, 1.00033])).toEqual({ type: 'box', size: [0.0001, 3, 0.1] })
  })

  it('only parts not linked to a component, with a box or cylinder envelope, can be resized', () => {
    expect(resizable(part())).toBe(true)
    expect(resizable(part({ componentId: randomUUID() }))).toBe(false)
    expect(resizable(part({ shape: { type: 'model', assetId: 'a'.repeat(64), units: 'm', upAxis: 'z' } }))).toBe(false)
  })
})

describe('migration 0009', () => {
  it('rebuilds the part table keeping every part, then stores the new kinds and an inertia override', () => {
    const path = join(dir, 'v8.db')
    const v8 = new Database(path)
    v8.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.slice(0, 8)) v8.exec(m)
    v8.pragma('user_version = 8')
    v8.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', 'Legacy', 'quad-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    v8.prepare("INSERT INTO assemblies (project_id, revision, frame_json, updated_at) VALUES ('p1', 1, ?, '2026-01-01T00:00:00.000Z')").run(
      JSON.stringify(STARTING_FRAME['quad-x']),
    )
    const insert = v8.prepare(
      `INSERT INTO assembly_parts (id, project_id, sort_index, parent_id, mount_id, kind, name, shape_json, px, py, pz, qx, qy, qz, qw, mass_kg, mass_source)
       VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, 0, 0, 0.01, 0, 0, 0, 1, ?, ?)`,
    )
    insert.run('a', 0, null, 'motor-1', 'motor', 'Motor 1', '{"type":"cylinder","radius":0.014,"height":0.03}', 0.098, 'user')
    insert.run('b', 1, 'a', null, 'propeller', 'Prop 1', '{"type":"cylinder","radius":0.127,"height":0.008}', null, null)
    v8.close()

    const db = openDatabase(path)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    const repos = createRepositories(db)
    const loaded = repos.assemblies.load('p1')
    expect(loaded.parts.map((p) => [p.id, p.kind, p.parentId, p.mass?.valueKg ?? null])).toEqual([
      ['a', 'motor', null, 0.098],
      ['b', 'propeller', 'a', null],
    ])
    expect(loaded.parts[0]).not.toHaveProperty('inertia')
    const gear = part({ kind: 'landing-gear', mountId: 'plate-bottom' })
    const camera = part({ kind: 'camera', inertia: { inertia: [1e-5, 2e-5, 2e-5, 0, 0, 0], comOffset: [0.002, 0, 0], source: 'user' } })
    const kinds = (['gps', 'sensor'] as const).map((kind) => part({ kind }))
    repos.assemblies.save({ projectId: 'p1', baseRevision: 1, frame: loaded.frame, motors: {}, parts: [gear, camera, ...kinds] })
    const again = repos.assemblies.load('p1')
    expect(again.parts).toEqual([gear, camera, ...kinds])
    db.close()
  })
})
