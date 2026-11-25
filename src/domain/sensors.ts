import { ISA_MAX_ALTITUDE_M, ISA_MIN_ALTITUDE_M } from './atmosphere'
import { cepToAxisSigma, noiseDensityToSampleSigma, type SensorSpecs } from './sensor-specs'
import { dimensionOf, toSI } from './units'

// phase-7-telemetry.md:43,81–84 and engine-core/src/sim.rs:28.
const STEP_MS = 1
const IMU_RATE_HZ = 1000 / STEP_MS

export const GPS_DELAY_SUGGESTION = {
  label: 'PX4 v1.13.3 EKF2_GPS_DELAY (suggestion)',
  value: 110,
  unit: 'ms',
  source: 'src/modules/ekf2/ekf2_params.c:89',
} as const

type Vec3 = [number, number, number]
type ImuPayload = {
  noiseSigma: number | null
  vibrationSigma: number | null
  bias: Vec3 | null
  randomWalk: number | null
  delaySteps: number | null
  range: number | null
}
type BarometerPayload = {
  referenceAltitudeM: number
  referenceTemperatureK: number | null
  sigmaPa: number | null
  biasPa: number | null
  periodSteps: number
  delaySteps: number | null
}
type GpsPayload = {
  positionSigmaHorizontalM: number | null
  positionSigmaVerticalM: number | null
  velocitySigmaMps: number | null
  periodSteps: number
  delaySteps: number | null
}

export interface GyroNotchPayload {
  frequencyHz: number
  bandwidthHz: number
}

export interface GyroFilterPayload {
  gyroCutoffHz: number
  dgyroCutoffHz: number
  notch0: GyroNotchPayload | null
  notch1: GyroNotchPayload | null
}

export interface SensorPayload {
  seed: number
  gyro: ImuPayload | null
  flyOnGyro?: GyroFilterPayload | null
  accelerometer: (ImuPayload & { mountPositionM: Vec3 }) | null
  barometer: BarometerPayload | null
  gps: GpsPayload | null
}

type ImuSettings = Partial<Omit<ImuPayload, 'delaySteps'>> & { delayMs?: number | null }
type BarometerSettings = Partial<Pick<BarometerPayload, 'sigmaPa' | 'biasPa'>> & {
  periodMs?: number
  delayMs?: number | null
}
type GpsSettings = Partial<Omit<GpsPayload, 'periodSteps' | 'delaySteps'>> & {
  periodMs?: number
  delayMs?: number | null
}

/** Project choices in SI, except periods and delays entered in milliseconds. */
export interface SensorSettings {
  seed?: number
  flightControllerPartId?: string
  gpsPartId?: string
  gyro?: ImuSettings | null
  flyOnGyro?: boolean
  gyroFilters?: Partial<Omit<GyroFilterPayload, 'notch0' | 'notch1'>> & {
    notch0?: Partial<GyroNotchPayload> | null
    notch1?: Partial<GyroNotchPayload> | null
  }
  accelerometer?: (ImuSettings & { mountPositionM?: Vec3 }) | null
  barometer?: BarometerSettings | null
  gps?: GpsSettings | null
}

export interface SensorFlightConditions {
  ambientAltitudeM?: number | null
  temperatureC?: number | null
}

export interface MissingSensorInput {
  path: string
  unit: string
  enterAt: 'project-sensor-settings' | 'flight-conditions' | SensorSpecs['missing'][number]['enterAt']
  message: string
  partId?: string
  suggestion?: typeof GPS_DELAY_SUGGESTION
}

const nonnegative = (n: number) => Number.isFinite(n) && n >= 0
// Match the f32 frequencies in PX4's LowPassFilter2p.hpp:61–90,
// NotchFilter.hpp:217–285 and AlphaFilter.hpp:76–86.
export const validGyroFilterHz = (n: number) => nonnegative(n) && Number.isFinite(Math.fround(n))
const positive = (n: number) => Number.isFinite(n) && n > 0
const whole = (n: number) => Number.isSafeInteger(n) && n >= 0
const wholePositive = (n: number) => whole(n) && n > 0
const finiteVector = (v: Vec3) => v.length === 3 && v.every(Number.isFinite)
const nullable = <T>(valid: (v: T) => boolean) => (value: T | null) => value === null || valid(value)

function complete<T extends object>(fields: T): fields is T & { [K in keyof T]-?: Exclude<T[K], undefined> } {
  return Object.values(fields).every((value) => value !== undefined)
}

/** A null group or effect is an explicit choice to disable it. Undefined asks
 * for a value unless a selected component supplies the required statistic.
 */
export function buildSensorPayload(
  specs: SensorSpecs, settings: SensorSettings | null, conditions: SensorFlightConditions,
): { payload?: SensorPayload; missing: MissingSensorInput[] } {
  const missing: MissingSensorInput[] = []
  if (settings === null) return { missing }

  function read<T>(
    path: string, unit: string, value: T | undefined, valid: (value: T) => boolean, message: string,
    source?: { partId?: string; key: string }, suggestion?: typeof GPS_DELAY_SUGGESTION,
  ): T | undefined {
    if (value !== undefined && valid(value)) return value
    const spec = value === undefined && source?.partId !== undefined
      ? specs.missing.find((entry) => entry.partId === source.partId && entry.field.key === source.key)
      : undefined
    missing.push({
      path, unit,
      enterAt: path.startsWith('conditions.') ? 'flight-conditions' : spec?.enterAt ?? 'project-sensor-settings',
      message,
      ...(spec ? { partId: spec.partId } : {}),
      ...(suggestion ? { suggestion } : {}),
    })
    return undefined
  }

  function quantity(source: { partId?: string; key: string }, inMs = false): number | undefined {
    if (source.partId === undefined) return
    const entry = specs.values.find((entry) => entry.partId === source.partId && entry.field.key === source.key)
    const spec = entry?.value
    if (entry?.field.kind !== 'quantity' || typeof spec?.value !== 'number' || !('unit' in spec)
      || dimensionOf(spec.unit) !== entry.field.dimension) return
    if (!inMs) return toSI(spec.value, spec.unit)
    if (spec.unit === 'ms') return spec.value
    // Seconds and milliseconds are the time units (units.ts:132–133).
    // Check the decimal places before shifting so 1.001 s is 1001 ms exactly.
    const seconds = spec.value.toString()
    return /^\d+(?:\.\d{1,3})?$/.test(seconds) ? Number(`${seconds}e3`) : Number.NaN
  }

  function effect(
    path: string, unit: string, override: number | null | undefined, valid: (value: number) => boolean,
    message: string, source?: { partId?: string; key: string }, transform = (value: number) => value,
    suggestion?: typeof GPS_DELAY_SUGGESTION,
  ) {
    const value = override === undefined && source ? quantity(source, path.endsWith('.delayMs')) : undefined
    return read(path, unit, value === undefined ? override : transform(value), nullable(valid), message, source, suggestion)
  }

  function group<T extends object, R>(name: string, value: T | null | undefined, build: (value: T) => R | undefined) {
    const selected = read(name, '1', value, () => true, 'Configure this sensor or select off.')
    return selected == null ? selected : build(selected)
  }

  const delayMessage = 'Enter a nonnegative whole millisecond delay or select off.'
  const sigmaMessage = 'Enter a nonnegative one-sigma value or select off.'
  const imu = (name: 'gyro' | 'accelerometer', value: ImuSettings) => {
    const isGyro = name === 'gyro'
    const prefix = isGyro ? 'gyro' : 'accel'
    const unit = isGyro ? 'rad/s' : 'm/s²'
    const partId = settings.flightControllerPartId
    const fields = {
      noiseSigma: effect(`${name}.noiseSigma`, unit, value.noiseSigma, nonnegative, sigmaMessage,
        { partId, key: `${prefix}NoiseDensity` }, (density) => noiseDensityToSampleSigma(density, IMU_RATE_HZ)),
      vibrationSigma: read(`${name}.vibrationSigma`, unit, value.vibrationSigma, nullable(nonnegative),
        'Enter the extra per-axis sample sigma from a log or select off (vibration not modelled).'),
      bias: read(`${name}.bias`, unit, value.bias, nullable(finiteVector), 'Enter three finite body-axis biases or select off.'),
      randomWalk: read(`${name}.randomWalk`, `${unit}/√s`, value.randomWalk, nullable(nonnegative), sigmaMessage),
      delaySteps: read(`${name}.delayMs`, 'ms', value.delayMs, nullable(whole), delayMessage),
      range: effect(`${name}.range`, unit, value.range, positive, 'Enter a positive full-scale limit or select off.',
        { partId, key: `${prefix}FullScaleRange` }),
    }
    return complete(fields) ? fields : undefined
  }

  function period(path: string, override: number | undefined, source: { partId?: string; key: string }) {
    const rate = override === undefined ? quantity(source) : undefined
    return read(path, 'ms', rate === undefined ? override : IMU_RATE_HZ / rate, wholePositive,
      'Enter a positive whole millisecond period. A catalogue rate must divide 1 kHz exactly.', source)
  }

  const seed = read('seed', '1', settings.seed, Number.isSafeInteger, 'Enter a signed safe integer seed.')
  const gyro = group('gyro', settings.gyro, (v) => imu('gyro', v))
  function flightFilters(): GyroFilterPayload | undefined {
    const filters = settings?.gyroFilters
    const message = 'Enter a nonnegative finite frequency in Hz.'
    const frequency = (key: string, value: number | undefined) => read(key, 'Hz', value, validGyroFilterHz, message)
    const notch = (key: 'notch0' | 'notch1') => group(`flyOnGyro.${key}`, filters?.[key], (v) => {
      const fields = {
        frequencyHz: frequency(`flyOnGyro.${key}.frequencyHz`, v.frequencyHz),
        bandwidthHz: frequency(`flyOnGyro.${key}.bandwidthHz`, v.bandwidthHz),
      }
      return complete(fields) ? fields : undefined
    })
    const fields = {
      gyroCutoffHz: frequency('flyOnGyro.gyroCutoffHz', filters?.gyroCutoffHz),
      dgyroCutoffHz: frequency('flyOnGyro.dgyroCutoffHz', filters?.dgyroCutoffHz),
      notch0: notch('notch0'),
      notch1: notch('notch1'),
    }
    return complete(fields) ? fields : undefined
  }

  const flyOnGyro = settings.flyOnGyro === true ? flightFilters() : undefined
  if (settings.flyOnGyro === true && settings.gyro == null) {
    read('flyOnGyro', '1', undefined, () => false, 'Configure a gyroscope to use gyro rate feedback.')
  }
  const payload = {
    seed,
    gyro,
    ...(flyOnGyro !== undefined ? { flyOnGyro } : {}),
    accelerometer: group('accelerometer', settings.accelerometer, (v) => {
      const model = imu('accelerometer', v)
      const mountPositionM = read('accelerometer.mountPositionM', 'm', v.mountPositionM, finiteVector,
        'Enter the flight controller’s mount relative to the body origin in forward, left, up axes.')
      return model && mountPositionM ? { ...model, mountPositionM } : undefined
    }),
    barometer: group('barometer', settings.barometer, (v) => {
      const partId = settings.flightControllerPartId
      const temperature = conditions.temperatureC
      const fields = {
        referenceAltitudeM: read('conditions.ambientAltitudeM', 'm', conditions.ambientAltitudeM ?? undefined,
          (n) => n >= ISA_MIN_ALTITUDE_M && n <= ISA_MAX_ALTITUDE_M,
          `Enter the world-Z-zero reference altitude in ${ISA_MIN_ALTITUDE_M}–${ISA_MAX_ALTITUDE_M} m.`),
        referenceTemperatureK: read('conditions.temperatureC', '°C',
          temperature == null ? temperature : toSI(temperature, '°C'), nullable(positive),
          'Enter a temperature above absolute zero or select standard atmosphere.'),
        sigmaPa: effect('barometer.sigmaPa', 'Pa', v.sigmaPa, nonnegative, sigmaMessage, { partId, key: 'baroRmsNoise' }),
        biasPa: read('barometer.biasPa', 'Pa', v.biasPa, nullable(Number.isFinite), 'Enter a finite bias or select off.'),
        periodSteps: period('barometer.periodMs', v.periodMs, { partId, key: 'baroOutputRate' }),
        delaySteps: read('barometer.delayMs', 'ms', v.delayMs, nullable(whole), delayMessage),
      }
      return complete(fields) ? fields : undefined
    }),
    gps: group('gps', settings.gps, (v) => {
      const partId = settings.gpsPartId
      const fields = {
        positionSigmaHorizontalM: effect('gps.positionSigmaHorizontalM', 'm', v.positionSigmaHorizontalM,
          nonnegative, sigmaMessage, { partId, key: 'gpsHorizontalCep' }, cepToAxisSigma),
        // sensor-specs.ts:19–20 permits unspecified confidence for these accuracy fields.
        positionSigmaVerticalM: read('gps.positionSigmaVerticalM', 'm', v.positionSigmaVerticalM, nullable(nonnegative), sigmaMessage),
        velocitySigmaMps: read('gps.velocitySigmaMps', 'm/s', v.velocitySigmaMps, nullable(nonnegative), sigmaMessage),
        periodSteps: period('gps.periodMs', v.periodMs, { partId, key: 'gpsUpdateRate' }),
        delaySteps: effect('gps.delayMs', 'ms', v.delayMs, whole, delayMessage,
          { partId, key: 'gpsPositionDelay' }, undefined, GPS_DELAY_SUGGESTION),
      }
      return complete(fields) ? fields : undefined
    }),
  }

  return missing.length === 0 && complete(payload) ? { payload, missing } : { missing }
}
