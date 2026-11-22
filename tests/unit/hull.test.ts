/**
 * Convex hulls of imported models (electron/main/assets/hull.ts): read correctly from the
 * glTF data, conservative (every vertex inside), refused when they cannot be trusted, and
 * used for collisions but not for mass.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssemblyDocument, AssetInfo } from '../../electron/ipc/contract'
import { inspectGltf } from '../../electron/main/assets/gltf'
import { MAX_HULL_VERTICES, modelHull, scenePositions } from '../../electron/main/assets/hull'
import { interferences } from '../../src/domain/collisions'
import { massProperties } from '../../src/domain/mass'
import { addModelPart, updatePart } from '../../src/features/workshop/assembly-ops'
import { interferenceInput } from '../../src/features/workshop/interference-input'
import { collisionShape, massBodies } from '../../src/features/workshop/mass-input'
import { placeModel, placePoint } from '../../src/three/model-units'
import { buildFrame } from '../../src/three/frame-geometry'
import { boxGlb, boxGltf, packGlb } from '../fixtures/gltf'

type V3 = [number, number, number]

/** A GLB with one mesh of `points` (float32, optionally interleaved with a dummy attribute) and extra accessor fields. */
function pointsGlb(points: V3[], opts: { stride?: boolean; accessor?: Record<string, unknown>; extraBin?: Uint8Array; node?: Record<string, unknown> } = {}) {
  const stride = opts.stride ? 24 : 12
  const data = new DataView(new ArrayBuffer(points.length * stride))
  points.forEach((p, i) => p.forEach((v, k) => data.setFloat32(i * stride + k * 4, v, true)))
  if (opts.stride) points.forEach((_, i) => [9, 9, 9].forEach((v, k) => data.setFloat32(i * stride + 12 + k * 4, v, true)))
  const main = new Uint8Array(data.buffer)
  const bin = opts.extraBin ? new Uint8Array([...main, ...opts.extraBin]) : main
  const min = [0, 1, 2].map((k) => points.reduce((m, p) => Math.min(m, p[k]!), Infinity))
  const max = [0, 1, 2].map((k) => points.reduce((m, p) => Math.max(m, p[k]!), -Infinity))
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...opts.node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: points.length, type: 'VEC3', min, max, ...opts.accessor }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: main.byteLength, ...(opts.stride ? { byteStride: 24 } : {}) },
      ...(opts.extraBin ? [{ buffer: 0, byteOffset: main.byteLength, byteLength: opts.extraBin.byteLength }] : []),
    ],
    buffers: [{ byteLength: bin.byteLength }],
  }
  return packGlb(json, bin)
}

const hullOf = (bytes: Uint8Array, name = 'm.glb') => {
  const facts = inspectGltf(bytes, name)
  return { facts, hull: modelHull(bytes, facts.format, facts.bounds) }
}
const sorted = (pts: V3[]) => [...pts].map((p) => p.map((v) => Math.round(v * 1e6) / 1e6).join(',')).sort()
const cube = (h: number, c: V3 = [0, 0, 0]): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h)])

describe('reading the vertices', () => {
  it('a box: the hull is its 8 corners, from a GLB and from an embedded .gltf alike', () => {
    for (const [bytes, name] of [[boxGlb({ size: [2, 3, 4], centre: [1, 0, 0] }), 'b.glb'], [boxGltf({ size: [2, 3, 4], centre: [1, 0, 0] }), 'b.gltf']] as const) {
      const { hull } = hullOf(bytes, name)
      expect(hull.reason).toBeNull()
      expect(sorted(hull.points!)).toEqual(sorted([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? 2 : 0, i & 2 ? 1.5 : -1.5, i & 4 ? 2 : -2])))
    }
  })

  it('applies node transforms (a 90° turn about Z and a translation), like the stored bounds', () => {
    const turn = { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [10, 0, 0] }
    const { facts, hull } = hullOf(boxGlb({ size: [2, 4, 6], node: turn }))
    // (x, y) → (−y, x), then +10 in X: x ∈ [8, 12], y ∈ [−1, 1].
    for (const p of hull.points!) {
      expect(Math.abs(p[0] - 10)).toBeCloseTo(2, 6)
      expect(Math.abs(p[1])).toBeCloseTo(1, 6)
    }
    expect(facts.bounds.min[0]).toBeCloseTo(8, 6)
  })

  it('honours byteStride (interleaved attributes) and sparse substitution', () => {
    const interleaved = hullOf(pointsGlb(cube(1), { stride: true })).hull
    expect(sorted(interleaved.points!)).toEqual(sorted(cube(1)))
    // Sparse: vertex 7 (1, 1, 1) is replaced by (3, 3, 3).
    const idx = new Uint8Array(4)
    idx[0] = 7
    const val = new Uint8Array(new Float32Array([3, 3, 3]).buffer)
    const extra = new Uint8Array([...idx, ...val])
    const sparse = { sparse: { count: 1, indices: { bufferView: 1, byteOffset: 0, componentType: 5121 }, values: { bufferView: 1, byteOffset: 4 } }, max: [3, 3, 3] }
    const { hull } = hullOf(pointsGlb(cube(1), { accessor: sparse, extraBin: extra }))
    expect(hull.reason).toBeNull()
    expect(sorted(hull.points!)).toContain('3,3,3')
    expect(sorted(hull.points!)).not.toContain('1,1,1')
  })

  it('reads normalized integer positions (KHR_mesh_quantization) as fractions', () => {
    const q = new Int16Array(cube(1).flat().map((v) => v * 32767))
    const bytes = packGlb(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_mesh_quantization'],
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5122, normalized: true, count: 8, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }],
        buffers: [{ byteLength: 48 }],
      },
      new Uint8Array(q.buffer),
    )
    expect(sorted(hullOf(bytes).hull.points!)).toEqual(sorted(cube(1)))
  })
})

describe('only a trustworthy hull is used', () => {
  it('the fixture model: every vertex lies inside its hull, and the hull is made of its own vertices', () => {
    const bytes = readFileSync(join(__dirname, '../fixtures/blender/pod.glb'))
    const { facts, hull } = hullOf(bytes, 'pod.glb')
    expect(hull.reason).toBeNull()
    const src = scenePositions(bytes, 'glb')
    const own = new Set(src.map((p) => p.join(',')))
    expect(hull.points!.every((p) => own.has(p.join(',')))).toBe(true)
    // Independent check: in 200 directions, the hull reaches exactly as far as the farthest vertex
    // (a hull missing part of the model would fall short in some direction).
    for (let k = 0; k < 200; k++) {
      const d: V3 = [Math.sin(k * 1.7) * Math.cos(k * 0.3), Math.sin(k * 0.9), Math.cos(k * 1.3)]
      const s = (pts: V3[]) => Math.max(...pts.map((p) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2]))
      expect(s(hull.points!)).toBeCloseTo(s(src), 9)
    }
    for (const p of hull.points!) for (let i = 0; i < 3; i++) {
      expect(p[i]).toBeGreaterThanOrEqual(facts.bounds.min[i]! - 1e-9)
      expect(p[i]).toBeLessThanOrEqual(facts.bounds.max[i]! + 1e-9)
    }
  })

  it('a flat model (no volume) has no hull: it collides as its bounding box', () => {
    const flat: V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]]
    expect(hullOf(pointsGlb(flat)).hull).toEqual({ points: null, reason: 'The model is flat (its hull has no volume).' })
  })

  it(`a hull with more than ${MAX_HULL_VERTICES} vertices is not used (no simplification)`, () => {
    const n = MAX_HULL_VERTICES + 500
    // Points on a sphere (golden-angle spiral): every one is a hull vertex.
    const sphere: V3[] = Array.from({ length: n }, (_, i) => {
      const z = 1 - (2 * (i + 0.5)) / n
      const r = Math.sqrt(1 - z * z)
      const a = i * Math.PI * (3 - Math.sqrt(5))
      return [r * Math.cos(a), r * Math.sin(a), z]
    })
    const { hull } = hullOf(pointsGlb(sphere))
    expect(hull.points).toBeNull()
    expect(hull.reason).toMatch(new RegExp(`more than ${MAX_HULL_VERTICES}`))
  })

  it('unreadable vertex data gives a reason, not a hull', () => {
    const bad = pointsGlb(cube(1), { accessor: { count: 100 } }) // runs past its buffer view
    expect(hullOf(bad).hull.reason).toMatch(/^The vertices could not be read: accessor 0 runs past its buffer view\.$/)
  })
})

describe('in the workshop', () => {
  const frame = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }
  const geo = buildFrame('quad-x', frame)
  /** A square pyramid, apex up: base 100 mm at z = 0, apex at z = 100 mm (file units: mm). */
  const pyramid: V3[] = [[-50, -50, 0], [50, -50, 0], [50, 50, 0], [-50, 50, 0], [0, 0, 100]]
  const bytes = pointsGlb(pyramid)
  const facts = inspectGltf(bytes, 'p.glb')
  const asset = (hull: boolean): AssetInfo => ({
    id: 'a'.repeat(64),
    filename: 'p.glb',
    bytes: bytes.byteLength,
    importedAt: '',
    warnings: [],
    ...facts,
    hull: hull ? modelHull(bytes, 'glb', facts.bounds) : null,
  })

  it("maps the hull with the part's units and up axis, like the drawn model", () => {
    const a = asset(true)
    const shape = { type: 'model' as const, assetId: a.id, units: 'mm' as const, upAxis: 'y' as const }
    const c = collisionShape(shape, { [a.id]: a })
    expect(c.type).toBe('hull')
    const pl = placeModel(a.bounds, 'mm', 'y')
    if (c.type === 'hull') expect(sorted(c.points)).toEqual(sorted(a.hull!.points!.map((p) => placePoint(p, pl) as V3)))
  })

  it('collides as its hull: a box beside the apex overlaps the bounding box but not the pyramid', () => {
    const doc0: AssemblyDocument = { frame, motors: {}, parts: [] }
    const check = (withHull: boolean) => {
      const a = asset(withHull)
      const assets = { [a.id]: a }
      const m = addModelPart(doc0, a, { kind: 'payload', units: 'mm', upAxis: 'z' }, { kind: 'none' }, 0.004, assets, 'pyr')
      // A 20 mm cube next to the apex, inside the pyramid's bounding box (corner region).
      const withCube = { ...m.doc, parts: [...m.doc.parts, { ...m.part, id: 'cube', name: 'Cube', kind: 'custom' as const, shape: { type: 'box' as const, size: [0.02, 0.02, 0.02] as V3 }, position: [0.035, 0.035, m.part.position[2] + 0.035] as V3 }] }
      const input = interferenceInput(withCube, geo, {}, assets)
      return interferences(input.bodies.filter((b) => b.ownerId !== 'frame'), { toleranceM: 0, attached: [], allowed: [] })
    }
    expect(check(false).map((o) => o.status)).toEqual(['error'])
    expect(check(true)).toEqual([])
  })

  it('the hull does not change mass or inertia: both use the bounding box as a uniform solid', () => {
    const doc0: AssemblyDocument = { frame, frameMass: { valueKg: 0.3, source: 'user' }, motors: {}, parts: [] }
    const run = (withHull: boolean) => {
      const a = asset(withHull)
      const assets = { [a.id]: a }
      const m = addModelPart(doc0, a, { kind: 'payload', units: 'mm', upAxis: 'z' }, { kind: 'none' }, 0.004, assets, 'pyr')
      const doc = updatePart(m.doc, 'pyr', { mass: { valueKg: 0.2, source: 'user' } })
      return massProperties(massBodies(doc, geo, {}, assets))
    }
    const box = run(false)
    const hull = run(true)
    expect(hull.inertia).toEqual(box.inertia)
    expect(hull.com).toEqual(box.com)
    expect(hull.parts.find((p) => p.partId === 'pyr')!.shape.type).toBe('hull')
    expect(box.parts.find((p) => p.partId === 'pyr')!.shape.type).toBe('box')
  })
})
