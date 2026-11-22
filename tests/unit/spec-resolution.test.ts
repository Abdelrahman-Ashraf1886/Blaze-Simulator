/**
 * Effective specifications (src/domain/spec-resolution.ts): layer precedence, cache
 * invalidation, and propagation of catalog fills and part overrides into every
 * calculation that reads a linked component.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssemblyDocument, Component, FrameParams, SpecValue } from '../../electron/ipc/contract'
import { COMPONENT_CATEGORIES, COMPONENT_FIELDS, isOverridable, overridableField } from '../../electron/ipc/component-fields'
import { effectiveComponent, resolveSpec } from '../../src/domain/spec-resolution'
import { addPart, updatePart } from '../../src/features/workshop/assembly-ops'
import { checkInput } from '../../src/features/workshop/check-input'
import { effectiveMass, effectiveShape, linkedComponent, type ComponentIndex } from '../../src/features/workshop/links'
import { massState } from '../../src/features/workshop/mass-input'
import { propulsionState } from '../../src/features/workshop/propulsion-input'
import { wiringParts } from '../../src/features/workshop/wiring-input'
import { buildFrame } from '../../src/three/frame-geometry'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const named = (name: string): Component => ({ ...seed.components.find((c) => c.name === name)!, origin: 'built-in', schemaVersion: 1, revision: 1, createdAt: '', updatedAt: '' })
const KV470 = named('MN3110 KV470')
const P13 = named('P13*4.4 CF propeller')
const TATTU = named('Tattu G-Tech 5200mAh 4S 35C')

const measured = (value: number, unit: string): SpecValue => ({ value, unit, source: 'measured' }) as SpecValue
const user = (value: number, unit: string): SpecValue => ({ value, unit, source: 'user' }) as SpecValue

describe('layer precedence', () => {
  const filled: Component = { ...TATTU, fills: { internalResistance: measured(12, 'mΩ') } }
  it('manufacturer value alone', () => {
    const r = resolveSpec(TATTU, undefined, 'capacity')
    expect(r.layer).toBe('manufacturer')
    expect(r.value).toBe(TATTU.specs.capacity)
  })
  it('missing everywhere', () => {
    expect(resolveSpec(TATTU, undefined, 'internalResistance')).toEqual({ key: 'internalResistance', value: null, layer: 'missing', layers: {} })
  })
  it('catalog fill when the record states nothing; part override above both; every layer kept', () => {
    expect(resolveSpec(filled, undefined, 'internalResistance').layer).toBe('catalog')
    const o = { internalResistance: user(15, 'mΩ') }
    const r = resolveSpec(filled, o, 'internalResistance')
    expect(r.layer).toBe('instance')
    expect(r.value).toBe(o.internalResistance)
    expect(r.layers).toEqual({ instance: o.internalResistance, catalog: filled.fills!.internalResistance })
    // An override above a stated value keeps the stated one in `layers`.
    const m = resolveSpec(TATTU, { capacity: measured(5000, 'mAh') }, 'capacity')
    expect(m.layers.manufacturer).toBe(TATTU.specs.capacity)
  })
  it('a fill still wins when a later seed states the field (user priority)', () => {
    const stated: Component = { ...filled, specs: { ...filled.specs, internalResistance: { value: 9, unit: 'mΩ', source: 'manufacturer' } as SpecValue } }
    const r = resolveSpec(stated, undefined, 'internalResistance')
    expect(r.layer).toBe('catalog')
    expect(r.layers.manufacturer).toEqual(stated.specs.internalResistance)
  })
})

describe('effective component cache', () => {
  it('same inputs give the same object; a changed component, fills or overrides give a new one', () => {
    const o1 = { mass: measured(101, 'g') }
    const a = effectiveComponent(KV470, o1)
    expect(effectiveComponent(KV470, o1)).toBe(a)
    expect(a.specs.mass).toBe(o1.mass)
    // New overrides object (a part edit).
    const o2 = { mass: measured(102, 'g') }
    expect(effectiveComponent(KV470, o2).specs.mass).toBe(o2.mass)
    // New component object (a library edit or a new fill).
    const withFill: Component = { ...KV470, fills: { rotorInertia: measured(150, 'g·cm²') } }
    expect(effectiveComponent(withFill, o1)).not.toBe(a)
    expect(effectiveComponent(withFill, o1).specs.rotorInertia).toBe(withFill.fills!.rotorInertia)
    // No layers: the record itself; empty overrides count as none.
    expect(effectiveComponent(KV470, undefined)).toBe(KV470)
    expect(effectiveComponent(KV470, {})).toBe(KV470)
  })
})

describe('overridable fields', () => {
  it('keys shared by categories have the same kind and dimension (part overrides are validated by key)', () => {
    for (const c of COMPONENT_CATEGORIES) {
      for (const f of COMPONENT_FIELDS[c].filter(isOverridable)) {
        const g = overridableField(f.key)!
        expect(g.kind, `${c}.${f.key}`).toBe(f.kind)
        if (f.kind === 'quantity' && g.kind === 'quantity') expect(g.dimension, `${c}.${f.key}`).toBe(f.dimension)
      }
    }
    expect(overridableField('thrustTable')).toBeUndefined()
  })
})

describe('propagation into every calculation', () => {
  const frame: FrameParams = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }
  const geo = buildFrame('quad-x', frame)
  const build = (): AssemblyDocument => {
    let doc: AssemblyDocument = { frame, frameMass: { valueKg: 0.3, source: 'user' }, motors: {}, parts: [] }
    const m = addPart(doc, 'motor', { kind: 'mount', id: 'motor-1' }, frame.armThickness, 'm1')
    doc = addPart(m.doc, 'propeller', { kind: 'part', id: 'm1' }, frame.armThickness, 'p1').doc
    doc = addPart(doc, 'battery', { kind: 'mount', id: 'plate-bottom' }, frame.armThickness, 'b1').doc
    doc = updatePart(doc, 'm1', { componentId: KV470.id })
    doc = updatePart(doc, 'p1', { componentId: P13.id })
    return updatePart(doc, 'b1', { componentId: TATTU.id })
  }
  const index = (...cs: Component[]): ComponentIndex => Object.fromEntries(cs.map((c) => [c.id, c]))
  const lib = index(KV470, P13, TATTU)

  it('mass and inertia follow a mass override, and revert when it is cleared', () => {
    const doc = build()
    const before = massState(doc, geo, lib).mp
    const over = updatePart(doc, 'm1', { overrides: { mass: measured(150, 'g') } })
    expect(effectiveMass(over.parts.find((p) => p.id === 'm1')!, lib)!.valueKg).toBeCloseTo(0.15, 15)
    const after = massState(over, geo, lib).mp
    expect(after.totalMassKg - before.totalMassKg).toBeCloseTo(0.15 - 0.098, 12)
    expect(after.inertia![2]).toBeGreaterThan(before.inertia![2])
    const cleared = updatePart(over, 'm1', { overrides: undefined })
    expect(massState(cleared, geo, lib).mp.totalMassKg).toBeCloseTo(before.totalMassKg, 15)
  })

  it('a size override changes the shape that is drawn and used for inertia', () => {
    const doc = updatePart(build(), 'm1', { overrides: { bodyDiameter: measured(40, 'mm') } })
    const shape = effectiveShape(doc.parts.find((p) => p.id === 'm1')!, lib)
    expect(shape).toMatchObject({ type: 'cylinder', radius: 0.02 })
  })

  it('compatibility checks and wiring/electrical read the overridden value', () => {
    const doc = updatePart(build(), 'm1', { overrides: { maxCurrent: measured(18, 'A') } })
    const checked = checkInput(doc, geo, lib).parts.find((p) => p.id === 'm1')!
    expect(checked.component!.specs.maxCurrent).toEqual(measured(18, 'A'))
    const wired = wiringParts(doc, geo, lib).find((p) => p.id === 'm1')!
    expect(wired.component!.specs.maxCurrent).toEqual(measured(18, 'A'))
  })

  it('a catalog fill satisfies the checklist for every part; an override for one part only', () => {
    const doc = build()
    const items = (d: AssemblyDocument, l: ComponentIndex) => propulsionState(d, geo, l).ready.map((i) => i.id)
    expect(items(doc, lib)).toContain(`component:${TATTU.id}:internalResistance`)
    expect(items(doc, lib)).toContain(`component:${KV470.id}:rotorInertia`)
    // Library fill on the Tattu record.
    const filled = index(KV470, P13, { ...TATTU, fills: { internalResistance: measured(12, 'mΩ') } })
    expect(items(doc, filled)).not.toContain(`component:${TATTU.id}:internalResistance`)
    // Part override of the rotor inertia.
    const over = updatePart(doc, 'm1', { overrides: { rotorInertia: measured(150, 'g·cm²') } })
    expect(items(over, lib)).not.toContain(`component:${KV470.id}:rotorInertia`)
    // The checklist item names the parts it is missing on.
    const item = propulsionState(doc, geo, lib).ready.find((i) => i.id === `component:${KV470.id}:rotorInertia`)!
    expect(item.parts).toEqual([{ id: 'm1', name: 'Motor 1' }])
  })

  it('propulsion uses the effective values (override > fill > stated)', () => {
    const lib2 = index({ ...KV470, fills: { rotorInertia: measured(150, 'g·cm²') } }, P13, TATTU)
    const doc = build()
    const m = (d: AssemblyDocument, l: ComponentIndex) => propulsionState(d, geo, l).motors[0]!
    const r1 = m(doc, lib2).rotor!
    expect(r1.ok && r1.value).toBeCloseTo(1.5e-5, 18)
    const over = updatePart(doc, 'm1', { overrides: { rotorInertia: user(200, 'g·cm²') } })
    const r2 = m(over, lib2).rotor!
    expect(r2.ok && r2.value).toBeCloseTo(2e-5, 18)
    expect(linkedComponent(over.parts.find((p) => p.id === 'm1')!, lib2)!.specs.rotorInertia).toEqual(user(200, 'g·cm²'))
  })
})
