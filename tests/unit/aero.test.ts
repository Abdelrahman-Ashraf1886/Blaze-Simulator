/** Body drag inputs (src/domain/aero.ts): projected areas and the drag force. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bodyDragForce, convexHull2, polygonArea, projectedAreas, unionArea, type AreaInput } from '../../src/domain/aero'
import type { Quat, Vec3 } from '../../src/domain/mass'

const box = (id: string, half: Vec3, position: Vec3 = [0, 0, 0], quaternion: Quat = [0, 0, 0, 1]): AreaInput => ({
  id,
  shape: { type: 'box', halfExtents: half },
  position,
  quaternion,
})
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * b)

describe('polygons', () => {
  it('convex hull and shoelace area of a square with an interior point', () => {
    const h = convexHull2([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])
    expect(h).toHaveLength(4)
    expect(polygonArea(h)).toBe(1)
  })
  it('union of overlapping squares counts the overlap once', () => {
    const a: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const b: [number, number][] = [[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1]]
    near(unionArea([a, b], 0.001), 1.5, 0.002)
  })
})

describe('projected areas (hand cases)', () => {
  it('an axis-aligned box: A_x = b·c, A_y = a·c, A_z = a·b', () => {
    const r = projectedAreas([box('b', [0.05, 0.1, 0.15])])
    near(r.area[0], 0.2 * 0.3)
    near(r.area[1], 0.1 * 0.3)
    near(r.area[2], 0.1 * 0.2)
    expect(r.cell).toBe(0.0005)
    expect(r.used).toEqual(['b'])
  })
  it('two boxes overlapping by half count their union, not their sum', () => {
    const r = projectedAreas([box('a', [0.05, 0.05, 0.05]), box('b', [0.05, 0.05, 0.05], [0.05, 0, 0])])
    near(r.area[2], 0.15 * 0.1)
    near(r.area[0], 0.1 * 0.1) // seen along x the two coincide
  })
  it('a cylinder along z: A_z = π r², A_x = A_y = 2r·h', () => {
    const r = projectedAreas([{ id: 'c', shape: { type: 'cylinder', radius: 0.05, halfHeight: 0.01 }, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }])
    near(r.area[2], Math.PI * 0.05 ** 2)
    near(r.area[0], 0.1 * 0.02)
  })
  it('a box yawed 45°: the side views widen to (a + b)/√2', () => {
    const s = Math.sin(Math.PI / 8)
    const r = projectedAreas([box('b', [0.05, 0.1, 0.15], [0, 0, 0], [0, 0, s, Math.cos(Math.PI / 8)])])
    near(r.area[2], 0.1 * 0.2)
    near(r.area[0], ((0.1 + 0.2) / Math.SQRT2) * 0.3)
  })
  it('propeller discs are left out', () => {
    const prop: AreaInput = { id: 'p', shape: { type: 'cylinder', radius: 0.17, halfHeight: 0.004 }, position: [0, 0, 0.05], quaternion: [0, 0, 0, 1], propeller: true }
    const r = projectedAreas([box('b', [0.05, 0.05, 0.05]), prop])
    expect(r.used).toEqual(['b'])
    near(r.area[2], 0.01)
  })
  it('reports a resolution error from the half-resolution grid', () => {
    const r = projectedAreas([{ id: 'c', shape: { type: 'cylinder', radius: 0.05, halfHeight: 0.01 }, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }])
    r.error.forEach((e) => expect(e).toBeGreaterThanOrEqual(0))
    expect(Math.abs(r.area[2] - Math.PI * 0.05 ** 2)).toBeLessThan(5 * Math.max(r.error[2], 1e-7))
  })
})

describe('drag force (same model as engine-core/src/aero.rs)', () => {
  it('hand case along x, and a yawed body using its side area', () => {
    const f = bodyDragForce(1.225, [1.1, 1.2, 1.3], [0.02, 0.03, 0.08], [0, 0, 0, 1], [10, 0, 0])
    expect(f[0]).toBeCloseTo(-1.3475, 12)
    const s = Math.SQRT1_2
    const g = bodyDragForce(1.225, [1.1, 1.2, 1.3], [0.02, 0.03, 0.08], [0, 0, s, s], [10, 0, 0])
    expect(g[0]).toBeCloseTo(-0.5 * 1.225 * 1.2 * 0.03 * 100, 12)
  })
  it('reproduces the shared fixture that engine-core also checks', () => {
    const f = JSON.parse(readFileSync(join(__dirname, '../fixtures/aero-cases.json'), 'utf8')) as {
      cases: { rho: number; cd: Vec3; area: Vec3; q: Quat; v: Vec3; expected: Vec3 }[]
    }
    expect(f.cases.length).toBeGreaterThanOrEqual(10)
    for (const c of f.cases) {
      const got = bodyDragForce(c.rho, c.cd, c.area, c.q, c.v)
      got.forEach((x, i) => expect(Math.abs(x - c.expected[i]!)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(c.expected[i]!))))
      // Drag never adds energy.
      expect(got[0] * c.v[0] + got[1] * c.v[1] + got[2] * c.v[2]).toBeLessThanOrEqual(0)
    }
  })
})
