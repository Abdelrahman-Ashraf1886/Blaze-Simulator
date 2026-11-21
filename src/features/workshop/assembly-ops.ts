/**
 * Pure editing operations on an assembly document. Every function returns a new
 * document (or the same one when nothing changes); none mutates its input.
 *
 * Attachment model
 * - free part:            parentId = null, mountId = null → pose in world coordinates
 * - on a frame mount:     parentId = null, mountId = "motor-3" | "plate-top" | …
 *                         → pose relative to the mount frame (moves with the frame and motor tilt)
 * - on another part:      parentId = <part id>, mountId = null → pose relative to that part
 * Part origins are at the centre of their shape; cylinders and boxes are placed so
 * their base sits on what they are attached to.
 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type {
  AssemblyDocument,
  AssemblyPart,
  AssetInfo,
  Bounds3,
  ModelHull,
  ModelUnits,
  PartKind,
  PartShape,
  UpAxis,
} from '../../../electron/ipc/contract'
import type { FrameGeometry } from '../../three/frame-geometry'
import { placeModel } from '../../three/model-units'
import type { Vec3 } from '../../three/views'

/** Bounds (and hulls) of imported models by asset id; models whose asset is unknown have no extent. */
export type AssetBounds = Readonly<Record<string, { bounds: Bounds3; hull?: ModelHull | null }>>

/** The shape used for placement; linked parts take their component's size (see links.ts). */
export type ShapeOf = (p: AssemblyPart) => PartShape
const ownShape: ShapeOf = (p) => p.shape

export const PART_LABELS: Record<PartKind, string> = {
  motor: 'Motor',
  propeller: 'Propeller',
  battery: 'Battery',
  'flight-controller': 'Flight controller',
  esc: 'ESC',
  gps: 'GPS',
  camera: 'Camera',
  sensor: 'Sensor',
  'landing-gear': 'Landing gear',
  payload: 'Payload',
  custom: 'Custom',
}

/**
 * Starting shape per kind so a new part is visible at a plausible scale. These
 * are placeholders for the user to replace with real dimensions; they are not
 * specifications of any product. Propellers are drawn as their swept disc.
 */
export const STARTING_SHAPES: Record<PartKind, PartShape> = {
  motor: { type: 'cylinder', radius: 0.014, height: 0.03 },
  propeller: { type: 'cylinder', radius: 0.127, height: 0.008 },
  battery: { type: 'box', size: [0.14, 0.045, 0.035] },
  'flight-controller': { type: 'box', size: [0.036, 0.036, 0.01] },
  esc: { type: 'box', size: [0.05, 0.025, 0.008] },
  gps: { type: 'box', size: [0.05, 0.05, 0.016] },
  camera: { type: 'box', size: [0.04, 0.03, 0.03] },
  sensor: { type: 'box', size: [0.025, 0.02, 0.008] },
  'landing-gear': { type: 'box', size: [0.22, 0.2, 0.1] },
  payload: { type: 'box', size: [0.08, 0.06, 0.05] },
  custom: { type: 'box', size: [0.05, 0.05, 0.05] },
}

export type AttachTarget = { kind: 'mount'; id: string } | { kind: 'part'; id: string } | { kind: 'none' }

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1]

/** Size of a shape along its local X, Y, Z in metres (null for a model whose file is unknown). */
export function shapeExtent(shape: PartShape, assets: AssetBounds = {}): Vec3 | null {
  if (shape.type === 'box') return [...shape.size]
  if (shape.type === 'cylinder') return [shape.radius * 2, shape.radius * 2, shape.height]
  const asset = assets[shape.assetId]
  return asset ? placeModel(asset.bounds, shape.units, shape.upAxis).extent : null
}

/** Half the extent of a shape along its local Z axis (so it can sit on a surface). */
export function halfHeight(shape: PartShape, assets: AssetBounds = {}): number {
  return (shapeExtent(shape, assets)?.[2] ?? 0) / 2
}

/** Next free "<Label> <n>" name for a kind. */
export function nextName(doc: AssemblyDocument, kind: PartKind): string {
  const base = PART_LABELS[kind]
  const used = new Set(doc.parts.map((p) => p.name))
  let n = 1
  while (used.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Pose that rests `shape` on the target: base on the mount surface / on top of the parent part. */
function restingPose(
  doc: AssemblyDocument,
  shape: PartShape,
  target: AttachTarget,
  frameTop: number,
  assets: AssetBounds = {},
  shapeOf: ShapeOf = ownShape,
) {
  const h = halfHeight(shape, assets)
  if (target.kind === 'mount') return { position: [0, 0, h] as Vec3 }
  if (target.kind === 'part') {
    const parent = doc.parts.find((p) => p.id === target.id)
    return { position: [0, 0, (parent ? halfHeight(shapeOf(parent), assets) : 0) + h] as Vec3 }
  }
  return { position: [0, 0, frameTop + h] as Vec3 }
}

export function addPart(
  doc: AssemblyDocument,
  kind: PartKind,
  target: AttachTarget,
  frameTop: number,
  id: string = crypto.randomUUID(),
  assets: AssetBounds = {},
  shapeOf: ShapeOf = ownShape,
): { doc: AssemblyDocument; part: AssemblyPart } {
  return insertPart(doc, kind, nextName(doc, kind), STARTING_SHAPES[kind], target, frameTop, assets, id, shapeOf)
}

/** Name for an imported model part: the file name without extension, made unique. */
export function modelName(doc: AssemblyDocument, filename: string): string {
  const base = (filename.replace(/\.(glb|gltf)$/i, '').trim() || 'Model').slice(0, 72)
  const used = new Set(doc.parts.map((p) => p.name))
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

export interface ModelOptions {
  kind: PartKind
  units: ModelUnits
  upAxis: UpAxis
}

/** Adds a part that displays an imported model, resting on the target like any other part. */
export function addModelPart(
  doc: AssemblyDocument,
  asset: AssetInfo,
  opts: ModelOptions,
  target: AttachTarget,
  frameTop: number,
  assets: AssetBounds,
  id: string = crypto.randomUUID(),
  shapeOf: ShapeOf = ownShape,
): { doc: AssemblyDocument; part: AssemblyPart } {
  const shape: PartShape = { type: 'model', assetId: asset.id, units: opts.units, upAxis: opts.upAxis }
  return insertPart(doc, opts.kind, modelName(doc, asset.filename), shape, target, frameTop, { ...assets, [asset.id]: asset }, id, shapeOf)
}

function insertPart(
  doc: AssemblyDocument,
  kind: PartKind,
  name: string,
  shape: PartShape,
  target: AttachTarget,
  frameTop: number,
  assets: AssetBounds,
  id: string,
  shapeOf: ShapeOf = ownShape,
): { doc: AssemblyDocument; part: AssemblyPart } {
  const { position } = restingPose(doc, shape, target, frameTop, assets, shapeOf)
  const part: AssemblyPart = {
    id,
    name,
    kind,
    shape,
    parentId: target.kind === 'part' ? target.id : null,
    mountId: target.kind === 'mount' ? target.id : null,
    position: [...position],
    rotation: [...IDENTITY],
    mass: null,
  }
  return { doc: { ...doc, parts: [...doc.parts, part] }, part }
}

/** Ids of a part and everything attached to it, directly or indirectly. */
export function subtreeIds(doc: AssemblyDocument, id: string): Set<string> {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const p of doc.parts) {
      if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) {
        ids.add(p.id)
        grew = true
      }
    }
  }
  return ids
}

/** Removes a part and everything attached to it, with their wires and schematic positions. */
export function deletePart(doc: AssemblyDocument, id: string): AssemblyDocument {
  const ids = subtreeIds(doc, id)
  const next: AssemblyDocument = { ...doc, parts: doc.parts.filter((p) => !ids.has(p.id)) }
  if (doc.wires) next.wires = doc.wires.filter((w) => !ids.has(w.from.partId) && !ids.has(w.to.partId))
  if (doc.schematic) next.schematic = Object.fromEntries(Object.entries(doc.schematic).filter(([k]) => !ids.has(k)))
  // Allowed overlaps that name a removed part go with it (undo brings both back).
  if (doc.interference) {
    next.interference = { ...doc.interference, allowedPairs: doc.interference.allowedPairs.filter(([a, b]) => !ids.has(a) && !ids.has(b)) }
  }
  return next
}

/**
 * Copies a part and everything attached to it. The copy keeps the same
 * attachment, offset by `offset` (in the attachment's frame) so it is visible.
 */
export function duplicatePart(
  doc: AssemblyDocument,
  id: string,
  offset: Vec3 = [0.01, -0.01, 0],
  newId: () => string = () => crypto.randomUUID(),
): { doc: AssemblyDocument; rootId: string | null } {
  const ids = subtreeIds(doc, id)
  if (!doc.parts.some((p) => p.id === id)) return { doc, rootId: null }
  const map = new Map([...ids].map((old) => [old, newId()]))
  const copies: AssemblyPart[] = []
  for (const p of doc.parts.filter((x) => ids.has(x.id))) {
    const isRoot = p.id === id
    copies.push({
      ...p,
      id: map.get(p.id)!,
      // Generated names ("Motor 3") get the next free number; custom names get "copy".
      name: /^.+ \d+$/.test(p.name) && p.name.startsWith(PART_LABELS[p.kind])
        ? nextName({ ...doc, parts: [...doc.parts, ...copies] }, p.kind)
        : `${p.name} copy`.slice(0, 80),
      parentId: isRoot ? p.parentId : map.get(p.parentId!)!,
      position: isRoot ? [p.position[0] + offset[0], p.position[1] + offset[1], p.position[2] + offset[2]] : p.position,
    })
  }
  return { doc: { ...doc, parts: [...doc.parts, ...copies] }, rootId: map.get(id)! }
}

/** Motor mounts a root part on a motor mount could be copied to: those holding no root part of its kind. */
export function freeMotorMounts(doc: AssemblyDocument, geo: FrameGeometry, id: string): string[] {
  const part = doc.parts.find((p) => p.id === id)
  if (!part || part.parentId !== null || !geo.motors.some((m) => m.id === part.mountId)) return []
  const taken = new Set(doc.parts.filter((p) => p.parentId === null && p.kind === part.kind).map((p) => p.mountId))
  return geo.motors.map((m) => m.id).filter((m) => !taken.has(m))
}

/**
 * Copies a part on a motor mount, with everything attached to it, onto every other
 * motor mount that holds no part of the same kind. Each copy keeps the pose relative
 * to its mount, so it follows that arm's tilt.
 */
export function copyToMotorMounts(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  id: string,
  newId: () => string = () => crypto.randomUUID(),
): { doc: AssemblyDocument; copies: number } {
  let next = doc
  const targets = freeMotorMounts(doc, geo, id)
  for (const mountId of targets) {
    const r = duplicatePart(next, id, [0, 0, 0], newId)
    next = r.rootId ? updatePart(r.doc, r.rootId, { mountId }) : r.doc
  }
  return { doc: next, copies: targets.length }
}

export function updatePart(
  doc: AssemblyDocument,
  id: string,
  patch: Partial<Omit<AssemblyPart, 'id'>>,
): AssemblyDocument {
  return { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
}

/** Parts a part may be attached to: everything except itself and its own subtree. */
export function attachableParts(doc: AssemblyDocument, id: string): AssemblyPart[] {
  const own = subtreeIds(doc, id)
  return doc.parts.filter((p) => !own.has(p.id))
}

/** Frames of the frame's mounting points in world coordinates. */
export function mountFrames(geo: FrameGeometry): Map<string, { position: Vec3; quaternion: Quaternion }> {
  const frames = new Map<string, { position: Vec3; quaternion: Quaternion }>()
  for (const m of geo.motors) {
    frames.set(m.id, {
      position: m.position,
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(...m.armDirection), m.tilt),
    })
  }
  for (const p of geo.plates) {
    // The bottom mount faces down: its local +Z points to world -Z.
    const q = p.id === 'plate-bottom' ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI) : new Quaternion()
    frames.set(p.id, { position: p.position, quaternion: q })
  }
  return frames
}

const localMatrix = (p: AssemblyPart) =>
  new Matrix4().compose(new Vector3(...p.position), new Quaternion(...p.rotation), new Vector3(1, 1, 1))

/** World matrix of a part, following its attachment chain. */
export function worldMatrix(doc: AssemblyDocument, geo: FrameGeometry, id: string): Matrix4 {
  const byId = new Map(doc.parts.map((p) => [p.id, p]))
  const frames = mountFrames(geo)
  const chain: AssemblyPart[] = []
  for (let p = byId.get(id); p; p = p.parentId ? byId.get(p.parentId) : undefined) chain.unshift(p)
  const m = new Matrix4()
  const root = chain[0]
  const mount = root?.mountId ? frames.get(root.mountId) : undefined
  if (mount) m.compose(new Vector3(...mount.position), mount.quaternion, new Vector3(1, 1, 1))
  for (const p of chain) m.multiply(localMatrix(p))
  return m
}

const round = (v: number, step = 1e-7) => Math.round(v / step) * step

function decompose(m: Matrix4): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const pos = new Vector3()
  const q = new Quaternion()
  m.decompose(pos, q, new Vector3())
  q.normalize()
  return { position: [round(pos.x), round(pos.y), round(pos.z)], rotation: [q.x, q.y, q.z, q.w] }
}

/**
 * Re-attaches a part. Attaching to a mount or part rests it on that target;
 * detaching (`none`) keeps the part exactly where it is in the world.
 */
export function attach(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  id: string,
  target: AttachTarget,
  assets: AssetBounds = {},
  shapeOf: ShapeOf = ownShape,
): AssemblyDocument {
  const part = doc.parts.find((p) => p.id === id)
  if (!part) return doc
  if (target.kind === 'part' && subtreeIds(doc, id).has(target.id)) return doc // would create a loop
  if (target.kind === 'none') {
    const pose = decompose(worldMatrix(doc, geo, id))
    return updatePart(doc, id, { parentId: null, mountId: null, ...pose })
  }
  const { position } = restingPose(doc, shapeOf(part), target, geo.plates[0]?.position[2] ?? 0, assets, shapeOf)
  return updatePart(doc, id, {
    parentId: target.kind === 'part' ? target.id : null,
    mountId: target.kind === 'mount' ? target.id : null,
    position: [...position],
    rotation: [...IDENTITY],
  })
}

/** Quaternion (x, y, z, w) → XYZ Euler angles in degrees (three.js order), and back. */
export function toEulerDeg(q: readonly [number, number, number, number]): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(...q), 'XYZ')
  const d = (r: number) => round((r * 180) / Math.PI, 1e-4)
  return [d(e.x), d(e.y), d(e.z)]
}

export function fromEulerDeg(deg: Vec3): [number, number, number, number] {
  const r = (d: number) => (d * Math.PI) / 180
  const q = new Quaternion().setFromEuler(new Euler(r(deg[0]), r(deg[1]), r(deg[2]), 'XYZ')).normalize()
  return [q.x, q.y, q.z, q.w]
}

/** Parts whose size is the user's own: not linked to a component, and a box or cylinder envelope. */
export const resizable = (p: AssemblyPart) => !p.componentId && (p.shape.type === 'box' || p.shape.type === 'cylinder')

/**
 * The envelope after a scale gizmo drag, rounded to 0.1 mm and kept within the saved
 * shape limits (0.1 mm – 3 m; cylinder radius ≤ 1.5 m). A cylinder stays round: its
 * radius follows the larger of the X and Y scales.
 */
export function scaledShape(shape: PartShape, [sx, sy, sz]: [number, number, number]): PartShape | null {
  const mm = (v: number, max: number) => Math.min(max, Math.max(1e-4, Math.round(v * 1e4) / 1e4))
  if (shape.type === 'box') return { type: 'box', size: [mm(shape.size[0] * sx, 3), mm(shape.size[1] * sy, 3), mm(shape.size[2] * sz, 3)] }
  if (shape.type === 'cylinder') return { type: 'cylinder', radius: mm(shape.radius * Math.max(sx, sy), 1.5), height: mm(shape.height * sz, 3) }
  return null
}
