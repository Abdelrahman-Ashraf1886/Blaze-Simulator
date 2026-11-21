import { beforeEach, describe, expect, it } from 'vitest'
import type { Component, ComponentInput } from '../../electron/ipc/component-fields'
import { MAX_PACK_BYTES, MAX_PACK_ENTRIES, PackError, buildPack, importPack, parsePack } from '../../electron/main/components/pack'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { draftFrom, parseNumber, toInput } from '../../src/features/components/editor-model'
import { formatReference, formatValue, matches, provenanceSummary } from '../../src/features/components/spec-format'
import { COMPONENT_FIELDS } from '../../electron/ipc/component-fields'

const cited = { source: 'manufacturer' as const, reference: { url: 'https://www.example.com/ds.pdf', locator: 'p. 2', retrieved: '2026-11-21' } }
const battery: ComponentInput = {
  category: 'battery',
  name: '4S 1300 mAh',
  manufacturer: 'Example',
  notes: null,
  specs: {
    series: { value: 4, ...cited },
    capacity: { value: 1300, unit: 'mAh', ...cited },
    cRateContinuous: { value: 100, unit: 'C', ...cited },
    mass: { value: 182, unit: 'g', source: 'measured', condition: 'with leads' },
  },
}

let repos: ReturnType<typeof createRepositories>
beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'))
})

describe('component packs', () => {
  it('export → delete → import restores identical records (same ids, values and sources)', () => {
    const a = repos.components.create(battery)
    const b = repos.components.create({ ...battery, name: '6S 1100 mAh', specs: { series: { value: 6, source: 'user' } } })
    const text = buildPack([a, b], new Date('2026-11-21T10:00:00Z'))
    expect(JSON.parse(text)).toMatchObject({ format: 'blaze-uav.components', version: 1, exportedAt: '2026-11-21T10:00:00.000Z' })
    repos.components.delete(a.id)
    repos.components.delete(b.id)

    expect(importPack(repos, text)).toEqual({ imported: 2, skipped: 0 })
    const strip = (c: Component) => ({ id: c.id, category: c.category, name: c.name, manufacturer: c.manufacturer, notes: c.notes, specs: c.specs })
    expect(repos.components.list().map(strip)).toEqual([a, b].map(strip))
    expect(repos.components.list().every((c) => c.origin === 'imported')).toBe(true)
    // Re-importing the same pack adds nothing.
    expect(importPack(repos, text)).toEqual({ imported: 0, skipped: 2 })
  })

  it('entries without ids get new ones', () => {
    const text = JSON.stringify({ format: 'blaze-uav.components', version: 1, components: [battery] })
    expect(importPack(repos, text)).toEqual({ imported: 1, skipped: 0 })
    expect(repos.components.list()[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.each([
    ['not JSON', '{ nope', 'The file is not valid JSON.'],
    ['another format', JSON.stringify({ format: 'something-else', version: 1, components: [] }), 'This is not a Blaze UAV component pack'],
    ['a newer version', JSON.stringify({ format: 'blaze-uav.components', version: 2, components: [] }), 'Only pack version 1 is supported'],
  ])('refuses %s', (_n, text, message) => {
    expect(() => parsePack(text)).toThrow(new PackError(message))
  })

  it('refuses the whole pack when any entry is invalid, naming each entry and field; nothing is imported', () => {
    const bad = {
      format: 'blaze-uav.components',
      version: 1,
      components: [
        battery,
        { ...battery, name: 'Uncited', specs: { capacity: { value: 1300, unit: 'mAh', source: 'manufacturer' } } },
        { ...battery, name: 'Wrong unit', specs: { capacity: { value: 1.3, unit: 'kg', source: 'user' } } },
        'garbage',
      ],
    }
    let message = ''
    try {
      importPack(repos, JSON.stringify(bad))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('Nothing was imported. 3 problems:')
    expect(message).toContain('Entry 2 (Uncited): Capacity: A manufacturer value needs its source (URL or document title)')
    expect(message).toContain('Entry 3 (Wrong unit): Capacity: Unit must be one of Ah, mAh')
    expect(message).toContain('Entry 4: not an object')
    expect(repos.components.count()).toBe(0)
  })

  it('round-trips every built-in record exactly: export, import into an empty library, export again is byte-identical (3.8)', () => {
    // Every category, nested ports, thrust tables, conditions, ranges and references.
    expect(loadBuiltIns(repos).added).toBeGreaterThan(0)
    const byId = (a: Component, b: Component) => a.id.localeCompare(b.id)
    const at = new Date('2026-11-21T10:00:00Z')
    const first = buildPack(repos.components.list().sort(byId), at)

    const other = createRepositories(openDatabase(':memory:'))
    expect(importPack(other, first)).toEqual({ imported: repos.components.count(), skipped: 0 })
    const second = buildPack(other.components.list().sort(byId), at)
    expect(second).toBe(first)
    expect(other.components.list().every((c) => c.origin === 'imported')).toBe(true)
  })

  it('refuses a pack that is too large or has too many entries, saying which', () => {
    expect(() => parsePack(' '.repeat(MAX_PACK_BYTES + 1))).toThrow(new PackError('The file is larger than 10 MB.'))
    const many = JSON.stringify({ format: 'blaze-uav.components', version: 1, components: Array.from({ length: MAX_PACK_ENTRIES + 1 }, () => ({})) })
    expect(() => parsePack(many)).toThrow(new PackError(`A pack can hold at most ${MAX_PACK_ENTRIES} components`))
    // More than five bad entries: the first five are listed and the rest counted.
    const bad = JSON.stringify({ format: 'blaze-uav.components', version: 1, components: Array.from({ length: 7 }, () => 'x') })
    expect(() => parsePack(bad)).toThrow(/7 problems:\n(Entry \d: not an object\n){4}Entry 5: not an object\n…and 2 more$/)
  })

  it('refuses duplicate ids inside a pack', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const text = JSON.stringify({ format: 'blaze-uav.components', version: 1, components: [{ id, ...battery }, { id, ...battery }] })
    expect(() => parsePack(text)).toThrow(/share the same id/)
  })
})

describe('component editor model', () => {
  it('round-trips a stored component through the form unchanged', () => {
    const c = repos.components.create(battery)
    const r = toInput(draftFrom(c, 'motor'))
    expect(r).toEqual({ ok: true, input: battery })
  })

  it('requires a source for every value, and numbers where numbers belong', () => {
    const d = draftFrom(null, 'motor')
    d.name = 'M'
    d.fields.kv!.value = '1750' // typed, but no source chosen
    d.fields.mass!.source = 'user' // source chosen, no value
    d.fields.cellsMin!.source = 'user'
    d.fields.cellsMin!.value = 'four'
    const r = toInput(d)
    expect(r).toEqual({
      ok: false,
      errors: [
        'Kv: choose where this value comes from',
        'Cells, minimum: "four" is not a number',
        'Mass: enter a value or set its source to "Not specified"',
      ],
    })
  })

  it('builds references, conditions, ports and tables; skips empty table rows', () => {
    const d = draftFrom(null, 'motor')
    d.name = ' Motor '
    Object.assign(d.fields.kv!, { source: 'manufacturer', value: '1 750'.replace(' ', ''), url: 'https://x.test/ds', retrieved: '2026-11-21', locator: '' })
    Object.assign(d.fields.thrustTable!, { source: 'user', rows: [{ prop: '5x4.3', voltage: '24', thrust: '1250,5' }, {}] })
    const r = toInput(d)
    expect(r.ok && r.input.name).toBe('Motor')
    expect(r.ok && r.input.specs.kv).toEqual({ value: 1750, unit: 'rpm/V', source: 'manufacturer', reference: { url: 'https://x.test/ds', retrieved: '2026-11-21' } })
    expect(r.ok && r.input.specs.thrustTable).toEqual({
      source: 'user',
      value: { units: { voltage: 'V', thrust: 'gf' }, rows: [{ prop: '5x4.3', voltage: 24, thrust: 1250.5 }] },
    })
    const fc = draftFrom(null, 'flight-controller')
    fc.name = 'FC'
    Object.assign(fc.fields.ports!, { source: 'user', ports: [{ name: ' TELEM1 ', type: 'uart' }] })
    const rf = toInput(fc)
    expect(rf.ok && rf.input.specs.ports).toEqual({ source: 'user', value: [{ name: 'TELEM1', type: 'uart' }] })
  })

  it('parses numbers strictly', () => {
    expect(parseNumber('1,5')).toBe(1.5)
    expect(parseNumber(' 2e3 ')).toBe(2000)
    expect(parseNumber('.5')).toBe(0.5)
    for (const bad of ['', '1.2.3', '12abc', 'NaN', 'Infinity', '0x10']) expect(parseNumber(bad)).toBeNull()
  })
})

describe('spec display', () => {
  it('formats values, citations and provenance counts', () => {
    const c = repos.components.create(battery)
    const cap = COMPONENT_FIELDS.battery.find((f) => f.key === 'capacity')!
    expect(formatValue(cap, c.specs.capacity!)).toBe('1300 mAh')
    expect(formatReference(c.specs.capacity!.reference)).toBe('example.com · p. 2 · read 2026-11-21')
    expect(formatReference({ document: 'Datasheet rev B', retrieved: '2026-01-02' })).toBe('Datasheet rev B · read 2026-01-02')
    expect(provenanceSummary(c)).toEqual({ values: 4, cited: 3 })
    expect(matches(c, 'example', 'Battery')).toBe(true)
    expect(matches(c, 'batt', 'Battery')).toBe(true)
    expect(matches(c, 'motor', 'Battery')).toBe(false)
  })
})
