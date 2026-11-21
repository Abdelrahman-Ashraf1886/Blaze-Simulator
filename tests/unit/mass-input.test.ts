/**
 * The assembly as the mass calculation sees it (src/features/workshop/mass-input.ts):
 * the frame model, part placement through the attachment chain, the motors' thrust
 * points, and attach/detach keeping the mass properties.
 */
import { describe, expect, it } from 'vitest'
import type { AssemblyDocument, FrameParams } from '../../electron/ipc/contract'
import { addPart, attach, updatePart } from '../../src/features/workshop/assembly-ops'
import { frameBoxes, massBodies, massState, motorInputs } from '../../src/features/workshop/mass-input'
import { massProperties } from '../../src/domain/mass'
import { buildFrame } from '../../src/three/frame-geometry'

const frame: FrameParams = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.1 }
const geo = buildFrame('quad-x', frame)
const base: AssemblyDocument = { frame, frameMass: { valueKg: 0.3, source: 'user' }, motors: {}, parts: [] }
const close = (a: number, b: number, tol = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)

describe('frame model', () => {
  it('plate plus each arm outside the plate; the arm length outside is (r + w/2) − exit', () => {
    // Quad X: arm along (√½, √½); the centre line leaves the 100 mm square at 50/√½ = 70.711 mm.
    // Arm length from the centre = 225 + 10 = 235 mm, so 164.289 mm lies outside the plate.
    const boxes = frameBoxes(geo, frame.plateSize, frame.armWidth, frame.armThickness)
    expect(boxes).toHaveLength(5)
    close(boxes[1]!.size[0], 0.235 - 0.05 / Math.SQRT1_2, 1e-12)
  })

  it('a symmetric frame alone has its CoM on the axis at half its thickness, and its mass is shared by volume', () => {
    const mp = massProperties(massBodies(base, geo, {}))
    close(mp.totalMassKg, 0.3, 1e-15)
    close(mp.com![0], 0, 1e-15)
    close(mp.com![1], 0, 1e-15)
    close(mp.com![2], 0.002, 1e-15)
    // Plate share = plate volume / total volume (all boxes have the same thickness, so by area):
    // plate 0.01 m², arms 4 × 0.164289 × 0.02 = 0.0131431 m² → plate share 0.01 / 0.0231431 = 0.43209
    const plate = mp.parts.find((p) => p.partId === 'frame:plate')!
    const armArea = 4 * (0.235 - 0.05 / Math.SQRT1_2) * 0.02
    close(plate.massKg, (0.3 * 0.01) / (0.01 + armArea), 1e-15)
    // Square symmetry: Ixx = Iyy, no products of inertia.
    close(mp.inertia![0], mp.inertia![1], 1e-15)
    close(mp.inertia![3], 0, 1e-15)
  })

  it('without a frame mass the frame is listed as missing', () => {
    const mp = massProperties(massBodies({ ...base, frameMass: null }, geo, {}))
    expect(mp.missingMass).toEqual([{ id: 'frame', name: 'Frame' }])
    expect(mp.com).toBeNull()
  })
})

describe('parts and motors', () => {
  it('a part on the bottom plate mount sits below the frame and moves the CoM down', () => {
    const added = addPart(base, 'battery', { kind: 'mount', id: 'plate-bottom' }, frame.armThickness, 'batt')
    const doc = updatePart(added.doc, added.part.id, { mass: { valueKg: 0.5, source: 'user' } })
    const body = massBodies(doc, geo, {}).find((b) => b.id === 'batt')!
    // Battery starting box is 35 mm tall; resting under the plate its centre is at z = −17.5 mm.
    close(body.position[2], -0.0175, 1e-9)
    const mp = massProperties(massBodies(doc, geo, {}))
    // CoM z = (0.3 × 0.002 + 0.5 × −0.0175) / 0.8 = −0.0101875
    close(mp.com![2], (0.3 * 0.002 + 0.5 * -0.0175) / 0.8, 1e-12)
  })

  it('thrust points: the mount surface when empty, the prop hub when a prop is on the motor', () => {
    const empty = motorInputs(base, geo, {})
    expect(empty).toHaveLength(4)
    expect(empty[0]!.position).toEqual(geo.motors[0]!.position)
    expect(empty[0]!.thrustAxis.map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0, 0, 1])
    const added = addPart(base, 'motor', { kind: 'mount', id: 'motor-1' }, frame.armThickness, 'm1')
    const { doc } = addPart(added.doc, 'propeller', { kind: 'part', id: added.part.id }, frame.armThickness, 'p1')
    const withProp = motorInputs(doc, geo, {})[0]!
    // Motor 30 mm tall on the 4 mm-high mount, prop disc 8 mm: hub at 4 + 30 + 4 = 38 mm.
    close(withProp.position[2], 0.038, 1e-9)
    expect(withProp.partId).toBe('m1')
    expect(withProp.spin).toBe(geo.motors[0]!.spin)
  })

  it('a tilted mount tilts the thrust axis', () => {
    const tilted = buildFrame('quad-x', frame, { 'motor-1': { spin: 'ccw', tilt: 0.2 } })
    const axis = motorInputs(base, tilted, {})[0]!.thrustAxis
    close(axis[2], Math.cos(0.2), 1e-12)
    close(Math.hypot(...axis), 1, 1e-12)
  })

  it('detaching keeps the world pose, so mass properties are unchanged; attaching elsewhere changes them', () => {
    const added = addPart(base, 'payload', { kind: 'mount', id: 'plate-top' }, frame.armThickness, 'pay')
    const doc = updatePart(added.doc, added.part.id, { mass: { valueKg: 0.2, source: 'user' }, position: [0.03, 0.01, 0.03] })
    const before = massState(doc, geo, {}).mp
    const detached = attach(doc, geo, 'pay', { kind: 'none' })
    const after = massState(detached, geo, {}).mp
    for (let i = 0; i < 3; i++) close(after.com![i]!, before.com![i]!, 1e-7)
    for (let i = 0; i < 6; i++) close(after.inertia![i]!, before.inertia![i]!, 1e-9)
    const moved = massState(attach(doc, geo, 'pay', { kind: 'mount', id: 'motor-1' }), geo, {}).mp
    expect(moved.com![0]).toBeGreaterThan(before.com![0])
  })
})
