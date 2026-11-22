/**
 * Body drag inputs (Phase 4.5; the force is applied in 4.6). Pure, ADR 0008.
 *
 * Model (plan "Aerodynamics")
 * - Body drag per body axis i ∈ {x, y, z}:
 *     F_b,i = −½ ρ C_d,i A_i v_b,i |v_b,i|,   v_b = Rᵀ v_world,   F_world = R F_b
 *   (engine-core/src/aero.rs). C_d,i is entered per axis (no source states it).
 * - A_i is DERIVED: the area of the union of the parts' collision shapes projected
 *   onto the plane normal to axis i (A_x on the Y–Z plane, A_y on X–Z, A_z on X–Y).
 *   - Each shape projects to a convex polygon: a box's 8 corners, a cylinder's two
 *     rim circles sampled at 128 points each (inscribed polygon; area low by
 *     1 − (N/2π)·sin(2π/N) ≈ 0.04 % per circle), a hull's points; then their convex
 *     hull.
 *   - The union is rasterised on a square grid of cell `h` (default 0.5 mm): a cell
 *     counts when its centre lies inside any polygon. The resolution error is
 *     estimated as |A(h) − A(2h)| and reported with the area.
 *   - Propeller discs are left out (labelled): rotor aerodynamics is not body drag.
 */
import { rotationMatrix, type CollisionShape, type Quat, type Vec3 } from './mass'

export interface AreaInput {
  id: string
  shape: CollisionShape
  /** Shape centre, body coordinates. */
  position: Vec3
  quaternion: Quat
  /** Propellers are left out of body drag. */
  propeller?: boolean
}

export interface ProjectedAreas {
  /** [A_x, A_y, A_z], m². */
  area: Vec3
  /** Estimated resolution error per axis, m² (|A(h) − A(2h)|). */
  error: Vec3
  /** Grid cell, m. */
  cell: number
  /** Ids of the shapes used (propellers excluded). */
  used: string[]
}

type P2 = [number, number]

const CIRCLE_POINTS = 128

/** Corner / rim / hull points of a shape in body coordinates. */
export function shapePoints(s: AreaInput): Vec3[] {
  const R = rotationMatrix(s.quaternion)
  const place = ([x, y, z]: Vec3): Vec3 => [
    R[0] * x + R[1] * y + R[2] * z + s.position[0],
    R[3] * x + R[4] * y + R[5] * z + s.position[1],
    R[6] * x + R[7] * y + R[8] * z + s.position[2],
  ]
  const sh = s.shape
  if (sh.type === 'box') {
    const [a, b, c] = sh.halfExtents
    const pts: Vec3[] = []
    for (const x of [-a, a]) for (const y of [-b, b]) for (const z of [-c, c]) pts.push(place([x, y, z]))
    return pts
  }
  if (sh.type === 'cylinder') {
    const pts: Vec3[] = []
    for (let k = 0; k < CIRCLE_POINTS; k++) {
      const t = (2 * Math.PI * k) / CIRCLE_POINTS
      const x = sh.radius * Math.cos(t)
      const y = sh.radius * Math.sin(t)
      pts.push(place([x, y, -sh.halfHeight]), place([x, y, sh.halfHeight]))
    }
    return pts
  }
  return sh.points.map(place)
}

/** Andrew's monotone chain; counter-clockwise, no collinear points. */
export function convexHull2(points: readonly P2[]): P2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: P2[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: P2[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Shoelace area of a simple polygon. */
export const polygonArea = (poly: readonly P2[]) =>
  Math.abs(poly.reduce((s, [x, y], i) => {
    const [u, v] = poly[(i + 1) % poly.length]!
    return s + x * v - u * y
  }, 0)) / 2

/** Area of the union of convex CCW polygons, rasterised with cell h (cell centres). */
export function unionArea(polys: readonly P2[][], h: number): number {
  const usable = polys.filter((p) => p.length >= 3)
  if (usable.length === 0) return 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of usable) for (const [x, y] of p) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / h))
  const ny = Math.max(1, Math.ceil((maxY - minY) / h))
  const hit = new Uint8Array(nx * ny)
  for (const poly of usable) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    const i0 = Math.max(0, Math.floor((x0 - minX) / h))
    const i1 = Math.min(nx - 1, Math.ceil((x1 - minX) / h))
    const j0 = Math.max(0, Math.floor((y0 - minY) / h))
    const j1 = Math.min(ny - 1, Math.ceil((y1 - minY) / h))
    for (let j = j0; j <= j1; j++) {
      const cy = minY + (j + 0.5) * h
      for (let i = i0; i <= i1; i++) {
        if (hit[j * nx + i]) continue
        const cx = minX + (i + 0.5) * h
        let inside = true
        for (let k = 0; k < poly.length && inside; k++) {
          const a = poly[k]!
          const b = poly[(k + 1) % poly.length]!
          if ((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) < 0) inside = false
        }
        if (inside) hit[j * nx + i] = 1
      }
    }
  }
  let n = 0
  for (const v of hit) n += v
  return n * h * h
}

/** Drop axis i: x → (y, z), y → (x, z), z → (x, y). */
const PLANES: [number, number][] = [
  [1, 2],
  [0, 2],
  [0, 1],
]

/** Projected areas A_x, A_y, A_z of the non-propeller shapes (header). */
export function projectedAreas(shapes: readonly AreaInput[], cell = 0.0005): ProjectedAreas {
  const used = shapes.filter((s) => !s.propeller)
  const pts = used.map(shapePoints)
  const area: number[] = []
  const error: number[] = []
  for (const [a, b] of PLANES) {
    const polys = pts.map((p) => convexHull2(p.map((q): P2 => [q[a]!, q[b]!])))
    const fine = unionArea(polys, cell)
    const coarse = unionArea(polys, 2 * cell)
    area.push(fine)
    error.push(Math.abs(fine - coarse))
  }
  return { area: area as Vec3, error: error as Vec3, cell, used: used.map((s) => s.id) }
}

/**
 * Drag force in world axes for a body velocity, as the engine computes it (reference
 * for the TS/Rust consistency test): v_b = Rᵀ v, F_b,i = −½ρ C_d,i A_i v_b,i|v_b,i|,
 * F = R F_b.
 */
export function bodyDragForce(rho: number, cd: Vec3, area: Vec3, q: Quat, vWorld: Vec3): Vec3 {
  const R = rotationMatrix(q)
  const vb: Vec3 = [
    R[0] * vWorld[0] + R[3] * vWorld[1] + R[6] * vWorld[2],
    R[1] * vWorld[0] + R[4] * vWorld[1] + R[7] * vWorld[2],
    R[2] * vWorld[0] + R[5] * vWorld[1] + R[8] * vWorld[2],
  ]
  const fb = vb.map((v, i) => -0.5 * rho * cd[i]! * area[i]! * v * Math.abs(v)) as Vec3
  return [
    R[0] * fb[0] + R[1] * fb[1] + R[2] * fb[2],
    R[3] * fb[0] + R[4] * fb[1] + R[5] * fb[2],
    R[6] * fb[0] + R[7] * fb[1] + R[8] * fb[2],
  ]
}
