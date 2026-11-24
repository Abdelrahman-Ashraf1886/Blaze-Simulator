/**
 * The project's flight environment: no value is assumed, every missing one is listed with
 * where to enter it, the document is validated strictly and saved with the project.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EnvironmentDoc, LegacyBoxObstacleDoc } from '../../electron/ipc/contract'
import { environmentDocSchema, saveAssemblySchema } from '../../electron/ipc/schemas'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { dropTest, type EngineForDropTest } from '../../electron/main/engine/drop-test'
import { EMPTY_ENVIRONMENT, simEnvironment, yawQuaternion } from '../../src/domain/environment'

const obstacle = (over: Partial<LegacyBoxObstacleDoc> = {}): LegacyBoxObstacleDoc => ({
  id: 'o1',
  name: 'Table',
  center: [1, 0, 0.1],
  size: [0.4, 0.6, 0.2],
  yaw: Math.PI / 2,
  friction: 0.6,
  restitution: 0.1,
  ...over,
})

describe('simEnvironment', () => {
  it('nothing entered: the ground friction and restitution are listed as missing, with where to enter them', () => {
    for (const env of [undefined, null, EMPTY_ENVIRONMENT]) {
      const r = simEnvironment(env)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.missing.map((m) => m.field)).toEqual(['ground.friction', 'ground.restitution'])
      expect(r.missing[0]!.message).toBe('Ground friction is not set: enter it under Environment in the workshop.')
    }
  })

  it('an obstacle without its values is listed by name; complete values are passed on unchanged', () => {
    const half = simEnvironment({ ground: { friction: 0.5, restitution: 0 }, obstacles: [obstacle({ restitution: null })] })
    expect(half.ok ? [] : half.missing.map((m) => m.message)).toEqual(['Restitution of obstacle "Table" is not set: enter it under Environment in the workshop.'])
    const full = simEnvironment({ ground: { friction: 0.5, restitution: 0 }, obstacles: [obstacle()] })
    expect(full).toEqual({
      ok: true,
      environment: {
        ground: { friction: 0.5, restitution: 0 },
        obstacles: [{ id: 'o1', center: [1, 0, 0.1], halfExtents: [0.2, 0.3, 0.1], quaternion: yawQuaternion(Math.PI / 2), friction: 0.6, restitution: 0.1 }],
      },
    })
    // 90° about +Z: (0, 0, sin 45°, cos 45°).
    expect(yawQuaternion(Math.PI / 2)[2]).toBeCloseTo(Math.SQRT1_2, 15)
    expect(yawQuaternion(Math.PI / 2)[3]).toBeCloseTo(Math.SQRT1_2, 15)
    // Zero is a value, not "missing".
    expect(simEnvironment({ ground: { friction: 0, restitution: 0 }, obstacles: [] }).ok).toBe(true)
  })

  it('serializes terrain and each tagged obstacle shape in the engine frame', () => {
    const terrainId = 'a'.repeat(64)
    const modelId = 'b'.repeat(64)
    const grid = { rows: 2, columns: 2, cellSizeM: 2, cornerM: [4, -2] as const, heightsM: Float64Array.of(30, 40, 10, 20) }
    const pose = { center: [1, 2, 3] as [number, number, number], yaw: 0, friction: 0.5, restitution: 0 }
    const env: EnvironmentDoc = {
      ground: EMPTY_ENVIRONMENT.ground,
      terrain: { assetId: terrainId, friction: 0.4, restitution: 0.2 },
      obstacles: [
        { ...pose, id: 'box', name: 'Box', type: 'box', size: [2, 4, 6] },
        { ...pose, id: 'cyl', name: 'Cylinder', type: 'cylinder', radius: 0.75, height: 2 },
        { ...pose, id: 'hull', name: 'Hull', type: 'hull', assetId: modelId, units: 'mm', upAxis: 'y' },
      ],
    }
    expect(environmentDocSchema.parse(env)).toEqual(env)
    const result = simEnvironment(env, {
      grids: { [terrainId]: grid },
      models: { [modelId]: {
        bounds: { min: [0, 0, 0], max: [2000, 4000, 6000] },
        hull: { points: [[0, 0, 0], [2000, 0, 0], [0, 4000, 0], [0, 0, 6000]], reason: null },
      } },
    })
    const enginePose = { center: [1, 2, 3], quaternion: [0, 0, 0, 1], friction: 0.5, restitution: 0 }
    expect(result).toEqual({
      ok: true,
      environment: {
        ground: null,
        terrain: { rows: 2, columns: 2, cellSizeM: 2, cornerM: [4, -2], heightsM: [30, 40, 10, 20], friction: 0.4, restitution: 0.2 },
        obstacles: [
          { ...enginePose, id: 'box', type: 'box', halfExtents: [1, 2, 3] },
          { ...enginePose, id: 'cyl', type: 'cylinder', radius: 0.75, height: 2 },
          { ...enginePose, id: 'hull', type: 'hull', points: [[-1, 3, -2], [1, 3, -2], [-1, 3, 2], [-1, -3, -2]] },
        ],
      },
    })
  })

  it('lists missing terrain, dimensions and hull inputs with their entry locations', () => {
    const env: EnvironmentDoc = {
      ground: EMPTY_ENVIRONMENT.ground,
      terrain: { assetId: 'a'.repeat(64), friction: null, restitution: 0 },
      obstacles: [
        { type: 'cylinder', id: 'cyl', name: 'Cylinder', center: null, yaw: null, radius: null, height: null, friction: 0, restitution: 0 },
        { type: 'hull', id: 'hull', name: 'Hull', center: [0, 0, 0], yaw: 0, assetId: 'b'.repeat(64), units: null, upAxis: null, friction: 0, restitution: 0 },
      ],
    }
    expect(environmentDocSchema.parse(env)).toEqual(env)
    const result = simEnvironment(env)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.missing.map((m) => m.field)).toEqual([
      'terrain.friction', 'terrain.assetId', 'obstacles[0].center', 'obstacles[0].yaw', 'obstacles[0].radius',
      'obstacles[0].height', 'obstacles[1].units', 'obstacles[1].upAxis', 'obstacles[1].assetId',
    ])
    expect(result.missing.every(({ message }) => message.includes('Environment in the workshop'))).toBe(true)
    const cylinder = env.obstacles[0]!
    expect(environmentDocSchema.safeParse({ ...env, obstacles: [{ ...cylinder, height: -1 }] }).success).toBe(false)
    expect(environmentDocSchema.safeParse({ ...env, obstacles: [{ ...cylinder, size: [1, 1, 1] }] }).success).toBe(false)
  })
})

describe('environment document validation', () => {
  const ok = (e: unknown) => environmentDocSchema.safeParse(e).success
  it('accepts not-set values and refuses impossible ones', () => {
    expect(ok(EMPTY_ENVIRONMENT)).toBe(true)
    expect(ok({ ground: { friction: 0.5, restitution: 0.2 }, obstacles: [obstacle()] })).toBe(true)
    expect(ok({ ground: { friction: -0.1, restitution: 0 }, obstacles: [] })).toBe(false)
    expect(ok({ ground: { friction: 0.5, restitution: 1.2 }, obstacles: [] })).toBe(false)
    expect(ok({ ground: { friction: Number.NaN, restitution: 0 }, obstacles: [] })).toBe(false)
    expect(ok({ ground: { friction: 0.5 }, obstacles: [] })).toBe(false) // a missing key is not "not set"
    expect(ok({ ground: { friction: 0.5, restitution: 0 }, obstacles: [obstacle({ size: [0.4, 0, 0.2] })] })).toBe(false)
    expect(ok({ ground: { friction: 0.5, restitution: 0 }, obstacles: [obstacle(), obstacle()] })).toBe(false) // duplicate id
    expect(ok({ ground: { friction: 0.5, restitution: 0 }, obstacles: [], wind: 3 })).toBe(false)
    expect(ok({ ground: { friction: 0.5, restitution: 0 }, obstacles: [obstacle({ name: '  ' })] })).toBe(false)
  })
})

describe('environment persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blaze-env-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('is saved with the project and loads back unchanged; a project without one loads without the field', () => {
    const db = openDatabase(join(dir, 'env.db'))
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Env', frameType: 'quad-x' })
    const a = repos.assemblies.load(p.id)
    expect(a).not.toHaveProperty('environment')
    const environment: EnvironmentDoc = { ground: { friction: 0.7, restitution: null }, obstacles: [obstacle()] }
    const input = { projectId: p.id, baseRevision: a.revision, frame: a.frame, motors: a.motors, parts: a.parts, environment }
    expect(saveAssemblySchema.safeParse(input).success).toBe(true)
    repos.assemblies.save(input)
    expect(repos.assemblies.load(p.id).environment).toEqual(environment)
    db.close()
  })
})

describe('drop test handler', () => {
  const calls: string[] = []
  const fake: EngineForDropTest = {
    async loadVehicle() {
      calls.push('load')
      return { valid: true, partCount: 1, motorCount: 0, totals: { massKg: 1, com: [0, 0, 0], inertia: [1, 1, 1, 0, 0, 0] }, missingMass: [] }
    },
    async runSim() {
      calls.push('run')
      throw new Error('ENVIRONMENT_INCOMPLETE: environment.ground.friction: not set')
    },
  }
  it('refuses an invalid request before the engine sees it', async () => {
    const bad = await dropTest(fake, { vehicle: {}, environment: EMPTY_ENVIRONMENT, startPositionM: [0, 0, 1], durationS: 1 })
    expect(bad.ok).toBe(false)
    const tooLong = await dropTest(fake, { vehicle: {}, environment: { ground: null, obstacles: [] }, startPositionM: [0, 0, 1], durationS: 60 })
    expect(tooLong.ok ? '' : tooLong.error.message).toMatch(/durationS: must be more than 0 and at most 10 s/)
    expect(calls).toEqual([])
  })
})
