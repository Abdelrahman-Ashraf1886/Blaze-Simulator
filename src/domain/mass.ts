/**
 * Mass properties of the drone: total mass, centre of mass (CoM), inertia tensor,
 * and the static hover thrust each motor must give. Pure (no React, three.js or
 * IPC), so every number here is unit tested against a hand calculation.
 *
 * Coordinates (ADR 0003): body = workshop world. +X forward, +Y left, +Z up,
 * metres, kilograms. Origin: frame centre, bottom of the centre plate.
 *
 * Model
 * - Each part is a rigid body whose centre of mass is the centre of its shape
 *   (part origins are shape centres, see assembly-ops.ts).
 * - Inertia of a part about its own centre, in its own axes:
 *   - box a × b × c (uniform solid):  Ixx = m(b² + c²)/12, Iyy = m(a² + c²)/12, Izz = m(a² + b²)/12
 *   - cylinder r, h, axis Z (uniform solid):  Ixx = Iyy = m(3r² + h²)/12, Izz = m r²/2
 *   - propeller of radius R: blades as thin uniform rods from the axis to the tip,
 *     averaged over a revolution:  Izz = m R²/3, Ixx = Iyy = m R²/6
 *     (a rod at angle φ in the disc gives m R² sin²φ / 3 about X; the mean of sin²φ is ½)
 *   - convex hull: its axis-aligned bounding box as a uniform solid box.
 *   These are labelled assumptions; a part's own entered tensor and CoM offset
 *   (`override`) replace them.
 * - In body axes: I_body = R · I_local · Rᵀ (R from the part's rotation).
 * - Totals: m = Σ mᵢ, CoM = Σ mᵢ rᵢ / Σ mᵢ,
 *   I_CoM = Σ [ I_bodyᵢ + mᵢ (|dᵢ|² E − dᵢ dᵢᵀ) ] with dᵢ = rᵢ − CoM (parallel axis theorem).
 * - Inertia components use the tensor sign convention: Ixy = −Σ m·x·y, stored as
 *   [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (the shared interface in plans/phase-4-physics.md).
 * - Parts without a mass are left out and listed: the CoM is then "incomplete".
 */

import type { Finding } from './checks'

export type Vec3 = [number, number, number]
/** Unit quaternion x, y, z, w (three.js order). */
export type Quat = [number, number, number, number]
/** Inertia tensor components [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] in kg·m². */
export type Inertia6 = [number, number, number, number, number, number]
/** Row-major 3 × 3 matrix. */
type Mat3 = [number, number, number, number, number, number, number, number, number]

export type CollisionShape =
  | { type: 'box'; halfExtents: Vec3 }
  /** Axis along the local Z. */
  | { type: 'cylinder'; radius: number; halfHeight: number }
  | { type: 'hull'; points: Vec3[] }

/** How a part's inertia about its own centre is modelled (see the header). */
export type InertiaModel = 'solid' | 'propeller'

/** A part as the mass calculation sees it, already placed in body coordinates. */
export interface BodyInput {
  id: string
  name: string
  /** null = not set: left out of the totals and listed as missing. */
  massKg: number | null
  model: InertiaModel
  shape: CollisionShape
  /** Shape centre (and so the part's centre of mass), body coordinates. */
  position: Vec3
  quaternion: Quat
  /**
   * The user's own inertia about the part's CoM in the part's axes, and the CoM's
   * offset from the shape centre (part axes). Replaces the shape-derived values.
   */
  override?: { inertia: Inertia6; comOffset: Vec3 } | null
}

export interface MotorInput {
  partId: string
  name: string
  /** Thrust point (the prop hub), body coordinates. */
  position: Vec3
  /** Unit thrust direction in body axes (includes motor tilt). */
  thrustAxis: Vec3
  /** As seen from above. */
  spin: 'cw' | 'ccw'
}

/** One body in the shared `VehicleDefinition` (plans/phase-4-physics.md). */
export interface PartBody {
  partId: string
  massKg: number
  com: Vec3
  /** About the part's own CoM, body axes. */
  inertia: Inertia6
  pose: { position: Vec3; quaternion: Quat }
  shape: CollisionShape
}

export interface MassProperties {
  /** Sum of the known masses. */
  totalMassKg: number
  /** null when no part has a mass. */
  com: Vec3 | null
  /** About `com`, body axes; null with `com`. */
  inertia: Inertia6 | null
  parts: PartBody[]
  /** Parts left out because their mass is not set. */
  missingMass: { id: string; name: string }[]
}

/** The JSON the engine's `vehicle.load` takes (plans/phase-4-physics.md, "Shared interface"). */
export interface VehicleDefinition {
  version: 1
  parts: PartBody[]
  motors: { partId: string; position: Vec3; thrustAxis: Vec3; spin: 'cw' | 'ccw' }[]
  totalMassKg: number
  com: Vec3
  inertia: Inertia6
  missingMass: string[]
}

/**
 * Standard acceleration of gravity, 9.80665 m/s² exactly: 3rd CGPM (1901),
 * declaration on the unit of mass and on the definition of weight; adopted in
 * ISO 80000-3. Used only to turn a mass into a weight.
 */
export const STANDARD_GRAVITY = 9.80665

// ---- small linear algebra -------------------------------------------------------

const ZERO6: Inertia6 = [0, 0, 0, 0, 0, 0]

const toMat = (i: Inertia6): Mat3 => [i[0], i[3], i[4], i[3], i[1], i[5], i[4], i[5], i[2]]
const fromMat = (m: Mat3): Inertia6 => [m[0], m[4], m[8], (m[1] + m[3]) / 2, (m[2] + m[6]) / 2, (m[5] + m[7]) / 2]

function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = []
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let v = 0
      for (let k = 0; k < 3; k++) v += a[i * 3 + k]! * b[k * 3 + j]!
      r.push(v)
    }
  return r as Mat3
}

const transpose = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]

/** Rotation matrix of a unit quaternion (x, y, z, w). */
export function rotationMatrix([x, y, z, w]: Quat): Mat3 {
  const n = Math.hypot(x, y, z, w) || 1
  const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n]
  return [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ]
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** A vector in part axes, expressed in body axes. */
function rotate(q: Quat, v: Vec3): Vec3 {
  const m = rotationMatrix(q)
  return [0, 1, 2].map((i) => m[i * 3]! * v[0] + m[i * 3 + 1]! * v[1] + m[i * 3 + 2]! * v[2]) as Vec3
}

const add6 = (a: Inertia6, b: Inertia6): Inertia6 => a.map((v, i) => v + b[i]!) as Inertia6

/** Inertia of a point mass m at offset d: m (|d|² E − d dᵀ). */
export function pointInertia(m: number, [x, y, z]: Vec3): Inertia6 {
  return [m * (y * y + z * z), m * (x * x + z * z), m * (x * x + y * y), -m * x * y, -m * x * z, -m * y * z]
}

// ---- per part -------------------------------------------------------------------

/** Inertia of a part about its own centre, in its own axes (formulas in the header). */
export function shapeInertia(shape: CollisionShape, m: number, model: InertiaModel): Inertia6 {
  if (model === 'propeller') {
    const r = shape.type === 'cylinder' ? shape.radius : halfSize(shape)[0]
    return [(m * r * r) / 6, (m * r * r) / 6, (m * r * r) / 3, 0, 0, 0]
  }
  if (shape.type === 'cylinder') {
    const r = shape.radius
    const h = shape.halfHeight * 2
    const side = (m * (3 * r * r + h * h)) / 12
    return [side, side, (m * r * r) / 2, 0, 0, 0]
  }
  const [a, b, c] = halfSize(shape).map((v) => v * 2) as Vec3
  return [(m * (b * b + c * c)) / 12, (m * (a * a + c * c)) / 12, (m * (a * a + b * b)) / 12, 0, 0, 0]
}

/** Half extents of a box, or of a hull's bounding box about the part origin's centre of bounds. */
function halfSize(shape: CollisionShape): Vec3 {
  if (shape.type === 'box') return shape.halfExtents
  if (shape.type === 'cylinder') return [shape.radius, shape.radius, shape.halfHeight]
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of shape.points) for (let i = 0; i < 3; i++) {
    lo[i] = Math.min(lo[i]!, p[i]!)
    hi[i] = Math.max(hi[i]!, p[i]!)
  }
  return shape.points.length ? (lo.map((v, i) => (hi[i]! - v) / 2) as Vec3) : [0, 0, 0]
}

/** A local tensor expressed in body axes: R · I · Rᵀ. */
export function rotateInertia(local: Inertia6, q: Quat): Inertia6 {
  const r = rotationMatrix(q)
  return fromMat(mul(mul(r, toMat(local)), transpose(r)))
}

// ---- totals ---------------------------------------------------------------------

export function massProperties(bodies: readonly BodyInput[]): MassProperties {
  const parts: PartBody[] = []
  const missingMass: { id: string; name: string }[] = []
  for (const b of bodies) {
    if (b.massKg === null || !(b.massKg > 0)) {
      missingMass.push({ id: b.id, name: b.name })
      continue
    }
    parts.push({
      partId: b.id,
      massKg: b.massKg,
      com: b.override ? add3(b.position, rotate(b.quaternion, b.override.comOffset)) : [...b.position],
      inertia: rotateInertia(b.override ? b.override.inertia : shapeInertia(b.shape, b.massKg, b.model), b.quaternion),
      pose: { position: [...b.position], quaternion: [...b.quaternion] },
      shape: b.shape,
    })
  }
  const total = parts.reduce((s, p) => s + p.massKg, 0)
  if (total <= 0) return { totalMassKg: 0, com: null, inertia: null, parts, missingMass }
  const com: Vec3 = [0, 1, 2].map((i) => parts.reduce((s, p) => s + p.massKg * p.com[i]!, 0) / total) as Vec3
  let inertia = ZERO6
  for (const p of parts) {
    const d: Vec3 = [p.com[0] - com[0], p.com[1] - com[1], p.com[2] - com[2]]
    inertia = add6(inertia, add6(p.inertia, pointInertia(p.massKg, d)))
  }
  return { totalMassKg: total, com, inertia, parts, missingMass }
}

/** The engine's vehicle definition; null while any mass is missing or there is no mass at all. */
export function vehicleDefinition(mp: MassProperties, motors: readonly MotorInput[]): VehicleDefinition | null {
  if (!mp.com || !mp.inertia || mp.missingMass.length > 0) return null
  return {
    version: 1,
    parts: mp.parts,
    motors: motors.map((m) => ({ partId: m.partId, position: m.position, thrustAxis: m.thrustAxis, spin: m.spin })),
    totalMassKg: mp.totalMassKg,
    com: mp.com,
    inertia: mp.inertia,
    missingMass: [],
  }
}

// ---- static hover balance -------------------------------------------------------

export interface HoverBalance {
  /** Thrust each motor must give to hover level, in newtons (same order as the input). */
  thrustN: number[]
  /** Each motor's thrust divided by the mean (1 = an even share). */
  share: number[]
  /** Weight to carry, m·g in newtons. */
  weightN: number
  /** false when no set of non-negative thrusts holds the drone level. */
  feasible: boolean
  reason: string | null
}

/**
 * Thrusts that hold the drone level and still: the vertical thrust components carry
 * the weight, and the roll and pitch moments about the CoM cancel:
 *
 *   Σ Tᵢ aᵢz = m g
 *   Σ Tᵢ [(rᵢ − CoM) × aᵢ]ₓ = 0
 *   Σ Tᵢ [(rᵢ − CoM) × aᵢ]ᵧ = 0
 *
 * With more than three motors there are many solutions; the one with the least
 * Σ Tᵢ² (T = Aᵀ (A Aᵀ)⁻¹ b) is the even split a mixer aims for. Yaw is not balanced
 * here: that needs each prop's drag torque (4.5). A negative thrust means the CoM is
 * outside what the motors can hold, so the drone cannot hover level at all.
 */
export function hoverBalance(motors: readonly MotorInput[], com: Vec3, massKg: number, g = STANDARD_GRAVITY): HoverBalance {
  const weightN = massKg * g
  const fail = (reason: string): HoverBalance => ({ thrustN: motors.map(() => NaN), share: motors.map(() => NaN), weightN, feasible: false, reason })
  if (motors.length < 3) return fail('At least three motors are needed to hold roll and pitch.')
  // Rows of A: vertical force, moment about X, moment about Y (per unit thrust of each motor).
  const rows = motors.map((m) => {
    const d: Vec3 = [m.position[0] - com[0], m.position[1] - com[1], m.position[2] - com[2]]
    const a = m.thrustAxis
    return [a[2], d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2]] as const
  })
  // A Aᵀ (3 × 3), then solve (A Aᵀ) y = b with b = [W, 0, 0].
  const aat: number[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i]! * r[j]!, 0)))
  const y = solve3(aat, [weightN, 0, 0])
  if (!y) return fail('The motors lie on one line, so roll or pitch cannot be held.')
  const thrustN = rows.map((r) => r[0] * y[0] + r[1] * y[1] + r[2] * y[2])
  const mean = thrustN.reduce((s, t) => s + t, 0) / thrustN.length
  const share = thrustN.map((t) => t / mean)
  const negative = thrustN.findIndex((t) => t < 0)
  if (negative >= 0) {
    return {
      thrustN,
      share,
      weightN,
      feasible: false,
      reason: `The centre of mass is outside the motors' support: ${motors[negative]!.name} would have to pull downwards.`,
    }
  }
  return { thrustN, share, weightN, feasible: true, reason: null }
}

/** Solves a 3 × 3 system by Cramer's rule; null when it is singular. */
function solve3(m: number[][], b: [number, number, number]): Vec3 | null {
  const det = (a: number[][]) =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
    a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
    a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!)
  const d = det(m)
  const scale = Math.max(...m.flat().map(Math.abs), 1e-300)
  if (Math.abs(d) <= 1e-12 * scale ** 3) return null
  return [0, 1, 2].map((c) => det(m.map((row, i) => row.map((v, j) => (j === c ? b[i]! : v)))) / d) as Vec3
}

/** Horizontal distance of the CoM from the frame centre (the body Z axis), in metres. */
export const horizontalOffset = (com: Vec3) => Math.hypot(com[0], com[1])

/**
 * Checks findings from the hover balance:
 * - error: no non-negative thrusts hold the drone level (CoM outside the motors);
 * - warning: a motor's share exceeds the mean by more than `tolerancePct` percent;
 * - cannot check: parts without a mass, so the CoM is incomplete.
 */
export function massFindings(
  mp: MassProperties,
  motors: readonly MotorInput[],
  hover: HoverBalance | null,
  tolerancePct: number,
): Finding[] {
  const out: Finding[] = []
  if (mp.missingMass.length > 0) {
    out.push({
      id: `hover-balance:missing:${mp.missingMass.map((m) => m.id).join(',')}`,
      rule: 'hover-balance',
      severity: 'cannot-check',
      message: `Hover balance needs every mass: ${mp.missingMass.map((m) => m.name).join(', ')} ${mp.missingMass.length === 1 ? 'has' : 'have'} none.`,
      partIds: mp.missingMass.map((m) => m.id).filter((id) => !id.startsWith('frame')),
    })
    return out
  }
  if (!hover) return out
  const ids = motors.map((m) => m.partId)
  if (!hover.feasible) {
    out.push({ id: 'hover-balance:infeasible', rule: 'hover-balance', severity: 'error', message: hover.reason ?? 'The drone cannot hover level.', partIds: ids })
    return out
  }
  const limit = 1 + tolerancePct / 100
  const heavy = motors.filter((_, i) => hover.share[i]! > limit)
  if (heavy.length > 0) {
    const worst = Math.max(...hover.share)
    out.push({
      id: `hover-balance:share:${heavy.map((m) => m.partId).join(',')}`,
      rule: 'hover-balance',
      severity: 'warning',
      message: `${heavy.map((m) => m.name).join(', ')} must give up to ${Math.round(worst * 100)} % of the mean hover thrust (your limit: ${100 + tolerancePct} %). Move the centre of mass towards the frame centre.`,
      partIds: heavy.map((m) => m.partId),
    })
  }
  return out
}
