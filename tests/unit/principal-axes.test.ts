/**
 * `principalAxes` (src/domain/mass.ts): the Jacobi eigen-decomposition of the inertia tensor, the same method
 * and conventions as the engine's `principal_axes` (engine-core vehicle.rs, whose tests cover the same cases).
 * The sidecar reports only totals (mass, CoM, tensor), not principal moments, so there is no direct
 * engine-side value to compare with: these tests use the closed form (a box rotated by a known quaternion).
 */
import { describe, expect, it } from 'vitest'
import { principalAxes, rotateInertia, rotationMatrix, shapeInertia, type Inertia6, type Quat, type Vec3 } from '../../src/domain/mass'

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const apply = (i: Inertia6, v: Vec3): Vec3 => [
  i[0] * v[0] + i[3] * v[1] + i[4] * v[2],
  i[3] * v[0] + i[1] * v[1] + i[5] * v[2],
  i[4] * v[0] + i[5] * v[1] + i[2] * v[2],
]
const quat = ([x, y, z]: Vec3, angle: number): Quat => [x * Math.sin(angle / 2), y * Math.sin(angle / 2), z * Math.sin(angle / 2), Math.cos(angle / 2)]

/** A e = λ e for each axis, unit axes, orthogonal, right-handed. */
function expectDecomposition(i: Inertia6, tol = 1e-12) {
  const { moments, axes } = principalAxes(i)
  const scale = Math.max(...moments.map(Math.abs))
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(dot(axes[k]!, axes[k]!) - 1)).toBeLessThan(tol)
    const ae = apply(i, axes[k]!)
    for (let c = 0; c < 3; c++) expect(Math.abs(ae[c]! - moments[k]! * axes[k]![c]!)).toBeLessThan(tol * scale)
  }
  expect(Math.abs(dot(axes[0], axes[1]))).toBeLessThan(tol)
  const e3 = cross(axes[0], axes[1])
  for (let c = 0; c < 3; c++) expect(Math.abs(e3[c]! - axes[2][c]!)).toBeLessThan(tol)
  return { moments, axes }
}

describe('principalAxes', () => {
  it('a diagonal tensor: its entries ascending, the body axes (permuted, right-handed)', () => {
    const { moments, axes } = expectDecomposition([3, 1, 2, 0, 0, 0])
    expect(moments).toEqual([1, 2, 3])
    expect(axes.map((a) => a.map(Math.abs))).toEqual([[0, 1, 0], [0, 0, 1], [1, 0, 0]])
  })

  it('a box rotated by a known quaternion: the box’s moments, the rotated axes (closed form)', () => {
    const local = shapeInertia({ type: 'box', halfExtents: [0.05, 0.02, 0.01] }, 0.4, 'solid') // (b²+c²), (a²+c²), (a²+b²) · m/12
    const q = quat([1, 2, 3].map((v) => v / Math.hypot(1, 2, 3)) as Vec3, 0.9)
    const { moments, axes } = expectDecomposition(rotateInertia(local, q))
    const sorted = [local[0], local[1], local[2]].sort((a, b) => a - b)
    moments.forEach((m, k) => expect(Math.abs(m - sorted[k]!)).toBeLessThan(1e-15))
    // Each principal axis is ± the rotated box axis of the same moment: R e_j.
    const r = rotationMatrix(q)
    const column = (j: number): Vec3 => [r[j]!, r[3 + j]!, r[6 + j]!]
    axes.forEach((axis, k) => {
      const j = [local[0], local[1], local[2]].indexOf(sorted[k]!)
      expect(Math.abs(Math.abs(dot(axis, column(j))) - 1)).toBeLessThan(1e-12)
    })
  })

  it('is right-handed and reconstructs the tensor, also for repeated and tiny moments', () => {
    const q = quat([0, 1, 0], 0.4)
    for (const scale of [1, 1e-3, 1e-6, 1e-9]) {
      for (const d of [[1, 2, 3], [4, 4, 6], [4, 6, 6], [5, 5, 5]]) {
        const i = rotateInertia([d[0]! * scale, d[1]! * scale, d[2]! * scale, 0, 0, 0], quat([1, 0, 0], 0.9)) // a tilted frame
        const t = rotateInertia(i, q)
        const { moments } = expectDecomposition(t, 1e-9)
        moments.forEach((m, k) => expect(Math.abs(m - d[k]! * scale)).toBeLessThan(1e-13 * scale * 6))
        expect(moments[0]).toBeLessThanOrEqual(moments[1])
        expect(moments[1]).toBeLessThanOrEqual(moments[2])
      }
    }
  })
})
