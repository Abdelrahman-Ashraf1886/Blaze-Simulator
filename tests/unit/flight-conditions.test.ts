/**
 * The flight conditions (4.8 part B) are saved per project, like the 4.4 environment values: schema v12
 * (`assemblies.flight_json`), the strict document schema, the repository, and the migration of a v11 database.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FlightConditionsDoc, FlightSensorsDoc } from '../../electron/ipc/contract'
import { flightConditionsDocSchema, saveAssemblySchema } from '../../electron/ipc/schemas'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import { STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'
import { conditionsOf, EMPTY_CONDITIONS } from '../../src/features/flight/readiness'

const dir = mkdtempSync(join(tmpdir(), 'blaze-flight-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const entered: FlightConditionsDoc = { ambientAltitudeM: 1500, temperatureC: 12.5, cutoffType: 'chargeMah', cutoffValue: 4200 }
const sensors: FlightSensorsDoc = {
  mode: 'flyOnGyro', seed: -1, flightControllerPartId: 'controller',
  gyro: { bias: null, delayMs: 4 }, accelerometer: { mountPositionM: [0, 0, 0] },
  gyroFilters: { notch0: { frequencyHz: 0 }, notch1: null }, gps: { periodMs: 1000 }, barometer: null,
}

describe('flight conditions document', () => {
  const ok = (v: unknown) => flightConditionsDocSchema.safeParse(v).success
  it('takes the user entries, each optional (null = not entered)', () => {
    expect(ok(entered)).toBe(true)
    expect(ok(EMPTY_CONDITIONS)).toBe(true)
    expect(ok({ ...entered, temperatureC: null })).toBe(true)
  })
  it('refuses values out of range, unknown keys, a missing cut-off type and non-numbers', () => {
    for (const bad of [
      { ...entered, ambientAltitudeM: 12000 },
      { ...entered, ambientAltitudeM: -6000 },
      { ...entered, cutoffValue: 0 },
      { ...entered, cutoffValue: -4 },
      { ...entered, cutoffType: 'capacity' },
      { ...entered, temperatureC: Number.NaN },
      { ...entered, extra: 1 },
      { ambientAltitudeM: 0, temperatureC: null, cutoffValue: 1 },
    ]) expect(ok(bad), JSON.stringify(bad)).toBe(false)
  })
  it('round-trips partial sensor settings and preserves absent and null sensor fields', () => {
    for (const flight of [entered, { ...entered, sensors: null }, { ...entered, sensors }, { ...entered, sensors: { mode: 'off' } }]) {
      expect(flightConditionsDocSchema.parse(JSON.parse(JSON.stringify(flight)))).toStrictEqual(flight)
    }
    for (const bad of [
      { ...sensors, mode: 'on' }, { ...sensors, flyOnGyro: true }, { ...sensors, seed: 0.5 },
      { ...sensors, gyro: { range: 0 } }, { ...sensors, gyro: { delayMs: 0.5 } },
      { ...sensors, gyro: { delaySteps: 1 } }, { ...sensors, gyro: { bias: [1, 2] } },
      { ...sensors, gps: { periodMs: null } }, { ...sensors, barometer: { sigmaPa: -1 } },
      { ...sensors, gyroFilters: { notch0: { frequencyHz: 1, other: 2 } } },
      { ...sensors, gyroFilters: { notch0: { bandwidthHz: Number.MAX_VALUE } } },
    ]) expect(ok({ ...entered, sensors: bad }), JSON.stringify(bad)).toBe(false)
  })
})

describe('flight conditions persistence (schema v12)', () => {
  it('is saved with the project and loads back; a project without it loads without the field', () => {
    const db = openDatabase(join(dir, 'flight.db'))
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12)
    const repos = createRepositories(db)
    const p = repos.projects.create({ name: 'Flight', frameType: 'quad-x' })
    const a = repos.assemblies.load(p.id)
    expect(a).not.toHaveProperty('flight')
    expect(conditionsOf(a)).toEqual(EMPTY_CONDITIONS)
    const input = { projectId: p.id, baseRevision: a.revision, frame: a.frame, motors: a.motors, parts: a.parts, flight: entered }
    expect(saveAssemblySchema.safeParse(input).success).toBe(true)
    repos.assemblies.save(input)
    const loaded = repos.assemblies.load(p.id)
    expect(loaded.flight).toEqual(entered)
    expect(conditionsOf(loaded)).toEqual(entered)
    const extended: FlightConditionsDoc = {
      ...entered,
      wind: {
        kind: 'wind',
        fromDeg: 45,
        mean: { kind: 'shear', speedAt20FtMps: 2, roughness: { kind: 'custom', lengthM: null } },
        gust: { kind: 'none' },
      },
      groundEffect: true,
      sensors,
    }
    const updated = repos.assemblies.save(saveAssemblySchema.parse({ ...input, baseRevision: loaded.revision, flight: extended }))
    expect(repos.assemblies.load(p.id).flight).toEqual(extended)
    repos.assemblies.save(saveAssemblySchema.parse({
      ...input, baseRevision: updated.revision, flight: { ...entered, wind: null, groundEffect: null, sensors: null },
    }))
    expect(repos.assemblies.load(p.id).flight).toEqual({ ...entered, wind: null, groundEffect: null, sensors: null })
    // Clearing it removes the field again.
    repos.assemblies.save({ ...input, baseRevision: repos.assemblies.load(p.id).revision, flight: null })
    expect(repos.assemblies.load(p.id)).not.toHaveProperty('flight')
    // An invalid document is refused before it reaches the database.
    expect(saveAssemblySchema.safeParse({ ...input, flight: { ...entered, cutoffValue: 0 } }).success).toBe(false)
    db.close()
  })

  it('is kept per project, not shared', () => {
    const db = openDatabase(join(dir, 'two.db'))
    const repos = createRepositories(db)
    const [one, two] = [repos.projects.create({ name: 'One', frameType: 'quad-x' }), repos.projects.create({ name: 'Two', frameType: 'quad-x' })]
    const save = (id: string, flight: FlightConditionsDoc) => {
      const a = repos.assemblies.load(id)
      repos.assemblies.save({ projectId: id, baseRevision: a.revision, frame: a.frame, motors: a.motors, parts: a.parts, flight })
    }
    save(one.id, entered)
    save(two.id, { ...entered, ambientAltitudeM: 3000, cutoffType: 'voltageV', cutoffValue: 13.2 })
    expect(repos.assemblies.load(one.id).flight).toEqual(entered)
    expect(repos.assemblies.load(two.id).flight).toMatchObject({ ambientAltitudeM: 3000, cutoffType: 'voltageV', cutoffValue: 13.2 })
    db.close()
  })

  it('a v11 database migrates with its data, gets the column, and constrains it to JSON', () => {
    const path = join(dir, 'v11.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.slice(0, 11)) old.exec(m)
    old.pragma('user_version = 11')
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', 'Old', 'quad-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old
      .prepare("INSERT INTO assemblies (project_id, revision, frame_json, environment_json, updated_at) VALUES ('p1', 4, ?, ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify(STARTING_FRAME['quad-x']), JSON.stringify({ ground: { friction: 0.5, restitution: 0 }, obstacles: [] }))
    expect((old.prepare('PRAGMA table_info(assemblies)').all() as { name: string }[]).map((c) => c.name)).not.toContain('flight_json')
    old.close()

    const db = openDatabase(path)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect((db.prepare('PRAGMA table_info(assemblies)').all() as { name: string }[]).map((c) => c.name)).toContain('flight_json')
    const loaded = createRepositories(db).assemblies.load('p1')
    expect(loaded.revision).toBe(4)
    expect(loaded.environment).toEqual({ ground: { friction: 0.5, restitution: 0 }, obstacles: [] })
    expect(loaded).not.toHaveProperty('flight')
    expect(() => db.prepare("UPDATE assemblies SET flight_json = 'not json'").run()).toThrow()
    db.close()
  })
})
