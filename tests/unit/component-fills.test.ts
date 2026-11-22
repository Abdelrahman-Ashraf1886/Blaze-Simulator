/**
 * Catalog gap-fills and part overrides in storage (schema v11): the rules, the
 * handler validation, persistence, duplicate/export, and a seed update under a fill.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Component } from '../../electron/ipc/component-fields'
import { Channels, type IpcResult } from '../../electron/ipc/contract'
import { createHandlers } from '../../electron/ipc/handlers'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { buildPack } from '../../electron/main/components/pack'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase } from '../../electron/main/db/database'
import { STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'

let repos: ReturnType<typeof createRepositories>
let handlers: ReturnType<typeof createHandlers>
beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'))
  loadBuiltIns(repos)
  handlers = createHandlers(repos, () => ({}) as never)
})
const call = <T>(channel: string, payload?: unknown) => handlers[channel]!(payload) as IpcResult<T>
const byName = (name: string) => repos.components.list().find((c) => c.name === name)!
const R_INT = { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire, 1 kHz, 25 °C' }

describe('catalog gap-fills', () => {
  it('fill an empty field of a built-in record: stored apart, listed with the record, removable', () => {
    const tattu = byName('Tattu G-Tech 5200mAh 4S 35C')
    const r = call<Component>(Channels.componentsSetFill, { id: tattu.id, key: 'internalResistance', spec: R_INT })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.fills).toEqual({ internalResistance: R_INT })
    // The record's own values are untouched.
    expect(r.data.specs.internalResistance).toBeUndefined()
    expect(byName('Tattu G-Tech 5200mAh 4S 35C').fills).toEqual({ internalResistance: R_INT })
    expect(repos.components.get(tattu.id).fills).toEqual({ internalResistance: R_INT })
    // Remove.
    const cleared = call<Component>(Channels.componentsSetFill, { id: tattu.id, key: 'internalResistance', spec: null })
    expect(cleared.ok && cleared.data.fills).toBeUndefined()
  })

  it('refuses a manufacturer source, a stated field, a table field, a user record, and a bad unit', () => {
    const tattu = byName('Tattu G-Tech 5200mAh 4S 35C')
    const kv470 = byName('MN3110 KV470')
    const err = (p: unknown) => {
      const r = call(Channels.componentsSetFill, p)
      return r.ok ? null : r.error.message
    }
    expect(err({ id: tattu.id, key: 'internalResistance', spec: { ...R_INT, source: 'manufacturer' } })).toMatch(/never "manufacturer"/)
    expect(err({ id: kv470.id, key: 'internalResistance', spec: { value: 100, unit: 'mΩ', source: 'measured' } })).toMatch(/already states/)
    expect(err({ id: kv470.id, key: 'thrustTable', spec: { value: 1, source: 'user' } })).toMatch(/not a single value/)
    expect(err({ id: tattu.id, key: 'internalResistance', spec: { value: 12, unit: 'rpm', source: 'measured' } })).toMatch(/Unit must be one of/)
    const copy = repos.components.duplicate(tattu.id)
    expect(err({ id: copy.id, key: 'internalResistance', spec: R_INT })).toMatch(/Edit your own components directly/)
  })

  it('duplicate and export carry fills as values with their provenance', () => {
    const kv470 = byName('MN3110 KV470')
    const fill = { value: 150, unit: 'g·cm²', source: 'measured' }
    repos.components.setFill(kv470.id, 'rotorInertia', fill as never)
    const copy = repos.components.duplicate(kv470.id)
    expect(copy.specs.rotorInertia).toEqual(fill)
    expect(copy.fills).toBeUndefined()
    const pack = JSON.parse(buildPack([repos.components.get(kv470.id)])) as { components: { specs: Record<string, unknown> }[] }
    expect(pack.components[0]!.specs.rotorInertia).toEqual(fill)
  })

  it('a seed update never removes a fill; the fill still wins and both are kept', () => {
    const tattu = byName('Tattu G-Tech 5200mAh 4S 35C')
    repos.components.setFill(tattu.id, 'internalResistance', R_INT as never)
    const stated = { value: 9, unit: 'mΩ', source: 'manufacturer', reference: { url: 'https://genstattu.com/x', retrieved: '2026-12-01' } }
    repos.components.replaceBuiltIn(tattu.id, { category: tattu.category, name: tattu.name, manufacturer: tattu.manufacturer, notes: tattu.notes, specs: { ...tattu.specs, internalResistance: stated } as never })
    const after = repos.components.get(tattu.id)
    expect(after.specs.internalResistance).toEqual(stated)
    expect(after.fills).toEqual({ internalResistance: R_INT })
    // Loading the seed again (startup) leaves the fill alone.
    loadBuiltIns(repos)
    expect(repos.components.get(tattu.id).fills).toEqual({ internalResistance: R_INT })
  })
})

describe('part overrides', () => {
  const doc = (projectId: string, overrides?: Record<string, unknown>) => ({
    projectId,
    baseRevision: 0,
    frame: STARTING_FRAME['quad-x'],
    motors: {},
    parts: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Motor 1',
        kind: 'motor' as const,
        shape: { type: 'cylinder' as const, radius: 0.014, height: 0.03 },
        parentId: null,
        mountId: 'motor-1',
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        mass: null,
        componentId: byName('MN3110 KV470').id,
        ...(overrides ? { overrides } : {}),
      },
    ],
  })

  it('persist across save and reload; parts without overrides round-trip without the field', () => {
    const p = repos.projects.create({ name: 'Override quad', frameType: 'quad-x' })
    const overrides = { rotorInertia: { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum' }, mass: { value: 101, unit: 'g', source: 'user' } }
    const input = saveAssemblySchema.parse(doc(p.id, overrides))
    repos.assemblies.save(input)
    expect(repos.assemblies.load(p.id).parts[0]!.overrides).toEqual(overrides)
    repos.assemblies.save(saveAssemblySchema.parse({ ...doc(p.id), baseRevision: 1 }))
    expect(repos.assemblies.load(p.id).parts[0]).not.toHaveProperty('overrides')
  })

  it('the schema refuses a manufacturer source, an unknown key, a table field and a wrong unit', () => {
    const p = repos.projects.create({ name: 'Bad overrides', frameType: 'quad-x' })
    const bad = (o: Record<string, unknown>) => saveAssemblySchema.safeParse(doc(p.id, o)).success
    expect(bad({ mass: { value: 101, unit: 'g', source: 'manufacturer' } })).toBe(false)
    expect(bad({ nonsense: { value: 1, source: 'user' } })).toBe(false)
    expect(bad({ thrustTable: { value: { units: {}, rows: [] }, source: 'user' } })).toBe(false)
    expect(bad({ mass: { value: 101, unit: 'A', source: 'user' } })).toBe(false)
    expect(bad({ mass: { value: 101, unit: 'g', source: 'user' } })).toBe(true)
  })
})
