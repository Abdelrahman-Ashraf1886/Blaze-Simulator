/**
 * Pure inspection helpers: world bounds of parts and of the whole assembly,
 * the exploded-view layout, and the assembly status counts. No WebGL, so all of
 * it is unit tested.
 */
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { AssemblyDocument, AssemblyPart } from '../../../electron/ipc/contract'
import type { FrameGeometry } from '../../three/frame-geometry'
import type { Bounds, Vec3 } from '../../three/views'
import { mountFrames, shapeExtent, type AssetBounds } from './assembly-ops'

/** World matrix of every part, computed once per document (parents before children). */
export function worldMatrices(doc: AssemblyDocument, geo: FrameGeometry): Map<string, Matrix4> {
  const byId = new Map(doc.parts.map((p) => [p.id, p]))
  const frames = mountFrames(geo)
  const out = new Map<string, Matrix4>()
  const one = new Vector3(1, 1, 1)
  const visit = (p: AssemblyPart, depth: number): Matrix4 => {
    const cached = out.get(p.id)
    if (cached) return cached
    let base: Matrix4
    const parent = p.parentId ? byId.get(p.parentId) : undefined
    if (parent && depth < doc.parts.length) base = visit(parent, depth + 1)
    else {
      const mount = !p.parentId && p.mountId ? frames.get(p.mountId) : undefined
      base = mount ? new Matrix4().compose(new Vector3(...mount.position), mount.quaternion, one) : new Matrix4()
    }
    const local = new Matrix4().compose(new Vector3(...p.position), new Quaternion(...p.rotation), one)
    const m = base.clone().multiply(local)
    out.set(p.id, m)
    return m
  }
  for (const p of doc.parts) visit(p, 0)
  return out
}

/** Axis-aligned world bounds of a box of size `extent` centred on the origin of `m`. */
export function boxBounds(m: Matrix4, extent: Vec3): Bounds {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const v = new Vector3()
  for (const sx of [-0.5, 0.5])
    for (const sy of [-0.5, 0.5])
      for (const sz of [-0.5, 0.5]) {
        v.set(sx * extent[0], sy * extent[1], sz * extent[2]).applyMatrix4(m)
        ;[v.x, v.y, v.z].forEach((c, i) => {
          min[i] = Math.min(min[i]!, c)
          max[i] = Math.max(max[i]!, c)
        })
      }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 }
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

/** World bounds of a part (a point at its origin when its size is unknown). */
export function partBounds(doc: AssemblyDocument, geo: FrameGeometry, id: string, assets: AssetBounds = {}): Bounds | null {
  const part = doc.parts.find((p) => p.id === id)
  const m = worldMatrices(doc, geo).get(id)
  if (!part || !m) return null
  return boxBounds(m, shapeExtent(part.shape, assets) ?? [0, 0, 0])
}

/** Bounds of the frame and every part: what "fit" frames when nothing is selected. */
export function assemblyBounds(doc: AssemblyDocument, geo: FrameGeometry, assets: AssetBounds = {}): Bounds {
  const matrices = worldMatrices(doc, geo)
  let b: Bounds = geo.bounds
  for (const p of doc.parts) {
    const m = matrices.get(p.id)
    if (m) b = unionBounds(b, boxBounds(m, shapeExtent(p.shape, assets) ?? [0, 0, 0]))
  }
  return b
}

/** Every frame mounting point a part can attach to, with its world position. */
export function mountPoints(geo: FrameGeometry): { id: string; label: string; position: Vec3 }[] {
  return [
    ...geo.motors.map((m) => ({ id: m.id, label: `Motor ${m.number} mount`, position: m.position })),
    ...geo.plates.map((p) => ({ id: p.id, label: p.name, position: p.position })),
  ]
}

/** Snap tolerance for dropping a dragged part onto a mount. */
export const MOUNT_SNAP_RADIUS = 0.015

/**
 * The mount a part dragged to `centre` (world) would attach to: the nearest one
 * within MOUNT_SNAP_RADIUS sideways (world XY) and within the part's half height
 * plus MOUNT_SNAP_RADIUS vertically, excluding the mount it is already on. A part
 * resting on a mount has its centre half its height above it, so it qualifies.
 */
export function snapMount(geo: FrameGeometry, centre: Vec3, halfHeight: number, exclude: string | null): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (const mp of mountPoints(geo)) {
    if (mp.id === exclude) continue
    const side = Math.hypot(centre[0] - mp.position[0], centre[1] - mp.position[1])
    const up = Math.abs(centre[2] - mp.position[2])
    if (side > MOUNT_SNAP_RADIUS || up > halfHeight + MOUNT_SNAP_RADIUS) continue
    const d = Math.hypot(side, up)
    if (d < bestD) {
      best = mp.id
      bestD = d
    }
  }
  return best
}

// ---- Exploded view -----------------------------------------------------------------

/** Distance at full spread, relative to the motor-to-motor diagonal. */
export const EXPLODE_SCALE = 0.3

/**
 * Exploded-view offset of one part, in the frame its position is expressed in.
 * - on a motor mount: outward along the arm (the mount's tilt is about the arm axis,
 *   so the arm direction is the same in the mount frame);
 * - on a plate mount: away from the plate (local +Z faces up on top, down below);
 * - on another part: lifted along the parent's local +Z, so each stack level separates;
 * - free: outward from the frame centre in plan, or straight up when near the centre.
 */
export function explodeOffset(part: AssemblyPart, geo: FrameGeometry, distance: number): Vec3 {
  if (part.parentId) return [0, 0, distance]
  const motor = part.mountId ? geo.motors.find((m) => m.id === part.mountId) : undefined
  if (motor) return [motor.armDirection[0] * distance, motor.armDirection[1] * distance, motor.armDirection[2] * distance]
  if (part.mountId && geo.plates.some((p) => p.id === part.mountId)) return [0, 0, distance]
  const [x, y] = part.position
  const r = Math.hypot(x, y)
  if (r < 0.01) return [0, 0, distance]
  return [(x / r) * distance, (y / r) * distance, 0]
}

/**
 * The document as displayed in exploded view. Display only: the result is never
 * saved, and the gizmo is hidden while it is shown so display offsets are never committed.
 */
export function explodedDoc(doc: AssemblyDocument, geo: FrameGeometry, spread: number): AssemblyDocument {
  if (spread <= 0) return doc
  const distance = spread * EXPLODE_SCALE * doc.frame.motorDiagonal
  return {
    ...doc,
    parts: doc.parts.map((p) => {
      const o = explodeOffset(p, geo, distance)
      return { ...p, position: [p.position[0] + o[0], p.position[1] + o[1], p.position[2] + o[2]] }
    }),
  }
}

// ---- Status --------------------------------------------------------------------------

export interface AssemblyStatus {
  parts: number
  /** Parts not attached to a mount or another part. */
  unattached: string[]
  noMass: string[]
  /** Model parts whose file is missing, failed to display, or carries an import warning. */
  modelIssues: string[]
}

export function assemblyStatus(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  assets: Readonly<Record<string, { warnings: string[] }>>,
  failed: ReadonlySet<string>,
  /** Whether a part has a mass (its own, or a linked component's). Defaults to the part's own. */
  hasMass: (p: AssemblyPart) => boolean = (p) => p.mass !== null,
): AssemblyStatus {
  const mounts = new Set([...geo.motors.map((m) => m.id), ...geo.plates.map((p) => p.id)])
  return {
    parts: doc.parts.length,
    unattached: doc.parts.filter((p) => p.parentId === null && !(p.mountId && mounts.has(p.mountId))).map((p) => p.id),
    noMass: doc.parts.filter((p) => !hasMass(p)).map((p) => p.id),
    modelIssues: doc.parts
      .filter((p) => {
        if (p.shape.type !== 'model') return false
        const a = assets[p.shape.assetId]
        return !a || a.warnings.length > 0 || failed.has(p.shape.assetId)
      })
      .map((p) => p.id),
  }
}

// ---- Measure ---------------------------------------------------------------------------

/** Pixels within which a measure click snaps to a mesh vertex (with snapping on). */
export const VERTEX_SNAP_PX = 8

/** The candidate whose screen position is nearest the pointer, if within `maxPx`. */
export function nearestOnScreen(
  candidates: readonly { world: Vec3; screen: readonly [number, number] }[],
  pointer: readonly [number, number],
  maxPx: number = VERTEX_SNAP_PX,
): Vec3 | null {
  let best: Vec3 | null = null
  let bestD = maxPx
  for (const c of candidates) {
    const d = Math.hypot(c.screen[0] - pointer[0], c.screen[1] - pointer[1])
    if (d <= bestD) {
      best = c.world
      bestD = d
    }
  }
  return best
}

export interface Measurement {
  distanceMm: number
  deltaMm: Vec3
}

export function measure(a: Vec3, b: Vec3): Measurement {
  const d: Vec3 = [(b[0] - a[0]) * 1000, (b[1] - a[1]) * 1000, (b[2] - a[2]) * 1000]
  return { distanceMm: Math.hypot(...d), deltaMm: d }
}
