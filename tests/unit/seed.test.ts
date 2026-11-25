import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Component, SpecValue } from '../../electron/ipc/component-fields'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { toSI, type Unit } from '../../src/domain/units'

const seedPath = join(__dirname, '../../database/seed/components.v1.json')
const seedText = readFileSync(seedPath, 'utf8')
const seed = JSON.parse(seedText) as { components: (Omit<Component, 'origin'> & { id: string })[] }

/** Manufacturer domains the built-in data may cite. */
const ALLOWED_HOSTS = [
  'docs.holybro.com', 'holybro.com', 'store.tmotor.com', 'www.apcprop.com', 'genstattu.com',
  'invensense.tdk.com', 'www.te.com', // Pixhawk 6C IMU and barometer makers
]

let repos: ReturnType<typeof createRepositories>
beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'))
})

describe('built-in components', () => {
  it('load into an empty library as read-only built-ins, and a second start changes nothing', () => {
    expect(loadBuiltIns(repos)).toEqual({ added: seed.components.length, updated: 0, unchanged: 0 })
    const all = repos.components.list()
    expect(all).toHaveLength(seed.components.length)
    expect(all.every((c) => c.origin === 'built-in')).toBe(true)
    expect(loadBuiltIns(repos)).toEqual({ added: 0, updated: 0, unchanged: seed.components.length })
  })

  it('is a starter set of 15–25 parts across the main categories', () => {
    expect(seed.components.length).toBeGreaterThanOrEqual(15)
    expect(seed.components.length).toBeLessThanOrEqual(25)
    const categories = new Set(seed.components.map((c) => c.category))
    for (const c of ['motor', 'propeller', 'battery', 'esc', 'flight-controller', 'power-module', 'peripheral']) {
      expect(categories, c).toContain(c)
    }
  })

  it('cites a manufacturer page, with the date read, for every single value', () => {
    for (const c of seed.components) {
      const values = Object.entries(c.specs) as [string, SpecValue][]
      expect(values.length, c.name).toBeGreaterThanOrEqual(3)
      for (const [key, v] of values) {
        const where = `${c.name}.${key}`
        expect(v.source, where).toBe('manufacturer')
        expect(v.reference?.retrieved, where).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        const url = new URL(v.reference!.url!)
        expect(url.protocol, where).toBe('https:')
        expect(ALLOWED_HOSTS, where).toContain(url.host)
      }
    }
  })

  it('manufacturer test tables are internally consistent (power = voltage × current within rounding)', () => {
    const motors = seed.components.filter((c) => c.specs.thrustTable)
    expect(motors.length).toBeGreaterThan(0)
    for (const m of motors) {
      const rows = (m.specs.thrustTable!.value as { rows: Record<string, number>[] }).rows
      expect(rows.length, m.name).toBeGreaterThan(0)
      for (const r of rows) {
        expect(Math.abs(r.voltage! * r.current! - r.power!), `${m.name} ${JSON.stringify(r)}`).toBeLessThan(0.011)
        expect(r.thrust! > 0 && r.rpm! > 0 && r.throttle! > 0 && r.throttle! <= 100).toBe(true)
      }
    }
  })

  it('APC performance tables are static rows whose duplicated columns agree within the printed rounding', () => {
    const props = seed.components.filter((c) => c.specs.performanceTable)
    expect(props.map((p) => p.name).sort()).toEqual(['10x4.5MR', '11x4.5MR', '12x4.5MR'])
    for (const p of props) {
      const t = p.specs.performanceTable!.value as { units: Record<string, Unit>; rows: Record<string, number>[] }
      const dia = p.specs.diameter as { value: number; unit: Unit }
      const D = toSI(dia.value, dia.unit)
      expect(t.rows.length, p.name).toBeGreaterThan(10)
      for (const r of t.rows) {
        const where = `${p.name} @ ${r.rpm} rpm`
        expect(r.airspeed === 0 && r.advanceRatio === 0, where).toBe(true)
        // Imperial and SI columns: each printed to 3 decimals; APC's own conversion adds up to ~0.05 %.
        const near = (a: number, b: number, rounding: number) => Math.abs(a - b) <= rounding + 0.0005 * Math.abs(b)
        expect(near(toSI(r.powerImperial!, 'hp'), r.power!, 0.0005 * 745.7 + 0.0005), where).toBe(true)
        expect(near(toSI(r.thrustImperial!, 'lbf'), r.thrust!, 0.0005 * 4.45 + 0.0005), where).toBe(true)
        expect(near(toSI(r.torqueImperial!, 'in·lbf'), r.torque!, 0.0005 * 0.113 + 0.0005), where).toBe(true)
        // Ct/Cp definitions (file header): P = T·n·D·Cp/Ct, independent of the air density (sea-level ISA per APC's FAQ).
        const n = r.rpm! / 60
        expect(Math.abs((r.thrust! * n * D * r.cp!) / r.ct! / r.power! - 1), where).toBeLessThan(0.01)
      }
    }
  })

  it('has stable, unique ids', () => {
    const ids = seed.components.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('adds the new sensor specifications to a version 4 library and preserves user gap-fills', () => {
    const previous = JSON.parse(seedText) as typeof seed & { seedVersion: number }
    previous.seedVersion = 4
    const addedFields = {
      'Pixhawk 6C': ['imuName', 'gyroNoiseDensity', 'accelNoiseDensity', 'baroRmsNoise'],
      'M10 GPS': ['gpsHorizontalCep'],
      'M9N GPS': ['gpsHorizontalCep'],
    }
    const changed = Object.entries(addedFields).map(([name, keys]) => {
      const part = previous.components.find((c) => c.name === name)!
      for (const key of keys) delete part.specs[key]
      return { id: part.id, keys }
    })

    loadBuiltIns(repos, JSON.stringify(previous))
    const gps = previous.components.find((c) => c.name === 'M10 GPS')!
    const fill = { value: 2.5, unit: 'm', source: 'measured' } as const
    repos.components.setFill(gps.id, 'gpsHorizontalCep', fill)
    const before = new Map(repos.components.list().map((c) => [c.id, c.revision]))
    expect(loadBuiltIns(repos)).toEqual({ added: 0, updated: 3, unchanged: seed.components.length - 3 })
    for (const { id, keys } of changed) {
      const part = repos.components.get(id)
      const source = seed.components.find((c) => c.id === id)!
      expect(part.revision).toBe(before.get(id)! + 1)
      for (const key of keys) expect(part.specs[key]).toEqual(source.specs[key])
    }
    expect(repos.components.get(gps.id).fills?.gpsHorizontalCep).toEqual(fill)
    expect(loadBuiltIns(repos)).toEqual({ added: 0, updated: 0, unchanged: seed.components.length })
  })

  it('a corrected seed updates the built-in in place; user copies and same-id user records are left alone', () => {
    loadBuiltIns(repos)
    const px = repos.components.list().find((c) => c.name === 'Pixhawk 6C')!
    const copy = repos.components.duplicate(px.id)
    const corrected = JSON.parse(seedText)
    const entry = corrected.components.find((c: { id: string }) => c.id === px.id)
    entry.notes = 'Corrected note'
    expect(loadBuiltIns(repos, JSON.stringify(corrected))).toMatchObject({ updated: 1, added: 0 })
    const after = repos.components.get(px.id)
    expect(after).toMatchObject({ notes: 'Corrected note', revision: px.revision + 1, origin: 'built-in' })
    expect(repos.components.get(copy.id).notes).toBe(px.notes)

    // An id held by a user's own record (e.g. imported from a pack) is never overwritten.
    const fresh = createRepositories(openDatabase(':memory:'))
    fresh.components.create({ ...entry, notes: 'mine' }, 'imported', px.id)
    loadBuiltIns(fresh, JSON.stringify(corrected))
    expect(fresh.components.get(px.id)).toMatchObject({ origin: 'imported', notes: 'mine' })
  })
})
