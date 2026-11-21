/**
 * Placing an imported model in the Z-up, metre world frame.
 *
 * A model file has its own length unit and up axis. glTF 2.0 specifies metres and
 * +Y up; CAD exports are often millimetres and/or +Z up, so both are chosen per part.
 * Conversion, applied to a file point p:
 *   1. p − c       centre the file's bounding box on the part origin (c = box centre)
 *   2. R · (…)     Y-up files: +90° about X, so file +Y → world +Z and file +Z → world −Y.
 *                  Z-up files: identity.
 *   3. s · (…)     s = metres per file unit (m: 1, mm: 0.001, in: 0.0254 exactly)
 * Part origins sit at the centre of the shape, like boxes and cylinders, so a model
 * rests on a mount the same way.
 */
import type { Bounds3, ModelUnits, UpAxis } from '../../electron/ipc/contract'
import type { Vec3 } from './views'

export const UNIT_SCALE: Record<ModelUnits, number> = { m: 1, mm: 0.001, in: 0.0254 }
export const UNIT_LABELS: Record<ModelUnits, string> = { m: 'Metres', mm: 'Millimetres', in: 'Inches' }

const S = Math.SQRT1_2
/** Rotation (x, y, z, w) from the file's axes to the world's. */
export const UP_ROTATION: Record<UpAxis, [number, number, number, number]> = {
  y: [S, 0, 0, S],
  z: [0, 0, 0, 1],
}

export interface ModelPlacement {
  /** File-space offset that puts the bounding-box centre at the origin. */
  offset: Vec3
  rotation: [number, number, number, number]
  scale: number
  /** Size of the placed model along world X, Y, Z in metres. */
  extent: Vec3
}

export function placeModel(bounds: Bounds3, units: ModelUnits, upAxis: UpAxis): ModelPlacement {
  const { min, max } = bounds
  const scale = UNIT_SCALE[units]
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const extent: Vec3 = upAxis === 'y' ? [size[0], size[2], size[1]] : size
  return {
    offset: [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2],
    rotation: UP_ROTATION[upAxis],
    scale,
    extent: [extent[0] * scale, extent[1] * scale, extent[2] * scale],
  }
}

/** Applies the placement to a file point (for tests and for checking a mapping). */
export function placePoint(p: Vec3, pl: ModelPlacement): Vec3 {
  const c: Vec3 = [p[0] + pl.offset[0], p[1] + pl.offset[1], p[2] + pl.offset[2]]
  const r: Vec3 = pl.rotation[0] !== 0 ? [c[0], -c[2], c[1]] : c
  return [r[0] * pl.scale, r[1] * pl.scale, r[2] * pl.scale]
}
