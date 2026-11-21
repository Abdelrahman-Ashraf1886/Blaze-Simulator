import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCENE_BOUNDS,
  VIEW_DIRECTIONS,
  allOnScreen,
  boundingSphere,
  corners,
  presetPosition,
  type ViewPreset,
} from '../../src/three/views'

describe('view presets (Z-up, +X forward, +Y left)', () => {
  it('uses unit direction vectors', () => {
    for (const d of Object.values(VIEW_DIRECTIONS)) expect(Math.hypot(...d)).toBeCloseTo(1, 12)
  })

  it('puts each camera on the expected side of the target', () => {
    const { center } = boundingSphere(EMPTY_SCENE_BOUNDS)
    const rel = (p: ViewPreset) =>
      presetPosition(p, EMPTY_SCENE_BOUNDS).map((v, i) => v - center[i]!) as [number, number, number]
    const [tx, ty, tz] = rel('top')
    expect(tz).toBeGreaterThan(0) // above
    expect(Math.abs(tx) + Math.abs(ty)).toBeLessThan(tz * 0.01) // essentially straight down
    expect(tx).toBeLessThan(0) // nudged behind, so the nose points up the screen
    expect(rel('front')[0]).toBeGreaterThan(0) // in front of the nose
    expect(rel('right')[1]).toBeLessThan(0) // aircraft right is -Y
    const [ix, iy, iz] = rel('iso')
    expect(ix > 0 && iy < 0 && iz > 0).toBe(true)
  })

  it('places the camera several radii away', () => {
    const { center, radius } = boundingSphere(EMPTY_SCENE_BOUNDS)
    const p = presetPosition('iso', EMPTY_SCENE_BOUNDS)
    expect(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])).toBeCloseTo(radius * 4, 9)
  })
})

describe('bounds helpers', () => {
  it('computes the bounding sphere of a box', () => {
    const s = boundingSphere({ min: [-1, -2, 0], max: [1, 2, 4] })
    expect(s.center).toEqual([0, 0, 2])
    expect(s.radius).toBeCloseTo(Math.hypot(1, 2, 2), 12)
  })

  it('lists the eight corners', () => {
    const c = corners({ min: [0, 0, 0], max: [1, 2, 3] })
    expect(c).toHaveLength(8)
    expect(new Set(c.map((p) => p.join(','))).size).toBe(8)
    expect(c).toContainEqual([1, 2, 3])
  })

  it('detects points that fall off screen or behind the camera', () => {
    expect(allOnScreen([[0, 0, 0], [1, -1, 0.5]])).toBe(true)
    expect(allOnScreen([[1.01, 0, 0]])).toBe(false)
    expect(allOnScreen([[0, 0, 1.2]])).toBe(false)
  })
})
