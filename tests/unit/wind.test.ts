import { describe, expect, it } from 'vitest'
import type { WindDoc, WindRoughnessDoc } from '../../electron/ipc/contract'
import { windDocSchema } from '../../electron/ipc/schemas'
import { WindSchema } from '../../electron/main/engine/protocol'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { simGroundEffect } from '../../src/domain/environment'
import type { MotorSlot } from '../../src/domain/propulsion'
import { simWind } from '../../src/domain/wind'

it('round-trips Dryden and explicit off while refusing incomplete or unsafe inputs', () => {
  const base = { kind: 'wind', fromDeg: 90, mean: { kind: 'constant', speedMps: 4.5 }, gust: { kind: 'none' } } as const
  const wire = { fromDeg: base.fromDeg, mean: base.mean, gust: null }
  const dryden = (seed: number | null) => ({ kind: 'dryden', seed }) as const
  for (const turbulence of [null, dryden(0), dryden(Number.MAX_SAFE_INTEGER)]) {
    const doc = { ...base, turbulence }
    expect(windDocSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
    expect(simWind(windDocSchema.parse(doc))).toEqual({ ok: true, wind: WindSchema.parse({ ...wire, turbulence }) })
  }
  const legacy = windDocSchema.parse(base)
  expect(legacy).toEqual(base)
  expect(WindSchema.parse(wire)).toEqual(wire)
  expect(simWind(legacy)).toEqual({ ok: true, wind: wire })
  for (const turbulence of [dryden(-1), dryden(0.5), dryden(Number.MAX_SAFE_INTEGER + 1), { kind: 'dryden' }]) {
    expect(windDocSchema.safeParse({ ...base, turbulence }).success).toBe(false)
    expect(WindSchema.safeParse({ ...wire, turbulence }).success).toBe(false)
  }
  const draft = windDocSchema.parse({ ...base, turbulence: dryden(null) })
  expect(simWind(draft)).toMatchObject({ ok: false, missing: [{ field: 'wind.turbulence.seed' }] })
  expect(WindSchema.safeParse({ ...wire, turbulence: dryden(null) }).success).toBe(false)
  for (const mean of [{ kind: 'none' }, { ...base.mean, speedMps: 0 }] as const) {
    expect(simWind(windDocSchema.parse({ ...base, mean, turbulence: dryden(0) }))).toMatchObject({
      ok: false, missing: [{ field: 'wind.turbulence', message: expect.stringContaining('positive mean wind speed') }],
    })
    expect(WindSchema.safeParse({ ...wire, mean: mean.kind === 'none' ? null : mean, turbulence: dryden(0) }).success).toBe(false)
  }
})

describe('simWind', () => {
  it('preserves legacy omission, distinguishes unset and emits null for explicit calm', () => {
    expect(simWind(undefined)).toEqual({ ok: true })
    expect(simWind(null)).toMatchObject({ ok: false, missing: [{ field: 'wind' }] })
    expect(simWind({ kind: 'none' })).toEqual({ ok: true, wind: null })
  })

  it('passes the clockwise-from angle and constant speed in engine units', () => {
    expect(simWind(windDocSchema.parse({
      kind: 'wind', fromDeg: 90, mean: { kind: 'constant', speedMps: 4.5 }, gust: { kind: 'none' },
    }))).toEqual({ ok: true, wind: { fromDeg: 90, mean: { kind: 'constant', speedMps: 4.5 }, gust: null } })
  })

  it.each<WindRoughnessDoc>([{ kind: 'categoryC' }, { kind: 'otherPhases' }, { kind: 'custom', lengthM: 0.25 }])(
    'passes the shear type and gust parameters for $kind roughness',
    (roughness) => {
      const mean = { kind: 'shear', speedAt20FtMps: 3, roughness } as const
      const gust = { amplitudeMps: 2, lengthM: 12, startS: 0 }
      const doc = { kind: 'wind', fromDeg: -30, mean, gust: { kind: 'discrete', ...gust } }
      expect(simWind(windDocSchema.parse(doc))).toEqual({ ok: true, wind: { fromDeg: -30, mean, gust } })
    },
  )

  it('accepts a gust with no mean and lists every unset gust input', () => {
    const doc: WindDoc = {
      kind: 'wind', fromDeg: 0, mean: { kind: 'none' }, gust: { kind: 'discrete', amplitudeMps: 4, lengthM: 20, startS: 3 },
    }
    expect(simWind(windDocSchema.parse(doc))).toEqual({
      ok: true, wind: { fromDeg: 0, mean: null, gust: { amplitudeMps: 4, lengthM: 20, startS: 3 } },
    })
    const incomplete = windDocSchema.parse({
      ...doc, fromDeg: null, mean: { kind: 'shear', speedAt20FtMps: null, roughness: { kind: 'custom', lengthM: null } },
      gust: { kind: 'discrete', amplitudeMps: null, lengthM: null, startS: null },
    })
    const result = simWind(incomplete)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.missing.map((m) => m.field)).toEqual([
      'wind.fromDeg', 'wind.mean.speedAt20FtMps', 'wind.mean.roughness.lengthM',
      'wind.gust.amplitudeMps', 'wind.gust.lengthM', 'wind.gust.startS',
    ])
    expect(result.missing.every(({ message }) => message.includes('Wind in Flight Conditions'))).toBe(true)
    expect(windDocSchema.safeParse({ ...doc, gust: { ...doc.gust, lengthM: 0 } }).success).toBe(false)
    expect(windDocSchema.safeParse({ ...doc, mean: { kind: 'constant', speedMps: -1 } }).success).toBe(false)
    expect(windDocSchema.safeParse({ ...doc, mean: {
      kind: 'shear', speedAt20FtMps: 1, roughness: { kind: 'custom', lengthM: 3 * 0.3048 },
    } }).success).toBe(false)
  })
})

describe('simGroundEffect', () => {
  it('takes half the resolved Diameter in metres, in motor order', () => {
    const db = openDatabase(':memory:')
    try {
      const repos = createRepositories(db)
      const slot = (partId: string, value: number, unit: 'in' | 'mm'): MotorSlot => {
        const component = repos.components.create({
          category: 'propeller', name: partId, manufacturer: null, notes: null,
          specs: { diameter: { value, unit, source: 'user' } },
        })
        return { partId, name: partId, motor: null, prop: { partId: `prop-${partId}`, name: 'Propeller', component } }
      }
      const motors = [slot('m2', 200, 'mm'), slot('m1', 10, 'in')]
      expect(simGroundEffect(true, motors)).toEqual({ ok: true, radiiM: [0.1, 0.127] })
      const missing = { ...motors[1]!, prop: null }
      expect(simGroundEffect(true, [motors[0]!, missing])).toMatchObject({
        ok: false, missing: [{ field: 'motors[m1].prop.diameter', message: expect.stringContaining('Diameter in Components') }],
      })
      expect(simGroundEffect(null, motors)).toMatchObject({ ok: false, missing: [{ field: 'groundEffect' }] })
      expect(simGroundEffect(false, [missing])).toEqual({ ok: true })
      expect(simGroundEffect(undefined, [missing])).toEqual({ ok: true })
    } finally {
      db.close()
    }
  })
})
