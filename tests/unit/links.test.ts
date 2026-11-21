import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Component, ComponentInput } from '../../electron/ipc/component-fields'
import type { AssemblyDocument, AssemblyPart } from '../../electron/ipc/contract'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase } from '../../electron/main/db/database'
import { STARTING_FRAME, ValidationError, createRepositories } from '../../electron/main/db/repositories'
import { addPart, shapeExtent } from '../../src/features/workshop/assembly-ops'
import {
  effectiveMass,
  effectiveShape,
  linkableComponents,
  linkedShape,
  resolveLinks,
  type ComponentIndex,
} from '../../src/features/workshop/links'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as {
  components: (Component & { id: string })[]
}
const byName = (name: string) => ({ ...seed.components.find((c) => c.name === name)!, origin: 'built-in' }) as Component
const index: ComponentIndex = Object.fromEntries(seed.components.map((c) => [c.id, { ...c, origin: 'built-in' } as Component]))
const r = (v: readonly number[]) => v.map((x) => Math.round(x * 1e7) / 1e7)
/** Shape with lengths rounded to 0.1 µm (unit conversion adds float noise). */
const round = (s: unknown) => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e7) / 1e7 : v)))

const part = (over: Partial<AssemblyPart> = {}): AssemblyPart => ({
  id: randomUUID(),
  name: 'P',
  kind: 'motor',
  shape: { type: 'cylinder', radius: 0.014, height: 0.03 },
  parentId: null,
  mountId: null,
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  mass: null,
  ...over,
})

describe('linked parts', () => {
  it('take their size from the component, by category', () => {
    const motor = byName('MN3110 KV700')
    expect(round(linkedShape(part(), motor))).toEqual({ type: 'cylinder', radius: 0.01885, height: 0.0285 })
    // Propeller: the swept disc from the stated diameter; the part's own thickness is kept.
    const prop = linkedShape(part({ kind: 'propeller', shape: { type: 'cylinder', radius: 0.1, height: 0.006 } }), byName('10x4.5MR'))
    expect(round(prop)).toEqual({ type: 'cylinder', radius: 0.127, height: 0.006 })
    const battery = linkedShape(part({ kind: 'battery', shape: { type: 'box', size: [0.1, 0.1, 0.1] } }), byName('Tattu G-Tech 5200mAh 4S 35C'))
    expect(battery?.type === 'box' && r(battery.size)).toEqual([0.133, 0.045, 0.0335])
    expect(linkedShape(part({ kind: 'flight-controller' }), byName('Pixhawk 6C'))).toMatchObject({ type: 'box' })
    // The GPS states no box size: the part keeps its own shape. Imported models always keep their mesh.
    expect(linkedShape(part({ kind: 'payload' }), byName('M10 GPS'))).toBeNull()
    expect(linkedShape(part({ shape: { type: 'model', assetId: 'a'.repeat(64), units: 'mm', upAxis: 'y' } }), motor)).toBeNull()
  })

  it('use the stated mass (converted to kg) while linked, and their own value otherwise', () => {
    const own = { valueKg: 0.05, source: 'user' as const }
    const motor = part({ mass: own, componentId: byName('MN3110 KV700').id })
    expect(effectiveMass(motor, index)).toMatchObject({ valueKg: 0.099, from: 'component', spec: { value: 99, unit: 'g', source: 'manufacturer' } })
    const apc = effectiveMass(part({ kind: 'propeller', componentId: byName('10x4.5MR').id }), index)!
    expect(apc.valueKg).toBeCloseTo(0.53 * 0.028349523125, 12) // 0.53 oz
    expect(effectiveMass({ ...motor, componentId: null }, index)).toEqual({ valueKg: 0.05, from: 'part' })
    // A link to a component that states no mass falls back to the part's own value.
    const noMass = { ...byName('PM02 V3'), id: randomUUID(), specs: {} } as Component
    expect(effectiveMass(part({ mass: own, componentId: noMass.id }), { [noMass.id]: noMass })).toEqual({ valueKg: 0.05, from: 'part' })
    expect(effectiveMass(part({ componentId: randomUUID() }), index)).toBeNull() // missing component, no own value
  })

  it('are resolved for display only: the stored document keeps the own values, so unlinking restores them', () => {
    const own = part()
    const linked = { ...own, componentId: byName('MN3110 KV700').id }
    const doc: AssemblyDocument = { frame: STARTING_FRAME['quad-x'], motors: {}, parts: [linked] }
    const shown = resolveLinks(doc, index)
    expect(round(shown.parts[0]!.shape)).toEqual({ type: 'cylinder', radius: 0.01885, height: 0.0285 })
    expect(doc.parts[0]!.shape).toEqual(own.shape)
    expect(effectiveShape({ ...linked, componentId: null }, index)).toEqual(own.shape)
    expect(resolveLinks({ ...doc, parts: [own] }, index)).toStrictEqual({ ...doc, parts: [own] }) // no links: same content
  })

  it('a part added onto a linked motor rests on the motor’s stated height', () => {
    const motor = part({ componentId: byName('MN3110 KV700').id })
    const doc: AssemblyDocument = { frame: STARTING_FRAME['quad-x'], motors: {}, parts: [motor] }
    const { part: prop } = addPart(doc, 'propeller', { kind: 'part', id: motor.id }, 0, randomUUID(), {}, (p) => effectiveShape(p, index))
    expect(prop.position[2]).toBeCloseTo(0.0285 / 2 + 0.008 / 2, 12)
    expect(r(shapeExtent(effectiveShape(motor, index))!)).toEqual([0.0377, 0.0377, 0.0285])
  })

  it('offer only components of fitting categories', () => {
    const all = Object.values(index)
    expect(new Set(linkableComponents('motor', all).map((c) => c.category))).toEqual(new Set(['motor']))
    expect(new Set(linkableComponents('payload', all).map((c) => c.category))).toEqual(new Set(['peripheral', 'power-module']))
    expect(linkableComponents('custom', all)).toHaveLength(all.length)
  })
})

describe('links in storage', () => {
  let repos: ReturnType<typeof createRepositories>
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'))
    loadBuiltIns(repos)
  })

  it('save a link, refuse a link to a missing component, and refuse deleting a component in use', () => {
    const project = repos.projects.create({ name: 'Linked quad', frameType: 'quad-x' })
    const copy = repos.components.duplicate(byName('MN3110 KV700').id)
    const doc = (componentId: string) => ({
      projectId: project.id,
      baseRevision: 0,
      frame: STARTING_FRAME['quad-x'],
      motors: {},
      parts: [part({ componentId })],
    })
    expect(() => repos.assemblies.save(doc(randomUUID()))).toThrow(ValidationError)
    repos.assemblies.save(doc(copy.id))
    expect(repos.assemblies.load(project.id).parts[0]!.componentId).toBe(copy.id)
    expect(() => repos.components.delete(copy.id)).toThrow('Used by 1 part in "Linked quad". Unlink it in the workshop first.')
    // Unlinked parts round-trip without the field.
    const input: ComponentInput = { category: 'motor', name: 'Spare', manufacturer: null, notes: null, specs: {} }
    const spare = repos.components.create(input)
    repos.components.delete(spare.id)
  })
})
