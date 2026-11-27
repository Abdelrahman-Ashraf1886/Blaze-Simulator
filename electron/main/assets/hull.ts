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
import { MAX_ASSET_BYTES, type Bounds3, type ModelHull } from '../../ipc/contract'
import { AssetError, IDENTITY, inspectGltfDocument, MAX_NODE_DEPTH, MAX_SCENE_WORK, multiply, nodeMatrix, parseJson, readGlb, rootNodes, transform, validateHierarchy, type Gltf, type Mat4 } from './gltf'

/** More vertices than this: the bounding box is used instead (the GJK support loop is linear in them). */
export const MAX_HULL_VERTICES = 4096
/** A source vertex may lie this far outside a hull face (relative to the model's largest side). */
export const CONTAINMENT_TOLERANCE = 1e-9
/** Above this many vertex × face checks the hull is not verified and so not used. */
export const MAX_CONTAINMENT_CHECKS = 4e8
// A closed triangular hull with V vertices has 2V - 4 faces. Budget positions
// against the existing containment work cap at the largest supported hull.
export const MAX_INPUT_VERTICES = Math.floor(MAX_CONTAINMENT_CHECKS / (2 * MAX_HULL_VERTICES - 4))

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
    if (!natural(b.byteLength)) throw new HullError(`buffer ${i} has invalid length`)
    if (b.uri === undefined) {
      if (i === 0 && bin && bin.length >= b.byteLength) return bin.subarray(0, b.byteLength)
      throw new HullError(`buffer ${i} has no data`)
    }
    const m = /^data:[^,]*?(;base64)?,(.*)$/is.exec(b.uri)
    if (!m) throw new HullError(`buffer ${i} is not embedded`)
    const data = m[1] ? Buffer.from(m[2]!, 'base64') : new TextEncoder().encode(decodeURIComponent(m[2]!))
    if (data.length < b.byteLength) throw new HullError(`buffer ${i} is truncated`)
    return data.subarray(0, b.byteLength)
  })
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function viewOf(json: Gltf, buffers: Uint8Array[], index: number) {
  const bv = natural(index) ? json.bufferViews?.[index] : undefined
  if (!bv) throw new HullError(`buffer view ${index} does not exist`)
  const buf = natural(bv.buffer) ? buffers[bv.buffer] : undefined
  if (!buf) throw new HullError(`buffer ${bv.buffer} does not exist`)
  const start = bv.byteOffset ?? 0
  if (!natural(start) || !natural(bv.byteLength) || start + bv.byteLength > buf.byteLength) {
    throw new HullError(`buffer view ${index} runs past its buffer`)
  }
  return { data: new DataView(buf.buffer, buf.byteOffset + start, bv.byteLength), stride: bv.byteStride }
}

function span(data: DataView, offset: number, count: number, stride: number, size: number, alignment: number, label: string) {
  if (!natural(offset) || offset % alignment !== 0 || !natural(stride) || stride < size
      || stride % alignment !== 0) {
    throw new HullError(`${label} has an invalid offset or stride`)
  }
  if (offset + stride * (count - 1) + size > data.byteLength) throw new HullError(`${label} runs past its buffer view`)
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const ACCESSOR_SHAPES: Record<string, [number, number]> = {
  SCALAR: [1, 1], VEC2: [1, 2], VEC3: [1, 3], VEC4: [1, 4], MAT2: [2, 2], MAT3: [3, 3], MAT4: [4, 4],
}

/** Check storage, including sparse replacement indices, before any vertex array is allocated. */
function accessorData(json: Gltf, buffers: Uint8Array[], accessor: number) {
  const acc = natural(accessor) ? json.accessors?.[accessor] : undefined
  if (!acc) throw new HullError(`accessor ${accessor} does not exist`)
  const component = COMPONENT_BYTES[acc.componentType ?? -1]
  const shape = ACCESSOR_SHAPES[acc.type ?? '']
  const count = acc.count
  if (!component || !Array.isArray(shape) || !natural(count) || count === 0) throw new HullError('invalid accessor layout')
  const [columns, rows] = shape
  const packedColumn = rows * component
  const stride = columns > 1 ? Math.ceil(packedColumn / 4) * 4 * columns : packedColumn
  const size = stride - (stride / columns - packedColumn)
  const bytes = count * stride
  if (bytes > MAX_ASSET_BYTES) throw new HullError('accessor exceeds the decoded byte budget')

  const dense = acc.bufferView === undefined ? undefined : viewOf(json, buffers, acc.bufferView)
  const base = acc.byteOffset ?? 0
  const step = dense?.stride ?? stride
  if (dense) {
    if (dense.stride !== undefined && (step % 4 !== 0 || step > 252)) throw new HullError('invalid vertex byte stride')
    span(dense.data, base, count, step, size, component, `accessor ${accessor}`)
  } else if (base !== 0) {
    throw new HullError('an accessor offset requires a buffer view')
  }
  if (!acc.sparse) return { acc, count, bytes, dense, base, step }

  const s = acc.sparse
  if (!natural(s.count) || s.count === 0 || s.count > count) throw new HullError('invalid sparse accessor count')
  const ix = INDEX[s.indices.componentType]
  if (!ix) throw new HullError(`sparse index type ${s.indices.componentType} is not valid`)
  const iv = viewOf(json, buffers, s.indices.bufferView)
  const vv = viewOf(json, buffers, s.values.bufferView)
  if (iv.stride !== undefined || vv.stride !== undefined) throw new HullError('sparse data cannot have a byte stride')
  const io = s.indices.byteOffset ?? 0
  const vo = s.values.byteOffset ?? 0
  span(iv.data, io, s.count, ix.size, ix.size, ix.size, `sparse indices of accessor ${accessor}`)
  span(vv.data, vo, s.count, stride, size, component, `sparse values of accessor ${accessor}`)
  let previous = -1
  for (let j = 0; j < s.count; j++) {
    const index = ix.read(iv.data, io + j * ix.size)
    if (index <= previous || index >= count) throw new HullError('sparse indices are repeated, unordered or outside the accessor')
    previous = index
  }
  return { acc, count, bytes, dense, base, step, sparse: { iv: iv.data, vv: vv.data, ix, io, vo, count: s.count } }
}

/** The VEC3 values of an accessor, as numbers (glTF 2.0 ?3.6.2 and ?3.7). */
export function readVec3(json: Gltf, buffers: Uint8Array[], accessor: number, remaining = MAX_INPUT_VERTICES): V3[] {
  const { acc, count, dense, base, step, sparse } = accessorData(json, buffers, accessor)
  if (count > remaining) throw new HullError('the scene exceeds the input vertex budget')
  const c = COMPONENT[acc.componentType ?? -1]
  if (acc.type !== 'VEC3' || !c) throw new HullError('invalid POSITION accessor layout')
  const value = (v: number) => (acc.normalized ? c.norm(v) : v)
  const out: V3[] = Array.from({ length: count }, () => [0, 0, 0] as V3)
  if (dense) {
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) out[i]![k] = value(c.read(dense.data, base + i * step + k * c.size))
  }
  if (sparse) {
    const { iv, vv, ix, io, vo, count } = sparse
    for (let j = 0; j < count; j++) {
      const target = ix.read(iv, io + j * ix.size)
      for (let k = 0; k < 3; k++) out[target]![k] = value(c.read(vv, vo + (j * 3 + k) * c.size))
    }
  }
  return out
}

/** Preflight the accessors the renderer can load, then compute the default scene's hull. */
export function inspectModel(bytes: Uint8Array, filename: string) {
  try {
    const { facts, json } = inspectGltfDocument(bytes, filename)
    const buffers = buffersOf(json, bytes, facts.format)
    let viewBytes = 0
    for (let i = 0; i < (json.bufferViews?.length ?? 0); i++) {
      viewBytes += viewOf(json, buffers, i).data.byteLength
      // Three's loader copies each buffer view (GLTFLoader.js:3168?3175).
      if (viewBytes > MAX_ASSET_BYTES) throw new HullError('the model exceeds the buffer view byte budget')
    }
    let decodedBytes = 0
    for (let i = 0; i < (json.accessors?.length ?? 0); i++) {
      decodedBytes += accessorData(json, buffers, i).bytes
      if (decodedBytes > MAX_ASSET_BYTES) throw new HullError('the model exceeds the decoded accessor byte budget')
    }
    let vertices = 0
    for (const node of json.nodes ?? []) {
      for (const primitive of json.meshes?.[node.mesh ?? -1]?.primitives ?? []) {
        const position = primitive.attributes?.POSITION
        if (position === undefined) continue
        const acc = json.accessors?.[position]
        if (acc?.type !== 'VEC3' || !natural(acc.count) || !COMPONENT[acc.componentType ?? -1]) throw new HullError('invalid POSITION accessor layout')
        vertices += acc.count
        if (vertices > MAX_INPUT_VERTICES) throw new HullError('the model exceeds the input vertex budget')
      }
    }
    return { facts, hull: hullOf(() => positionsOf(json, buffers), facts.bounds) }
  } catch (error) {
    throw new AssetError(error instanceof Error ? error.message : 'The model geometry is invalid.')
  }
}

/** Every vertex of every mesh primitive in the default scene, with node transforms applied. */
export function scenePositions(bytes: Uint8Array, format: 'glb' | 'gltf'): V3[] {
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new HullError('the model exceeds the byte budget')
  const json = format === 'glb' ? readGlb(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)).json : parseJson(new TextDecoder().decode(bytes))
  validateHierarchy(json)
  return positionsOf(json, buffersOf(json, bytes, format))
}

function positionsOf(json: Gltf, buffers: Uint8Array[]): V3[] {
  const nodes = json.nodes ?? []
  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene?.nodes ?? (json.scenes?.length ? [] : rootNodes(json))
  const out: V3[] = []
  let depth = 0
  let work = 0
  const charge = () => {
    if (++work > MAX_SCENE_WORK) throw new HullError('the scene exceeds the traversal budget')
  }
  const visit = (index: number, parent: Mat4) => {
    charge()
    const node = nodes[index]
    if (!node || ++depth > MAX_NODE_DEPTH) throw new HullError('the node hierarchy is invalid')
    const m = multiply(parent, nodeMatrix(node))
    for (const p of node.mesh !== undefined ? (json.meshes?.[node.mesh]?.primitives ?? []) : []) {
      charge()
      const pos = p.attributes?.POSITION
      if (pos === undefined) continue
      for (const v of readVec3(json, buffers, pos, MAX_INPUT_VERTICES - out.length)) out.push(transform(m, v))
    }
    for (const c of node.children ?? []) visit(c, m)
    depth--
  }
  for (const r of roots) visit(r, IDENTITY)
  return out
}

/** The model's hull, or why there is none (the box is used then). */
export function modelHull(bytes: Uint8Array, format: 'glb' | 'gltf', bounds: Bounds3): ModelHull {
  return hullOf(() => scenePositions(bytes, format), bounds)
}

function hullOf(readPositions: () => V3[], bounds: Bounds3): ModelHull {
  const none = (reason: string): ModelHull => ({ points: null, reason })
  let source: V3[]
  try {
    source = readPositions()
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
