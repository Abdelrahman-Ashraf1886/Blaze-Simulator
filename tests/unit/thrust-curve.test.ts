import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component } from '../../electron/ipc/component-fields'
import { batteryModel, fitPair, IDEAL_MAP, motorElectrical, steadyState } from '../../src/domain/propulsion'
import { fitThrustCurve, fitThrustSamples, type ThrustCurveInput } from '../../src/domain/thrust-curve'

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const component = (name: string) => {
  const c = seed.components.find((entry) => entry.name === name)
  if (!c) throw new Error(`Missing built-in ${name}`)
  return c
}

describe('PX4 thrust curve least squares', () => {
  it('recovers synthetic factors with zero residual', () => {
    for (const factor of [0, 0.1, 0.42, 0.8, 1]) {
      const samples = Array.from({ length: 101 }, (_, i) => {
        const throttle = i / 100
        return { throttle, relativeThrust: factor * throttle ** 2 + (1 - factor) * throttle }
      })
      const result = fitThrustSamples(samples)!
      expect(result.factor).toBeCloseTo(factor, 14)
      expect(result.rmsError).toBeLessThan(1e-14)
      expect(result.maxAbsError).toBeLessThan(1e-14)
    }
  })

  it('clamps the least-squares optimum and reports the bounded model error', () => {
    for (const [relativeThrust, factor, raw] of [[0.6, 0, -0.4], [0.1, 1, 1.6]]) {
      const result = fitThrustSamples([{ throttle: 0.5, relativeThrust: relativeThrust! }])!
      expect(result.factor).toBe(factor)
      expect(result.unconstrainedFactor).toBeCloseTo(raw!, 14)
      expect(result.clamped).toBe(true)
      const error = Math.abs((factor! * 0.25 + (1 - factor!) * 0.5) - relativeThrust!)
      expect(result.rmsError).toBeCloseTo(error, 14)
      expect(result.maxAbsError).toBeCloseTo(error, 14)
    }
  })

  it('requires an identifiable factor and rejects invalid samples', () => {
    expect(fitThrustSamples([])).toBeNull()
    expect(fitThrustSamples([{ throttle: 0, relativeThrust: 0 }, { throttle: 1, relativeThrust: 1 }])).toBeNull()
    for (const value of [NaN, Infinity, -0.1, 1.1]) {
      expect(() => fitThrustSamples([{ throttle: value, relativeThrust: 0.5 }])).toThrow(RangeError)
    }
    expect(() => fitThrustSamples([{ throttle: 0.5, relativeThrust: NaN }])).toThrow(RangeError)
  })
})

function builtInInput(): ThrustCurveInput {
  const motor = component('MN3110 KV470')
  const prop = component('P13*4.4 CF propeller')
  const electrical = motorElectrical(motor)
  const pack = component('Tattu G-Tech 5200mAh 4S 35C')
  // The seed does not state pack resistance. Use the explicit 12 mOhm
  // test-fixture input from propulsion.test.ts, not a manufacturer claim.
  const battery = batteryModel({ ...pack, specs: { ...pack.specs, internalResistance: { value: 0.012, unit: 'Ω', source: 'measured' } } })
  if (!electrical.ok || !battery.ok) throw new Error('Incomplete built-in model')
  const pair = fitPair(motor, prop, battery.value.openCircuitVoltage)!
  return {
    motor: electrical.value,
    kQ: pair.kQ!.k,
    map: pair.map,
    supplyVoltage: battery.value.openCircuitVoltage,
    // Four identical motors draw 4I, so each sees V_oc - I*(4R_pack).
    sourceResistance: 4 * battery.value.internalResistance,
    throttleMin: 0.12,
    throttleMax: 1,
    sampleCount: 101,
  }
}

describe('fit to the Phase 4.5 propulsion solver', () => {
  it('reports the built-in motor fit and its actual residual at nominal pack voltage with sag', () => {
    const input = builtInInput()
    const result = fitThrustCurve(input)!
    expect(result.factor).toBeGreaterThanOrEqual(0)
    expect(result.factor).toBeLessThanOrEqual(1)
    expect(result.supplyVoltage).toBe(14.8)
    expect(result.sourceResistance).toBeCloseTo(0.048, 14)
    expect(result.sampleCount).toBe(101)
    expect(result.throttleMin).toBe(0.12)
    expect(result.throttleMax).toBe(1)
    expect(result.extrapolatedSamples).toBeGreaterThan(0)
    const errors = Array.from({ length: input.sampleCount }, (_, i) => {
      const x = input.throttleMin + (input.throttleMax - input.throttleMin) * i / (input.sampleCount - 1)
      const state = steadyState(input.motor, input.kQ, input.supplyVoltage, x, input.sourceResistance, input.map)
      return result.factor * x ** 2 + (1 - result.factor) * x - (state.omega / result.fullThrottleOmega) ** 2
    })
    expect(result.rmsError).toBeCloseTo(Math.sqrt(errors.reduce((sum, e) => sum + e ** 2, 0) / errors.length), 14)
    expect(result.maxAbsError).toBeCloseTo(Math.max(...errors.map(Math.abs)), 14)
    console.info('MN3110 KV470 / P13*4.4, nominal 4S, four motors:', JSON.stringify(result))
  })

  it('normalizes at full throttle even when the fitting range stops earlier', () => {
    const input = { ...builtInInput(), map: IDEAL_MAP, throttleMax: 0.7 }
    const fit = fitThrustCurve(input)!
    const full = steadyState(input.motor, input.kQ, input.supplyVoltage, 1, input.sourceResistance, input.map)
    expect(fit.fullThrottleOmega).toBe(full.omega)
    expect(fit.extrapolatedSamples).toBe(0)
    expect(fitThrustCurve(input)).toEqual(fit)
  })

  it('rejects invalid model/range inputs and returns null without full-throttle thrust', () => {
    const input = builtInInput()
    for (const patch of [{ supplyVoltage: 0 }, { sourceResistance: -1 }, { throttleMin: 1 }, { throttleMax: NaN }, { sampleCount: 2 }, { kQ: -1 }]) {
      expect(() => fitThrustCurve({ ...input, ...patch })).toThrow(RangeError)
    }
    expect(() => fitThrustCurve({ ...input, map: { ...IDEAL_MAP, points: [{ throttle: 0, effectiveDuty: 1 }] } })).toThrow(RangeError)
    expect(fitThrustCurve({ ...input, motor: { ...input.motor, noLoadCurrent: 1e9 } })).toBeNull()
  })
})
