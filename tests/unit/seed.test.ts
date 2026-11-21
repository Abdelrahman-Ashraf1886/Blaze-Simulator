import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Component, SpecValue } from '../../electron/ipc/component-fields'
import { loadBuiltIns } from '../../electron/main/components/seed'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'

const seedPath = join(__dirname, '../../database/seed/components.v1.json')
const seedText = readFileSync(seedPath, 'utf8')
const seed = JSON.parse(seedText) as { components: (Omit<Component, 'origin'> & { id: string })[] }

/** Manufacturer domains the built-in data may cite. */
const ALLOWED_HOSTS = ['docs.holybro.com', 'holybro.com', 'store.tmotor.com', 'www.apcprop.com', 'genstattu.com']

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

  it('has stable, unique ids', () => {
    const ids = seed.components.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
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
