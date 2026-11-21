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
  IDEAL_MAP,
  analyseMotor,
  benchThrottleMap,
  effectiveDuty,
  batteryModel,
  fitPair,
  fitSquareLaw,
  labelMatchesProp,
  monotone,
  motorElectrical,
  otherTablesKT,
  outsideDomain,
  parsePropSize,
  propInertia,
  propulsionDefinition,
  readyToFly,
  rotorInertia,
  rowDuty,
  statedTestVoltage,
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

describe('throttle map (empirical effective control ratio)', () => {
  const hand: MotorElectrical = { kv: 100, kt: 0.01, resistance: 0.1, noLoadCurrent: 0.5, noLoadCondition: null }
  it('row duty: d·V = E + R·I_s/d solved for d (hand case)', () => {
    // V = 10, ω = 500, I_s = 4: E = 5, d = (5 + √(25 + 16)) / 20 = 0.570156…
    const d = rowDuty(hand, 10, 500, 4)
    expect(d).toBeCloseTo((5 + Math.sqrt(41)) / 20, 15)
    expect(d * 10).toBeCloseTo(5 + (0.1 * 4) / d, 12)
  })
  it('pool-adjacent-violators gives the closest non-decreasing sequence', () => {
    expect(monotone([1, 3, 2, 4])).toEqual([1, 2.5, 2.5, 4])
    expect(monotone([3, 2, 1])).toEqual([2, 2, 2])
    expect(monotone([0.1, 0.2])).toEqual([0.1, 0.2])
  })
  it('interpolates effective duty linearly, holds the ratio outside the steps, flags it, bounds to [0, 1]', () => {
    const map = { ...IDEAL_MAP, origin: 'bench' as const, points: [{ throttle: 0.5, effectiveDuty: 0.45 }, { throttle: 1, effectiveDuty: 0.85 }] }
    expect(effectiveDuty(map, 0.75)).toEqual({ duty: 0.65, extrapolated: false })
    expect(effectiveDuty(map, 0.25)).toEqual({ duty: 0.225, extrapolated: true })
    expect(effectiveDuty(map, 0)).toEqual({ duty: 0, extrapolated: false })
    expect(effectiveDuty(map, 1.5).duty).toBe(0.85)
    expect(effectiveDuty(IDEAL_MAP, 0.42)).toEqual({ duty: 0.42, extrapolated: false })
    const over = { ...map, points: [{ throttle: 0.5, effectiveDuty: 0.6 }] }
    expect(effectiveDuty(over, 1).duty).toBe(1)
  })
  it('the seed maps are monotone in effective voltage and bounded (regression)', () => {
    for (const m of [KV470, KV700, KV780]) {
      const map = benchThrottleMap(m)!
      expect(map.origin).toBe('bench')
      const e = map.points.map((p) => p.effectiveDuty)
      e.forEach((x, i) => {
        expect(x).toBeGreaterThan(0)
        expect(x).toBeLessThanOrEqual(1)
        if (i > 0) expect(x).toBeGreaterThanOrEqual(e[i - 1]!)
      })
      for (let d = 0; d <= 1.0001; d += 0.01) expect(effectiveDuty(map, d + 0.01).duty).toBeGreaterThanOrEqual(effectiveDuty(map, d).duty - 1e-15)
    }
    // KV470 at 100 %: the median of the five 100 % rows (0.853, 0.815, 0.799, 0.862, 0.839).
    expect(benchThrottleMap(KV470)!.points.at(-1)!.effectiveDuty).toBeCloseTo(0.839, 3)
  })
  it('a table whose medians fall is made monotone, and says so', () => {
    const rows = [
      { prop: 'A10*4', voltage: 10, throttle: 50, rpm: 2000, current: 1, thrust: 100 },
      { prop: 'A10*4', voltage: 10, throttle: 60, rpm: 1500, current: 1, thrust: 100 },
      { prop: 'A10*4', voltage: 10, throttle: 100, rpm: 4000, current: 2, thrust: 300 },
    ]
    const units = { voltage: 'V', throttle: '%', rpm: 'rpm', current: 'A', thrust: 'gf' }
    const m = { ...KV470, specs: { ...KV470.specs, thrustTable: { source: 'measured' as const, value: { units, rows } } } } as Component
    const map = benchThrottleMap(m)!
    expect(map.adjusted).toBe(true)
    expect(map.points[0]!.effectiveDuty).toBeCloseTo(map.points[1]!.effectiveDuty, 15)
  })
  it('steady state through a map equals the ideal model at the effective duty', () => {
    const map = { ...IDEAL_MAP, origin: 'bench' as const, points: [{ throttle: 0.5, effectiveDuty: 0.45 }, { throttle: 1, effectiveDuty: 0.85 }] }
    const a = steadyState(hand, 1e-7, 10, 0.75, 0.02, map)
    const b = steadyState(hand, 1e-7, 10, 0.65, 0.02)
    expect(a.omega).toBe(b.omega)
    expect(a.supplyCurrent).toBe(b.supplyCurrent)
    expect(a.effectiveDuty).toBe(0.65)
  })
  it('reads the no-load test voltage from its condition', () => {
    expect(statedTestVoltage('Idle current at 10 V')).toBe(10)
    expect(statedTestVoltage('at 7.4V')).toBe(7.4)
    expect(statedTestVoltage(null)).toBeNull()
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
    return t.rows.filter((r) => r.prop === label) as { voltage: number; throttle: number; thrust: number; current: number; power: number; rpm: number }[]
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
    // k_Q from Q = K_t (I_s/d_eff − I₀), d_eff from each row's own speed and current.
    const kt = 60 / (2 * Math.PI * 470)
    const kv = 1 / kt
    const deff = rows.map((r) => {
      const e = (r.rpm * RPM) / kv
      return (e + Math.sqrt(e * e + 4 * r.voltage * 0.135 * r.current)) / (2 * r.voltage)
    })
    const Q = rows.map((r, i) => kt * (r.current / deff[i]! - 0.3))
    const kQ = w.reduce((s, x, i) => s + Q[i]! * x * x, 0) / w.reduce((s, x) => s + x ** 4, 0)
    expect(fit.kQMethod).toBe('motor-current')
    expect(fit.kQ!.k).toBeCloseTo(kQ, 15)
    // The 4.5 "before" fit used d = throttle.
    const Q0 = rows.map((r) => kt * (r.current / (r.throttle / 100) - 0.3))
    expect(fit.kQIdealDuty!.k).toBeCloseTo(w.reduce((s, x, i) => s + Q0[i]! * x * x, 0) / w.reduce((s, x) => s + x ** 4, 0), 15)
  })

  it('k_Q scatter falls with the effective duty on every motor-table pair (regression)', () => {
    for (const [m, p] of [[KV470, P13], [KV470, P15], [KV700, P13]] as const) {
      const f = fitPair(m, p)!
      expect(f.kQ!.rmsError).toBeLessThan(f.kQIdealDuty!.rmsError)
      expect(f.kQ!.maxAbsError).toBeLessThan(f.kQIdealDuty!.maxAbsError)
    }
    // Measured 2026-11-22 (KV470 + P13*4.4): max 19.1 % → 10.7 %.
    expect(fitPair(KV470, P13)!.kQIdealDuty!.maxAbsError).toBeCloseTo(0.191, 3)
    expect(fitPair(KV470, P13)!.kQ!.maxAbsError).toBeCloseTo(0.107, 3)
  })

  it('validates leave-one-prop-out: the map comes from the other propellers only', () => {
    const fit = fitPair(KV470, P13)!
    const v = fit.validation!
    expect(v.mapIndependent).toBe(true)
    expect(v.map.excluded).toEqual(['T-MOTO13*4.4CF'])
    expect(v.map.rows).toBe(25 - 5)
    // The simulation's map uses every row of the table.
    expect(fit.map.rows).toBe(25)
    expect(fit.map.excluded).toEqual([])
  })

  it('every validation point satisfies the model equations, current/power and energy balance', () => {
    const fit = fitPair(KV470, P13)!
    const e = motorElectrical(KV470)
    if (!e.ok) throw new Error('incomplete')
    const { kv, kt, resistance: R, noLoadCurrent: i0 } = e.value
    const rows = rawRows(KV470, 'T-MOTO13*4.4CF')
    expect(fit.validation!.rows).toHaveLength(rows.length)
    fit.validation!.rows.forEach((v, i) => {
      const r = rows[i]!
      expect(v.voltage).toBe(r.voltage)
      expect(v.throttle).toBeCloseTo(r.throttle / 100, 15)
      expect(v.effectiveDuty).toBeCloseTo(effectiveDuty(fit.validation!.map, v.throttle).duty, 15)
      const w = v.rpm.model * RPM
      const im = v.current.model / v.effectiveDuty
      const vm = v.effectiveDuty * v.voltage
      // Winding and torque balance at the model point.
      expect(w / kv + R * im).toBeCloseTo(vm, 9)
      expect(kt * (im - i0)).toBeCloseTo(fit.kQ!.k * w * w, 12)
      // Ideal converter: V·I_s = V_m·I_m, and the model's power is V·I_s.
      expect(v.voltage * v.current.model).toBeCloseTo(vm * im, 9)
      expect(v.power.model).toBeCloseTo(v.voltage * v.current.model, 12)
      // Energy: V_m·I_m = Q·ω + K_t·I₀·ω + R·I_m².
      expect(vm * im).toBeCloseTo(fit.kQ!.k * w ** 3 + kt * i0 * w + R * im * im, 9)
      // The table's own power column is V × I (to its printed rounding).
      expect(Math.abs(v.tablePowerConsistency!)).toBeLessThan(1e-3)
      expect(v.power.error).toBeCloseTo((v.power.model - r.power) / r.power, 12)
      expect(v.rpm.error).toBeCloseTo((v.rpm.model - r.rpm) / r.rpm, 12)
      expect(v.thrust.error).toBeCloseTo((fit.kT.k * w * w - r.thrust * GF) / (r.thrust * GF), 9)
      expect(v.noLoadShare).toBeCloseTo(i0 / im, 12)
      expect(v.noLoadOutsideStated).toBe(Math.abs(vm - 10) > 0.5)
    })
  })

  it('before/after at full throttle (regression, measured 2026-11-22)', () => {
    const full = (pair: [Component, Component]) => {
      const f = fitPair(...pair)!
      const after = f.validation!.rows.find((r) => r.throttle === 1)!
      const before = f.validationIdeal!.find((r) => r.throttle === 1)!
      return [before.rpm.error, before.thrust.error, after.rpm.error, after.thrust.error].map((x) => Math.round(x * 1000) / 1000)
    }
    expect(full([KV470, P13])).toEqual([0.166, 0.353, -0.029, -0.063])
    expect(full([KV470, P15])).toEqual([0.237, 0.573, 0.047, 0.127])
    expect(full([KV700, P13])).toEqual([0.14, 0.289, -0.002, -0.013])
  })

  it('groups rows by size across spellings and voltages (KV700 + P13*4.4 at 11.1 V)', () => {
    const fit = fitPair(KV700, P13)!
    expect(fit.origin.labels).toEqual(['T-MOTOR13*4.4CF'])
    expect(fit.validation!.rows.every((v) => v.voltage === 11.1)).toBe(true)
    expect(fitPair(KV470, P15)!.origin.labels).toEqual(['T-MOTOR15*5CF'])
  })

  it('falls back to the APC table (sea-level ISA, cited) inside the reachable speed domain', () => {
    const all = fitPair(KV470, APC10)!
    expect(all.origin.kind).toBe('prop-table')
    expect(all.origin.condition).toMatch(/^Computed by APC .*1\.225 kg\/m³ \(APC FAQ/)
    expect(all.kQMethod).toBe('prop-torque')
    expect(all.validation).toBeNull()
    expect(all.domain).toMatchObject({ rowsUsed: 22, rowsTotal: 22, cappedBy: 'table' })
    // Static thrust at 10 000 rpm is 15.407 N: within the reported fit error there.
    const row = all.kT.rows.find((r) => Math.abs(r.omega - 10000 * RPM) < 1e-9)!
    expect(row.source).toBeCloseTo(15.407, 9)
    expect(Math.abs(row.error)).toBeLessThanOrEqual(all.kT.maxAbsError)
    // On a 14.8 V pack the KV470 reaches 470 × 14.8 = 6956 rpm: rows up to 7000 rpm.
    const capped = fitPair(KV470, APC10, 14.8)!
    expect(capped.domain).toMatchObject({ rowsUsed: 7, rowsTotal: 22, cappedBy: 'motor-speed' })
    expect(capped.domain.maxOmega).toBeCloseTo(7000 * RPM, 9)
    expect(capped.kT.maxAbsError).toBeLessThan(all.kT.maxAbsError)
    expect(outsideDomain(capped, 8000 * RPM)).toBe(true)
    expect(outsideDomain(capped, 5000 * RPM)).toBe(false)
    // The APC pair uses the motor's bench map in the simulation.
    expect(capped.map.origin).toBe('bench')
  })

  it('reports k_T of the same propeller in the other motor tables (no pooling)', () => {
    const others = otherTablesKT(P13, KV470, [KV470, KV700, KV780, P13])
    expect(others.map((o) => o.motor.name)).toEqual(['MN3110 KV700'])
    expect(others[0]!.kT).toBeCloseTo(fitPair(KV700, P13)!.kT.k, 18)
    expect(others[0]!.kT / fitPair(KV470, P13)!.kT.k - 1).toBeCloseTo(0.052, 3)
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
    bodyCd: [null, null, null],
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
    expect(items[2]!.link).toEqual({ to: 'body-drag', axis: 'x' })
    expect(items[2]!.label).toBe('Body drag coefficient C_d (x, y, z)')
    // A partly entered C_d names only the missing axes and links to the first.
    const partial = readyToFly({ ...base, bodyCd: [1.1, null, 1.3] }).find((i) => i.id === 'body-cd')!
    expect(partial.label).toBe('Body drag coefficient C_d (y)')
    expect(partial.link).toEqual({ to: 'body-drag', axis: 'y' })
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
    expect(readyToFly({ ...base, motors, battery: { partId: 'b', name: 'Battery 1', component: battery }, bodyCd: [1.1, 1.1, 1.2], ground: { friction: 0.6, restitution: 0.1 } })).toEqual([])
    const def = propulsionDefinition(motors.map((s) => analyseMotor(s)), battery)!
    expect(def.motors).toHaveLength(4)
    const m = def.motors[0]!
    expect(m.partId).toBe('m1')
    expect(m.thrustCoefNs2).toBeCloseTo(fitPair(motor, P13)!.kT.k, 18)
    expect(m.inertiaKgM2).toBeCloseTo(1.5e-5 + propInertia(0.0142, 13 * 0.0254), 18)
    expect(def.battery).toEqual({ openCircuitVoltageV: 14.8, internalResistanceOhm: 0.012, capacityC: 5200 * 3.6 })
    // Anything missing → no definition.
    expect(propulsionDefinition(quad(KV470, P13).map((s) => analyseMotor(s)), battery)).toBeNull()
  })
})

describe('TypeScript/Rust consistency', () => {
  it('reproduces the shared fixture that engine-core also checks (1e-12)', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/propulsion-cases.json'), 'utf8')) as {
      cases: {
        kvRadPerSV: number
        resistanceOhm: number
        noLoadCurrentA: number
        torqueCoefNms2: number
        supplyV: number
        sourceResistanceOhm: number
        throttle: number
        throttleMap: [number, number][]
        expected: { effectiveDuty: number; omega: number; supplyCurrent: number; extrapolated: boolean }
      }[]
    }
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40)
    const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(b)))
    for (const c of fixture.cases) {
      const m: MotorElectrical = { kv: c.kvRadPerSV, kt: 1 / c.kvRadPerSV, resistance: c.resistanceOhm, noLoadCurrent: c.noLoadCurrentA, noLoadCondition: null }
      const map = { ...IDEAL_MAP, origin: c.throttleMap.length ? ('bench' as const) : ('ideal' as const), points: c.throttleMap.map(([throttle, effectiveDuty]) => ({ throttle, effectiveDuty })) }
      const s = steadyState(m, c.torqueCoefNms2, c.supplyV, c.throttle, c.sourceResistanceOhm, map)
      close(s.effectiveDuty, c.expected.effectiveDuty)
      close(s.omega, c.expected.omega)
      close(s.supplyCurrent, c.expected.supplyCurrent)
      expect(s.extrapolated).toBe(c.expected.extrapolated)
    }
  })
  it('the engine definition carries the bench map of the motor', () => {
    const motor = withSpec(KV470, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured' })
    const battery = withSpec(TATTU, 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured' })
    const slot: MotorSlot = { partId: 'm1', name: 'm1', motor: { partId: 'm1', name: 'm1', component: motor }, prop: { partId: 'p1', name: 'p', component: P13 } }
    const def = propulsionDefinition([analyseMotor(slot)], battery)!
    expect(def.motors[0]!.throttleMap).toEqual(benchThrottleMap(KV470)!.points.map((p) => [p.throttle, p.effectiveDuty]))
  })
})
