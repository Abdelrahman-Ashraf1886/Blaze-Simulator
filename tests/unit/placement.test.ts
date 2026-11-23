/**
 * Placement of new and resized parts (src/features/workshop/placement.ts): clear of other
 * parts, on what supports them, deterministic, and an explicit failure when nothing fits.
 * Adding through the editor (one undo step, nothing added on failure) is in collisions.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { AssemblyDocument, FrameParams } from '../../electron/ipc/contract'
import { addPart, attach, duplicatePart, halfHeight, seatPropsOnMotors, updatePart, worldMatrix } from '../../src/features/workshop/assembly-ops'
import { assemblyOverlaps } from '../../src/features/workshop/interference-input'
import { candidates, partErrors, placeClear, reseat, supportOf } from '../../src/features/workshop/placement'
import { buildFrame } from '../../src/three/frame-geometry'

const frame: FrameParams = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }
const geo = buildFrame('quad-x', frame)
const base: AssemblyDocument = { frame, motors: {}, parts: [] }
const t = frame.armThickness
const errors = (doc: AssemblyDocument) => assemblyOverlaps(doc, geo, {}, {}).filter((o) => o.status === 'error')

/** Adds a part and places it; throws with the reason when it cannot be placed. */
function add(doc: AssemblyDocument, kind: Parameters<typeof addPart>[1], target: Parameters<typeof addPart>[2], id: string) {
  const r = placeClear(addPart(doc, kind, target, t, id).doc, geo, id, {}, {})
  if (!r.ok) throw new Error(r.reason)
  return r.doc
}

describe('placement', () => {
  const hexFrame = { ...frame, motorDiagonal: 0.27 }
  const hex = buildFrame('hex-x', hexFrame)
  function hexWithMotors() {
    let doc = { ...base, frame: hexFrame }
    for (const m of hex.motors) doc = addPart(doc, 'motor', { kind: 'mount', id: m.id }, t, `m${m.number}`).doc
    return addPart(doc, 'propeller', { kind: 'part', id: 'm4' }, t, 'p4').doc
  }

  it('upgrades a legacy Hex X prop on bare motor-3 and clears its overlap with Motor 2', () => {
    const added = addPart(hexWithMotors(), 'propeller', { kind: 'mount', id: 'motor-3' }, t, 'p3')
    const legacy = updatePart(added.doc, 'p3', { parentId: null, mountId: 'motor-3', position: [0, 0, 0.004] })
    expect(partErrors(legacy, hex, 'p3', {}, {}).some((o) => o.aName === 'Motor 2' || o.bName === 'Motor 2')).toBe(true)
    const upgraded = seatPropsOnMotors(legacy, hex)
    expect(upgraded.parts.find((p) => p.id === 'p3')).toEqual(added.part)
    expect(partErrors(upgraded, hex, 'p3', {}, {})).toEqual([])
    expect(placeClear(upgraded, hex, 'p3', {}, {}).ok).toBe(true)
    expect(seatPropsOnMotors(upgraded, hex)).toBe(upgraded)
  })

  it('leaves a legacy prop without a motor unchanged, retaining the missing-motor explanation', () => {
    const legacy = addPart(base, 'propeller', { kind: 'mount', id: 'motor-3' }, t, 'p3').doc
    expect(seatPropsOnMotors(legacy, hex)).toBe(legacy)
    expect(placeClear(legacy, hex, 'p3', {}, {})).toEqual({
      ok: false, reason: 'Cannot add Propeller 1: add a motor to Motor 3 mount first.',
    })
  })

  it('adds a prop to Motor 3 on a fully populated Hex X with a prop already on Motor 4', () => {
    const before = hexWithMotors()
    const added = addPart(before, 'propeller', { kind: 'mount', id: 'motor-3' }, t, 'p3')
    const bare = updatePart(added.doc, 'p3', { parentId: null, mountId: 'motor-3', position: [0, 0, 0.004] })
    expect(partErrors(bare, hex, 'p3', {}, {}).some((o) => o.a === 'm2' || o.b === 'm2')).toBe(true)
    expect(placeClear(bare, hex, 'p3', {}, {})).toEqual({ ok: false, reason: 'Cannot place Propeller 2 on Motor 3 mount: attach the propeller to its motor first.' })
    expect(added.part).toMatchObject({ parentId: 'm3', mountId: null, position: [0, 0, 0.019] })
    const result = placeClear(added.doc, hex, 'p3', {}, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(assemblyOverlaps(result.doc, hex, {}, {}).filter((o) => o.status === 'error')).toEqual([])
    expect(worldMatrix(result.doc, hex, 'p3').elements[14]).toBeCloseTo(t + 0.03 + 0.004)
    // The 254 mm discs on opposite mounts (270 mm apart) clear each other;
    // neighbouring motor bodies end at z=34 mm, where the prop's bottom starts.
    expect(Math.hypot(...hex.motors[2]!.position.map((v, i) => v - hex.motors[3]!.position[i]!))).toBeCloseTo(0.27)
  })

  it('refuses a prop on an empty motor mount, including reattachment and unknown model bounds', () => {
    const before = hexWithMotors()
    const doc = { ...before, parts: before.parts.filter((p) => p.id !== 'm3') }
    const added = addPart(doc, 'propeller', { kind: 'mount', id: 'motor-3' }, t, 'p3')
    const refusal = { ok: false, reason: 'Cannot add Propeller 2: add a motor to Motor 3 mount first.' }
    expect(placeClear(added.doc, hex, 'p3', {}, {})).toEqual(refusal)
    const moved = attach(doc, hex, 'p4', { kind: 'mount', id: 'motor-3' })
    expect(placeClear(moved, hex, 'p4', {}, {})).toEqual({ ...refusal, reason: refusal.reason.replace('Propeller 2', 'Propeller 1') })
    const unknown = updatePart(added.doc, 'p3', { shape: { type: 'model', assetId: 'unknown', units: 'm', upAxis: 'z' } })
    expect(placeClear(unknown, hex, 'p3', {}, {})).toEqual(refusal)
  })

  it('reattaches a dragged prop onto the motor on its target mount', () => {
    const moved = attach(hexWithMotors(), hex, 'p4', { kind: 'mount', id: 'motor-3' })
    expect(moved.parts.find((p) => p.id === 'p4')).toMatchObject({ parentId: 'm3', mountId: null, position: [0, 0, 0.019] })
    expect(placeClear(moved, hex, 'p4', {}, {}).ok).toBe(true)
  })

  it('explains genuinely oversized props with their size and motor spacing', () => {
    const added = addPart(hexWithMotors(), 'propeller', { kind: 'mount', id: 'motor-3' }, t, 'p3')
    const tallerMotor = updatePart(added.doc, 'm2', { shape: { type: 'cylinder', radius: 0.014, height: 0.05 }, position: [0, 0, 0.025] })
    expect(placeClear(tallerMotor, hex, 'p3', {}, {}).ok).toBe(true)
    const tooBig = updatePart(tallerMotor, 'p3', { shape: { type: 'cylinder', radius: 0.5, height: 0.008 } })
    const result = placeClear(tooBig, hex, 'p3', {}, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('Propeller 2 (1000 × 1000 × 8 mm)')
      expect(result.reason).toContain('too large for the available motor spacing')
      expect(result.reason).toContain('Motor 2 (28 × 28 × 50 mm), with centres 135 mm apart (frame motor diagonal 270 mm)')
      expect(result.reason).not.toContain('a motor must sit')
    }
  })

  it('names the mount constraint for non-motors without calling them motors', () => {
    const first = addPart(base, 'custom', { kind: 'mount', id: 'motor-1' }, t, 'c1')
    const second = addPart(first.doc, 'custom', { kind: 'mount', id: 'motor-1' }, t, 'c2')
    const result = placeClear(second.doc, geo, 'c2', {}, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('this mount only supports its centre position')
      expect(result.reason).not.toContain('a motor must sit')
    }
  })

  it('a second battery lands beside the first on the frame, resting on the plate, with no overlap', () => {
    let doc = add(base, 'battery', { kind: 'none' }, 'b1')
    doc = add(doc, 'esc', { kind: 'none' }, 'e1')
    doc = add(doc, 'gps', { kind: 'none' }, 'g1')
    expect(errors(doc)).toEqual([])
    const b1 = doc.parts.find((p) => p.id === 'b1')!
    const e1 = doc.parts.find((p) => p.id === 'e1')!
    // The first part keeps the plate centre; the next one moves off it, within the plate square.
    expect(b1.position).toEqual([0, 0, t + 0.035 / 2])
    expect(e1.position[0] !== 0 || e1.position[1] !== 0).toBe(true)
    for (const p of doc.parts) {
      expect(Math.abs(p.position[0])).toBeLessThanOrEqual(frame.plateSize / 2)
      expect(Math.abs(p.position[1])).toBeLessThanOrEqual(frame.plateSize / 2)
      // Still free (not stacked onto another part), resting on the plate.
      expect([p.parentId, p.mountId]).toEqual([null, null])
      expect(p.position[2]).toBeCloseTo(t + halfHeight(p.shape), 12)
    }
  })

  it('is deterministic: the same document gives the same spot, and candidates come in a fixed order', () => {
    const doc = add(base, 'battery', { kind: 'none' }, 'b1')
    const a = placeClear(addPart(doc, 'esc', { kind: 'none' }, t, 'e1').doc, geo, 'e1', {}, {})
    const b = placeClear(addPart(doc, 'esc', { kind: 'none' }, t, 'e1').doc, geo, 'e1', {}, {})
    expect(a).toEqual(b)
    const sup = supportOf(base, geo, addPart(base, 'esc', { kind: 'none' }, t, 'x').part, {}, {})
    const c = candidates(sup, [0, 0])
    expect(c.slice(0, 5)).toEqual([[0, 0], [0.005, 0], [0, 0.005], [-0.005, 0], [0, -0.005]])
    expect(new Set(c.map(String)).size).toBe(c.length)
    expect(c.every(([x, y]) => Math.abs(x) <= 0.06 && Math.abs(y) <= 0.06)).toBe(true)
  })

  it('children stay on their parent: resting on its top face, centred within it, attachment unchanged', () => {
    let doc = add(base, 'battery', { kind: 'none' }, 'b1')
    doc = add(doc, 'esc', { kind: 'part', id: 'b1' }, 'e1')
    doc = add(doc, 'esc', { kind: 'part', id: 'b1' }, 'e2')
    expect(errors(doc)).toEqual([])
    for (const id of ['e1', 'e2']) {
      const e = doc.parts.find((p) => p.id === id)!
      expect(e.parentId).toBe('b1')
      expect(Math.abs(e.position[0])).toBeLessThanOrEqual(0.14 / 2)
      expect(Math.abs(e.position[1])).toBeLessThanOrEqual(0.045 / 2)
      expect(e.position[2]).toBeCloseTo(0.035 / 2 + 0.008 / 2, 12)
    }
  })

  it('a motor mount allows only its pose: a second motor there is an explicit failure naming the mount', () => {
    const doc = add(base, 'motor', { kind: 'mount', id: 'motor-1' }, 'm1')
    const second = addPart(doc, 'motor', { kind: 'mount', id: 'motor-1' }, t, 'm2').doc
    const r = placeClear(second, geo, 'm2', {}, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/^No free spot on Motor 1 mount for Motor 2 \(28 × 28 × 30 mm\): it would overlap Motor 1 there, and a motor must sit on its mount\./)
  })

  it('a full plate is an explicit failure; nothing is stacked or moved off the plate', () => {
    let doc = base
    let failure: string | null = null
    for (let i = 0; i < 40 && !failure; i++) {
      const withPart = addPart(doc, 'custom', { kind: 'mount', id: 'plate-top' }, t, `c${i}`).doc
      const r = placeClear(withPart, geo, `c${i}`, {}, {})
      if (r.ok) doc = r.doc
      else failure = r.reason
    }
    expect(failure).toMatch(/^No free spot on the top plate for Custom \d+ \(50 × 50 × 50 mm\): every position overlaps another part by more than your tolerance\. Move or remove a part, or add it elsewhere\.$/)
    expect(errors(doc)).toEqual([])
    expect(doc.parts.every((p) => p.mountId === 'plate-top' && p.parentId === null)).toBe(true)
  })

  it('a duplicate is placed clear of its original, on the same support', () => {
    const doc = add(base, 'battery', { kind: 'mount', id: 'plate-top' }, 'b1')
    const d = duplicatePart(doc, 'b1', undefined, () => 'b2')
    const r = placeClear(d.doc, geo, 'b2', {}, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(errors(r.doc)).toEqual([])
    expect(r.doc.parts.find((p) => p.id === 'b2')!.mountId).toBe('plate-top')
  })

  it('a taller size keeps the part and what rests on it on their supports', () => {
    let doc = add(base, 'battery', { kind: 'none' }, 'b1')
    doc = add(doc, 'esc', { kind: 'part', id: 'b1' }, 'e1')
    const taller = updatePart(doc, 'b1', { shape: { type: 'box', size: [0.14, 0.045, 0.05] } })
    const seated = reseat(doc, taller, geo, 'b1', {}, {})
    expect(seated.parts.find((p) => p.id === 'b1')!.position[2]).toBeCloseTo(t + 0.025, 12)
    expect(seated.parts.find((p) => p.id === 'e1')!.position[2]).toBeCloseTo(0.025 + 0.004, 12)
    expect(partErrors(seated, geo, 'b1', {}, {})).toEqual([])
    // Without reseating the battery would sink 7.5 mm into the plate.
    expect(errors(taller).length).toBeGreaterThan(0)
  })
})
