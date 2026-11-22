/**
 * The convex hull of an imported model, computed once at import (plan, "Collisions").
 * Pure: bytes in, hull out; no Electron imports, unit tested directly.
 *
 * Coordinates: file units and file axes, after the node transforms of the default scene,
 * the same space as the stored bounds (gltf.ts `measure`). The renderer applies the part's
 * units and up axis (src/three/model-units.ts `placePoint`).
 *
 * Conservative by construction, or not used:
 * - every vertex of every mesh primitive is read from its POSITION accessor (byteOffset,
 *   byteStride, normalized integer types and sparse substitution per glTF 2.0 §3.6–3.7);
 * - the full hull is kept (quickhull, three.js `ConvexHull`); nothing is simplified;
 * - every source vertex is then checked to lie inside or on the hull (each face plane,
 *   within CONTAINMENT_TOLERANCE × the model's size), and every hull point within the
 *   stored bounds.
 * If any check fails, or the hull is flat (no volume) or has more than MAX_HULL_VERTICES
 * vertices, no hull is stored and the reason is: the part then collides as its bounding
 * box, which contains the model.
 */
import { Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import type { Bounds3, ModelHull } from '../../ipc/contract'
import { IDENTITY, multiply, nodeMatrix, parseJson, readGlb, rootNodes, transform, type Gltf, type Mat4 } from './gltf'

/** More vertices than this: the bounding box is used instead (the GJK support loop is linear in them). */
export const MAX_HULL_VERTICES = 4096
/** A source vertex may lie this far outside a hull face (relative to the model's largest side). */
export const CONTAINMENT_TOLERANCE = 1e-9
/** Above this many vertex × face checks the hull is not verified and so not used. */
export const MAX_CONTAINMENT_CHECKS = 4e8

type V3 = [number, number, number]

const COMPONENT: Record<number, { size: number; read: (d: DataView, o: number) => number; norm: (v: number) => number }> = {
  5126: { size: 4, read: (d, o) => d.getFloat32(o, true), norm: (v) => v },
  5120: { size: 1, read: (d, o) => d.getInt8(o), norm: (v) => Math.max(v / 127, -1) },
  5121: { size: 1, read: (d, o) => d.getUint8(o), norm: (v) => v / 255 },
  5122: { size: 2, read: (d, o) => d.getInt16(o, true), norm: (v) => Math.max(v / 32767, -1) },
  5123: { size: 2, read: (d, o) => d.getUint16(o, true), norm: (v) => v / 65535 },
}
const INDEX: Record<number, { size: number; read: (d: DataView, o: number) => number }> = {
  5121: { size: 1, read: (d, o) => d.getUint8(o) },
  5123: { size: 2, read: (d, o) => d.getUint16(o, true) },
  5125: { size: 4, read: (d, o) => d.getUint32(o, true) },
}

class HullError extends Error {}

function buffersOf(json: Gltf, bytes: Uint8Array, format: 'glb' | 'gltf'): Uint8Array[] {
  let bin: Uint8Array | null = null
  if (format === 'glb') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const jsonLength = view.getUint32(12, true)
    const next = 20 + jsonLength
    if (next + 8 <= bytes.byteLength) bin = bytes.subarray(next + 8, next + 8 + view.getUint32(next, true))
  }
  return (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin
      throw new HullError(`buffer ${i} has no data`)
    }
    const m = /^data:[^,]*?(;base64)?,(.*)$/is.exec(b.uri)
    if (!m) throw new HullError(`buffer ${i} is not embedded`)
    return m[1] ? new Uint8Array(Buffer.from(m[2]!, 'base64')) : new TextEncoder().encode(decodeURIComponent(m[2]!))
  })
}

function viewOf(json: Gltf, buffers: Uint8Array[], index: number) {
  const bv = json.bufferViews?.[index]
  if (!bv) throw new HullError(`buffer view ${index} does not exist`)
  const buf = buffers[bv.buffer]
  if (!buf) throw new HullError(`buffer ${bv.buffer} does not exist`)
  const start = bv.byteOffset ?? 0
  if (start + bv.byteLength > buf.byteLength) throw new HullError(`buffer view ${index} runs past its buffer`)
  return { data: new DataView(buf.buffer, buf.byteOffset + start, bv.byteLength), stride: bv.byteStride }
}

/** The VEC3 values of an accessor, as numbers (glTF 2.0 §3.6.2 and §3.7). */
export function readVec3(json: Gltf, buffers: Uint8Array[], accessor: number): V3[] {
  const acc = json.accessors?.[accessor]
  if (!acc) throw new HullError(`accessor ${accessor} does not exist`)
  if (acc.type !== 'VEC3') throw new HullError(`POSITION accessor ${accessor} is not VEC3`)
  const c = COMPONENT[acc.componentType ?? -1]
  if (!c) throw new HullError(`POSITION component type ${acc.componentType} is not supported`)
  const count = acc.count ?? 0
  const value = (v: number) => (acc.normalized ? c.norm(v) : v)
  const out: V3[] = Array.from({ length: count }, () => [0, 0, 0] as V3)
  if (acc.bufferView !== undefined) {
    const { data, stride } = viewOf(json, buffers, acc.bufferView)
    const step = stride ?? c.size * 3
    const base = acc.byteOffset ?? 0
    if (count > 0 && base + step * (count - 1) + c.size * 3 > data.byteLength) throw new HullError(`accessor ${accessor} runs past its buffer view`)
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) out[i]![k] = value(c.read(data, base + i * step + k * c.size))
  }
  if (acc.sparse) {
    const s = acc.sparse
    const ix = INDEX[s.indices.componentType]
    if (!ix) throw new HullError(`sparse index type ${s.indices.componentType} is not valid`)
    const iv = viewOf(json, buffers, s.indices.bufferView)
    const vv = viewOf(json, buffers, s.values.bufferView)
    const io = s.indices.byteOffset ?? 0
    const vo = s.values.byteOffset ?? 0
    if (io + ix.size * s.count > iv.data.byteLength || vo + c.size * 3 * s.count > vv.data.byteLength) throw new HullError(`sparse data of accessor ${accessor} runs past its buffer view`)
    for (let j = 0; j < s.count; j++) {
      const target = ix.read(iv.data, io + j * ix.size)
      if (target >= count) throw new HullError(`sparse index ${target} is outside accessor ${accessor}`)
      for (let k = 0; k < 3; k++) out[target]![k] = value(c.read(vv.data, vo + (j * 3 + k) * c.size))
    }
  }
  return out
}

/** Every vertex of every mesh primitive in the default scene, with node transforms applied. */
export function scenePositions(bytes: Uint8Array, format: 'glb' | 'gltf'): V3[] {
  const json = format === 'glb' ? readGlb(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)).json : parseJson(new TextDecoder().decode(bytes))
  const buffers = buffersOf(json, bytes, format)
  const nodes = json.nodes ?? []
  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene?.nodes ?? (json.scenes?.length ? [] : rootNodes(json))
  const out: V3[] = []
  let depth = 0
  const visit = (index: number, parent: Mat4) => {
    const node = nodes[index]
    if (!node || ++depth > 1000) throw new HullError('the node hierarchy is invalid')
    const m = multiply(parent, nodeMatrix(node))
    for (const p of node.mesh !== undefined ? (json.meshes?.[node.mesh]?.primitives ?? []) : []) {
      const pos = p.attributes?.POSITION
      if (pos === undefined) continue
      for (const v of readVec3(json, buffers, pos)) out.push(transform(m, v))
    }
    for (const c of node.children ?? []) visit(c, m)
    depth--
  }
  for (const r of roots) visit(r, IDENTITY)
  return out
}

/** The model's hull, or why there is none (the box is used then). */
export function modelHull(bytes: Uint8Array, format: 'glb' | 'gltf', bounds: Bounds3): ModelHull {
  const none = (reason: string): ModelHull => ({ points: null, reason })
  let source: V3[]
  try {
    source = scenePositions(bytes, format)
  } catch (e) {
    return none(e instanceof HullError ? `The vertices could not be read: ${e.message}.` : 'The vertices could not be read.')
  }
  if (source.length < 4) return none('The model has fewer than 4 vertices.')
  const size = Math.max(...bounds.max.map((v, i) => v - bounds.min[i]!))
  if (!(size > 0)) return none('The model has no size.')

  const hull = new ConvexHull().setFromPoints(source.map((p) => new Vector3(...p)))
  const seen = new Map<string, V3>()
  for (const f of hull.faces) {
    let e = f.edge
    do {
      const p = e.head().point
      seen.set(`${p.x},${p.y},${p.z}`, [p.x, p.y, p.z])
      e = e.next
    } while (e !== f.edge)
  }
  const points = [...seen.values()]
  if (hull.faces.length < 4 || points.length < 4) return none('The model is flat (its hull has no volume).')
  // Volume by the divergence theorem over the hull's triangles; flat if negligible (as the engine checks).
  let volume = 0
  for (const f of hull.faces) {
    const a = f.edge.tail().point
    let e = f.edge.next
    while (e.head() !== f.edge.tail()) {
      volume += a.dot(e.tail().point.clone().cross(e.head().point)) / 6
      e = e.next
    }
  }
  if (!(Math.abs(volume) > 1e-9 * size ** 3)) return none('The model is flat (its hull has no volume).')
  if (points.length > MAX_HULL_VERTICES) return none(`The hull has ${points.length} vertices (more than ${MAX_HULL_VERTICES}).`)

  const eps = CONTAINMENT_TOLERANCE * size
  if (source.length * hull.faces.length > MAX_CONTAINMENT_CHECKS) return none('The model is too large to verify its hull.')
  const v = new Vector3()
  for (const p of source) {
    v.set(p[0], p[1], p[2])
    for (const f of hull.faces) {
      const d = f.normal.dot(v) - f.constant
      if (d > eps) return none(`A vertex lies ${d.toExponential(2)} outside the computed hull.`)
    }
  }
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i]! < bounds.min[i]! - eps || p[i]! > bounds.max[i]! + eps) return none('The hull reaches outside the model bounds.')
    }
  }
  return { points, reason: null }
}
