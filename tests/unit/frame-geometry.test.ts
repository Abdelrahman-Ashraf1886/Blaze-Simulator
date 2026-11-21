import { describe, expect, it } from 'vitest'
import { FRAME_TYPES, type FrameParams, type FrameType } from '../../electron/ipc/contract'
import { PX4_ROTORS, buildFrame } from '../../src/three/frame-geometry'

const P: FrameParams = { motorDiagonal: 0.55, armWidth: 0.02, armThickness: 0.004, plateSize: 0.15 }
const TOL = 1e-5 // 0.01 mm

describe('frame geometry', () => {
  it.each(FRAME_TYPES)('%s: motors sit on the diagonal circle at PX4 positions (y mirrored)', (type) => {
    const f = buildFrame(type, P)
    const r = P.motorDiagonal / 2
    expect(f.motors).toHaveLength(PX4_ROTORS[type].length)
    f.motors.forEach((m, i) => {
      const px4 = PX4_ROTORS[type][i]!
      expect(m.id).toBe(`motor-${i + 1}`)
      expect(Math.abs(m.position[0] - px4.x * r)).toBeLessThan(TOL)
      expect(Math.abs(m.position[1] + px4.y * r)).toBeLessThan(TOL) // PX4 y-right → our y-left
      expect(m.position[2]).toBeCloseTo(P.armThickness, 12) // top face of the arm
      expect(Math.abs(Math.hypot(m.position[0], m.position[1]) - r)).toBeLessThan(TOL)
    })
  })

  it.each(FRAME_TYPES)('%s: opposite motors are exactly one diagonal apart', (type) => {
    const f = buildFrame(type, P)
    for (const a of f.motors) {
      const far = Math.max(...f.motors.map((b) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1])))
      expect(Math.abs(far - P.motorDiagonal)).toBeLessThan(TOL)
    }
  })

  it.each<[FrameType, number]>([
    ['quad-x', 45],
    ['hex-x', 30],
    ['octo-x', 22.5],
  ])('%s: X orientation — the front arms are ±%s° off the nose', (type, deg) => {
    const angles = buildFrame(type, P).motors.map((m) => (m.angle * 180) / Math.PI)
    expect(angles.some((a) => Math.abs(a - deg) < 1e-3)).toBe(true)
    expect(angles.some((a) => Math.abs(a + deg) < 1e-3)).toBe(true)
    expect(angles.some((a) => Math.abs(a) < 1e-3)).toBe(false) // no arm straight ahead
  })

  it('quad X follows PX4 numbering: 1 front-right CCW, 2 rear-left CCW, 3 front-left CW, 4 rear-right CW', () => {
    const m = buildFrame('quad-x', P).motors
    const side = (i: number) =>
      `${m[i]!.position[0] > 0 ? 'front' : 'rear'}-${m[i]!.position[1] < 0 ? 'right' : 'left'}`
    expect(m.map((_, i) => side(i))).toEqual(['front-right', 'rear-left', 'front-left', 'rear-right'])
    expect(m.map((x) => x.spin)).toEqual(['ccw', 'ccw', 'cw', 'cw'])
  })

  it.each(FRAME_TYPES)('%s: spins balance (equal CW and CCW) so yaw torque cancels', (type) => {
    const spins = buildFrame(type, P).motors.map((m) => m.spin)
    expect(spins.filter((s) => s === 'cw')).toHaveLength(spins.length / 2)
  })

  it('applies overrides and flags customised motors; ignores mounts the layout lacks', () => {
    const f = buildFrame('quad-x', P, { 'motor-1': { spin: 'cw', tilt: 0.1 }, 'motor-7': { spin: 'cw', tilt: 0 } })
    expect(f.motors[0]).toMatchObject({ spin: 'cw', tilt: 0.1, defaultSpin: 'ccw', customised: true })
    expect(f.motors[1]).toMatchObject({ spin: 'ccw', tilt: 0, customised: false })
    expect(f.motors).toHaveLength(4)
  })

  it('bounds contain every motor, arm tip and plate corner, from the ground up', () => {
    for (const type of FRAME_TYPES) {
      const f = buildFrame(type, P)
      const reach = P.motorDiagonal / 2 + P.armWidth / 2
      expect(f.bounds.min[2]).toBe(0)
      expect(f.bounds.max[0]).toBeGreaterThanOrEqual(reach - 1e-12)
      for (const m of f.motors) for (const k of [0, 1] as const) expect(Math.abs(m.position[k])).toBeLessThanOrEqual(f.bounds.max[k])
    }
  })

  it('provides plate mounts on top and bottom of the centre plate', () => {
    const plates = buildFrame('hex-x', P).plates
    expect(plates).toEqual([
      { id: 'plate-top', name: 'Plate top', position: [0, 0, P.armThickness], normal: [0, 0, 1] },
      { id: 'plate-bottom', name: 'Plate bottom', position: [0, 0, 0], normal: [0, 0, -1] },
    ])
  })
})
