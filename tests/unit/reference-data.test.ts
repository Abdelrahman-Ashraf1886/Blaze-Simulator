import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUnit, toSI } from '../../src/domain/units'

interface Entry {
  key: string
  value: number
  min?: number
  max?: number
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
// Source units without a conversion in src/domain/units.ts; limited to their cited parameters.
const px4SourceUnits: Record<string, string> = {
  MPC_TILTMAX_AIR: 'deg', MPC_TILTMAX_LND: 'deg', MPC_MAN_TILT_MAX: 'deg',
  MPC_VELD_LP: 'Hz', MPC_JERK_MAX: 'm/s^3', MPC_JERK_AUTO: 'm/s^3',
  HTE_HT_NOISE: 'normalized_thrust/s',
}
// MIL-F-8785C states its lengths in feet; src/domain/units.ts has no conversion for ft.
const windShearSourceUnits: Record<string, string> = { z0CategoryC: 'ft', z0OtherPhases: 'ft' }
const si = (e: Entry) => (e.unit ? toSI(e.value, e.unit as never) : e.value)

describe('physics reference data (database/reference/physics.v1.json)', () => {
  it('has the expected format and unique keys per set', () => {
    expect(ref.format).toBe('blaze-uav.reference')
    expect(ref.version).toBe(1)
    expect(ref.sets.map((s) => s.id)).toEqual([
      'isa', 'carbonFibrePlate', 'px4',
      'px4Position', 'px4Allocation', 'px4ThrustModel', 'px4HoverThrust',
      'takeoffLandPx4', 'returnPx4', 'landDetectorConstantsPx4', 'windShear',
    ])
    for (const s of ref.sets) {
      const keys = s.values.map((v) => v.key)
      expect(new Set(keys).size, s.id).toBe(keys.length)
    }
  })

  it('every value is a finite number with a known or documented source unit (or none) and a complete citation', () => {
    for (const s of ref.sets) {
      for (const v of s.values) {
        const where = `${s.id}.${v.key}`
        expect(Number.isFinite(v.value), where).toBe(true)
        if (v.unit !== undefined) {
          const retainedSourceUnit =
            (s.id.startsWith('px4') && px4SourceUnits[v.key] === v.unit) ||
            (s.id === 'returnPx4' && v.key === 'RTL_CONE_ANG' && v.unit === 'deg') ||
            (s.id === 'windShear' && windShearSourceUnits[v.key] === v.unit)
          expect(isUnit(v.unit) || retainedSourceUnit, `${where} unit ${v.unit}`).toBe(true)
        }
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

  it('new PX4 sets cite v1.13.3 definition lines and respect every documented bound', () => {
    const counts = { px4Position: 36, px4Allocation: 1, px4ThrustModel: 1, px4HoverThrust: 6, takeoffLandPx4: 10, returnPx4: 6 }
    for (const [id, count] of Object.entries(counts)) {
      expect(set(id).values, id).toHaveLength(count)
      for (const v of set(id).values) {
        const where = `${id}.${v.key}`
        expect(v.source, where).toBe('software-default')
        expect(v.key, where).toMatch(/^(MC|MPC|HTE|THR|LNDMC|MIS|RTL|NAV)_[A-Z0-9_]+$/)
        expect(v.reference?.url, where).toMatch(
          /^https:\/\/github\.com\/PX4\/PX4-Autopilot\/blob\/v1\.13\.3\/src\/.+\.c#L[1-9]\d*$/,
        )
        expect(v.reference?.locator, where).toMatch(new RegExp(`PARAM_DEFINE_(FLOAT|INT32)\\(${v.key}, `))
        const line = v.reference!.url!.split('#L')[1]
        expect(v.reference?.locator, where).toContain(`line ${line}:`)
        expect(Number.isFinite(v.value), where).toBe(true)
        if (v.min !== undefined) {
          expect(Number.isFinite(v.min), where).toBe(true)
          expect(v.value, where).toBeGreaterThanOrEqual(v.min)
        }
        if (v.max !== undefined) {
          expect(Number.isFinite(v.max), where).toBe(true)
          expect(v.value, where).toBeLessThanOrEqual(v.max)
        }
        if (v.min !== undefined && v.max !== undefined) expect(v.min, where).toBeLessThanOrEqual(v.max)
      }
    }
  })

  it('records the exact return defaults and override ranges in the dedicated set', () => {
    const expected = [
      ['RTL_RETURN_ALT', 60, 0, 150, 59],
      ['RTL_DESCEND_ALT', 30, 2, 100, 75],
      ['RTL_LAND_DELAY', 0, -1, 300, 90],
      ['RTL_MIN_DIST', 10, 0.5, 100, 106],
      ['RTL_CONE_ANG', 45, 0, 90, 138],
      ['RTL_HDG_MD', 0, undefined, undefined, 176],
    ] as const
    for (const [key, value, min, max, line] of expected) {
      const entry = get('returnPx4', key)
      expect([entry.value, entry.min, entry.max], key).toEqual([value, min, max])
      expect(entry.reference?.url, key).toMatch(new RegExp(`/navigator/rtl_params.c#L${line}$`))
    }
  })

  it('takeoffLandPx4 repeats no parameter of another set and leaves out the range-sensor and return parameters', () => {
    const others = new Set(ref.sets.filter((s) => s.id !== 'takeoffLandPx4').flatMap((s) => s.values.map((v) => v.key)))
    for (const v of set('takeoffLandPx4').values) expect(others.has(v.key), v.key).toBe(false)
    const keys = set('takeoffLandPx4').values.map((v) => v.key)
    expect(keys).toEqual([
      'MPC_TKO_RAMP_T', 'MPC_SPOOLUP_TIME', 'MPC_Z_V_AUTO_UP', 'MPC_Z_V_AUTO_DN', 'MPC_YAWRAUTO_MAX',
      'LNDMC_TRIG_TIME', 'LNDMC_Z_VEL_MAX', 'LNDMC_XY_VEL_MAX', 'LNDMC_ROT_MAX', 'MIS_TAKEOFF_ALT',
    ])
    for (const absent of ['MPC_LAND_CRWL', 'MPC_LAND_ALT3']) expect(others.has(absent) || keys.includes(absent), absent).toBe(false)
    expect(keys.some((k) => k.startsWith('RTL_'))).toBe(false)
    expect(get('takeoffLandPx4', 'MPC_TKO_RAMP_T')).toMatchObject({ value: 3, min: 0, max: 5 })
    expect(get('takeoffLandPx4', 'MPC_TKO_RAMP_T')).not.toHaveProperty('unit')
    expect(get('takeoffLandPx4', 'LNDMC_TRIG_TIME')).toMatchObject({ value: 1, unit: 's', min: 0.1, max: 10 })
    expect(get('takeoffLandPx4', 'LNDMC_ROT_MAX')).toMatchObject({ value: 20, unit: 'deg/s' })
    expect(get('takeoffLandPx4', 'LNDMC_ROT_MAX')).not.toHaveProperty('min')
  })

  it('land detector header constants cite their MulticopterLandDetector.h lines', () => {
    const lines: Record<string, number> = { FREEFALL_TRIGGER_TIME_US: 84, LAND_DETECTOR_LAND_PHASE_TIME_US: 87, DIST_FROM_GROUND_THRESHOLD: 90 }
    expect(set('landDetectorConstantsPx4').values.map((v) => v.key)).toEqual(Object.keys(lines))
    for (const v of set('landDetectorConstantsPx4').values) {
      expect(v.source, v.key).toBe('software-default')
      expect(v.reference?.url, v.key).toBe(
        `https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/modules/land_detector/MulticopterLandDetector.h#L${lines[v.key]}`,
      )
      expect(v.reference?.locator, v.key).toContain(`line ${lines[v.key]}: static constexpr`)
    }
    expect(get('landDetectorConstantsPx4', 'FREEFALL_TRIGGER_TIME_US')).toMatchObject({ value: 300, unit: 'ms' })
    expect(get('landDetectorConstantsPx4', 'LAND_DETECTOR_LAND_PHASE_TIME_US')).toMatchObject({ value: 2, unit: 's' })
  })

  it('wind shear z0 values cite MIL-F-8785C 3.7.3.2 as the primary text', () => {
    expect(set('windShear').values.map((v) => v.key)).toEqual(['z0CategoryC', 'z0OtherPhases'])
    expect(get('windShear', 'z0CategoryC')).toMatchObject({ value: 0.15, unit: 'ft', source: 'standard' })
    expect(get('windShear', 'z0OtherPhases')).toMatchObject({ value: 2, unit: 'ft', source: 'standard' })
    for (const v of set('windShear').values) {
      expect(v.reference?.document, v.key).toContain('MIL-F-8785C')
      expect(v.reference?.locator, v.key).toContain('3.7.3.2')
      expect(v.reference?.locator, v.key).toContain('p. 51')
      expect(v.condition, v.key).toContain('Primary text')
      expect(v.value, v.key).toBeGreaterThan(0)
    }
  })

  it('keeps the 38-field Gains set separate and PX4 keys unique across sets', () => {
    expect(set('px4').values).toHaveLength(38)
    const keys = ref.sets.filter((s) => s.id.startsWith('px4')).flatMap((s) => s.values.map((v) => v.key))
    expect(new Set(keys).size).toBe(keys.length)
    expect(get('px4Allocation', 'MC_AIRMODE')).not.toHaveProperty('min')
    expect(get('px4Allocation', 'MC_AIRMODE')).not.toHaveProperty('max')
    expect(get('px4Position', 'MPC_POS_MODE')).not.toHaveProperty('min')
    expect(get('px4Position', 'MPC_POS_MODE')).not.toHaveProperty('max')
    expect(get('px4Position', 'MPC_XY_VEL_ALL').value).toBe(-10)
    expect(get('px4Position', 'MPC_Z_VEL_ALL').value).toBe(-3)
    expect(get('px4Position', 'MPC_LAND_SPEED')).toMatchObject({ min: 0.6 })
    expect(get('px4Position', 'MPC_LAND_SPEED')).not.toHaveProperty('max')
    expect(get('px4ThrustModel', 'THR_MDL_FAC').condition).toContain(
      'rel_thrust = factor * rel_signal^2 + (1-factor) * rel_signal',
    )
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
