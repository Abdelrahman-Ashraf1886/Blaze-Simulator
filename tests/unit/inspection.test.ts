import { describe, expect, it } from 'vitest'
import type { AssemblyDocument } from '../../electron/ipc/contract'
import { addPart, worldMatrix } from '../../src/features/workshop/assembly-ops'
import {
  EXPLODE_SCALE,
  assemblyBounds,
  assemblyStatus,
  explodedDoc,
  measure,
  nearestOnScreen,
  MOUNT_SNAP_RADIUS,
  snapMount,
  partBounds,
  worldMatrices,
} from '../../src/features/workshop/inspection'
import { buildFrame } from '../../src/three/frame-geometry'

const FRAME = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }
const empty = (): AssemblyDocument => ({ frame: FRAME, motors: {}, parts: [] })
let n = 0
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const r = (v: readonly number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0)

/** Motor on mount 1 with a prop on it, a battery under the bottom plate, a free payload. */
function sample() {
  const geo = buildFrame('quad-x', FRAME, {})
  const motor = addPart(empty(), 'motor', { kind: 'mount', id: 'motor-1' }, 0.004, ids())
  const prop = addPart(motor.doc, 'propeller', { kind: 'part', id: motor.part.id }, 0.004, ids())
  const battery = addPart(prop.doc, 'battery', { kind: 'mount', id: 'plate-bottom' }, 0.004, ids())
  const payload = addPart(battery.doc, 'payload', { kind: 'none' }, 0.004, ids())
  return { geo, doc: payload.doc, motor: motor.part, prop: prop.part, battery: battery.part, payload: payload.part }
}

describe('inspection', () => {
  it('computes every world matrix in one pass, matching worldMatrix', () => {
    const { geo, doc } = sample()
    const all = worldMatrices(doc, geo)
    for (const p of doc.parts) expect(all.get(p.id)!.elements).toEqual(worldMatrix(doc, geo, p.id).elements)
  })

  it('part and assembly bounds include every part, not just the frame', () => {
    const { geo, doc, battery } = sample()
    // Battery 140 × 45 × 35 mm hangs below the bottom plate (z = 0), so the assembly reaches −35 mm.
    const b = partBounds(doc, geo, battery.id)!
    expect(r(b.max)[2]).toBe(0)
    expect(r(b.min)[2]).toBe(-0.035)
    const all = assemblyBounds(doc, geo)
    expect(r(all.min)[2]).toBe(-0.035)
    for (const p of doc.parts) {
      const pb = partBounds(doc, geo, p.id)!
      for (let i = 0; i < 3; i++) {
        expect(all.min[i]).toBeLessThanOrEqual(pb.min[i]! + 1e-12)
        expect(all.max[i]).toBeGreaterThanOrEqual(pb.max[i]! - 1e-12)
      }
    }
    expect(assemblyBounds(empty(), geo)).toEqual(geo.bounds)
  })

  it('explodes radially along arms, away from plates, outward for free parts, and lifts each stack level', () => {
    const { geo, doc, motor, prop, battery, payload } = sample()
    const d = 0.5 * EXPLODE_SCALE * FRAME.motorDiagonal
    const ex = explodedDoc(doc, geo, 0.5)
    const at = (x: AssemblyDocument, id: string) => worldMatrix(x, geo, id).elements.slice(12, 15)
    const arm = geo.motors.find((m) => m.id === 'motor-1')!.armDirection
    // Motor: moved d along its arm in the world.
    const dm = at(ex, motor.id).map((v, i) => v - at(doc, motor.id)[i]!)
    expect(r(dm)).toEqual(r(arm.map((a) => a * d)))
    // Prop: the motor's move plus a d lift along the stack.
    const dp = at(ex, prop.id).map((v, i) => v - at(doc, prop.id)[i]!)
    expect(r(dp)).toEqual(r([arm[0] * d, arm[1] * d, d]))
    // Battery under the bottom plate: moved down.
    expect(r([at(ex, battery.id)[2]! - at(doc, battery.id)[2]!])).toEqual(r([-d]))
    // Free payload at the centre: lifted.
    expect(r([at(ex, payload.id)[2]! - at(doc, payload.id)[2]!])).toEqual(r([d]))
    // The saved document is untouched, and zero spread is the identity.
    expect(doc.parts.find((p) => p.id === motor.id)!.position).toEqual(motor.position)
    expect(explodedDoc(doc, geo, 0)).toBe(doc)
  })

  it('status: counts parts, unattached, without mass and model issues', () => {
    const { geo, doc, payload } = sample()
    const model = { id: 'p', name: 'Pod', kind: 'payload' as const, parentId: null, mountId: 'motor-9', mass: null }
    const withModel: AssemblyDocument = {
      ...doc,
      parts: [
        ...doc.parts,
        { ...model, id: ids(), shape: { type: 'model', assetId: 'a'.repeat(64), units: 'mm', upAxis: 'y' }, position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      ],
    }
    const s = assemblyStatus(withModel, geo, {}, new Set())
    expect(s.parts).toBe(5)
    // The free payload and the model on a mount that does not exist.
    expect(s.unattached).toEqual([payload.id, withModel.parts[4]!.id])
    expect(s.noMass).toHaveLength(5)
    expect(s.modelIssues).toEqual([withModel.parts[4]!.id]) // asset unknown
    expect(assemblyStatus(withModel, geo, { ['a'.repeat(64)]: { warnings: [] } }, new Set()).modelIssues).toEqual([])
    expect(assemblyStatus(withModel, geo, { ['a'.repeat(64)]: { warnings: [] } }, new Set(['a'.repeat(64)])).modelIssues).toHaveLength(1)
  })

  it('snaps a dragged part to the mount under it, within 15 mm sideways and its own height', () => {
    const geo = buildFrame('quad-x', FRAME, {})
    const m1 = geo.motors.find((m) => m.id === 'motor-1')!.position
    const h = 0.015 // a 30 mm tall part
    // Resting on motor 1 (centre half its height above), or 10 mm off to the side: snaps.
    expect(snapMount(geo, [m1[0], m1[1], m1[2] + h], h, null)).toBe('motor-1')
    expect(snapMount(geo, [m1[0] + 0.01, m1[1], m1[2] + h], h, null)).toBe('motor-1')
    // 16 mm sideways, or too high above it: no snap.
    expect(snapMount(geo, [m1[0] + MOUNT_SNAP_RADIUS + 0.001, m1[1], m1[2]], h, null)).toBeNull()
    expect(snapMount(geo, [m1[0], m1[1], m1[2] + h + MOUNT_SNAP_RADIUS + 0.001], h, null)).toBeNull()
    // The mount it is already on is excluded (a drag there is a normal move).
    expect(snapMount(geo, [m1[0], m1[1], m1[2] + h], h, 'motor-1')).toBeNull()
    // At the plate centre the nearer plate wins: above → top, below → bottom.
    expect(snapMount(geo, [0, 0, 0.004 + h], h, null)).toBe('plate-top')
    expect(snapMount(geo, [0, 0, -h], h, null)).toBe('plate-bottom')
  })

  it('measure: distance and deltas in mm; vertex snapping picks the nearest within 8 px', () => {
    const m = measure([0.159, -0.159, 0.005], [-0.159, 0.159, 0.005])
    expect(m.distanceMm).toBeCloseTo(449.72, 2)
    expect(r([...m.deltaMm])).toEqual([-318, 318, 0])
    const c = [
      { world: [1, 0, 0] as const, screen: [100, 100] as const },
      { world: [2, 0, 0] as const, screen: [104, 100] as const },
    ]
    expect(nearestOnScreen(c, [103, 100])).toEqual([2, 0, 0])
    expect(nearestOnScreen(c, [100, 107.9])).toEqual([1, 0, 0])
    expect(nearestOnScreen(c, [120, 100])).toBeNull()
  })
})
