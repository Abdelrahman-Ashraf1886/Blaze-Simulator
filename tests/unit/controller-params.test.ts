import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTROLLER_PARAMS,
  CONTROLLER_PARAM_GROUPS,
  controllerParam,
  controllerParams,
  effectiveParams,
  resetParam,
  resetToDefaults,
  validateOverrides,
  type ParamError,
} from '../../src/domain/controller-params'

const ref = JSON.parse(readFileSync(join(__dirname, '../../database/reference/physics.v1.json'), 'utf8'))
const sets = ref.sets as { id: string; values: {
  key: string; value: number; unit?: string; min?: number; max?: number
  reference: { url: string; locator: string; retrieved: string }
}[] }[]
const tuningSets = sets
  .filter(({ id }) => /^px4/.test(id) || id === 'returnPx4')
  .map((s) => ({ ...s, values: s.values.filter((v) => v.key !== 'RTL_HDG_MD') }))

const errorsOf = (o: unknown): ParamError[] => {
  const r = validateOverrides(o)
  return r.ok ? [] : r.errors
}

describe('the parameter table', () => {
  it('includes the editable controller and return parameters in reference order with no duplicates', () => {
    const keys = tuningSets.flatMap((s) => s.values.map((v) => v.key))
    expect(keys).toHaveLength(91)
    expect(new Set(keys).size).toBe(keys.length)
    expect(CONTROLLER_PARAMS.map((p) => p.name)).toEqual(keys)
  })

  it('copies each default, unit, range and citation from the reference entry', () => {
    for (const s of tuningSets) {
      for (const v of s.values) {
        const p = controllerParam(v.key)!
        expect(p, v.key).toBeDefined()
        expect(p.default, v.key).toBe(v.value)
        expect(p.unit, v.key).toBe(v.unit ?? null)
        expect(p.min, v.key).toBe(v.min ?? null)
        expect(p.max, v.key).toBe(v.max ?? null)
        expect(p.set, v.key).toBe(s.id)
        expect(p.source, v.key).toEqual(v.reference)
      }
    }
  })

  it('puts every parameter in a known group, with these counts', () => {
    const ids = CONTROLLER_PARAM_GROUPS.map((g) => g.id)
    const counts = Object.fromEntries(ids.map((id) => [id, CONTROLLER_PARAMS.filter((p) => p.group === id).length]))
    expect(CONTROLLER_PARAMS.every((p) => ids.includes(p.group))).toBe(true)
    expect(counts).toEqual({ attitude: 7, rate: 21, vertical: 9, position: 36, allocation: 1, thrustModel: 1, hoverEstimator: 7, return: 9 })
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(91)
  })

  it('marks integer parameters from the source definition', () => {
    for (const n of ['MC_AIRMODE', 'MPC_POS_MODE', 'MPC_USE_HTE', 'MPC_ALT_MODE', 'RTL_CONE_ANG']) expect(controllerParam(n)!.integer, n).toBe(true)
    for (const n of ['MC_ROLL_P', 'MPC_THR_HOVER', 'THR_MDL_FAC']) expect(controllerParam(n)!.integer, n).toBe(false)
  })

  it('rejects reference data with a duplicate name or an entry it cannot group', () => {
    const entry = (key: string) => ({ key, value: 1, reference: { url: 'u', locator: 'l', retrieved: 'r' } })
    expect(() => controllerParams({ sets: [{ id: 'px4Allocation', values: [entry('A'), entry('A')] }] })).toThrow(/twice/)
    expect(() => controllerParams({ sets: [{ id: 'px4', values: [entry('NEW_PARAM')] }] })).toThrow(/no group/)
    expect(() => controllerParams({ sets: [] })).toThrow(/no controller or return sets/)
  })
})

describe('validateOverrides', () => {
  it('accepts no overrides and every PX4 default', () => {
    expect(validateOverrides({})).toEqual({ ok: true })
    expect(validateOverrides(Object.fromEntries(CONTROLLER_PARAMS.map((p) => [p.name, p.default])))).toEqual({ ok: true })
  })

  it('accepts a value exactly at a documented bound and refuses one just outside, naming the PX4 bound', () => {
    for (const p of CONTROLLER_PARAMS) {
      if (p.min !== null && p.min !== 0) {
        expect(errorsOf({ [p.name]: p.min }).filter((e) => e.name === p.name && !e.related), `${p.name} at min`).toEqual([])
      }
      if (p.max !== null) {
        expect(errorsOf({ [p.name]: p.max }).filter((e) => e.name === p.name && !e.related), `${p.name} at max`).toEqual([])
      }
    }
    const below = errorsOf({ MPC_TILTMAX_AIR: 19.99 })
    expect(below).toHaveLength(1)
    expect(below[0]!.name).toBe('MPC_TILTMAX_AIR')
    expect(below[0]!.message).toContain('between 20 and 89 deg')
    expect(errorsOf({ MPC_TILTMAX_AIR: 89.01 })[0]!.message).toContain('between 20 and 89')
    expect(errorsOf({ MPC_LAND_SPEED: 0.59 })[0]!.message).toContain('at least 0.6 m/s')
    expect(errorsOf({ MPC_LAND_SPEED: 1000 })).toEqual([]) // no documented maximum
    expect(errorsOf({ MPC_XY_VEL_ALL: -20 })).toEqual([]) // a documented negative minimum
    expect(errorsOf({ MPC_XY_VEL_ALL: -20.1 })[0]!.name).toBe('MPC_XY_VEL_ALL')
    expect(errorsOf({ HTE_HT_NOISE: 0.0001 })).toEqual([])
    expect(errorsOf({ HTE_HT_NOISE: 0.00009 })[0]!.name).toBe('HTE_HT_NOISE')
  })

  it('a parameter with no documented range must be finite and not negative', () => {
    expect(errorsOf({ MC_ROLL_P: 0 })).toEqual([])
    expect(errorsOf({ MC_ROLL_P: 1e6 })).toEqual([])
    expect(errorsOf({ MC_ROLL_P: -0.01 })).toMatchObject([{ name: 'MC_ROLL_P', message: expect.stringContaining('not be negative') }])
    for (const bad of [NaN, Infinity, -Infinity, '6.5', null, undefined, true]) {
      expect(errorsOf({ MC_ROLL_P: bad }), String(bad)).toMatchObject([{ name: 'MC_ROLL_P', message: expect.stringContaining('finite number') }])
    }
  })

  it('refuses a fractional value for an integer parameter', () => {
    expect(errorsOf({ MC_AIRMODE: 1 })).toEqual([])
    expect(errorsOf({ MC_AIRMODE: 1.5 })).toMatchObject([{ name: 'MC_AIRMODE', message: expect.stringContaining('whole number') }])
  })

  it('refuses unknown names, including ones that differ only in case', () => {
    expect(errorsOf({ NOT_A_PARAM: 1 })).toMatchObject([{ name: 'NOT_A_PARAM' }])
    expect(errorsOf({ mc_roll_p: 6 })).toMatchObject([{ name: 'mc_roll_p' }])
    expect(errorsOf({ constructor: 1, __proto__x: 1 }).map((e) => e.name).sort()).toEqual(['__proto__x', 'constructor'])
  })

  it('refuses input that is not an object of numbers', () => {
    for (const bad of [null, undefined, 5, 'x', [1, 2]]) expect(errorsOf(bad), String(bad)).toMatchObject([{ name: '' }])
  })

  it('checks the thrust relation on the effective values (defaults 0.12 ≤ 0.5 ≤ 1)', () => {
    expect(errorsOf({ MPC_THR_MIN: 0.5 })).toEqual([]) // equal to the default hover is allowed
    expect(errorsOf({ MPC_THR_MIN: 0.6 })).toMatchObject([{ name: 'MPC_THR_MIN', related: ['MPC_THR_HOVER', 'MPC_THR_MAX'] }])
    expect(errorsOf({ MPC_THR_MAX: 0.4 })).toMatchObject([{ name: 'MPC_THR_MAX' }])
    expect(errorsOf({ MPC_THR_HOVER: 0.1 })).toMatchObject([{ name: 'MPC_THR_HOVER' }])
    expect(errorsOf({ MPC_THR_HOVER: 0.9 })).toEqual([]) // within 0.12…1
    expect(errorsOf({ MPC_THR_HOVER: 0 }).map((e) => e.message)).toContainEqual('MPC_THR_HOVER must be greater than 0')
    expect(errorsOf({ MPC_THR_MAX: 1.01 })).toMatchObject([{ name: 'MPC_THR_MAX', message: expect.stringContaining('≤ 1') }])
    // Several overrides are judged together, on the effective values.
    expect(errorsOf({ MPC_THR_MIN: 0.2, MPC_THR_HOVER: 0.4, MPC_THR_MAX: 0.8 })).toEqual([])
    expect(errorsOf({ MPC_THR_MIN: 0.5, MPC_THR_HOVER: 0.4, MPC_THR_MAX: 0.8 })).toHaveLength(1)
  })

  it('checks MC_YAW_WEIGHT ≤ 1 and the landing altitudes', () => {
    expect(errorsOf({ MC_YAW_WEIGHT: 1 })).toEqual([])
    expect(errorsOf({ MC_YAW_WEIGHT: 1.01 })).toMatchObject([{ name: 'MC_YAW_WEIGHT' }])
    expect(errorsOf({ MPC_LAND_ALT2: 10 })).toMatchObject([{ name: 'MPC_LAND_ALT2', related: ['MPC_LAND_ALT1'] }]) // equal to the default ALT1
    expect(errorsOf({ MPC_LAND_ALT1: 4 })).toMatchObject([{ name: 'MPC_LAND_ALT1' }]) // below the default ALT2 = 5
    expect(errorsOf({ MPC_LAND_ALT1: 20, MPC_LAND_ALT2: 15 })).toEqual([])
  })

  it('returns every error with its parameter name, and no relation noise for a refused member', () => {
    const errs = errorsOf({ MC_ROLL_P: -1, NOT_A_PARAM: 2, MPC_TILTMAX_AIR: 5, MPC_THR_MIN: NaN, MC_YAW_WEIGHT: 3 })
    expect(errs.map((e) => e.name).sort()).toEqual(['MC_ROLL_P', 'MC_YAW_WEIGHT', 'MPC_THR_MIN', 'MPC_TILTMAX_AIR', 'NOT_A_PARAM'])
    for (const e of errs) expect(e.message, e.name).toContain(e.name)
  })
})

describe('effective values and reset', () => {
  it('gives the PX4 default for every parameter and the override where one is set; the overrides stay separate', () => {
    const overrides = { MC_ROLL_P: 7, MPC_THR_HOVER: 0.6 }
    const eff = effectiveParams(overrides)
    expect(Object.keys(eff)).toEqual(CONTROLLER_PARAMS.map((p) => p.name))
    expect(eff.MC_ROLL_P).toBe(7)
    expect(eff.MPC_THR_HOVER).toBe(0.6)
    expect(eff.MC_PITCH_P).toBe(controllerParam('MC_PITCH_P')!.default)
    expect(overrides).toEqual({ MC_ROLL_P: 7, MPC_THR_HOVER: 0.6 })
    expect(controllerParam('MC_ROLL_P')!.default).toBe(6.5) // the default is still visible
    expect(effectiveParams()).toEqual(effectiveParams({}))
    expect(effectiveParams({ UNKNOWN: 1 })).not.toHaveProperty('UNKNOWN')
  })

  it('resets to no overrides, or removes one', () => {
    expect(resetToDefaults()).toEqual({})
    const o = { MC_ROLL_P: 7, MC_PITCH_P: 7 }
    expect(resetParam(o, 'MC_ROLL_P')).toEqual({ MC_PITCH_P: 7 })
    expect(o).toEqual({ MC_ROLL_P: 7, MC_PITCH_P: 7 })
  })
})
