import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { AssemblyDocument } from '../../electron/ipc/contract'
import {
  addPart,
  attach,
  attachableParts,
  copyToMotorMounts,
  freeMotorMounts,
  deletePart,
  duplicatePart,
  fromEulerDeg,
  halfHeight,
  toEulerDeg,
  worldMatrix,
} from '../../src/features/workshop/assembly-ops'
import { buildFrame } from '../../src/three/frame-geometry'

const FRAME = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }
const empty = (): AssemblyDocument => ({ frame: FRAME, motors: {}, parts: [] })
let n = 0
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

describe('assembly operations', () => {
  it('resolves mount-targeted props for insertion and reattachment using the motor effective height', () => {
    const geo = buildFrame('hex-x', FRAME)
    const motor = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-3' }, 0, ids())
    const shapeOf = (p: typeof motor.part) => p.kind === 'motor' ? { type: 'cylinder' as const, radius: 0.014, height: 0.05 } : p.shape
    const prop = addPart(motor.doc, 'propeller', { kind: 'mount', id: 'motor-3' }, 0, ids(), {}, shapeOf)
    expect(prop.part).toMatchObject({ parentId: motor.part.id, mountId: null })
    expect(prop.part.position[2]).toBeCloseTo(0.029)
    const detached = attach(prop.doc, geo, prop.part.id, { kind: 'none' })
    const reattached = attach(detached, geo, prop.part.id, { kind: 'mount', id: 'motor-3' }, {}, shapeOf)
    expect(reattached.parts.find((p) => p.id === prop.part.id)).toMatchObject({ parentId: motor.part.id, mountId: null })
    expect(reattached.parts.find((p) => p.id === prop.part.id)!.position[2]).toBeCloseTo(0.029)
  })

  it('adds parts resting on a mount, a part, or the frame top, with numbered names and no mass', () => {
    let doc = empty()
    const m = addPart(doc, 'motor', { kind: 'mount', id: 'motor-1' }, 0.004, ids())
    doc = m.doc
    expect(m.part).toMatchObject({ name: 'Motor 1', mountId: 'motor-1', parentId: null, mass: null })
    expect(m.part.position).toEqual([0, 0, 0.015]) // half of the 30 mm starting height
    const prop = addPart(doc, 'propeller', { kind: 'part', id: m.part.id }, 0.004, ids())
    expect(prop.part.parentId).toBe(m.part.id)
    expect(prop.part.position[2]).toBeCloseTo(0.015 + 0.004, 12) // on top of the motor
    const free = addPart(prop.doc, 'battery', { kind: 'none' }, 0.004, ids())
    expect(free.part.position).toEqual([0, 0, 0.004 + 0.0175])
    expect(addPart(free.doc, 'motor', { kind: 'none' }, 0, ids()).part.name).toBe('Motor 2')
  })

  it('deletes a part together with everything attached to it', () => {
    const a = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-1' }, 0, ids())
    const b = addPart(a.doc, 'propeller', { kind: 'part', id: a.part.id }, 0, ids())
    const c = addPart(b.doc, 'battery', { kind: 'none' }, 0, ids())
    expect(deletePart(c.doc, a.part.id).parts.map((p) => p.name)).toEqual(['Battery 1'])
  })

  it('duplicates a subtree with fresh ids, remapped parents and the next free names', () => {
    const a = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-2' }, 0, ids())
    const b = addPart(a.doc, 'propeller', { kind: 'part', id: a.part.id }, 0, ids())
    const { doc, rootId } = duplicatePart(b.doc, a.part.id, [0.01, 0, 0], ids)
    expect(doc.parts).toHaveLength(4)
    const root = doc.parts.find((p) => p.id === rootId)!
    expect(root).toMatchObject({ name: 'Motor 2', mountId: 'motor-2', parentId: null })
    expect(root.position[0]).toBeCloseTo(0.01, 12)
    const childCopy = doc.parts.find((p) => p.parentId === rootId)!
    expect(childCopy).toMatchObject({ name: 'Propeller 2', kind: 'propeller' })
    expect(new Set(doc.parts.map((p) => p.id)).size).toBe(4)
  })

  it('refuses attachments that would form a loop and lists valid targets', () => {
    const a = addPart(empty(), 'motor', { kind: 'none' }, 0, ids())
    const b = addPart(a.doc, 'propeller', { kind: 'part', id: a.part.id }, 0, ids())
    const geo = buildFrame('quad-x', FRAME)
    expect(attach(b.doc, geo, a.part.id, { kind: 'part', id: b.part.id })).toBe(b.doc)
    expect(attachableParts(b.doc, a.part.id)).toEqual([])
    expect(attachableParts(b.doc, b.part.id).map((p) => p.id)).toEqual([a.part.id])
  })

  it('detaching keeps the part where it is in the world, through a tilted motor mount', () => {
    const geo = buildFrame('quad-x', FRAME, { 'motor-1': { spin: 'ccw', tilt: (20 * Math.PI) / 180 } })
    const a = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-1' }, 0, ids())
    const b = addPart(a.doc, 'propeller', { kind: 'part', id: a.part.id }, 0, ids())
    const before = new Vector3().setFromMatrixPosition(worldMatrix(b.doc, geo, b.part.id))
    const detached = attach(b.doc, geo, b.part.id, { kind: 'none' })
    const p = detached.parts.find((x) => x.id === b.part.id)!
    expect(p.parentId).toBeNull()
    expect(p.mountId).toBeNull()
    expect(Math.hypot(p.position[0] - before.x, p.position[1] - before.y, p.position[2] - before.z)).toBeLessThan(1e-6)
    expect(Math.hypot(...p.rotation)).toBeCloseTo(1, 9)
    // Motor 1 sits at (159.1, −159.1) mm; the tilt leans the stack sideways, so the prop is no longer straight above it.
    expect(before.z).toBeGreaterThan(0.004)
  })

  it('attaching rests the part on its new target and resets its rotation', () => {
    const geo = buildFrame('hex-x', FRAME)
    const a = addPart(empty(), 'battery', { kind: 'none' }, 0, ids())
    const moved = attach(a.doc, geo, a.part.id, { kind: 'mount', id: 'plate-bottom' })
    expect(moved.parts[0]).toMatchObject({ mountId: 'plate-bottom', position: [0, 0, halfHeight(a.part.shape)], rotation: [0, 0, 0, 1] })
    // The bottom mount faces down, so the battery hangs below the plate.
    expect(new Vector3().setFromMatrixPosition(worldMatrix(moved, geo, a.part.id)).z).toBeCloseTo(-0.0175, 9)
  })

  it('converts rotations between quaternions and XYZ degrees', () => {
    for (const deg of [[0, 0, 0], [90, 0, 0], [10, 20, 30], [-45, 15, 170]] as const) {
      const back = toEulerDeg(fromEulerDeg([...deg]))
      back.forEach((v, i) => expect(v).toBeCloseTo(deg[i]!, 3))
    }
  })

  it('copies a motor-mount part and its attachments onto every free motor mount, once', () => {
    const geo = buildFrame('hex-x', { ...FRAME, motorDiagonal: 0.55 }, { 'motor-3': { spin: 'cw', tilt: 0.2 } })
    const motor = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-1' }, 0, ids())
    const prop = addPart(motor.doc, 'propeller', { kind: 'part', id: motor.part.id }, 0, ids())
    const moved = { ...prop.doc, parts: prop.doc.parts.map((p) => (p.id === motor.part.id ? { ...p, position: [0.002, 0, 0.015] as [number, number, number] } : p)) }
    const { doc, copies } = copyToMotorMounts(moved, geo, motor.part.id, ids)
    expect(copies).toBe(5)
    expect(doc.parts).toHaveLength(12)
    const motors = doc.parts.filter((p) => p.kind === 'motor')
    expect(motors.map((p) => p.mountId).sort()).toEqual(['motor-1', 'motor-2', 'motor-3', 'motor-4', 'motor-5', 'motor-6'])
    expect(motors.every((p) => p.position.join() === '0.002,0,0.015')).toBe(true) // same pose relative to its mount
    expect(new Set(doc.parts.map((p) => p.name)).size).toBe(12) // unique names
    // Each copied motor carries its own propeller.
    for (const m of motors) expect(doc.parts.filter((p) => p.parentId === m.id)).toHaveLength(1)
    // The tilted mount's copy follows the tilt: its world position differs from an untilted pose.
    const m3 = motors.find((p) => p.mountId === 'motor-3')!
    const prop3 = doc.parts.find((p) => p.parentId === m3.id)!
    expect(worldMatrix(doc, geo, prop3.id).elements[12]).not.toBeCloseTo(geo.motors[2]!.position[0] + 0.002, 4)
    // Nothing left to copy to; a free or child part cannot be copied this way.
    expect(freeMotorMounts(doc, geo, motor.part.id)).toEqual([])
    expect(copyToMotorMounts(doc, geo, prop.part.id).copies).toBe(0)
  })
})
