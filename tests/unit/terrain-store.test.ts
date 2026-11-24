import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, type EnvironmentDoc } from '../../electron/ipc/contract'
import { createTerrainHandlers, importTerrain } from '../../electron/ipc/handlers'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { importAssetFile, removeAssetFiles, resolveAssetUrl } from '../../electron/main/assets/store'
import { openDatabase, type Db } from '../../electron/main/db/database'
import { createRepositories, ValidationError } from '../../electron/main/db/repositories'
import { boxGlb } from '../fixtures/gltf'

const header = 'ncols 2\nnrows 2\nxllcorner 4\nyllcorner -2\ncellsize 2\n'
const samples = '30 40\n10 20\n'
const withSentinel = `${header}NODATA_VALUE -42\n${samples}`
const withoutSentinel = header + samples
const metres = { verticalUnit: 'm' } as const

describe('terrain IPC and storage', () => {
  let dir: string
  let assetsDir: string
  let path: string
  let db: Db
  let repos: ReturnType<typeof createRepositories>
  const open = () => {
    db = openDatabase(path)
    repos = createRepositories(db)
    return createTerrainHandlers(repos, assetsDir)
  }
  const file = (name: string, bytes: string | Uint8Array) => {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return path
  }
  const importFile = (name: string, contents: string, input: unknown = metres) =>
    importTerrain(input, async () => file(name, contents), assetsDir, repos)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blaze-terrain-'))
    assetsDir = join(dir, 'assets')
    path = join(dir, 'test.db')
    open()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports by digest and preserves referenced terrain and hull models through startup collection', async () => {
    const used = await importFile('used.ASC', withoutSentinel, { ...metres, noDataValue: -42 })
    const unused = await importFile('unused.asc', withSentinel)
    const model = importAssetFile(file('box.glb', boxGlb({ size: [1, 1, 1] })), assetsDir, repos)
    expect([used.ok, unused.ok, model.ok]).toEqual([true, true, true])
    if (!used.ok || !used.data || !unused.ok || !unused.data || !model.ok) throw new Error('Fixture import failed')
    const id = createHash('sha256').update(withoutSentinel).digest('hex')
    expect(used.data).toMatchObject({ format: 'asc', id, filename: 'used.ASC', bytes: Buffer.byteLength(withoutSentinel) })
    expect(await importFile('duplicate.asc', withoutSentinel, { ...metres, noDataValue: -50 })).toEqual(used)
    expect(readFileSync(join(assetsDir, `${id}.asc`), 'utf8')).toBe(withoutSentinel)
    expect(repos.assets.list()).toEqual([model.data])
    expect(resolveAssetUrl(`blaze-asset://model/${id}`, assetsDir)).toBeNull()

    const project = repos.projects.create({ name: 'Terrain flight', frameType: 'quad-x' })
    const { frame, motors, parts } = repos.assemblies.load(project.id)
    const pose = { center: [0, 0, 1] as [number, number, number], yaw: 0, friction: 0, restitution: 0 }
    const environment: EnvironmentDoc = {
      ground: { friction: null, restitution: null },
      terrain: { assetId: id, friction: 0.5, restitution: 0 },
      obstacles: [
        { ...pose, type: 'box', id: 'box', name: 'Box', size: [1, 1, 1] },
        { ...pose, type: 'cylinder', id: 'cylinder', name: 'Cylinder', radius: 1, height: 2 },
        { ...pose, type: 'hull', id: 'hull', name: 'Hull', assetId: model.data.id, units: 'm', upAxis: 'y' },
      ],
    }
    const input = saveAssemblySchema.parse({ projectId: project.id, baseRevision: 0, frame, motors, parts, environment })
    expect(() => repos.assemblies.save({
      ...input, environment: { ...environment, terrain: { assetId: model.data.id, friction: 0, restitution: 0 } },
    })).toThrow(ValidationError)
    expect(() => repos.assemblies.save({
      ...input, environment: { ...environment, obstacles: [{ ...pose, type: 'hull', id: 'bad', name: 'Bad', assetId: id, units: 'm', upAxis: 'y' }] },
    })).toThrow(ValidationError)
    repos.assemblies.save(input)
    db.close()

    const handlers = open()
    const unusedIds = repos.assets.collectGarbage()
    expect(unusedIds).toEqual([unused.data.id])
    removeAssetFiles(assetsDir, unusedIds)
    expect(readdirSync(assetsDir).sort()).toEqual([`${id}.asc`, `${model.data.id}.glb`].sort())
    expect(repos.assemblies.load(project.id).environment).toEqual(environment)
    expect(handlers[Channels.terrainList](undefined)).toEqual({ ok: true, data: [used.data] })
    expect(handlers[Channels.terrainRead](id)).toEqual({
      ok: true, data: { rows: 2, columns: 2, cellSizeM: 2, cornerM: [4, -2], heightsM: Float64Array.of(30, 40, 10, 20) },
    })
    expect(handlers[Channels.terrainRead](unused.data.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    repos.projects.delete(project.id)
    expect(repos.assets.collectGarbage().sort()).toEqual([id, model.data.id].sort())
  })

  it('asks for metres and the omitted sentinel, and refuses invalid files and ids', async () => {
    const pick = vi.fn(async () => undefined)
    for (const input of [undefined, { verticalUnit: 'ft' }, { ...metres, noDataValue: Infinity }, { ...metres, path: 'test.asc' }]) {
      expect(await importTerrain(input, pick, assetsDir, repos)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
    expect(pick).not.toHaveBeenCalled()
    expect(await importTerrain(metres, pick, assetsDir, repos)).toEqual({ ok: true, data: null })
    expect(await importFile('grid.asc', withoutSentinel)).toMatchObject({
      ok: false, error: { code: 'VALIDATION', errors: [{ name: 'noDataValue', message: expect.stringContaining('sentinel') }] },
    })
    for (const [name, contents, input] of [
      ['wrong.txt', withSentinel, metres],
      ['missing-cells.asc', `${header}NODATA_VALUE -42\n30 40\n10 -42\n`, metres],
      ['header-wins.asc', `${header}NODATA_VALUE -42\n30 40\n10 -42\n`, { ...metres, noDataValue: -50 }],
      ['bad-length.asc', `${header}NODATA_VALUE -42\n1 2 3\n`, metres],
      ['bad-fallback.asc', withoutSentinel, { ...metres, noDataValue: 20 }],
    ] as const) {
      expect(await importFile(name, contents, input), name).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
    const handlers = createTerrainHandlers(repos, assetsDir)
    expect(handlers[Channels.terrainList](undefined)).toEqual({ ok: true, data: [] })
    expect(handlers[Channels.terrainList]({})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(handlers[Channels.terrainRead]('../grid.asc')).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  })
})
