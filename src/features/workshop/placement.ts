/**
 * Where a part may go: on what supports it, clear of the other parts.
 *
 * Rules (physical constraints first, convenience second)
 * - A part keeps its attachment (mount or parent part); placement only moves it within
 *   what supports it. It is never stacked onto another part it is not attached to.
 * - Supports, in the frame of what the part is attached to:
 *   - a motor mount: the mount pose itself; no other position (the motor's bolt pattern);
 *   - a plate mount, or free on the frame: resting on the plate face, its centre within
 *     the plate square;
 *   - a parent part: resting on the parent's top face, its centre within that face (a
 *     box's rectangle, a cylinder's disc).
 *   "Resting" means its bottom face is on the support's surface (unrotated parts only).
 * - Search: positions on a 5 mm grid of the support face (PLACEMENT_STEP_M), plus the preferred
 *   position, ordered by distance from the preferred position, then by angle from +X,
 *   then by x and y. The first one where the part (with everything attached to it) has
 *   no interference error is taken. Deterministic: the same document gives the same spot.
 * - When no position is free, placement fails with the reason. Nothing is moved silently
 *   and nothing is added.
 */
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'
import type { AssemblyDocument, AssemblyPart } from '../../../electron/ipc/contract'
import { overlapsBetween, type CollisionBody, type Overlap } from '../../domain/collisions'
import type { FrameGeometry } from '../../three/frame-geometry'
import { halfHeight, shapeExtent, subtreeIds, updatePart, worldMatrix, type AssetBounds } from './assembly-ops'
import { interferenceInput, interferenceSettings } from './interference-input'
import { effectiveShape, type ComponentIndex } from './links'

/** Search grid: 5 mm, the workshop's move snap (SNAP_MM in view-store.ts). */
export const PLACEMENT_STEP_M = 0.005

/** What a part rests on, in the frame of what it is attached to. */
export interface Support {
  /** For messages: "the top plate", "Motor 2 mount", "Battery 1". */
  label: string
  /** Only the mount pose is allowed (motor mounts). */
  fixed: boolean
  /** Centre height when resting on the support. */
  restZ: number
  /** Half size of the face's bounding rectangle (search area), and whether a centre fits. */
  half: [number, number]
  contains(x: number, y: number): boolean
}

export type PlaceResult = { ok: true; doc: AssemblyDocument; moved: boolean } | { ok: false; reason: string }

const unrotated = (p: AssemblyPart) => Math.abs(Math.abs(p.rotation[3]) - 1) < 1e-12
const square = (h: number) => (x: number, y: number) => Math.abs(x) <= h + 1e-12 && Math.abs(y) <= h + 1e-12

export function supportOf(doc: AssemblyDocument, geo: FrameGeometry, part: AssemblyPart, components: ComponentIndex, assets: AssetBounds): Support {
  const h = halfHeight(effectiveShape(part, components), assets)
  const plate = doc.frame.plateSize / 2
  if (part.parentId) {
    const parent = doc.parts.find((p) => p.id === part.parentId)
    if (parent) {
      const shape = effectiveShape(parent, components)
      const ext = shapeExtent(shape, assets) ?? [0, 0, 0]
      const restZ = ext[2] / 2 + h
      if (shape.type === 'cylinder') {
        const r = shape.radius
        return { label: parent.name, fixed: false, restZ, half: [r, r], contains: (x, y) => x * x + y * y <= r * r + 1e-12 }
      }
      const [hx, hy] = [ext[0] / 2, ext[1] / 2]
      return { label: parent.name, fixed: false, restZ, half: [hx, hy], contains: (x, y) => Math.abs(x) <= hx + 1e-12 && Math.abs(y) <= hy + 1e-12 }
    }
  }
  const motor = part.mountId ? geo.motors.find((m) => m.id === part.mountId) : undefined
  if (motor) return { label: `Motor ${motor.number} mount`, fixed: true, restZ: h, half: [0, 0], contains: (x, y) => x === 0 && y === 0 }
  if (part.mountId === 'plate-top' || part.mountId === 'plate-bottom') {
    return { label: part.mountId === 'plate-top' ? 'the top plate' : 'the bottom plate', fixed: false, restZ: h, half: [plate, plate], contains: square(plate) }
  }
  // Free: on top of the frame (its plate).
  return { label: 'the frame', fixed: false, restZ: doc.frame.armThickness + h, half: [plate, plate], contains: square(plate) }
}

/** Rotation of the frame the part's position is expressed in (its mount, parent or the world). */
function attachmentRotation(doc: AssemblyDocument, geo: FrameGeometry, part: AssemblyPart): Matrix3 {
  const local = new Matrix4().compose(new Vector3(...part.position), new Quaternion(...part.rotation), new Vector3(1, 1, 1))
  return new Matrix3().setFromMatrix4(worldMatrix(doc, geo, part.id).multiply(local.invert()))
}

interface Search {
  part: AssemblyPart
  support: Support
  moving: CollisionBody[]
  fixed: CollisionBody[]
  settings: Parameters<typeof overlapsBetween>[2]
  rotation: Matrix3
}

function prepare(doc: AssemblyDocument, geo: FrameGeometry, partId: string, components: ComponentIndex, assets: AssetBounds): Search | null {
  const part = doc.parts.find((p) => p.id === partId)
  if (!part) return null
  const input = interferenceInput(doc, geo, components, assets)
  const sub = subtreeIds(doc, partId)
  const s = interferenceSettings(doc)
  return {
    part,
    support: supportOf(doc, geo, part, components, assets),
    moving: input.bodies.filter((b) => sub.has(b.ownerId)),
    fixed: input.bodies.filter((b) => !sub.has(b.ownerId)),
    settings: { toleranceM: s.toleranceM, attached: input.attached, allowed: s.allowedPairs },
    rotation: attachmentRotation(doc, geo, part),
  }
}

/** Interference errors of the part (and what is attached to it) moved by (dx, dy) in its attachment frame. */
function errorsAt(s: Search, dx: number, dy: number): Overlap[] {
  const d = new Vector3(dx, dy, 0).applyMatrix3(s.rotation)
  const moved = s.moving.map((b) => ({ ...b, position: [b.position[0] + d.x, b.position[1] + d.y, b.position[2] + d.z] as CollisionBody['position'] }))
  return overlapsBetween(moved, s.fixed, s.settings).filter((o) => o.status === 'error')
}

/** Interference errors between the part (with what is attached to it) and everything else, where it is now. */
export function partErrors(doc: AssemblyDocument, geo: FrameGeometry, partId: string, components: ComponentIndex, assets: AssetBounds): Overlap[] {
  const s = prepare(doc, geo, partId, components, assets)
  return s ? errorsAt(s, 0, 0) : []
}

/** Candidate centres on the support face, in search order. */
export function candidates(support: Support, start: [number, number], step = PLACEMENT_STEP_M): [number, number][] {
  const out: [number, number][] = support.contains(start[0], start[1]) ? [start] : []
  const [kx, ky] = [Math.floor(support.half[0] / step + 1e-9), Math.floor(support.half[1] / step + 1e-9)]
  for (let i = -kx; i <= kx; i++)
    for (let j = -ky; j <= ky; j++) {
      const p: [number, number] = [i * step, j * step]
      if (support.contains(p[0], p[1]) && !(p[0] === start[0] && p[1] === start[1])) out.push(p)
    }
  const angle = (p: [number, number]) => {
    const a = Math.atan2(p[1] - start[1], p[0] - start[0])
    return a < 0 ? a + 2 * Math.PI : a
  }
  const dist = (p: [number, number]) => Math.hypot(p[0] - start[0], p[1] - start[1])
  const first = out[0] === start ? out.shift()! : null
  out.sort((a, b) => dist(a) - dist(b) || angle(a) - angle(b) || a[0] - b[0] || a[1] - b[1])
  return first ? [first, ...out] : out
}

const mmSize = (part: AssemblyPart, components: ComponentIndex, assets: AssetBounds) => {
  const e = shapeExtent(effectiveShape(part, components), assets)
  return e ? `${e.map((v) => Math.round(v * 1000)).join(' × ')} mm` : 'size unknown'
}

/**
 * Moves a part (with what is attached to it) to the nearest free position on its support,
 * starting from where it is. Fails, with the reason, when none is free.
 */
export function placeClear(doc: AssemblyDocument, geo: FrameGeometry, partId: string, components: ComponentIndex, assets: AssetBounds): PlaceResult {
  const s = prepare(doc, geo, partId, components, assets)
  if (!s) return { ok: false, reason: 'The part is not in the assembly.' }
  // An imported model whose size is not loaded yet cannot be checked ("cannot check" in Checks).
  if (s.moving.length === 0) return { ok: true, doc, moved: false }
  const { part, support } = s
  const fail = (why: string): PlaceResult => ({
    ok: false,
    reason: `No free spot on ${support.label} for ${part.name} (${mmSize(part, components, assets)}): ${why} Move or remove a part, or add it elsewhere.`,
  })
  if (support.fixed) {
    const errs = errorsAt(s, 0, 0)
    return errs.length === 0 ? { ok: true, doc, moved: false } : fail(`it would overlap ${errs.map((o) => (o.a === part.id ? o.bName : o.aName)).join(', ')} there, and a motor must sit on its mount.`)
  }
  const start: [number, number] = [part.position[0], part.position[1]]
  for (const [x, y] of candidates(support, start)) {
    if (errorsAt(s, x - start[0], y - start[1]).length > 0) continue
    if (x === start[0] && y === start[1]) return { ok: true, doc, moved: false }
    return { ok: true, doc: updatePart(doc, partId, { position: [x, y, part.position[2]] }), moved: true }
  }
  return fail('every position overlaps another part by more than your tolerance.')
}

/**
 * After a part's size changed (linked to a component, resized), keeps it and the parts
 * resting on it on their supports: a part that rested on its support before rests on it
 * after, and so does each unrotated child that rested on it. Rotated or lifted parts keep
 * their position.
 */
export function reseat(before: AssemblyDocument, after: AssemblyDocument, geo: FrameGeometry, partId: string, components: ComponentIndex, assets: AssetBounds): AssemblyDocument {
  let doc = after
  const fix = (id: string) => {
    const p0 = before.parts.find((p) => p.id === id)
    const p1 = doc.parts.find((p) => p.id === id)
    if (!p0 || !p1 || !unrotated(p1)) return
    const was = supportOf(before, geo, p0, components, assets).restZ
    const now = supportOf(doc, geo, p1, components, assets).restZ
    if (Math.abs(p0.position[2] - was) < 1e-6 && Math.abs(now - was) > 1e-12) {
      doc = updatePart(doc, id, { position: [p1.position[0], p1.position[1], now] })
    }
  }
  fix(partId)
  for (const c of doc.parts.filter((p) => p.parentId === partId)) fix(c.id)
  return doc
}

