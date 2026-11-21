/**
 * Mass properties against hand calculations. Each expected value is worked out in
 * the comment above it, from the formulas in src/domain/mass.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  hoverBalance,
  massProperties,
  rotateInertia,
  shapeInertia,
  vehicleDefinition,
  type BodyInput,
  type MotorInput,
  type Vec3,
} from '../../src/domain/mass'

const ID: [number, number, number, number] = [0, 0, 0, 1]
const box = (id: string, massKg: number | null, position: Vec3, size: Vec3, quaternion = ID): BodyInput => ({
  id,
  name: id,
  massKg,
  model: 'solid',
  shape: { type: 'box', halfExtents: size.map((v) => v / 2) as Vec3 },
  position,
  quaternion,
})
const point = (id: string, massKg: number, position: Vec3) => box(id, massKg, position, [0, 0, 0])
const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)))

describe('part inertia', () => {
  it('uniform box: m(b²+c²)/12 …', () => {
    // m = 0.5 kg, 0.14 × 0.045 × 0.035 m:
    // Ixx = 0.5 (0.045² + 0.035²)/12 = 0.5 × 0.00325 / 12 = 1.3541667e-4
    // Iyy = 0.5 (0.14² + 0.035²)/12  = 0.5 × 0.020825 / 12 = 8.6770833e-4
    // Izz = 0.5 (0.14² + 0.045²)/12  = 0.5 × 0.021625 / 12 = 9.0104167e-4
    const i = shapeInertia({ type: 'box', halfExtents: [0.07, 0.0225, 0.0175] }, 0.5, 'solid')
    close(i[0], 1.3541666666666666e-4)
    close(i[1], 8.677083333333333e-4)
    close(i[2], 9.010416666666667e-4)
    expect(i.slice(3)).toEqual([0, 0, 0])
  })

  it('uniform cylinder about its axis and across it', () => {
    // m = 0.098 kg, r = 0.0185 m, h = 0.0275 m:
    // Izz = m r²/2 = 0.098 × 3.4225e-4 / 2 = 1.677025e-5
    // Ixx = m (3r² + h²)/12 = 0.098 × (1.02675e-3 + 7.5625e-4)/12 = 0.098 × 1.783e-3 / 12 = 1.4561167e-5
    const i = shapeInertia({ type: 'cylinder', radius: 0.0185, halfHeight: 0.01375 }, 0.098, 'solid')
    close(i[2], 1.677025e-5)
    close(i[0], 1.4561166666666667e-5)
    close(i[1], i[0])
  })

  it('propeller: thin rods to the tip, averaged over a turn', () => {
    // m = 0.012 kg, R = 0.127 m: Izz = m R²/3 = 0.012 × 0.016129 / 3 = 6.4516e-5; Ixx = Iyy = half = 3.2258e-5
    const i = shapeInertia({ type: 'cylinder', radius: 0.127, halfHeight: 0.004 }, 0.012, 'propeller')
    close(i[2], 6.4516e-5)
    close(i[0], 3.2258e-5)
    close(i[1], 3.2258e-5)
  })

  it('a rotated part: 90° about Z swaps Ixx and Iyy; 45° gives a product of inertia', () => {
    const local = shapeInertia({ type: 'box', halfExtents: [0.1, 0.02, 0.01] }, 1, 'solid')
    const q90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
    const r = rotateInertia(local, q90)
    close(r[0], local[1])
    close(r[1], local[0])
    close(r[2], local[2])
    // 45°: R = [[c, −s], [s, c]] with c = s = √½.
    // (R I Rᵀ)₀₀ = c² Ixx + s² Iyy = (Ixx + Iyy)/2;  (R I Rᵀ)₀₁ = c s Ixx − s c Iyy = (Ixx − Iyy)/2.
    const q45: [number, number, number, number] = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]
    const r45 = rotateInertia(local, q45)
    close(r45[0], (local[0] + local[1]) / 2)
    close(r45[3], (local[0] - local[1]) / 2)
  })
})

describe('totals', () => {
  it('CoM = Σ mᵢ rᵢ / Σ mᵢ for two point masses', () => {
    // 1 kg at x = 0, 3 kg at x = 0.1: CoM x = 0.3 / 4 = 0.075
    const mp = massProperties([point('a', 1, [0, 0, 0]), point('b', 3, [0.1, 0, 0])])
    expect(mp.totalMassKg).toBe(4)
    close(mp.com![0], 0.075)
    // Iyy = Izz about the CoM = 1 × 0.075² + 3 × 0.025² = 0.005625 + 0.001875 = 0.0075; Ixx = 0
    close(mp.inertia![1], 0.0075)
    close(mp.inertia![2], 0.0075)
    close(mp.inertia![0], 0)
  })

  it('moving the battery 30 mm forward moves the CoM by 30 mm × m_batt / m_total', () => {
    // Frame 0.3 kg at the origin, battery 0.5 kg at z = −0.02. Total 0.8 kg.
    // Battery moved to x = 0.03: CoM x = 0.5 × 0.03 / 0.8 = 0.01875 m exactly.
    const frame = box('frame', 0.3, [0, 0, 0.002], [0.1, 0.1, 0.004])
    const before = massProperties([frame, box('batt', 0.5, [0, 0, -0.02], [0.14, 0.045, 0.035])])
    const after = massProperties([frame, box('batt', 0.5, [0.03, 0, -0.02], [0.14, 0.045, 0.035])])
    close(before.com![0], 0)
    close(after.com![0], 0.01875)
    close(after.com![2], before.com![2])
    // Parallel-axis change in Izz: the battery is 0.03 × 0.3/0.8 = 0.01125 m from the new CoM,
    // the frame 0.01875 m: ΔIzz = 0.5 × 0.01125² + 0.3 × 0.01875² = 6.328125e-5 + 1.0546875e-4 = 1.6875e-4
    close(after.inertia![2] - before.inertia![2], 1.6875e-4, 1e-9)
    // Product of inertia appears: Ixz = −Σ m dx dz.
    // dz: CoM z = (0.3 × 0.002 + 0.5 × −0.02)/0.8 = −0.01175; frame dz = 0.01375, battery dz = −0.00825.
    // Ixz = −(0.3 × (−0.01875)(0.01375) + 0.5 × (0.01125)(−0.00825)) = 7.734375e-5 + 4.640625e-5 = 1.2375e-4
    close(after.inertia![4], 1.2375e-4, 1e-9)
  })

  it('changing a mass changes CoM and inertia', () => {
    const light = massProperties([point('a', 1, [0, 0, 0]), point('b', 1, [0.2, 0, 0])])
    const heavy = massProperties([point('a', 1, [0, 0, 0]), point('b', 2, [0.2, 0, 0])])
    close(light.com![0], 0.1)
    close(heavy.com![0], 0.4 / 3)
    // Izz: light = 2 × 1 × 0.1² = 0.02; heavy = 1 × (0.4/3)² + 2 × (0.2/3)² = 0.08/3 = 0.0266667
    close(light.inertia![2], 0.02)
    close(heavy.inertia![2], 0.08 / 3)
  })

  it('parts without a mass are left out and listed; the definition is withheld', () => {
    const mp = massProperties([point('a', 1, [0, 0, 0]), box('b', null, [1, 0, 0], [0.1, 0.1, 0.1])])
    expect(mp.totalMassKg).toBe(1)
    expect(mp.com).toEqual([0, 0, 0])
    expect(mp.missingMass).toEqual([{ id: 'b', name: 'b' }])
    expect(vehicleDefinition(mp, [])).toBeNull()
    expect(massProperties([]).com).toBeNull()
  })

  it('the vehicle definition carries the totals and the motors', () => {
    const mp = massProperties([point('a', 1, [0, 0, 0])])
    const motor: MotorInput = { partId: 'm', name: 'Motor 1', position: [0.1, 0, 0.03], thrustAxis: [0, 0, 1], spin: 'cw' }
    expect(vehicleDefinition(mp, [motor])).toMatchObject({
      version: 1,
      totalMassKg: 1,
      com: [0, 0, 0],
      motors: [{ partId: 'm', position: [0.1, 0, 0.03], thrustAxis: [0, 0, 1], spin: 'cw' }],
      missingMass: [],
    })
  })
})

describe('hover balance', () => {
  // A quad X with motors at (±a, ±a) and vertical thrust.
  const a = 0.15
  const quad: MotorInput[] = [
    [a, -a],
    [-a, a],
    [a, a],
    [-a, -a],
  ].map(([x, y], i) => ({ partId: `m${i}`, name: `Motor ${i + 1}`, position: [x!, y!, 0.03], thrustAxis: [0, 0, 1], spin: i < 2 ? 'ccw' : 'cw' }))

  it('centred CoM: each motor carries a quarter of the weight', () => {
    // 1.2 kg × 9.80665 = 11.76798 N; quarter = 2.941995 N
    const h = hoverBalance(quad, [0, 0, 0], 1.2)
    expect(h.feasible).toBe(true)
    for (const t of h.thrustN) close(t, (1.2 * 9.80665) / 4)
    for (const s of h.share) close(s, 1)
  })

  it('CoM 30 mm forward: front motors carry (a + d)/(2a) of the weight', () => {
    // Moments about the CoM: front pair at arm a − d = 0.12, rear pair at a + d = 0.18.
    // T_front (a − d) = T_rear (a + d) and 2(T_front + T_rear) = W
    // → T_front = W (a + d) / (4a) = W × 0.18/0.6 = 0.3 W, T_rear = 0.2 W (shares 1.2 and 0.8)
    const W = 1.2 * 9.80665
    const h = hoverBalance(quad, [0.03, 0, 0], 1.2)
    expect(h.feasible).toBe(true)
    close(h.thrustN[0]!, 0.3 * W, 1e-9) // front right
    close(h.thrustN[2]!, 0.3 * W, 1e-9) // front left
    close(h.thrustN[1]!, 0.2 * W, 1e-9) // rear left
    close(h.share[0]!, 1.2, 1e-9)
    close(h.share[1]!, 0.8, 1e-9)
  })

  it('CoM outside the motors: infeasible, naming the motor that would pull down', () => {
    const h = hoverBalance(quad, [0.2, 0, 0], 1.2)
    expect(h.feasible).toBe(false)
    expect(h.reason).toMatch(/Motor 2|Motor 4/)
  })

  it('fewer than three motors, or all in a line, cannot hold roll and pitch', () => {
    expect(hoverBalance(quad.slice(0, 2), [0, 0, 0], 1).feasible).toBe(false)
    const line = [0, 1, 2].map((i) => ({ ...quad[0]!, position: [i * 0.1, 0, 0] as Vec3 }))
    expect(hoverBalance(line, [0.1, 0, 0], 1).reason).toMatch(/one line/)
  })
})
