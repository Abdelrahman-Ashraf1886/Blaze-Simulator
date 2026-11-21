import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, readFileSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Quaternion, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, type AssetInfo, type SaveAssemblyInput } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { AssetError, inspectGltf } from '../../electron/main/assets/gltf'
import { importAssetFile, removeAssetFiles, resolveAssetUrl } from '../../electron/main/assets/store'
import { openDatabase, type Db } from '../../electron/main/db/database'
import { STARTING_FRAME, ValidationError, createRepositories } from '../../electron/main/db/repositories'
import { addModelPart, halfHeight, shapeExtent } from '../../src/features/workshop/assembly-ops'
import { placeModel, placePoint, UP_ROTATION } from '../../src/three/model-units'
import { boxGlb, boxGlbWith, boxGltf, externalBufferGltf, packGlb } from '../fixtures/gltf'

const reject = (bytes: Uint8Array, name: string) => {
  try {
    inspectGltf(bytes, name)
  } catch (e) {
    expect(e).toBeInstanceOf(AssetError)
    return (e as Error).message
  }
  throw new Error('expected the file to be rejected')
}

describe('glTF validation', () => {
  it('accepts a GLB and reports triangles and bounds in file units and axes', () => {
    const f = inspectGltf(boxGlb({ size: [100, 20, 50], centre: [10, 10, 0] }), 'Box.GLB')
    expect(f.format).toBe('glb')
    expect(f.triangles).toBe(12)
    expect(f.bounds).toEqual({ min: [-40, 0, -25], max: [60, 20, 25] })
  })

  it('accepts a self-contained .gltf (embedded data URI buffer)', () => {
    const f = inspectGltf(boxGltf({ size: [1, 2, 3] }), 'box.gltf')
    expect(f.format).toBe('gltf')
    expect(f.bounds.max).toEqual([0.5, 1, 1.5])
  })

  it('applies node transforms (translation, rotation, scale) to the bounds', () => {
    // 90° about Z maps file X → Y; scale 2; then translate +5 on X.
    const s = Math.SQRT1_2
    const f = inspectGltf(
      boxGlb({ size: [4, 2, 2], node: { translation: [5, 0, 0], rotation: [0, 0, s, s], scale: [2, 2, 2] } }),
      'b.glb',
    )
    const r = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0)
    expect(r(f.bounds.min)).toEqual([3, -4, -2])
    expect(r(f.bounds.max)).toEqual([7, 4, 2])
  })

  it('rejects external buffer and image references with a clear message', () => {
    expect(reject(externalBufferGltf('../../secret.bin'), 'evil.gltf')).toMatch(/references an external file or URL \("\.\.\/\.\.\/secret\.bin"\)/)
    expect(reject(externalBufferGltf('https://example.com/x.bin'), 'evil.gltf')).toMatch(/external file or URL/)
    expect(reject(boxGlbWith({ images: [{ uri: 'file:///C:/Windows/win.ini' }] }), 'img.glb')).toMatch(/external image/)
    // Embedded images are fine.
    expect(() => inspectGltf(boxGlbWith({ images: [{ uri: 'data:image/png;base64,AAAA' }] }), 'ok.glb')).not.toThrow()
  })

  it('rejects wrong signatures, truncation, other versions and unsupported compression', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(reject(png, 'model.glb')).toMatch(/not a GLB file/)
    expect(reject(Buffer.from('hello'), 'model.gltf')).toMatch(/not valid glTF/)
    expect(reject(boxGlb({ size: [1, 1, 1] }), 'model.obj')).toMatch(/Only \.glb and \.gltf/)
    const glb = boxGlb({ size: [1, 1, 1] })
    expect(reject(glb.subarray(0, glb.length - 8), 'cut.glb')).toMatch(/truncated/)
    expect(reject(boxGlbWith({ asset: { version: '1.0' } }), 'old.glb')).toMatch(/Only glTF 2\.0/)
    expect(reject(boxGlbWith({ extensionsRequired: ['KHR_draco_mesh_compression'] }), 'd.glb')).toMatch(/Draco/)
    expect(reject(packGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }), 'empty.glb')).toMatch(/no meshes/)
    expect(reject(packGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ children: [0] }] }), 'loop.glb')).toMatch(/loop/)
  })

  it('rejects files over the size limit before parsing', () => {
    expect(reject(new Uint8Array(MAX_ASSET_BYTES + 1), 'big.glb')).toMatch(/limit is 50 MB/)
  })
})

describe('files exported by Blender 4.2 (tests/fixtures/blender/make_fixtures.py)', () => {
  const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/blender', name))

  it('accepts the default GLB export: metres, +Y up, the 100 × 60 × 50 mm pod', () => {
    const f = inspectGltf(fixture('pod.glb'), 'pod.glb')
    const pl = placeModel(f.bounds, 'm', 'y')
    expect(pl.extent.map((v) => Math.round(v * 1e6) / 1e3)).toEqual([100, 60, 50]) // mm
    expect(f.triangles).toBeGreaterThan(12)
  })

  it('refuses the separate .gltf + .bin export and the Draco-compressed export', () => {
    expect(reject(fixture('pod-separate.gltf'), 'pod-separate.gltf')).toMatch(/external file or URL \("pod-separate\.bin"\)/)
    expect(reject(fixture('pod-draco.glb'), 'pod-draco.glb')).toMatch(/Draco/)
  })
})

describe('asset store', () => {
  let dir: string
  let db: Db
  let repos: ReturnType<typeof createRepositories>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blazeuav-assets-'))
    db = openDatabase(join(dir, 'test.db'))
    repos = createRepositories(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const write = (name: string, bytes: Uint8Array) => {
    const p = join(dir, name)
    writeFileSync(p, bytes)
    return p
  }
  const store = () => join(dir, 'assets')

  it('stores a valid file by content hash, once, and lists it', () => {
    const bytes = boxGlb({ size: [0.1, 0.02, 0.05] })
    const a = importAssetFile(write('Camera pod.glb', bytes), store(), repos)
    const b = importAssetFile(write('copy.glb', bytes), store(), repos)
    expect(a.ok && b.ok).toBe(true)
    const info = (a as { data: AssetInfo }).data
    expect(info.id).toMatch(/^[0-9a-f]{64}$/)
    expect(info.filename).toBe('Camera pod.glb') // first import keeps its name
    expect((b as { data: AssetInfo }).data.id).toBe(info.id)
    expect(readdirSync(store())).toEqual([`${info.id}.glb`])
    expect(repos.assets.list()).toHaveLength(1)
    expect(info.warnings).toEqual([])
  })

  it('rejects malicious files with VALIDATION errors and stores nothing', () => {
    const cases: [string, Uint8Array, RegExp][] = [
      ['external.gltf', externalBufferGltf(), /external file/],
      ['fake.glb', Buffer.from('this is a text file pretending to be a model'), /not a GLB file/],
    ]
    for (const [name, bytes, msg] of cases) {
      const r = importAssetFile(write(name, bytes), store(), repos)
      expect(r).toEqual({ ok: false, error: { code: 'VALIDATION', message: expect.stringMatching(msg) } })
    }
    // Oversized: a sparse file, so the test does not allocate 50 MB; refused from its size alone.
    const big = join(dir, 'huge.glb')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, MAX_ASSET_BYTES + 1024)
    closeSync(fd)
    const r = importAssetFile(big, store(), repos)
    expect(r).toEqual({ ok: false, error: { code: 'VALIDATION', message: expect.stringMatching(/limit is 50 MB/) } })
    expect(importAssetFile(join(dir, 'missing.glb'), store(), repos).ok).toBe(false)
    expect(existsSync(store()) ? readdirSync(store()) : []).toEqual([])
    expect(repos.assets.list()).toEqual([])
  })

  it('serves only exact asset ids from the store folder', () => {
    const r = importAssetFile(write('a.glb', boxGlb({ size: [1, 1, 1] })), store(), repos)
    const id = (r as { data: AssetInfo }).data.id
    expect(resolveAssetUrl(`blaze-asset://model/${id}`, store())).toBe(join(store(), `${id}.glb`))
    for (const bad of [
      `blaze-asset://model/${'0'.repeat(64)}`, // unknown id
      'blaze-asset://model/..%2Ftest.db',
      'blaze-asset://model/../test.db',
      `blaze-asset://other/${id}`,
      `file:///${join(store(), id)}.glb`,
      `blaze-asset://model/${id.toUpperCase()}`,
      'not a url',
    ]) {
      expect(resolveAssetUrl(bad, store())).toBeNull()
    }
  })

  it('a save may only reference stored assets; unused assets are collected at startup', () => {
    const r = importAssetFile(write('a.glb', boxGlb({ size: [1, 1, 1] })), store(), repos)
    const asset = (r as { data: AssetInfo }).data
    const project = repos.projects.create({ name: 'P', frameType: 'quad-x' })
    const part = (assetId: string) => ({
      id: randomUUID(),
      name: 'Pod',
      kind: 'payload' as const,
      shape: { type: 'model' as const, assetId, units: 'mm' as const, upAxis: 'y' as const },
      parentId: null,
      mountId: null,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      mass: null,
    })
    const input = (assetId: string): SaveAssemblyInput => ({
      projectId: project.id,
      baseRevision: 0,
      frame: STARTING_FRAME['quad-x'],
      motors: {},
      parts: [part(assetId)],
    })
    expect(saveAssemblySchema.safeParse({ ...input(asset.id), parts: [{ ...part(asset.id), shape: { type: 'model', assetId: asset.id } }] }).success).toBe(false)
    expect(() => repos.assemblies.save(input('f'.repeat(64)))).toThrow(ValidationError)
    repos.assemblies.save(input(asset.id))
    expect(repos.assets.collectGarbage()).toEqual([])

    repos.projects.delete(project.id)
    const removed = repos.assets.collectGarbage()
    expect(removed).toEqual([asset.id])
    removeAssetFiles(store(), removed)
    expect(readdirSync(store())).toEqual([])
  })
})

describe('model placement (units and up axis)', () => {
  const bounds = { min: [-40, 0, -25] as [number, number, number], max: [60, 20, 25] as [number, number, number] }

  it('Y-up millimetre file: file Y becomes world Z, file Z becomes world −Y, centred, in metres', () => {
    const pl = placeModel(bounds, 'mm', 'y')
    expect(pl.extent.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.1, 0.05, 0.02])
    // Top-front corner of the file box (max X, max Y = up, max Z) → +X, −Y, +Z in the world.
    const p = placePoint([60, 20, 25], pl)
    expect(p.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.05, -0.025, 0.01])
    // The quaternion used for rendering agrees with the documented mapping.
    const v = new Vector3(1, 2, 3).applyQuaternion(new Quaternion(...UP_ROTATION.y))
    expect([v.x, v.y, v.z].map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([1, -3, 2])
  })

  it('Z-up inch file keeps its axes; scale is 25.4 mm per inch', () => {
    const pl = placeModel({ min: [0, 0, 0], max: [1, 2, 3] }, 'in', 'z')
    expect(pl.rotation).toEqual([0, 0, 0, 1])
    expect(pl.extent.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.0254, 0.0508, 0.0762])
  })

  it('a model part rests on its mount using its converted height', () => {
    const asset: AssetInfo = {
      id: 'a'.repeat(64),
      filename: 'Gimbal.glb',
      format: 'glb',
      bytes: 1,
      triangles: 12,
      bounds,
      importedAt: '',
      warnings: [],
    }
    const doc = { frame: STARTING_FRAME['quad-x'], motors: {}, parts: [] }
    const { doc: next, part } = addModelPart(doc, asset, { kind: 'payload', units: 'mm', upAxis: 'y' }, { kind: 'mount', id: 'plate-bottom' }, 0.004, {})
    expect(part.name).toBe('Gimbal')
    expect(part.mountId).toBe('plate-bottom')
    expect(part.position[2]).toBeCloseTo(0.01, 9) // half of 20 mm
    const assets = { [asset.id]: asset }
    expect(shapeExtent(part.shape, assets)!.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.1, 0.05, 0.02])
    expect(halfHeight(part.shape, {})).toBe(0) // unknown asset: no extent
    expect(addModelPart(next, asset, { kind: 'payload', units: 'm', upAxis: 'z' }, { kind: 'none' }, 0, assets).part.name).toBe('Gimbal (2)')
  })
})
