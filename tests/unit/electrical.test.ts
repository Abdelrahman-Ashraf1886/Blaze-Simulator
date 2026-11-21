import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component, SpecValue } from '../../electron/ipc/component-fields'
import type { Wire } from '../../electron/ipc/contract'
import { calculate, cableResistance, copperResistivity, DEFAULT_LOAD_CASE, type Calc } from '../../src/domain/electrical'
import { autoWire, type WiringPart } from '../../src/domain/wiring'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const lib = (name: string) =>
  ({
    ...seed.components.find((c) => c.name === name)!,
    origin: 'built-in',
  }) as Component
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const part = (name: string, kind: WiringPart['kind'], component: Component | null, motorNumber: number | null = null): WiringPart => ({ id: id(), name, kind, component, motorNumber })
const user = (v: number, unit: string): SpecValue => ({ value: v, unit, source: 'user' }) as SpecValue
/** A user battery: 4S, 4.2 V/cell full, 3.7 V nominal, 20 mΩ pack, 5000 mAh, 30 C. */
const BATTERY = {
  ...lib('Tattu G-Tech 5200mAh 4S 35C'),
  id: 'user-battery',
  specs: {
    series: { value: 4, source: 'user' },
    cellVoltageMax: user(4.2, 'V'),
    cellVoltageNominal: user(3.7, 'V'),
    internalResistance: user(20, 'mΩ'),
    capacity: user(5000, 'mAh'),
    cRateContinuous: user(30, 'C'),
  },
} as Component

/** Within 0.1 % of the hand-calculated value. */
function near(c: Calc, expected: number) {
  expect(c.value, c.value === null ? c.reason : '').not.toBeNull()
  expect(Math.abs(c.value! - expected) / Math.abs(expected)).toBeLessThan(0.001)
}

const wire = (from: WiringPart, fromPort: string, to: WiringPart, toPort: string, gaugeAwg: number | null = null, lengthMm: number | null = null): Wire => ({
  id: id(),
  from: { partId: from.id, port: fromPort },
  to: { partId: to.id, port: toPort },
  gaugeAwg,
  lengthMm,
  color: null,
})

/** Battery → PM02 (12 AWG, 150 mm) → ESC 1 (14 AWG, 100 mm) and ESC 2 (14 AWG, 200 mm), one MN3110 each. */
function twoMotors() {
  const bat = part('Battery', 'battery', BATTERY)
  const pm = part('PM', 'payload', lib('PM02 V3'))
  const e1 = part('ESC 1', 'esc', lib('Tekko32 F4 45A ESC (AM32)'))
  const e2 = part('ESC 2', 'esc', lib('Tekko32 F4 45A ESC (AM32)'))
  const m1 = part('Motor 1', 'motor', lib('MN3110 KV700'), 1)
  const m2 = part('Motor 2', 'motor', lib('MN3110 KV700'), 2)
  const wires = [wire(bat, 'power', pm, 'in', 12, 150), wire(pm, 'out', e1, 'power', 14, 100), wire(pm, 'out', e2, 'power', 14, 200), wire(e1, 'out1', m1, 'phases'), wire(e2, 'out1', m2, 'phases')]
  return { parts: [bat, pm, e1, e2, m1, m2], wires, bat, pm, e1, e2, m1, m2 }
}

describe('constants and cable resistance', () => {
  it('copper resistivity follows IEC 60028', () => {
    // ρ₂₀ = 1/58 Ω·mm²/m = 1.72414e-8 Ω·m; at 60 °C: × (1 + 0.00393 · 40) = × 1.1572 → 1.99517e-8 Ω·m.
    expect(copperResistivity(20)).toBeCloseTo(1.72414e-8, 12)
    expect(Math.abs(copperResistivity(60) - 1.99517e-8) / 1.99517e-8).toBeLessThan(0.001)
  })

  it('R = ρ·2L/A for 12 AWG, 150 mm at 20 °C', () => {
    // d(12 AWG) = 0.127 mm × 92^(24/39) = 2.05253 mm; A = π·d²/4 = 3.30877 mm².
    // R = 1.72414e-8 Ω·m × 0.300 m / 3.30877e-6 m² = 1.56324 mΩ.
    expect(Math.abs(cableResistance(12, 150, 20) - 1.56324e-3) / 1.56324e-3).toBeLessThan(0.001)
  })
})

describe('steady-state network', () => {
  it('matches the hand calculation: currents, drops, sag, losses (each motor at 21 A, full charge)', () => {
    const { parts, wires, bat, e1, e2, m2 } = twoMotors()
    const r = calculate(parts, wires, {
      mode: 'max',
      battery: 'full',
      conductorTempC: 20,
    })
    expect(r.problem).toBeNull()
    // MN3110: 21 A each (stated, 180 s). Battery current = 2 × 21 = 42 A.
    near(r.battery!.current, 42)
    // V_oc = 4 × 4.2 = 16.8 V; V_terminal = 16.8 − 42 × 0.020 = 15.96 V; battery loss = 42² × 0.020 = 35.28 W.
    near(r.battery!.openCircuit, 16.8)
    near(r.battery!.terminal, 15.96)
    near(r.battery!.loss, 35.28)
    expect(r.battery!.partId).toBe(bat.id)

    // Battery → PM: 42 A × 1.56324 mΩ = 65.656 mV, loss 42² × 1.56324 mΩ = 2.75756 W.
    const main = r.cables.find((c) => c.from.partId === bat.id)!
    near(main.current, 42)
    near(main.drop, 0.0656562)
    near(main.loss, 2.75756)
    // 14 AWG: d = 0.127 × 92^(22/39) = 1.62773 mm, A = 2.08091 mm².
    // PM → ESC 1 (100 mm): R = 1.72414e-8 × 0.2 / 2.08091e-6 = 1.65710 mΩ, ΔV = 21 × 1.65710 mΩ = 34.799 mV.
    // PM → ESC 2 (200 mm): R = 3.31420 mΩ, ΔV = 69.598 mV.
    near(r.cables.find((c) => c.to.partId === e1.id)!.resistance, 1.6571e-3)
    near(r.cables.find((c) => c.to.partId === e2.id)!.drop, 0.0695983)
    // V(ESC 1) = 15.96 − 0.0656562 − 0.0347991 = 15.85954 V; V(ESC 2) = 15.96 − 0.0656562 − 0.0695983 = 15.82475 V.
    near(r.escs.find((x) => x.partId === e1.id)!.voltage, 15.85954)
    near(r.escs.find((x) => x.partId === e2.id)!.voltage, 15.82475)
    near(r.motors.find((x) => x.partId === m2.id)!.voltage, 15.82475) // supplied through its ESC
    // Total loss = 35.28 + 2.75756 + 21² × (1.65710 + 3.31420) mΩ = 35.28 + 2.75756 + 2.19234 = 40.2299 W.
    near(r.totalLoss, 40.2299)
  })

  it('applies the conductor temperature (60 °C) and an entered motor current (10 A)', () => {
    const { parts, wires, bat } = twoMotors()
    const r = calculate(parts, wires, {
      mode: 'fixed',
      motorCurrentA: 10,
      battery: 'nominal',
      conductorTempC: 60,
    })
    // V_oc (nominal) = 4 × 3.7 = 14.8 V; I = 20 A; V_terminal = 14.8 − 20 × 0.02 = 14.4 V.
    near(r.battery!.openCircuit, 14.8)
    near(r.battery!.terminal, 14.4)
    // 12 AWG 150 mm at 60 °C: 1.56324 mΩ × 1.1572 = 1.80898 mΩ; ΔV = 20 × 1.80898 mΩ = 36.180 mV.
    near(r.cables.find((c) => c.from.partId === bat.id)!.drop, 0.03618)
  })

  it('says what is missing instead of guessing', () => {
    const { parts, wires, e1 } = twoMotors()
    const tattu = parts.map((p) => (p.kind === 'battery' ? { ...p, component: lib('Tattu G-Tech 5200mAh 4S 35C') } : p))
    const noLength = wires.map((w) => (w.to.partId === e1.id ? { ...w, lengthMm: null } : w))
    const r = calculate(tattu, noLength, DEFAULT_LOAD_CASE)
    // Tattu states 14.8 V nominal but no internal resistance: open circuit known, sag not.
    near(r.battery!.openCircuit, 14.8)
    expect(r.battery!.terminal).toMatchObject({
      value: null,
      reason: expect.stringContaining('internal resistance not specified'),
    })
    const esc1 = r.escs.find((x) => x.partId === e1.id)!
    expect(esc1.drop).toMatchObject({
      value: null,
      reason: expect.stringContaining('Set the gauge and length'),
    })
    near(esc1.current, 21) // current does not need the cable
    expect(r.totalLoss.value).toBeNull()
    // Full charge: the Tattu page states no full-charge cell voltage.
    expect(calculate(tattu, wires, { ...DEFAULT_LOAD_CASE, battery: 'full' }).battery!.openCircuit).toMatchObject({
      value: null,
      reason: expect.stringContaining('full charge'),
    })
    // An unlinked motor in "max" mode: its ESC and everything upstream are not calculated.
    const unlinked = parts.map((p) => (p.name === 'Motor 1' ? { ...p, component: null } : p))
    expect(calculate(unlinked, wires, DEFAULT_LOAD_CASE).battery!.current).toMatchObject({
      value: null,
      reason: 'Motor 1: maximum current not specified.',
    })
  })

  it('refuses loops and two batteries, and needs a wired battery', () => {
    const { parts, wires, pm, e1, bat } = twoMotors()
    expect(calculate(parts, [...wires, wire(bat, 'power', e1, 'power', 14, 100)], DEFAULT_LOAD_CASE).problem).toMatch(/loop/)
    const second = part('Battery 2', 'battery', BATTERY)
    expect(calculate([...parts, second], [...wires, wire(second, 'power', pm, 'in')], DEFAULT_LOAD_CASE).problem).toMatch(/2 batteries/)
    expect(calculate(parts, [], DEFAULT_LOAD_CASE).problem).toMatch(/No battery/)
  })

  it('rates the battery, power module and ESC outputs for the load case', () => {
    const { parts, wires, pm } = twoMotors()
    const r = calculate(parts, wires, DEFAULT_LOAD_CASE)
    const bat = r.ratings.find((x) => x.what === 'Continuous discharge')!
    near(bat.rated, 150) // 30 C × 5 Ah
    expect(bat.within).toBe(true)
    expect(r.ratings.find((x) => x.partId === pm.id)).toMatchObject({
      within: true,
      rated: { value: 60 },
    }) // 42 A ≤ 60 A
    expect(r.ratings.filter((x) => x.what.startsWith('Output to'))).toHaveLength(2)
  })

  it('auto-wired hex at maximum current: 126 A exceeds the PM02 rating', () => {
    const parts = [
      part('Battery 1', 'battery', lib('Tattu G-Tech 5200mAh 4S 35C')),
      part('Power module', 'payload', lib('PM02 V3')),
      part('Flight controller 1', 'flight-controller', lib('Pixhawk 6C')),
      ...Array.from({ length: 6 }, (_, i) => part(`ESC ${i + 1}`, 'esc', lib('Tekko32 F4 45A ESC (AM32)'))),
      ...Array.from({ length: 6 }, (_, i) => part(`Motor ${i + 1}`, 'motor', lib('MN3110 KV700'), i + 1)),
    ]
    const { wires } = autoWire(parts, id)
    const r = calculate(parts, wires, DEFAULT_LOAD_CASE)
    near(r.battery!.current, 126) // 6 × 21 A
    const pm = r.ratings.find((x) => x.name === 'Power module')!
    expect(pm).toMatchObject({ within: false, rated: { value: 60 } })
    // Tattu: 35 C × 5.2 Ah = 182 A ≥ 126 A.
    expect(r.ratings.find((x) => x.name === 'Battery 1')!.within).toBe(true)
  })
})
