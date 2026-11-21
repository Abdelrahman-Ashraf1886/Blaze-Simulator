import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUnit, toSI } from '../../src/domain/units'

interface Entry {
  key: string
  value: number
  unit?: string
  source: string
  reference?: { url?: string; document?: string; locator?: string; retrieved?: string }
  condition?: string
  formula?: string
  inputs?: string[]
}
interface RefFile {
  format: string
  version: number
  sets: { id: string; title: string; note?: string; values: Entry[] }[]
}

const ref = JSON.parse(readFileSync(join(__dirname, '../../database/reference/physics.v1.json'), 'utf8')) as RefFile
const set = (id: string) => ref.sets.find((s) => s.id === id)!
const get = (id: string, key: string) => set(id).values.find((v) => v.key === key)!
const si = (e: Entry) => (e.unit ? toSI(e.value, e.unit as never) : e.value)

describe('physics reference data (database/reference/physics.v1.json)', () => {
  it('has the expected format and unique keys per set', () => {
    expect(ref.format).toBe('blaze-uav.reference')
    expect(ref.version).toBe(1)
    expect(ref.sets.map((s) => s.id)).toEqual(['isa', 'carbonFibrePlate', 'px4'])
    for (const s of ref.sets) {
      const keys = s.values.map((v) => v.key)
      expect(new Set(keys).size, s.id).toBe(keys.length)
    }
  })

  it('every value is a finite number with a known unit (or none) and a complete citation', () => {
    for (const s of ref.sets) {
      for (const v of s.values) {
        const where = `${s.id}.${v.key}`
        expect(Number.isFinite(v.value), where).toBe(true)
        if (v.unit !== undefined) expect(isUnit(v.unit), `${where} unit ${v.unit}`).toBe(true)
        expect(['standard', 'manufacturer', 'software-default', 'derived'], where).toContain(v.source)
        expect(v.condition?.trim(), `${where} needs a condition`).toBeTruthy()
        if (v.source === 'derived') {
          expect(v.formula, where).toBeTruthy()
          expect(v.reference, `${where}: a derived value cites its inputs, not a document`).toBeUndefined()
          for (const input of v.inputs ?? []) {
            const src = s.values.find((x) => x.key === input)
            expect(src && src.source !== 'derived', `${where} input ${input}`).toBe(true)
          }
          continue
        }
        expect(v.reference?.url ?? v.reference?.document, `${where} needs a URL or document`).toBeTruthy()
        if (v.reference?.url) expect(new URL(v.reference.url).protocol, where).toBe('https:')
        expect(v.reference?.locator, `${where} needs a locator`).toBeTruthy()
        expect(v.reference?.retrieved, where).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })

  it('derived values follow their formula: R = R*/M0', () => {
    const r = get('isa', 'specificGasConstant')
    expect(r.inputs).toEqual(['universalGasConstant', 'seaLevelMolarMass'])
    const expected = si(get('isa', 'universalGasConstant')) / si(get('isa', 'seaLevelMolarMass'))
    expect(Math.abs(si(r) - expected) / expected).toBeLessThan(5e-7)
  })

  it('the cited sea-level values agree with the standard\'s own equation of state, ρ0 = P0·M0/(R*·T0), to its 5 figures', () => {
    const rho =
      (si(get('isa', 'seaLevelPressure')) * si(get('isa', 'seaLevelMolarMass'))) /
      (si(get('isa', 'universalGasConstant')) * si(get('isa', 'seaLevelTemperature')))
    expect(Math.abs(rho - si(get('isa', 'seaLevelDensity')))).toBeLessThan(5e-5)
  })

  it('PX4 entries are the v1.13.3 parameters by exact name, each citing its PARAM_DEFINE line', () => {
    const px4 = set('px4').values
    for (const v of px4) {
      expect(v.key, v.key).toMatch(/^(MC|MPC)_[A-Z_]+$/)
      expect(v.reference!.url, v.key).toContain('/PX4/PX4-Autopilot/blob/v1.13.3/')
      expect(v.reference!.locator, v.key).toContain(`(${v.key}, `)
    }
    for (const required of [
      'MC_ROLL_P', 'MC_PITCH_P', 'MC_YAW_P',
      'MC_ROLLRATE_P', 'MC_ROLLRATE_I', 'MC_ROLLRATE_D', 'MC_ROLLRATE_FF', 'MC_RR_INT_LIM',
      'MC_PITCHRATE_P', 'MC_PITCHRATE_I', 'MC_PITCHRATE_D', 'MC_PITCHRATE_FF', 'MC_PR_INT_LIM',
      'MC_YAWRATE_P', 'MC_YAWRATE_I', 'MC_YAWRATE_D', 'MC_YAWRATE_FF', 'MC_YR_INT_LIM',
      'MC_ROLLRATE_MAX', 'MC_PITCHRATE_MAX', 'MC_YAWRATE_MAX',
      'MPC_Z_P', 'MPC_Z_VEL_P_ACC', 'MPC_Z_VEL_I_ACC', 'MPC_Z_VEL_D_ACC',
    ]) {
      expect(px4.some((v) => v.key === required), required).toBe(true)
    }
    expect(get('px4', 'MC_ROLL_P').value).toBe(6.5)
    expect(get('px4', 'MC_ROLLRATE_MAX')).toMatchObject({ value: 220, unit: 'deg/s' })
  })
})
