/**
 * Phase 4.5 motor, propeller and battery models (src/domain/propulsion.ts).
 * Plan test 6: the fit reproduces the cited table rows within the reported error,
 * and the steady-state solver is checked against a hand solution.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component, QuantityValue } from '../../electron/ipc/component-fields'
import {
  analyseMotor,
  batteryModel,
  fitPair,
  fitSquareLaw,
  labelMatchesProp,
  motorElectrical,
  parsePropSize,
  propInertia,
  propulsionDefinition,
  readyToFly,
  rotorInertia,
  steadyState,
  terminalVoltage,
  type MotorElectrical,
  type MotorSlot,
  type ReadyInput,
} from '../../src/domain/propulsion'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as {
  components: Component[]
}
const byName = (name: string): Component => {
  const c = seed.components.find((x) => x.name === name)
  if (!c) throw new Error(`no seed component ${name}`)
  return { ...c, origin: 'built-in', schemaVersion: 1, revision: 1, createdAt: '', updatedAt: '' }
}
const KV470 = byName('MN3110 KV470')
const KV700 = byName('MN3110 KV700')
const KV780 = byName('MN3110 KV780')
const P13 = byName('P13*4.4 CF propeller')
const P15 = byName('P15*5 CF propeller')
const APC10 = byName('10x4.5MR')
const TATTU = byName('Tattu G-Tech 5200mAh 4S 35C')

const withSpec = (c: Component, key: string, spec: QuantityValue): Component => ({ ...c, specs: { ...c.specs, [key]: spec } })
const RPM = (2 * Math.PI) / 60
const GF = 9.80665e-3

describe('square-law fit', () => {
  it('is exact on exact data and is the least-squares k = Σyω²/Σω⁴', () => {
    const f = fitSquareLaw([100, 200, 300].map((w) => ({ omega: w, y: 2e-5 * w * w })))!
    expect(f.k).toBeCloseTo(2e-5, 15)
    expect(f.maxAbsError).toBeLessThan(1e-12)
    // Two points (1, 1) and (2, 5): k = (1·1 + 5·4) / (1 + 16) = 21/17.
    const g = fitSquareLaw([
      { omega: 1, y: 1 },
      { omega: 2, y: 5 },
    ])!
    expect(g.k).toBeCloseTo(21 / 17, 15)
    expect(g.rows.map((r) => r.error)).toEqual([21 / 17 - 1, (84 / 17 - 5) / 5])
  })
  it('skips points that carry no information and returns null without any', () => {
    expect(fitSquareLaw([{ omega: 0, y: 1 }, { omega: 10, y: 0 }])).toBeNull()
    expect(fitSquareLaw([{ omega: 0, y: 1 }, { omega: 10, y: 1 }])!.rows).toHaveLength(1)
  })
})

describe('motor model', () => {
  it('derives K_v and K_t = 60/(2π·KV) from the stated KV', () => {
    const e = motorElectrical(KV470)
    if (!e.ok) throw new Error('incomplete')
    expect(e.value.kv).toBeCloseTo((470 * 2 * Math.PI) / 60, 12)
    expect(e.value.kt).toBeCloseTo(60 / (2 * Math.PI * 470), 15)
    expect(e.value.resistance).toBeCloseTo(0.135, 15)
    expect(e.value.noLoadCurrent).toBe(0.3)
    expect(e.value.noLoadCondition).toBe('Idle current at 10 V')
  })
  it('lists what a motor without data is missing', () => {
    const bare = { ...KV470, specs: { kv: KV470.specs.kv! } }
    expect(motorElectrical(bare)).toEqual({ ok: false, missing: ['internalResistance', 'noLoadCurrent'] })
  })

  // Hand solution. K_v = 100 rad/(s·V), R = 0.1 Ω, I₀ = 0.5 A, k_Q = 1e-7 N·m·s², V = 10 V, d = 1:
  //   a = R·k_Q·K_v = 1e-6,  b = 1/K_v = 0.01,  c = V − R·I₀ = 9.95
  //   ω = (−0.01 + √(0.01² + 4·1e-6·9.95)) / (2·1e-6) = (−0.01 + √1.398e-4) / 2e-6
  //     = (−0.01 + 0.0118237050…) / 2e-6 = 911.852502 rad/s
  //   I_m = I₀ + k_Q ω²/K_t = 0.5 + 1e-7 · 911.8525² · 100 = 8.814750 A
  //   check: ω/K_v + R·I_m = 9.118525 + 0.881475 = 10.000000 V
  const hand: MotorElectrical = { kv: 100, kt: 0.01, resistance: 0.1, noLoadCurrent: 0.5, noLoadCondition: null }
  it('steady state matches the hand solution', () => {
    const s = steadyState(hand, 1e-7, 10, 1)
    expect(s.omega).toBeCloseTo(911.852502, 5)
    expect(s.motorCurrent).toBeCloseTo(8.81475, 5)
    expect(s.supplyCurrent).toBeCloseTo(8.81475, 5)
    expect(s.omega / hand.kv + hand.resistance * s.motorCurrent).toBeCloseTo(10, 12)
  })
  it('without drag torque the speed is K_v(V − R·I₀); below R·I₀ the motor does not turn', () => {
    expect(steadyState(hand, 0, 10, 1).omega).toBeCloseTo(100 * 9.95, 10)
    expect(steadyState(hand, 1e-7, 10, 0.004).omega).toBe(0)
  })
  it('at part throttle the supply current is d·I_m and both equations hold', () => {
    const d = 0.6
    const s = steadyState(hand, 1e-7, 10, d)
    expect(s.supplyCurrent).toBeCloseTo(d * s.motorCurrent, 12)
    expect(s.omega / hand.kv + hand.resistance * s.motorCurrent).toBeCloseTo(d * 10, 12)
    expect(hand.kt * (s.motorCurrent - hand.noLoadCurrent)).toBeCloseTo(1e-7 * s.omega ** 2, 12)
  })
  it('with a battery resistance the pack sags: V = V_oc − R_int·I_s and V_m = d·V', () => {
    const d = 0.5
    const vOc = 20
    const rInt = 0.2
    const s = steadyState(hand, 1e-7, vOc, d, rInt)
    const v = vOc - rInt * s.supplyCurrent
    expect(s.motorVoltage).toBeCloseTo(d * v, 12)
    expect(s.omega / hand.kv + hand.resistance * s.motorCurrent).toBeCloseTo(d * v, 12)
    expect(s.omega).toBeLessThan(steadyState(hand, 1e-7, vOc, d).omega)
  })
})

describe('propeller matching', () => {
  it('reads D × P from table labels', () => {
    expect(parsePropSize('T-MOTOR15*5CF')).toEqual({ diameterIn: 15, pitchIn: 5 })
    expect(parsePropSize('T-MOTO13*4.4CF')).toEqual({ diameterIn: 13, pitchIn: 4.4 })
    expect(parsePropSize('10x4.5MR')).toEqual({ diameterIn: 10, pitchIn: 4.5 })
    expect(parsePropSize('no size')).toBeNull()
  })
  it('matches the same maker and size only', () => {
    expect(labelMatchesProp('T-MOTO13*4.4CF', P13, KV470)).toBe(true)
    expect(labelMatchesProp('T-MOTOR14*4.8CF', P13, KV470)).toBe(false)
    const otherMaker = { ...P13, manufacturer: 'APC' }
    expect(labelMatchesProp('T-MOTO13*4.4CF', otherMaker, KV470)).toBe(false)
  })
})

describe('k_T and k_Q fits on the cited data (plan test 6)', () => {
  /** Rows of the motor's table for a prop label, in SI, read independently of the module. */
  const rawRows = (motor: Component, label: string) => {
    const t = motor.specs.thrustTable!.value as { rows: Record<string, number | string>[] }
    return t.rows.filter((r) => r.prop === label) as { voltage: number; throttle: number; thrust: number; current: number; rpm: number }[]
  }

  it('MN3110 KV470 + P13*4.4: fit from the five cited rows, each within the reported error', () => {
    const fit = fitPair(KV470, P13)!
    expect(fit.origin.kind).toBe('motor-table')
    expect(fit.origin.labels).toEqual(['T-MOTO13*4.4CF'])
    expect(fit.origin.reference?.url).toBe('https://store.tmotor.com/product/mn3110-motor-navigator-type.html')
    const rows = rawRows(KV470, 'T-MOTO13*4.4CF')
    expect(fit.kT.rows).toHaveLength(rows.length)
    // Independent least squares from the raw table (gf → N, rpm → rad/s).
    const w = rows.map((r) => r.rpm * RPM)
    const T = rows.map((r) => r.thrust * GF)
    const kT = w.reduce((s, x, i) => s + T[i]! * x * x, 0) / w.reduce((s, x) => s + x ** 4, 0)
    expect(fit.kT.k).toBeCloseTo(kT, 15)
    expect(fit.kT.k).toBeCloseTo(2.294e-5, 8)
    rows.forEach((r, i) => {
      const err = (kT * w[i]! ** 2 - T[i]!) / T[i]!
      expect(Math.abs(err)).toBeLessThanOrEqual(fit.kT.maxAbsError + 1e-15)
      expect(fit.kT.rows[i]!.error).toBeCloseTo(err, 12)
    })
    expect(fit.kT.maxAbsError).toBeLessThan(0.04)
    // k_Q from Q = K_t (I_s/d − I₀).
    const kt = 60 / (2 * Math.PI * 470)
    const Q = rows.map((r) => kt * (r.current / (r.throttle / 100) - 0.3))
    const kQ = w.reduce((s, x, i) => s + Q[i]! * x * x, 0) / w.reduce((s, x) => s + x ** 4, 0)
    expect(fit.kQMethod).toBe('motor-current')
    expect(fit.kQ!.k).toBeCloseTo(kQ, 15)
  })

  it('validates the solver at every cited row and reports the errors', () => {
    const fit = fitPair(KV470, P13)!
    const e = motorElectrical(KV470)
    if (!e.ok) throw new Error('incomplete')
    const rows = rawRows(KV470, 'T-MOTO13*4.4CF')
    expect(fit.validation).toHaveLength(rows.length)
    fit.validation!.forEach((v, i) => {
      const r = rows[i]!
      expect(v.voltage).toBe(r.voltage)
      expect(v.throttle).toBeCloseTo(r.throttle / 100, 15)
      expect(v.rpm.table).toBeCloseTo(r.rpm, 9)
      // The model point satisfies both steady-state equations at the row's voltage and throttle.
      const w = v.rpm.model * RPM
      const im = v.current.model / v.throttle
      expect(w / e.value.kv + e.value.resistance * im).toBeCloseTo(v.voltage * v.throttle, 9)
      expect(e.value.kt * (im - e.value.noLoadCurrent)).toBeCloseTo(fit.kQ!.k * w * w, 12)
      expect(v.rpm.error).toBeCloseTo((v.rpm.model - r.rpm) / r.rpm, 12)
      expect(v.thrust.error).toBeCloseTo((fit.kT.k * w * w - r.thrust * GF) / (r.thrust * GF), 9)
    })
    // The reported errors, as measured on 2026-11-21: within 2 % at 50 % throttle; the
    // ideal-ESC model over-predicts speed at full throttle (17 %).
    expect(Math.abs(fit.validation![0]!.rpm.error)).toBeLessThan(0.02)
    expect(fit.validation![4]!.rpm.error).toBeCloseTo(0.166, 2)
  })

  it('groups rows by size across spellings and voltages (KV700 + P13*4.4 at 11.1 V)', () => {
    const fit = fitPair(KV700, P13)!
    expect(fit.origin.labels).toEqual(['T-MOTOR13*4.4CF'])
    expect(fit.validation!.every((v) => v.voltage === 11.1)).toBe(true)
    expect(fitPair(KV470, P15)!.origin.labels).toEqual(['T-MOTOR15*5CF'])
  })

  it('falls back to the APC performance table, carrying its "computed" condition', () => {
    const fit = fitPair(KV470, APC10)!
    expect(fit.origin.kind).toBe('prop-table')
    expect(fit.origin.condition).toMatch(/^Computed by APC/)
    expect(fit.kT.rows).toHaveLength(22)
    expect(fit.kQMethod).toBe('prop-torque')
    expect(fit.validation).toBeNull()
    // Static thrust at 10 000 rpm is 15.407 N: the fit is within its reported error there.
    const row = fit.kT.rows.find((r) => Math.abs(r.omega - 10000 * RPM) < 1e-9)!
    expect(row.source).toBeCloseTo(15.407, 9)
    expect(Math.abs(row.error)).toBeLessThanOrEqual(fit.kT.maxAbsError)
    expect(fit.kQ!.rows.find((r) => Math.abs(r.omega - 10000 * RPM) < 1e-9)!.source).toBeCloseTo(0.221, 9)
  })

  it('has no data for a pair neither table covers (KV780 + P13*4.4)', () => {
    expect(fitPair(KV780, P13)).toBeNull()
  })
})

describe('inertia', () => {
  it('propeller: blade-as-rod J = m R²/3', () => {
    expect(propInertia(0.0142, 13 * 0.0254)).toBeCloseTo((0.0142 * (13 * 0.0254 * 0.5) ** 2) / 3, 15)
  })
  it('rotor: stated, or J = τ_m K_t²/R; missing otherwise', () => {
    expect(rotorInertia(KV470)).toEqual({ ok: false, missing: 'rotorInertia' })
    const stated = withSpec(KV470, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured' })
    const r = rotorInertia(stated)
    expect(r.ok && r.value).toBeCloseTo(1.5e-5, 18)
    const tau = withSpec(KV470, 'mechanicalTimeConstant', { value: 10, unit: 'ms', source: 'measured' })
    const kt = 60 / (2 * Math.PI * 470)
    const t = rotorInertia(tau)
    expect(t).toMatchObject({ ok: true, from: 'time-constant' })
    expect(t.ok && t.value).toBeCloseTo((0.01 * kt * kt) / 0.135, 18)
  })
})

describe('battery', () => {
  it('the Tattu pack states no internal resistance', () => {
    expect(batteryModel(TATTU)).toEqual({ ok: false, missing: ['internalResistance'] })
  })
  it('with R_int entered: V = V_oc − I·R_int, capacity in coulombs', () => {
    const b = batteryModel(withSpec(TATTU, 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured' }))
    if (!b.ok) throw new Error('incomplete')
    expect(b.value.openCircuitVoltage).toBe(14.8)
    expect(b.value.capacity).toBeCloseTo(5200 * 3.6, 9)
    expect(terminalVoltage(b.value, 20)).toBeCloseTo(14.8 - 20 * 0.012, 12)
  })
})

describe('ready-to-fly checklist', () => {
  const quad = (motor: Component, prop: Component): MotorSlot[] =>
    [1, 2, 3, 4].map((n) => ({
      partId: `m${n}`,
      name: `Motor ${n}`,
      motor: { partId: `m${n}`, name: `Motor ${n}`, component: motor },
      prop: { partId: `p${n}`, name: `Prop ${n}`, component: prop },
    }))
  const base: ReadyInput = {
    frameMassSet: true,
    partsWithoutMass: [],
    motors: quad(KV470, P13),
    battery: { partId: 'b', name: 'Battery 1', component: TATTU },
    bodyCd: null,
  }

  it('lists exactly the values no source states for the built-in parts, once each', () => {
    const items = readyToFly(base)
    expect(items.map((i) => i.id)).toEqual([
      `component:${KV470.id}:rotorInertia`,
      `component:${TATTU.id}:internalResistance`,
      'body-cd',
      'ground-friction',
      'ground-restitution',
    ])
    expect(items[0]!.link).toEqual({ to: 'component', componentId: KV470.id, field: 'rotorInertia' })
    expect(items[1]!.link).toEqual({ to: 'component', componentId: TATTU.id, field: 'internalResistance' })
    expect(items[2]!.link).toEqual({ to: 'body-drag' })
    // Ground settings come with 4.4: listed, without a link until they exist.
    expect(items[3]!.link).toBeNull()
  })

  it('adds frame mass, unlinked parts and pairs without data', () => {
    const slots = quad(KV780, P13)
    slots[1] = { ...slots[1]!, prop: { partId: 'p2', name: 'Prop 2', component: null } }
    const items = readyToFly({ ...base, frameMassSet: false, partsWithoutMass: [{ id: 'cam', name: 'Camera 1' }], motors: slots })
    const ids = items.map((i) => i.id)
    expect(ids.slice(0, 2)).toEqual(['frame-mass', 'part-mass:cam'])
    expect(ids).toContain(`pair:${KV780.id}:${P13.id}`)
    expect(ids).toContain('link:p2')
    expect(items.find((i) => i.id === `pair:${KV780.id}:${P13.id}`)!.link).toEqual({
      to: 'component',
      componentId: P13.id,
      field: 'performanceTable',
    })
  })

  it('is empty when everything is entered, and the engine definition is then complete', () => {
    const motor = withSpec(KV470, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured' })
    const battery = withSpec(TATTU, 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured' })
    const motors = quad(motor, P13)
    expect(readyToFly({ ...base, motors, battery: { partId: 'b', name: 'Battery 1', component: battery }, bodyCd: 1.1, ground: { friction: 0.6, restitution: 0.1 } })).toEqual([])
    const def = propulsionDefinition(motors.map(analyseMotor), battery)!
    expect(def.motors).toHaveLength(4)
    const m = def.motors[0]!
    expect(m.partId).toBe('m1')
    expect(m.thrustCoefNs2).toBeCloseTo(fitPair(motor, P13)!.kT.k, 18)
    expect(m.inertiaKgM2).toBeCloseTo(1.5e-5 + propInertia(0.0142, 13 * 0.0254), 18)
    expect(def.battery).toEqual({ openCircuitVoltageV: 14.8, internalResistanceOhm: 0.012, capacityC: 5200 * 3.6 })
    // Anything missing → no definition.
    expect(propulsionDefinition(quad(KV470, P13).map(analyseMotor), battery)).toBeNull()
  })
})
