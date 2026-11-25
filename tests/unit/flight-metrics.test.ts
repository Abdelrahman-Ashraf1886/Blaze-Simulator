import { describe, expect, it } from 'vitest'
import { createFlightMetrics, flightMetricChannels } from '../../src/domain/flight-metrics'
import { telemetryChannels } from '../../src/domain/telemetry-channels'

const channels = telemetryChannels(1, 'flightLoop').map(({ name }) => name)
const byId = (calculator: ReturnType<typeof createFlightMetrics>) =>
  Object.fromEntries(calculator.results().map(({ id, result }) => [id, result]))

describe('recorded flight metrics', () => {
  it('matches every metric to a hand-computed series', () => {
    const calculator = createFlightMetrics({ channels, elapsedS: 5 })
    const q = Math.sqrt(3) / 2
    // Telemetry enum order: flightLoop position = 4, auto hold = 1,
    // manual position input = 5 (telemetry-channels.ts:83–86,115–116).
    const series: Record<string, (number | null)[]> = {
      'controller.land.groundContact': [0, 0, 1, 1],
      'controller.land.maybeLanded': [0, 0, 0, 1],
      'controller.land.landed': [0, 0, 0, 1],
      'state.groundContact': [0, 0, 1, 1],
      'state.quaternion.x': [0, 0.5, 0, 0.5],
      'state.quaternion.y': [0, 0, 0, 0],
      'state.quaternion.z': [0, 0, 0, 0],
      'state.quaternion.w': [1, q, 1, q],
      'state.bodyRates.x': [1, 1, null, 1],
      'state.bodyRates.y': [0, 0, 0, 0],
      'state.bodyRates.z': [0, 0, 0, 0],
      'setpoint.rates.x': [1, 3, 9, 3],
      'setpoint.rates.y': [1, 1, 1, 1],
      'setpoint.rates.z': [-3, 3, -3, 3],
      'state.velocity.x': [3, 0, 0, 0],
      'state.velocity.y': [4, 0, 0, 0],
      'state.velocity.z': [0, -4, 0, 2],
      'controller.autoMode': [1, 1, null, null],
      'controller.mode': [4, 4, 4, 4],
      'input.command': [6, 6, 5, 5],
      'input.stick.forward': [null, null, 0, 1],
      'input.stick.right': [null, null, 0, 0],
      'input.stick.throttle': [null, null, 0, 0],
      'setpoint.position.x': [3, 0, 6, 99],
      'setpoint.position.y': [4, 0, 8, 99],
      'setpoint.position.z': [10, 14, 17, 99],
      'state.com.x': [0, 0, 0, 0],
      'state.com.y': [0, 0, 0, 0],
      'state.com.z': [10, 12, 14, 0],
      'motor.0.throttle': [0, 1, 0.5, 1],
      'pack.voltage': [10, 8, 6, 4],
      'pack.current': [2, 5, 3, 10],
      'pack.chargeUsed': [0, 2, 5, 8],
      'loads.wind.x': [0, 3, 0, 0],
      'loads.wind.y': [0, 4, 0, 0],
      'loads.wind.z': [0, 0, 12, 3],
      'loads.windAboveRange': [1, 0, 0, 1],
      'motor.0.groundEffectBelowTestedRange': [0, 1, 0, 0],
      'loads.windInvalid': [0, 0, 1, 0],
    }
    for (const channel of channels.filter((name) => name.startsWith('controller.saturation.'))) {
      series[channel] = channel.endsWith('positive.roll') ? [0, 1, 0, 0] : [0, 0, 0, 0]
    }
    ;[0, 1, 3, 4].forEach((timeS, i) => calculator.add({
      timeS, values: Object.fromEntries(Object.entries(series).map(([channel, values]) => [channel, values[i]!])),
    }))

    const expected = {
      duration: 5, airtime: 3, 'tilt-max': 60, 'tilt-rms': Math.sqrt(1800),
      'rate-x': Math.sqrt(8 / 3), 'rate-y': 1, 'rate-z': 3,
      'auto-altitude': Math.sqrt(2), 'auto-horizontal': Math.sqrt(25 / 2),
      'centred-altitude': 3, 'centred-horizontal': 10,
      speed: 5, climb: 2, sink: 4, touchdown: 4,
      'motor.0.throttle-mean': 0.625, 'motor.0.throttle-max': 1,
      'motor.0.throttle-0': 1, 'motor.0.throttle-1': 2, 'allocation-saturation': 2,
      voltage: 4, current: 10, charge: 8, energy: 30 + 58 + 29,
      'wind-mean': 5, 'wind-max': 12, 'wind-range': 1, 'ground-effect-range': 2, 'wind-invalid': 1,
    }
    const results = byId(calculator)
    expect(Object.keys(results).sort()).toEqual(Object.keys(expected).sort())
    for (const [id, value] of Object.entries(expected)) {
      expect(results[id]).toEqual({ value: expect.closeTo(value) })
    }
  })

  it('gives a reason for every empty metric and tolerates a single sample', () => {
    const calculator = createFlightMetrics({ channels })
    expect(calculator.results().every(({ name, unit, definition, result }) => name && unit && definition && 'reason' in result)).toBe(true)
    calculator.add({ timeS: 1, values: { 'pack.voltage': 4, 'pack.current': 1 } })
    expect(byId(calculator)).toMatchObject({
      duration: { value: 1 }, voltage: { value: 4 }, current: { value: 1 },
      energy: { reason: expect.any(String) }, airtime: { reason: expect.any(String) },
    })
  })

  it('handles missing channels, null and nonfinite values without bridging missing intervals', () => {
    const inputs = flightMetricChannels(['time', 'pack.voltage', 'pack.current', 'loads.windInvalid', 'pack.chargeUsed'])
    expect(inputs).toEqual(['pack.voltage', 'pack.current', 'loads.windInvalid', 'pack.chargeUsed'])
    const calculator = createFlightMetrics({ channels: inputs })
    const voltage = [10, null, 5, 2]
    voltage.forEach((value, timeS) => calculator.add({
      timeS, values: { 'pack.voltage': value, 'pack.current': 2, 'pack.chargeUsed': null, 'loads.windInvalid': NaN },
    }))
    calculator.add({ timeS: NaN, values: {} })
    expect(byId(calculator)).toMatchObject({
      duration: { value: 3 }, voltage: { value: 2 }, energy: { value: 7 },
      charge: { reason: expect.any(String) }, 'wind-invalid': { reason: expect.any(String) },
      'tilt-max': { reason: expect.any(String) },
    })
    expect(calculator.results().every(({ result }) => 'reason' in result || Number.isFinite(result.value))).toBe(true)
  })

  it('measures a rate step on its recorded axis and leaves the other axes unavailable', () => {
    const calculator = createFlightMetrics({ channels: ['stepTest.setpoint', 'stepTest.measured'], rateStepAxis: 'y' })
    calculator.add({ timeS: 0, values: { 'stepTest.setpoint': 3, 'stepTest.measured': 1 } })
    expect(byId(calculator)).toMatchObject({
      'rate-x': { reason: expect.any(String) }, 'rate-y': { value: 2 }, 'rate-z': { reason: expect.any(String) },
    })
  })
})
