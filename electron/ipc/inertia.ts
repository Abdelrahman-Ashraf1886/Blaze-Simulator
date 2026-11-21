/**
 * Physical validity of an inertia tensor, shared by IPC validation (main) and the
 * inspector (renderer). Pure.
 *
 * A real body's inertia tensor about any point, in any orthonormal axes:
 * - is positive definite (every leading principal minor > 0), and
 * - satisfies the triangle inequality on its diagonal: Ixx + Iyy ≥ Izz and the two
 *   other pairs (Ixx = ∫(y² + z²) dm etc., so any two sum to at least the third).
 * Components are [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] with the tensor sign convention.
 */
export type Inertia6 = [number, number, number, number, number, number]

/** Relative slack for rounding in user-entered values. */
const SLACK = 1e-9

/** null when the tensor can belong to a real body, otherwise the reason it cannot. */
export function inertiaProblem(i: readonly number[]): string | null {
  if (i.length !== 6 || i.some((v) => !Number.isFinite(v))) return 'Inertia needs six finite numbers.'
  const [xx, yy, zz, xy, xz, yz] = i as Inertia6
  if (xx <= 0 || yy <= 0 || zz <= 0) return 'Ixx, Iyy and Izz must be positive.'
  const scale = Math.max(xx, yy, zz)
  if (xx + yy < zz - SLACK * scale || xx + zz < yy - SLACK * scale || yy + zz < xx - SLACK * scale) {
    return 'No real body has these moments: each of Ixx, Iyy, Izz must be at most the sum of the other two.'
  }
  const m2 = xx * yy - xy * xy
  const m3 = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz)
  if (m2 <= 0 || m3 <= 0) return 'The products of inertia are too large for these moments (the tensor is not positive definite).'
  return null
}
