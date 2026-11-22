/**
 * Workshop interference check: which parts' collision shapes overlap at their
 * workshop poses, and by how much. Pure (no React, three.js or IPC), so every
 * case is unit tested.
 *
 * Shapes and poses are the ones `mass.ts` uses (the shared `CollisionShape`):
 * box, cylinder (axis = local Z) and convex hull, placed in body coordinates
 * (ADR 0003, metres). A propeller's shape is its swept disc, a cylinder of the
 * prop's radius and thickness.
 *
 * Method
 * - Overlap depth is the penetration depth: the shortest distance one shape must
 *   move so the two only touch (the minimum translation distance). Touching
 *   shapes have depth 0; separated shapes have none.
 * - All three shapes are convex, so the depth is the distance from the origin to
 *   the boundary of the Minkowski difference A − B. GJK (Gilbert–Johnson–Keerthi)
 *   finds whether the origin is inside it; EPA (expanding polytope) then grows a
 *   polytope inside A − B towards its nearest face. Both only use each shape's
 *   support function, so they are exact for boxes and hulls and converge to
 *   EPA_TOLERANCE for the round side of a cylinder.
 * - A bounding sphere per shape skips pairs that cannot touch.
 *
 * Rules
 * - Bodies of one owner never collide with each other (the frame is a plate and
 *   arms; they are one rigid part).
 * - An overlap deeper than the user's tolerance is an error, except:
 *   - between a part and what it is attached to (a motor on its pad, a prop on its
 *     motor): parent–child contact is how parts are mounted;
 *   - for a pair the user allowed.
 * - Two propellers are not compared here: the `prop-clearance` rule (checks.ts)
 *   already reports overlapping discs, with the tip gap.
 */

import type { Finding } from './checks'
import type { CollisionShape, Quat, Vec3 } from './mass'
import { rotationMatrix } from './mass'

/** One collision shape placed in body coordinates. */
export interface CollisionBody {
  /** Unique per body, e.g. a part id or `frame:arm-2`. */
  id: string
  /** The part this shape belongs to (several bodies may share one, like the frame's plate and arms). */
  ownerId: string
  /** The owner's name, as findings show it. */
  name: string
  /** Propellers are compared by `prop-clearance`, not here. */
  propeller: boolean
  shape: CollisionShape
  position: Vec3
  quaternion: Quat
}

export interface InterferenceSettings {
  /** Overlaps up to this depth (metres) are accepted. */
  toleranceM: number
  /** Owner pairs that are attached to each other (child, parent): contact is allowed. */
  attached: readonly (readonly [string, string])[]
  /** Owner pairs the user allowed to overlap. */
  allowed: readonly (readonly [string, string])[]
}

export type OverlapStatus = 'error' | 'attached' | 'allowed'

/** The deepest overlap between two owners. */
export interface Overlap {
  /** Owner ids, sorted. */
  a: string
  b: string
  aName: string
  bName: string
  /** Body ids involved (to highlight the exact plate or arm). */
  bodies: string[]
  depthM: number
  /** Unit direction to move `b` out of `a`, body axes. */
  normal: Vec3
  status: OverlapStatus
}

/** EPA stops when the nearest face can no longer move out by more than this (m). */
export const EPA_TOLERANCE = 1e-9
/** A point this close to a face's plane (m, per metre of size) is taken as on it. */
const VISIBLE_EPS = 1e-12

// ---- vectors ------------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]]

// ---- support functions --------------------------------------------------------------------

/** A shape placed in the body frame, with its support function and bounding sphere. */
interface Placed {
  center: Vec3
  radius: number
  support(d: Vec3): Vec3
}

function localSupport(shape: CollisionShape, d: Vec3): Vec3 {
  if (shape.type === 'box') {
    const h = shape.halfExtents
    return [d[0] >= 0 ? h[0] : -h[0], d[1] >= 0 ? h[1] : -h[1], d[2] >= 0 ? h[2] : -h[2]]
  }
  if (shape.type === 'cylinder') {
    const r = Math.hypot(d[0], d[1])
    const z = d[2] >= 0 ? shape.halfHeight : -shape.halfHeight
    return r > 0 ? [(shape.radius * d[0]) / r, (shape.radius * d[1]) / r, z] : [0, 0, z]
  }
  let best = shape.points[0] ?? [0, 0, 0]
  let bestDot = -Infinity
  for (const p of shape.points) {
    const v = dot(p, d)
    if (v > bestDot) {
      bestDot = v
      best = p
    }
  }
  return best
}

function boundingRadius(shape: CollisionShape): number {
  if (shape.type === 'box') return norm(shape.halfExtents)
  if (shape.type === 'cylinder') return Math.hypot(shape.radius, shape.halfHeight)
  return shape.points.reduce((m, p) => Math.max(m, norm(p)), 0)
}

function place(b: CollisionBody): Placed {
  const m = rotationMatrix(b.quaternion)
  const toBody = (v: Vec3): Vec3 => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
  const toLocal = (v: Vec3): Vec3 => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ]
  return {
    center: b.position,
    radius: boundingRadius(b.shape),
    support: (d) => add(b.position, toBody(localSupport(b.shape, toLocal(d)))),
  }
}

// ---- GJK ----------------------------------------------------------------------------------

/** Support point of the Minkowski difference A − B. */
const cso = (a: Placed, b: Placed) => (d: Vec3): Vec3 => sub(a.support(d), b.support(neg(d)))

/** Closest point to the origin on a simplex, and the smallest sub-simplex that holds it. */
function closest(s: Vec3[]): { v: Vec3; s: Vec3[] } {
  if (s.length === 1) return { v: s[0]!, s }
  if (s.length === 2) return segment(s[0]!, s[1]!)
  if (s.length === 3) return triangle(s[0]!, s[1]!, s[2]!)
  return tetrahedron(s[0]!, s[1]!, s[2]!, s[3]!)
}

function segment(a: Vec3, b: Vec3): { v: Vec3; s: Vec3[] } {
  const ab = sub(b, a)
  const den = dot(ab, ab)
  const t = den > 0 ? -dot(a, ab) / den : 0
  if (t <= 0) return { v: a, s: [a] }
  if (t >= 1) return { v: b, s: [b] }
  return { v: add(a, scale(ab, t)), s: [a, b] }
}

/** Ericson, Real-Time Collision Detection (2005), 5.1.5, with p = origin. */
function triangle(a: Vec3, b: Vec3, c: Vec3): { v: Vec3; s: Vec3[] } {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = neg(a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return { v: a, s: [a] }
  const bp = neg(b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return { v: b, s: [b] }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return { v: add(a, scale(ab, d1 / (d1 - d3))), s: [a, b] }
  const cp = neg(c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return { v: c, s: [c] }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return { v: add(a, scale(ac, d2 / (d2 - d6))), s: [a, c] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return { v: add(b, scale(sub(c, b), w)), s: [b, c] }
  }
  const den = va + vb + vc
  if (den === 0) return segment(a, b) // degenerate (collinear) triangle
  return { v: add(a, add(scale(ab, vb / den), scale(ac, vc / den))), s: [a, b, c] }
}

function tetrahedron(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { v: Vec3; s: Vec3[] } {
  const faces: [Vec3, Vec3, Vec3, Vec3][] = [[a, b, c, d], [a, c, d, b], [a, d, b, c], [b, d, c, a]]
  const volume = dot(sub(d, a), cross(sub(b, a), sub(c, a)))
  const size = Math.max(norm(sub(b, a)), norm(sub(c, a)), norm(sub(d, a)))
  const flat = Math.abs(volume) <= 1e-12 * size ** 3
  let best: { v: Vec3; s: Vec3[] } | null = null
  for (const [p, q, r, o] of faces) {
    // The origin is outside a face when it lies on the other side from the fourth vertex.
    const n = cross(sub(q, p), sub(r, p))
    if (!flat && -dot(n, p) * dot(n, sub(o, p)) >= 0) continue
    const t = triangle(p, q, r)
    if (!best || dot(t.v, t.v) < dot(best.v, best.v)) best = t
  }
  return best ?? { v: [0, 0, 0], s: [a, b, c, d] }
}

/**
 * GJK on A − B. Returns null when the shapes are apart (or only touch), otherwise
 * a simplex of A − B that contains the origin (1 to 4 points).
 */
function gjk(support: (d: Vec3) => Vec3, start: Vec3): Vec3[] | null {
  let v = support(norm(start) > 0 ? start : [1, 0, 0])
  let s: Vec3[] = [v]
  for (let i = 0; i < 64; i++) {
    const vv = dot(v, v)
    if (vv <= 1e-24) return s
    const w = support(neg(v))
    // No support point beyond the origin along −v: A − B lies on v's side, so the shapes are apart.
    if (dot(w, v) >= 0) return null
    // Converged on a positive distance.
    if (vv - dot(v, w) <= 1e-12 * vv) return null
    if (s.some((p) => p[0] === w[0] && p[1] === w[1] && p[2] === w[2])) return null
    const r = closest([...s, w])
    s = r.s
    v = r.v
    if (s.length === 4) return s
  }
  return s
}

// ---- EPA ----------------------------------------------------------------------------------

interface Face {
  i: [number, number, number]
  n: Vec3
  d: number
}

/** Expands a GJK simplex to a tetrahedron of A − B that still contains the origin. */
function blowUp(support: (d: Vec3) => Vec3, s: Vec3[]): Vec3[] | null {
  const pts = [...s]
  const tryAdd = (dirs: Vec3[], ok: (p: Vec3) => boolean) => {
    for (const d of dirs) {
      if (norm(d) === 0) continue
      const p = support(d)
      if (ok(p)) {
        pts.push(p)
        return true
      }
    }
    return false
  }
  const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]]
  if (pts.length === 1 && !tryAdd(axes, (p) => norm(sub(p, pts[0]!)) > 1e-12)) return null
  if (pts.length === 2) {
    const dir = sub(pts[1]!, pts[0]!)
    const k = [0, 1, 2].reduce((m, i) => (Math.abs(dir[i]!) < Math.abs(dir[m]!) ? i : m), 0)
    const e: Vec3 = [0, 0, 0]
    e[k] = 1
    const p1 = cross(dir, e)
    const p2 = cross(dir, p1)
    const off = (p: Vec3) => norm(cross(sub(p, pts[0]!), dir)) > 1e-12 * norm(dir)
    if (!tryAdd([p1, neg(p1), p2, neg(p2)], off)) return null
  }
  if (pts.length === 3) {
    const n = cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!))
    const l = norm(n)
    if (l === 0 || !tryAdd([n, neg(n)], (p) => Math.abs(dot(sub(p, pts[0]!), n)) > 1e-12 * l * Math.max(norm(sub(p, pts[0]!)), 1e-12))) return null
  }
  return pts
}

/** A face with its outward unit normal; `away` is a point on the inner side (the tetrahedron's fourth vertex). */
function face(pts: Vec3[], i: number, j: number, k: number, away?: Vec3): Face | null {
  const a = pts[i]!
  let n = cross(sub(pts[j]!, a), sub(pts[k]!, a))
  const l = norm(n)
  if (l === 0) return null
  let idx: [number, number, number] = [i, j, k]
  if (away && dot(n, sub(away, a)) > 0) {
    n = neg(n)
    idx = [i, k, j]
  }
  const un = scale(n, 1 / l)
  return { i: idx, n: un, d: dot(un, a) }
}

/** Penetration depth and direction from a tetrahedron of A − B around the origin. */
function epa(support: (d: Vec3) => Vec3, tetra: Vec3[]): { depth: number; normal: Vec3 } {
  const pts = [...tetra]
  const [p0, p1, p2, p3] = tetra as [Vec3, Vec3, Vec3, Vec3]
  let faces = [face(pts, 0, 1, 2, p3), face(pts, 0, 1, 3, p2), face(pts, 0, 2, 3, p1), face(pts, 1, 2, 3, p0)].filter(
    (f): f is Face => f !== null,
  )
  if (faces.length < 4) return { depth: 0, normal: [0, 0, 1] }
  let best = faces[0]!
  for (let iter = 0; iter < 256 && faces.length > 0; iter++) {
    best = faces.reduce((m, f) => (f.d < m.d ? f : m), faces[0]!)
    const p = support(best.n)
    if (dot(p, best.n) - best.d <= EPA_TOLERANCE) break
    pts.push(p)
    const pi = pts.length - 1
    // Remove every face that sees the new point; its open rim (edges used once) is the horizon.
    // New faces keep the removed faces' winding, so they face outward too. A face whose plane
    // holds the point counts as seen: otherwise the new face on its edge would fold back over it
    // (box faces make this the usual case, not a rare one).
    const eps = VISIBLE_EPS * Math.max(norm(p), 1)
    const edges = new Map<string, [number, number]>()
    const keep: Face[] = []
    for (const f of faces) {
      if (dot(f.n, sub(p, pts[f.i[0]]!)) > -eps) {
        for (const [u, w] of [[f.i[0], f.i[1]], [f.i[1], f.i[2]], [f.i[2], f.i[0]]] as [number, number][]) {
          const back = `${w},${u}`
          if (edges.has(back)) edges.delete(back)
          else edges.set(`${u},${w}`, [u, w])
        }
      } else keep.push(f)
    }
    for (const [u, w] of edges.values()) {
      const f = face(pts, u, w, pi)
      if (f) keep.push(f)
    }
    faces = keep
  }
  return { depth: Math.max(best.d, 0), normal: best.n }
}

/**
 * Penetration depth of two placed shapes (metres) and the unit direction to move
 * `b` out of `a`; null when they are apart or only touch.
 */
export function penetration(a: CollisionBody, b: CollisionBody): { depthM: number; normal: Vec3 } | null {
  const pa = place(a)
  const pb = place(b)
  if (norm(sub(pa.center, pb.center)) > pa.radius + pb.radius) return null
  const support = cso(pa, pb)
  const simplex = gjk(support, sub(pa.center, pb.center))
  if (!simplex) return null
  const tetra = simplex.length === 4 ? simplex : blowUp(support, simplex)
  // A flat Minkowski difference (a zero-size shape on a face) has no depth.
  if (!tetra) return null
  const { depth, normal } = epa(support, tetra)
  // Moving B by t moves A − B by −t, so B leaves along the outward normal of the nearest face.
  return depth > EPA_TOLERANCE ? { depthM: depth, normal } : null
}

/**
 * Lowest z of a set of placed shapes (body coordinates): the support point of each shape
 * along −Z. Exact for boxes, cylinders and hulls. Used to release a drop test from a
 * stated clearance above the ground.
 */
export function lowestPoint(bodies: readonly Pick<CollisionBody, 'shape' | 'position' | 'quaternion'>[]): number {
  let low = Infinity
  for (const b of bodies) low = Math.min(low, place(b as CollisionBody).support([0, 0, -1])[2])
  return low
}

// ---- pairs and findings -------------------------------------------------------------------

const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/**
 * Every overlap between bodies of different owners, as the deepest per owner pair.
 * Overlaps of depth up to the tolerance are left out; deeper ones carry their
 * status (error, or why they are accepted).
 */
export function interferences(bodies: readonly CollisionBody[], settings: InterferenceSettings): Overlap[] {
  const attached = new Set(settings.attached.map(([a, b]) => key(a, b)))
  const allowed = new Set(settings.allowed.map(([a, b]) => key(a, b)))
  const byPair = new Map<string, Overlap>()
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      let x = bodies[i]!
      let y = bodies[j]!
      if (x.ownerId === y.ownerId || (x.propeller && y.propeller)) continue
      if (y.ownerId < x.ownerId) [x, y] = [y, x]
      const hit = penetration(x, y)
      if (!hit || hit.depthM <= settings.toleranceM) continue
      const k = key(x.ownerId, y.ownerId)
      const prev = byPair.get(k)
      const bodiesInvolved = [...new Set([...(prev?.bodies ?? []), x.id, y.id])]
      if (prev && prev.depthM >= hit.depthM) {
        prev.bodies = bodiesInvolved
        continue
      }
      byPair.set(k, {
        a: x.ownerId,
        b: y.ownerId,
        aName: x.name,
        bName: y.name,
        bodies: bodiesInvolved,
        depthM: hit.depthM,
        normal: hit.normal,
        status: attached.has(k) ? 'attached' : allowed.has(k) ? 'allowed' : 'error',
      })
    }
  return [...byPair.values()].sort((p, q) => q.depthM - p.depthM || p.a.localeCompare(q.a) || p.b.localeCompare(q.b))
}

/**
 * Overlaps between bodies that move together (`moving`) and the rest (`fixed`), deeper
 * than the tolerance, with their status. Pairs within each set are not compared (a part
 * moved with what is attached to it keeps those contacts). Used to search for a free spot.
 */
export function overlapsBetween(moving: readonly CollisionBody[], fixed: readonly CollisionBody[], settings: InterferenceSettings): Overlap[] {
  const movingIds = new Set(moving.map((b) => b.ownerId))
  const others = fixed.filter((b) => !movingIds.has(b.ownerId))
  const attached = new Set(settings.attached.map(([a, b]) => key(a, b)))
  const allowed = new Set(settings.allowed.map(([a, b]) => key(a, b)))
  const out: Overlap[] = []
  for (const m of moving)
    for (const f of others) {
      if (m.propeller && f.propeller) continue
      const [x, y] = f.ownerId < m.ownerId ? [f, m] : [m, f]
      const hit = penetration(x, y)
      if (!hit || hit.depthM <= settings.toleranceM) continue
      const k = key(x.ownerId, y.ownerId)
      out.push({
        a: x.ownerId,
        b: y.ownerId,
        aName: x.name,
        bName: y.name,
        bodies: [x.id, y.id],
        depthM: hit.depthM,
        normal: hit.normal,
        status: attached.has(k) ? 'attached' : allowed.has(k) ? 'allowed' : 'error',
      })
    }
  return out
}

const mm = (m: number) => String(Math.round(m * 10_000) / 10)

/** Checks findings: one error per owner pair overlapping deeper than the tolerance. */
export function interferenceFindings(overlaps: readonly Overlap[], toleranceM: number, frameId = 'frame'): Finding[] {
  return overlaps
    .filter((o) => o.status === 'error')
    .map((o) => [o, [o.aName, o.bName].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))] as const)
    .map(([o, [first, second]]) => ({
      id: `interference:${o.a},${o.b}`,
      rule: 'interference' as const,
      severity: 'error' as const,
      message: `${first} and ${second} overlap by ${mm(o.depthM)} mm (your tolerance: ${mm(toleranceM)} mm). Move one of them, or allow this pair if the overlap is intended.`,
      partIds: [o.a, o.b].filter((id) => id !== frameId),
    }))
}
