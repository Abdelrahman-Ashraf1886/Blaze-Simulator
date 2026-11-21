/**
 * Camera view maths for the workshop viewport. Pure functions over plain
 * tuples so they are unit-testable without WebGL.
 *
 * World frame: right-handed, Z-up, metres; +X forward (nose), +Y left.
 */
export type Vec3 = readonly [number, number, number]
export type ViewPreset = 'top' | 'front' | 'right' | 'iso'
export type Projection = 'perspective' | 'orthographic'

export interface Bounds {
  min: Vec3
  max: Vec3
}

const normalize = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n]
}

export const VIEW_LABELS: Record<ViewPreset, string> = {
  top: 'Top',
  front: 'Front',
  right: 'Right',
  iso: 'Iso',
}

/** Unit vectors pointing from the target towards the camera. */
export const VIEW_DIRECTIONS: Record<ViewPreset, Vec3> = {
  // Straight down. The tiny -X offset keeps the nose (+X) at the top of the screen.
  top: normalize([-0.001, 0, 1]),
  // In front of the nose, looking back along -X.
  front: [1, 0, 0],
  // The aircraft's right side is -Y.
  right: [0, -1, 0],
  // Front-right, above.
  iso: normalize([1, -1, 1]),
}

/**
 * Region framed while the assembly is empty: a 600 × 600 × 150 mm build area
 * on the ground plane. A viewing default, not a component specification.
 */
export const EMPTY_SCENE_BOUNDS: Bounds = { min: [-0.3, -0.3, 0], max: [0.3, 0.3, 0.15] }

export function boundingSphere(b: Bounds): { center: Vec3; radius: number } {
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  const radius = Math.hypot(b.max[0] - center[0], b.max[1] - center[1], b.max[2] - center[2])
  return { center, radius }
}

/** Camera position for a preset: on the preset direction, a few radii from the centre. */
export function presetPosition(preset: ViewPreset, b: Bounds): Vec3 {
  const { center, radius } = boundingSphere(b)
  const d = VIEW_DIRECTIONS[preset]
  const dist = Math.max(radius, 1e-3) * 4
  return [center[0] + d[0] * dist, center[1] + d[1] * dist, center[2] + d[2] * dist]
}

/** All eight corners of an axis-aligned box. */
export function corners(b: Bounds): Vec3[] {
  const out: Vec3[] = []
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z])
  return out
}

/** True when every projected point (normalised device coordinates) lies on screen. */
export function allOnScreen(ndc: readonly Vec3[]): boolean {
  return ndc.every(([x, y, z]) => Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1)
}
