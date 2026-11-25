import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SensorsSchema } from '../../electron/main/engine/protocol'
import { airDensity, isaConstants, isaTemperaturePressure } from '../../src/domain/atmosphere'
import { GPS_SENSOR_FIELDS, resolveSensorSpecs } from '../../src/domain/sensor-specs'
import { buildSensorPayload, GPS_DELAY_SUGGESTION, type SensorSettings } from '../../src/domain/sensors'
import { toSI } from '../../src/domain/units'
import physics from '../../database/reference/physics.v1.json'

const noSpecs = { values: [], missing: [] }
const effectsOff = { noiseSigma: null, vibrationSigma: null, bias: null, randomWalk: null, delayMs: null, range: null }
const off = { seed: -1, gyro: null, accelerometer: null, barometer: null, gps: null }
const mountPositionM: [number, number, number] = [0.01, -0.02, 0.03]
const configured = {
  ...off,
  gyro: { ...effectsOff, delayMs: 2 },
  accelerometer: { ...effectsOff, mountPositionM },
  barometer: { sigmaPa: null, biasPa: null, periodMs: 20, delayMs: null },
  gps: { positionSigmaHorizontalM: null, positionSigmaVerticalM: null, velocitySigmaMps: null, periodMs: 200, delayMs: null },
} satisfies SensorSettings
const conditions = { ambientAltitudeM: 1000, temperatureC: 35 }

describe('sensor request builder', () => {
  it('preserves explicit off choices and sends SI per-sample values and whole steps', () => {
    expect(buildSensorPayload(noSpecs, null, {})).toEqual({ missing: [] })
    expect(buildSensorPayload(noSpecs, off, {})).toEqual({ payload: off, missing: [] })
    const { payload, missing } = buildSensorPayload(noSpecs, configured, conditions)
    expect(missing).toEqual([])
    expect(SensorsSchema.parse(payload)).toEqual({
      seed: -1,
      gyro: { noiseSigma: null, vibrationSigma: null, bias: null, randomWalk: null, range: null, delaySteps: 2 },
      accelerometer: { noiseSigma: null, vibrationSigma: null, bias: null, randomWalk: null, range: null, delaySteps: null, mountPositionM },
      barometer: { referenceAltitudeM: 1000, referenceTemperatureK: toSI(35, '°C'), sigmaPa: null, biasPa: null, periodSteps: 20, delaySteps: null },
      gps: { positionSigmaHorizontalM: null, positionSigmaVerticalM: null, velocitySigmaMps: null, periodSteps: 200, delaySteps: null },
    })
  })

  it('converts selected component statistics and honours explicit overrides', () => {
    const source = 'user' as const
    const specs = resolveSensorSpecs({ parts: [
      { id: 'fc', name: 'Controller', kind: 'flight-controller', componentId: null },
      { id: 'gps', name: 'GPS', kind: 'gps', componentId: null },
    ] }, {})
    const catalogueRows = [
      ['gyroNoiseDensity', { value: 2.8, unit: 'mdps/√Hz', source }],
      ['accelNoiseDensity', { value: 70, unit: 'µg/√Hz', source }],
      ['accelFullScaleRange', { value: 16, unit: 'g₀', source }],
      ['gpsHorizontalCep', { value: 2, unit: 'm', source }],
      ['gpsUpdateRate', { value: 5, unit: 'Hz', source }],
      ['gpsPositionDelay', { value: 1001, unit: 'ms', source }],
    ] as const
    for (const [key, value] of catalogueRows) {
      const entry = specs.missing.find(({ field }) => field.key === key)!
      specs.values.push({ ...entry, value, layer: 'instance' })
    }
    const { payload, missing } = buildSensorPayload(specs, {
      ...configured, flightControllerPartId: 'fc', gpsPartId: 'gps',
      gyro: { ...configured.gyro, noiseSigma: undefined },
      accelerometer: { ...configured.accelerometer, noiseSigma: undefined, range: undefined },
      gps: { ...configured.gps, positionSigmaHorizontalM: undefined, periodMs: undefined, delayMs: undefined },
    }, conditions)
    expect(missing).toEqual([])
    expect(payload?.gyro?.noiseSigma).toBe(toSI(2.8, 'mdps/√Hz') * Math.sqrt(1000 / 2))
    expect(payload?.accelerometer?.noiseSigma).toBe(toSI(70, 'µg/√Hz') * Math.sqrt(1000 / 2))
    expect(payload?.accelerometer?.range).toBe(toSI(16, 'g₀'))
    expect(payload?.gps).toMatchObject({
      positionSigmaHorizontalM: 2 / Math.sqrt(2 * Math.log(2)), periodSteps: 200, delaySteps: 1001,
    })
    expect(buildSensorPayload(specs, { ...configured, gpsPartId: 'gps' }, conditions).payload?.gps?.delaySteps).toBeNull()
  })

  it.each([[1.001, 1001], [1.0015, undefined]] as const)(
    'validates a selected component delay of %s seconds without rounding', (seconds, steps) => {
      const field = GPS_SENSOR_FIELDS.find(({ key }) => key === 'gpsPositionDelay')!
      const specs = { values: [{
        partId: 'gps', partName: 'GPS', componentId: 'm10', field,
        layer: 'instance' as const, value: { source: 'user' as const, value: seconds, unit: 's' as const },
      }], missing: [] }
      const { payload, missing } = buildSensorPayload(specs, {
        ...configured, gpsPartId: 'gps', gps: { ...configured.gps, delayMs: undefined },
      }, conditions)
      expect(payload?.gps?.delaySteps).toBe(steps)
      expect(missing.map(({ path }) => path)).toEqual(steps === undefined ? ['gps.delayMs'] : [])
    },
  )

  it('reports units and input locations and leaves the PX4 GPS delay unapplied', () => {
    const field = GPS_SENSOR_FIELDS.find(({ key }) => key === 'gpsPositionDelay')!
    const specs = { values: [], missing: [
      { partId: 'gps', partName: 'GPS', componentId: 'm10', field, enterAt: 'catalog-fill' as const },
    ] }
    const { payload, missing } = buildSensorPayload(specs, {
      ...configured, seed: undefined, gpsPartId: 'gps',
      gyro: { ...configured.gyro, delayMs: 0.5 },
      accelerometer: { ...configured.accelerometer, mountPositionM: undefined },
      gps: { ...configured.gps, delayMs: undefined },
    }, { ambientAltitudeM: null, temperatureC: null })
    expect(payload).toBeUndefined()
    expect(missing).toMatchObject([
      { path: 'seed', unit: '1', enterAt: 'project-sensor-settings' },
      { path: 'gyro.delayMs', unit: 'ms', message: expect.stringContaining('whole millisecond') },
      { path: 'accelerometer.mountPositionM', unit: 'm', enterAt: 'project-sensor-settings' },
      { path: 'conditions.ambientAltitudeM', unit: 'm', enterAt: 'flight-conditions' },
      { path: 'gps.delayMs', unit: 'ms', enterAt: 'catalog-fill', partId: 'gps', suggestion: GPS_DELAY_SUGGESTION },
    ])
    expect(GPS_DELAY_SUGGESTION).toMatchObject({ value: 110, unit: 'ms', source: 'src/modules/ekf2/ekf2_params.c:89' })
  })
})

it('matches the Rust pressure fixture and varies density with actual temperature', () => {
  const fixtureFile = join(__dirname, '../../simulation-engine/engine-core/src/sensors/tests.rs')
  const text = readFileSync(fixtureFile, 'utf8')
  const fixture = text.match(/const ISA_FIXTURE: &str = r#"([\s\S]*?)"#;/)?.[1]
  if (!fixture) throw new Error('Missing shared ISA pressure fixture')
  const cases = JSON.parse(fixture) as [number, number][]
  const isa = isaConstants(physics)
  for (const [altitude, expectedPa] of cases) {
    expect(Math.abs(isaTemperaturePressure(isa, altitude).pressurePa - expectedPa)).toBeLessThanOrEqual(1e-8)
    expect(airDensity(isa, altitude, 35)).toBeLessThan(airDensity(isa, altitude, 0))
  }
})

describe('gyro rate feedback settings', () => {
  // Test inputs use the PX4 reference cutoffs (physics.v1.json:1540–1562).
  const gyroFilters = { gyroCutoffHz: 40, dgyroCutoffHz: 30, notch0: null, notch1: null }
  it('leaves the recorded-only payload byte-for-byte unchanged when off', () => {
    const build = (settings: SensorSettings) => buildSensorPayload(noSpecs, settings, conditions)
    expect(JSON.stringify(build({ ...configured, flyOnGyro: false, gyroFilters }))).toBe(JSON.stringify(build(configured)))
    expect(build({ ...configured, flyOnGyro: true, gyroFilters }).payload?.flyOnGyro).toEqual(gyroFilters)
  })

  it('asks for all filter inputs and requires a gyro', () => {
    const build = (settings: SensorSettings) => buildSensorPayload(noSpecs, { ...configured, flyOnGyro: true, ...settings }, conditions)
    expect(build({}).missing.map(({ path }) => path)).toEqual([
      'flyOnGyro.gyroCutoffHz', 'flyOnGyro.dgyroCutoffHz', 'flyOnGyro.notch0', 'flyOnGyro.notch1',
    ])
    const noGyro = build({ gyro: null, gyroFilters })
    expect(noGyro.payload).toBeUndefined()
    expect(noGyro.missing.map(({ path }) => path)).toEqual(['flyOnGyro'])
    const missingNotch = build({ gyroFilters: { ...gyroFilters, notch0: { frequencyHz: 40 } } })
    expect(missingNotch.missing.map(({ path }) => path)).toEqual(['flyOnGyro.notch0.bandwidthHz'])
  })
})
