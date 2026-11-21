import { beforeEach, describe, expect, it } from 'vitest'
import { COMPONENT_CATEGORIES, COMPONENT_FIELDS, type Component, type ComponentInput } from '../../electron/ipc/component-fields'
import { Channels, type IpcResult } from '../../electron/ipc/contract'
import { createHandlers } from '../../electron/ipc/handlers'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { dimensionOf, isUnit } from '../../src/domain/units'

let repos: ReturnType<typeof createRepositories>
let handlers: ReturnType<typeof createHandlers>
beforeEach(() => {
  const db = openDatabase(':memory:')
  expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  repos = createRepositories(db)
  handlers = createHandlers(repos, () => ({}) as never)
})
const call = <T>(channel: string, payload?: unknown) => handlers[channel]!(payload) as IpcResult<T>
const ok = <T>(r: IpcResult<T>): T => {
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}
const error = (r: IpcResult<unknown>) => (r.ok ? null : r.error.message)

/** Placeholder citation for tests; real records cite real documents. */
const cited = { source: 'manufacturer' as const, reference: { url: 'https://example.com/datasheet.pdf', locator: 'p. 2', retrieved: '2026-11-21' } }

const motor = (specs: Record<string, unknown> = {}): ComponentInput =>
  ({
    category: 'motor',
    name: 'Test motor 2306',
    manufacturer: 'Example',
    notes: null,
    specs: {
      kv: { value: 1750, unit: 'rpm/V', ...cited },
      cellsMin: { value: 4, ...cited },
      cellsMax: { value: 6, ...cited },
      mass: { value: 31.5, unit: 'g', source: 'measured', condition: 'with 10 cm leads' },
      ...specs,
    },
  }) as ComponentInput

describe('component field definitions', () => {
  it('every category has fields with unique keys and valid default units', () => {
    for (const c of COMPONENT_CATEGORIES) {
      const keys = COMPONENT_FIELDS[c].map((f) => f.key)
      expect(new Set(keys).size, c).toBe(keys.length)
      for (const f of COMPONENT_FIELDS[c]) {
        if (f.kind === 'quantity') expect(isUnit(f.unit) && dimensionOf(f.unit) === f.dimension, `${c}.${f.key}`).toBe(true)
        if (f.kind === 'table')
          for (const col of f.columns) if (col.kind === 'quantity') expect(dimensionOf(col.unit), `${c}.${f.key}.${col.key}`).toBe(col.dimension)
      }
    }
  })
})

describe('component validation (IPC)', () => {
  it('creates, gets, lists, updates and round-trips a component exactly', () => {
    const created = ok(call<Component>(Channels.componentsCreate, motor()))
    expect(created).toMatchObject({ origin: 'user', revision: 0, schemaVersion: 1, category: 'motor' })
    expect(created.specs).toEqual(motor().specs)
    expect(ok(call<Component>(Channels.componentsGet, { id: created.id }))).toEqual(created)
    expect(ok(call<Component[]>(Channels.componentsList, { category: 'motor' }))).toHaveLength(1)
    expect(ok(call<Component[]>(Channels.componentsList, { category: 'battery' }))).toHaveLength(0)
    const updated = ok(call<Component>(Channels.componentsUpdate, { id: created.id, baseRevision: 0, input: motor({ kv: { value: 1950, unit: 'rpm/V', ...cited } }) }))
    expect(updated.revision).toBe(1)
    expect(updated.specs.kv).toEqual({ value: 1950, unit: 'rpm/V', ...cited })
  })

  it('refuses a manufacturer value without a source or a date: no invented specs', () => {
    expect(error(call(Channels.componentsCreate, motor({ kv: { value: 1750, unit: 'rpm/V', source: 'manufacturer' } })))).toBe(
      'Kv: A manufacturer value needs its source (URL or document title); Kv: A manufacturer value needs the date its source was read',
    )
    expect(
      error(call(Channels.componentsCreate, motor({ kv: { value: 1750, unit: 'rpm/V', source: 'manufacturer', reference: { url: 'https://x.test/a' } } }))),
    ).toBe('Kv: A manufacturer value needs the date its source was read')
    // A document title instead of a URL is fine; a user value needs nothing.
    expect(error(call(Channels.componentsCreate, motor({ kv: { value: 1750, unit: 'rpm/V', source: 'manufacturer', reference: { document: 'Datasheet rev B', retrieved: '2026-11-21' } } })))).toBeNull()
    expect(error(call(Channels.componentsCreate, motor({ kv: { value: 1750, unit: 'rpm/V', source: 'user' } })))).toBeNull()
  })

  it.each([
    ['wrong unit', { kv: { value: 1750, unit: 'A', source: 'user' } }, 'Kv: Unit must be one of rpm/V'],
    ['negative value', { mass: { value: -1, unit: 'g', source: 'user' } }, 'Mass: Value cannot be negative'],
    ['fractional count', { cellsMin: { value: 4.5, source: 'user' } }, 'Cells, minimum: Value must be a whole number'],
    ['min above max', { cellsMin: { value: 6, source: 'user' }, cellsMax: { value: 4, source: 'user' } }, 'Cells, minimum: Minimum cells exceed maximum cells'],
    ['field of another category', { capacity: { value: 1300, unit: 'mAh', source: 'user' } }, 'Unknown field(s) for this category: capacity'],
    ['javascript: URL', { kv: { value: 1, unit: 'rpm/V', source: 'manufacturer', reference: { url: 'javascript:alert(1)', retrieved: '2026-11-21' } } }, 'Kv: Reference URL must start with http:// or https://'],
    ['bad date', { kv: { value: 1, unit: 'rpm/V', source: 'manufacturer', reference: { url: 'https://x.test', retrieved: '21/11/2026' } } }, 'Kv: Retrieved date must be YYYY-MM-DD'],
    ['unknown source', { kv: { value: 1, unit: 'rpm/V', source: 'forum' } }, 'Kv:'],
    ['table unit of the wrong kind', { thrustTable: { source: 'user', value: { units: { thrust: 'g' }, rows: [{ prop: '5x4.3', thrust: 900 }] } } }, 'Manufacturer test data: Column "Thrust" needs a force unit'],
  ])('refuses %s with a message naming the field', (_name, specs, message) => {
    expect(error(call(Channels.componentsCreate, motor(specs)))).toContain(message)
  })

  it('accepts a thrust table with units per column', () => {
    const table = { source: 'user', value: { units: { voltage: 'V', thrust: 'gf', current: 'A' }, rows: [{ prop: '5x4.3x3', voltage: 24, thrust: 1250, current: 28.4 }] } }
    expect(error(call(Channels.componentsCreate, motor({ thrustTable: table })))).toBeNull()
  })

  it('validates flight-controller ports and voltage ranges across units', () => {
    const fc = (specs: Record<string, unknown>) => call(Channels.componentsCreate, { category: 'flight-controller', name: 'FC', manufacturer: null, notes: null, specs })
    expect(error(fc({ ports: { source: 'user', value: [{ name: 'TELEM1', type: 'uart' }, { name: 'GPS1', type: 'uart' }] } }))).toBeNull()
    expect(error(fc({ ports: { source: 'user', value: [{ name: 'TELEM1', type: 'uart' }, { name: 'TELEM1', type: 'can' }] } }))).toContain('Port names must be unique')
    expect(error(fc({ inputVoltageMin: { value: 4500, unit: 'mV', source: 'user' }, inputVoltageMax: { value: 5.5, unit: 'V', source: 'user' } }))).toBeNull()
    expect(error(fc({ inputVoltageMin: { value: 6000, unit: 'mV', source: 'user' }, inputVoltageMax: { value: 5.5, unit: 'V', source: 'user' } }))).toContain('Minimum input voltage exceeds the maximum')
  })

  it('refuses unknown categories and missing names', () => {
    expect(error(call(Channels.componentsCreate, { ...motor(), category: 'frame' }))).toContain("Expected 'motor' | 'propeller'")
    expect(error(call(Channels.componentsCreate, { ...motor(), name: '  ' }))).toBe('Name is required')
  })
})

describe('component repository rules', () => {
  it('rejects a stale update, and a category change', () => {
    const c = ok(call<Component>(Channels.componentsCreate, motor()))
    ok(call(Channels.componentsUpdate, { id: c.id, baseRevision: 0, input: motor() }))
    const stale = call(Channels.componentsUpdate, { id: c.id, baseRevision: 0, input: motor() })
    expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const battery = { category: 'battery', name: 'B', manufacturer: null, notes: null, specs: {} }
    expect(call(Channels.componentsUpdate, { id: c.id, baseRevision: 1, input: battery })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'A component cannot change category.' },
    })
  })

  it('built-in records are read-only; duplicating makes an editable user copy with the same provenance', () => {
    const builtIn = repos.components.create(motor(), 'built-in')
    expect(call(Channels.componentsUpdate, { id: builtIn.id, baseRevision: 0, input: motor() })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('Duplicate it') },
    })
    expect(call(Channels.componentsDelete, { id: builtIn.id })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const copy = ok(call<Component>(Channels.componentsDuplicate, { id: builtIn.id }))
    expect(copy).toMatchObject({ origin: 'user', name: 'Test motor 2306 (copy)', revision: 0 })
    expect(copy.specs).toEqual(builtIn.specs)
    expect(ok(call(Channels.componentsDelete, { id: copy.id }))).toBeNull()
    expect(call(Channels.componentsGet, { id: copy.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(repos.components.count()).toBe(1)
  })
})
