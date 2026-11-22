/**
 * Plan test 4 (collision detection): overlap / no overlap for each pair of shape
 * types, tolerance edges, attached and allowed pairs. Every depth is worked by hand
 * in the comment above its case.
 */
import { describe, expect, it } from 'vitest'
import { RULES } from '../../src/domain/checks'
import { interferenceFindings, interferences, penetration, type CollisionBody, type InterferenceSettings } from '../../src/domain/collisions'
import { rotationMatrix, type CollisionShape, type Quat, type Vec3 } from '../../src/domain/mass'

const I: Quat = [0, 0, 0, 1]
const aboutZ = (deg: number): Quat => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)]
const body = (id: string, shape: CollisionShape, position: Vec3 = [0, 0, 0], quaternion: Quat = I, extra: Partial<CollisionBody> = {}): CollisionBody => ({
  id,
  ownerId: id,
  name: id.toUpperCase(),
  propeller: false,
  shape,
  position,
  quaternion,
  ...extra,
})
const box = (h: Vec3): CollisionShape => ({ type: 'box', halfExtents: h })
const cyl = (radius: number, halfHeight: number): CollisionShape => ({ type: 'cylinder', radius, halfHeight })
/** Regular octahedron |x| + |y| + |z| ≤ a, as a hull of its six vertices. */
const octa = (a: number): CollisionShape => ({ type: 'hull', points: [[a, 0, 0], [-a, 0, 0], [0, a, 0], [0, -a, 0], [0, 0, a], [0, 0, -a]] })

const cube20 = box([0.02, 0.02, 0.02])

/** Each case: two shapes overlapping by a hand-worked depth, then the same pair moved apart. */
/**
 * `curved`: the contact is on a cylinder's round side, where EPA approximates the surface by
 * facets. Its depth is still within EPA_TOLERANCE, but the normal only to about √(2·tol/r).
 */
const cases: { name: string; a: CollisionBody; b: (gap: number) => CollisionBody; depth: number; normal?: Vec3; curved?: boolean }[] = [
  // Faces 40 mm apart at contact; B 1 mm closer → 1 mm along X.
  { name: 'box–box', a: body('a', cube20), b: (g) => body('b', cube20, [0.04 - 0.001 + g, 0, 0]), depth: 0.001, normal: [1, 0, 0] },
  // A cube turned 45° about Z has a vertical edge at x = 0.02·√2; B's face (half 10 mm) 1 mm inside it.
  {
    name: 'rotated box–box',
    a: body('a', cube20, [0, 0, 0], aboutZ(45)),
    b: (g) => body('b', box([0.01, 0.01, 0.01]), [0.02 * Math.SQRT2 + 0.01 - 0.001 + g, 0, 0]),
    depth: 0.001,
    normal: [1, 0, 0],
  },
  // Box face at x = 20 mm; cylinder (r 10 mm, axis Z) centred 28.5 mm away → 1.5 mm.
  { name: 'box–cylinder', a: body('a', cube20), b: (g) => body('b', cyl(0.01, 0.02), [0.0285 + g, 0, 0]), depth: 0.0015, normal: [1, 0, 0] },
  // Two r 10 mm discs (half height 5 mm) side by side on a diagonal, centres 18 mm apart → 2 mm radially
  // (less than the 10 mm axial overlap).
  {
    name: 'cylinder–cylinder (side)',
    a: body('a', cyl(0.01, 0.005)),
    b: (g) => body('b', cyl(0.01, 0.005), [(0.018 + g) / Math.SQRT2, (0.018 + g) / Math.SQRT2, 0]),
    depth: 0.002,
  },
  // Coaxial, stacked: half heights 5 mm, centres 9.5 mm apart → 0.5 mm.
  { name: 'cylinder–cylinder (stacked)', a: body('a', cyl(0.01, 0.005)), b: (g) => body('b', cyl(0.008, 0.005), [0, 0, 0.0095 + g]), depth: 0.0005, normal: [0, 0, 1] },
  // Octahedron tip at x = 20 mm pokes 1 mm into the face of a 20 mm cube centred at 29 mm.
  { name: 'hull–box', a: body('a', octa(0.02)), b: (g) => body('b', box([0.01, 0.01, 0.01]), [0.029 + g, 0, 0]), depth: 0.001, normal: [1, 0, 0] },
  // The same tip 1 mm inside the round side of a cylinder (r 10 mm) centred at 29 mm.
  { name: 'hull–cylinder', a: body('a', octa(0.02)), b: (g) => body('b', cyl(0.01, 0.01), [0.029 + g, 0, 0]), depth: 0.001, normal: [1, 0, 0], curved: true },
  // Two octahedra a = 20 mm, centres 39 mm apart. A − B is the octahedron a = 40 mm around (−39, 0, 0) mm;
  // the origin is (40 − 39) mm / √3 from its nearest faces x ± y ± z = 40 mm.
  { name: 'hull–hull', a: body('a', octa(0.02)), b: (g) => body('b', octa(0.02), [0.039 + g, 0, 0]), depth: 0.001 / Math.sqrt(3) },
]

describe('penetration depth (GJK + EPA) for each pair of shape types', () => {
  for (const c of cases) {
    it(`${c.name}: overlap depth equals the hand value; apart and touching give none`, () => {
      const hit = penetration(c.a, c.b(0))
      expect(hit).not.toBeNull()
      expect(hit!.depthM).toBeCloseTo(c.depth, 7)
      if (c.normal) c.normal.forEach((v, i) => expect(hit!.normal[i]).toBeCloseTo(v, c.curved ? 3 : 9))
      // Symmetric: swapping the shapes gives the same depth.
      expect(penetration(c.b(0), c.a)!.depthM).toBeCloseTo(c.depth, 7)
      // 1 mm beyond contact: apart.
      expect(penetration(c.a, c.b(c.depth * (c.name === 'hull–hull' ? Math.sqrt(3) : 1) + 0.001))).toBeNull()
    })
  }

  it('random box pairs (also as hulls): the depth equals the separating-axis minimum over the 15 candidate axes', () => {
    // For two boxes the minimum translation is along a face normal or a cross product of two
    // edges, so the least overlap over those 15 axes is the exact depth (Gottschalk et al. 1996).
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const quat = (): Quat => {
      const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]
      const n = Math.hypot(...q)
      return q.map((v) => v / n) as Quat
    }
    const axesOf = (q: Quat): Vec3[] => {
      const m = rotationMatrix(q)
      return [0, 1, 2].map((j) => [m[j]!, m[3 + j]!, m[6 + j]!] as Vec3)
    }
    let overlapping = 0
    for (let n = 0; n < 300; n++) {
      const ha: Vec3 = [0.005 + rnd() * 0.03, 0.005 + rnd() * 0.03, 0.001 + rnd() * 0.03]
      const hb: Vec3 = [0.005 + rnd() * 0.03, 0.005 + rnd() * 0.03, 0.001 + rnd() * 0.03]
      // Every fourth pair axis-aligned: the degenerate, coplanar case of the workshop.
      const qa = n % 4 === 0 ? I : quat()
      const qb = n % 4 === 0 ? I : quat()
      const t: Vec3 = [(rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06]
      const A = axesOf(qa)
      const B = axesOf(qb)
      const cand: Vec3[] = [...A, ...B]
      for (const u of A) for (const v of B) {
        const c: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        const l = Math.hypot(...c)
        if (l > 1e-6) cand.push(c.map((x) => x / l) as Vec3)
      }
      const d = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
      const sat = Math.min(
        ...cand.map((L) => A.reduce((s, ax, i) => s + ha[i]! * Math.abs(d(ax, L)), 0) + B.reduce((s, ax, i) => s + hb[i]! * Math.abs(d(ax, L)), 0) - Math.abs(d(t, L))),
      )
      const hit = penetration(body('a', box(ha), [0, 0, 0], qa), body('b', box(hb), t, qb))
      if (sat > 1e-9) {
        overlapping++
        expect(hit, `pair ${n}`).not.toBeNull()
        expect(Math.abs(hit!.depthM - sat), `pair ${n}`).toBeLessThan(1e-8)
        // The same box given as the hull of its 8 corners.
        const corners: Vec3[] = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x * ha[0], y * ha[1], z * ha[2]] as Vec3)))
        const asHull = penetration(body('a', { type: 'hull', points: corners }, [0, 0, 0], qa), body('b', box(hb), t, qb))
        expect(Math.abs(asHull!.depthM - sat), `hull pair ${n}`).toBeLessThan(1e-8)
      } else if (sat < -1e-9) expect(hit, `pair ${n}`).toBeNull()
    }
    expect(overlapping).toBeGreaterThan(100)
  })

  it('touching faces have no depth', () => {
    expect(penetration(body('a', cube20), body('b', cube20, [0.04, 0, 0]))).toBeNull()
    expect(penetration(body('a', cyl(0.01, 0.005)), body('b', cyl(0.01, 0.005), [0, 0, 0.01]))).toBeNull()
  })

  it('a shape deep inside another: the depth is the shortest way out', () => {
    // 10 mm cube at the centre of a 40 mm cube: it leaves through the nearest face, 20 + 10 mm.
    expect(penetration(body('a', cube20), body('b', box([0.01, 0.01, 0.01])))!.depthM).toBeCloseTo(0.03, 9)
    // Offset 5 mm in +Y: the nearest exit is now +Y, 20 − 5 + 10 = 25 mm.
    const off = penetration(body('a', cube20), body('b', box([0.01, 0.01, 0.01]), [0, 0.005, 0]))!
    expect(off.depthM).toBeCloseTo(0.025, 9)
    expect(off.normal[1]).toBeCloseTo(1, 9)
  })

  it('a thin plate (zero thickness) still overlaps what it passes through', () => {
    const plate = body('a', box([0.05, 0.05, 0]))
    expect(penetration(plate, body('b', cube20, [0, 0, 0.015]))!.depthM).toBeCloseTo(0.005, 9)
  })
})

describe('interference pairs: tolerance, attached and allowed pairs', () => {
  const settings = (over: Partial<InterferenceSettings> = {}): InterferenceSettings => ({ toleranceM: 0, attached: [], allowed: [], ...over })
  const a = body('a', cube20)
  const b = body('b', cube20, [0.039, 0, 0]) // 1 mm overlap (box–box case above)

  it('tolerance edges: an overlap up to the tolerance passes, deeper is an error', () => {
    expect(interferences([a, b], settings({ toleranceM: 0.001 + 1e-6 }))).toEqual([])
    const over = interferences([a, b], settings({ toleranceM: 0.001 - 1e-6 }))
    expect(over.map((o) => [o.a, o.b, o.status])).toEqual([['a', 'b', 'error']])
    expect(over[0]!.depthM).toBeCloseTo(0.001, 9)
  })

  it('attached (parent–child) and user-allowed pairs are accepted, in either order', () => {
    expect(interferences([a, b], settings({ attached: [['b', 'a']] }))[0]!.status).toBe('attached')
    expect(interferences([a, b], settings({ allowed: [['b', 'a']] }))[0]!.status).toBe('allowed')
    expect(interferenceFindings(interferences([a, b], settings({ allowed: [['a', 'b']] })), 0)).toEqual([])
  })

  it('bodies of one owner never collide; two propellers are left to prop-clearance', () => {
    const plate = body('frame:plate', box([0.05, 0.05, 0.002]), [0, 0, 0.002], I, { ownerId: 'frame', name: 'Frame' })
    const arm = body('frame:arm-1', box([0.05, 0.005, 0.002]), [0.08, 0, 0.002], I, { ownerId: 'frame', name: 'Frame' })
    expect(interferences([plate, arm], settings())).toEqual([])
    const p1 = body('p1', cyl(0.1, 0.005), [0, 0, 0.05], I, { propeller: true })
    const p2 = body('p2', cyl(0.1, 0.005), [0.15, 0, 0.05], I, { propeller: true })
    expect(interferences([p1, p2], settings())).toEqual([])
  })

  it('one finding per owner pair: the deepest of its bodies, naming both and listing every body involved', () => {
    const plate = body('frame:plate', box([0.05, 0.05, 0.002]), [0, 0, 0.002], I, { ownerId: 'frame', name: 'Frame' })
    const arm = body('frame:arm-1', box([0.05, 0.005, 0.002]), [0.1, 0, 0.002], I, { ownerId: 'frame', name: 'Frame' })
    // A battery over the plate edge and the arm root, 3 mm into the tops of both.
    const battery = body('bat', box([0.02, 0.01, 0.01]), [0.05, 0, 0.004 + 0.01 - 0.003], I, { name: 'Battery' })
    const over = interferences([plate, arm, battery], settings({ toleranceM: 0.0005 }))
    expect(over).toHaveLength(1)
    expect(over[0]!.depthM).toBeCloseTo(0.003, 9)
    expect(over[0]!.bodies.sort()).toEqual(['bat', 'frame:arm-1', 'frame:plate'])
    const f = interferenceFindings(over, 0.0005)
    expect(f).toEqual([
      {
        id: 'interference:bat,frame',
        rule: 'interference',
        severity: 'error',
        message: 'Battery and Frame overlap by 3 mm (your tolerance: 0.5 mm). Move one of them, or allow this pair if the overlap is intended.',
        // The frame is not a selectable part.
        partIds: ['bat'],
      },
    ])
    expect(RULES[f[0]!.rule]).toMatch(/tolerance/)
  })

  it('pass and fail: apart parts give no finding, overlapping ones an error', () => {
    expect(interferenceFindings(interferences([a, body('b', cube20, [0.05, 0, 0])], settings()), 0)).toEqual([])
    expect(interferenceFindings(interferences([a, b], settings()), 0).map((f) => f.severity)).toEqual(['error'])
  })
})
