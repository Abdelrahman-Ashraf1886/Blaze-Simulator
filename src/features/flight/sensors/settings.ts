import type { AssemblyDocument, FlightConditionsDoc, FlightSensorsDoc } from '../../../../electron/ipc/contract'
import { SENSOR_FILTERS_PX4 } from '../../../domain/controller-params'
import { resolveSensorSpecs } from '../../../domain/sensor-specs'
import { buildSensorPayload, type MissingSensorInput } from '../../../domain/sensors'
import type { ComponentIndex } from '../../workshop/links'

export const sensorId = (path: string) => `flight-sensor-${path.replaceAll('.', '-')}`

const gyroNames = {
  gyroCutoffHz: 'IMU_GYRO_CUTOFF',
  dgyroCutoffHz: 'IMU_DGYRO_CUTOFF',
  notch0FrequencyHz: 'IMU_GYRO_NF0_FRQ',
  notch0BandwidthHz: 'IMU_GYRO_NF0_BW',
  notch1FrequencyHz: 'IMU_GYRO_NF1_FRQ',
  notch1BandwidthHz: 'IMU_GYRO_NF1_BW',
} as const

function gyroReference(key: keyof typeof gyroNames) {
  const name = gyroNames[key]
  const ref = SENSOR_FILTERS_PX4.find((entry) => entry.key === name)
  if (!ref || ref.min === undefined || ref.max === undefined || ref.unit !== 'Hz') {
    throw new Error(`Missing PX4 frequency reference for ${name}`)
  }
  return { value: ref.value, min: ref.min, max: ref.max, name, source: ref.reference, description: ref.condition }
}

export const GYRO_REFERENCE = {
  gyroCutoffHz: gyroReference('gyroCutoffHz'),
  dgyroCutoffHz: gyroReference('dgyroCutoffHz'),
  notch0: { frequencyHz: gyroReference('notch0FrequencyHz'), bandwidthHz: gyroReference('notch0BandwidthHz') },
  notch1: { frequencyHz: gyroReference('notch1FrequencyHz'), bandwidthHz: gyroReference('notch1BandwidthHz') },
}

export const px4GyroDefaults = () => ({
  gyroCutoffHz: GYRO_REFERENCE.gyroCutoffHz.value,
  dgyroCutoffHz: GYRO_REFERENCE.dgyroCutoffHz.value,
  notch0: { frequencyHz: GYRO_REFERENCE.notch0.frequencyHz.value, bandwidthHz: GYRO_REFERENCE.notch0.bandwidthHz.value },
  notch1: { frequencyHz: GYRO_REFERENCE.notch1.frequencyHz.value, bandwidthHz: GYRO_REFERENCE.notch1.bandwidthHz.value },
})

export type SourceKey = 'flightControllerPartId' | 'gpsPartId'
export type SensorGroup = 'gyro' | 'accelerometer' | 'barometer' | 'gps'
export const sensorLabels = { gyro: 'Gyroscope', accelerometer: 'Accelerometer', barometer: 'Barometer', gps: 'GPS' }
export const sourceLabels = { flightControllerPartId: 'Flight controller', gpsPartId: 'GPS part' }

export function sensorSources(parts: AssemblyDocument['parts'], components: ComponentIndex) {
  const specs = resolveSensorSpecs({ parts }, components)
  const entries = [...specs.values, ...specs.missing]
  return {
    specs,
    flightControllerPartId: parts.filter((part) => entries.some((e) => e.partId === part.id && e.field.key === 'imuName')),
    gpsPartId: parts.filter((part) => entries.some((e) => e.partId === part.id && e.field.key === 'gpsUpdateRate')),
  }
}
export type SensorSources = ReturnType<typeof sensorSources>

export function selectedSensorPart(sources: SensorSources, key: SourceKey, saved?: string) {
  const parts = sources[key]
  return parts.length === 1 ? parts[0] : parts.find((part) => part.id === saved)
}

/** One settings-to-engine path for live flight, scenarios and step tests. */
export function flightSensors(c: FlightConditionsDoc, sources: SensorSources) {
  const { sensors } = c
  if (!sensors || sensors.mode === 'off') return buildSensorPayload(sources.specs, null, c)

  const { mode, ...settings } = sensors
  const flightControllerPartId = selectedSensorPart(sources, 'flightControllerPartId', settings.flightControllerPartId)?.id
  const gpsPartId = selectedSensorPart(sources, 'gpsPartId', settings.gpsPartId)?.id
  const built = buildSensorPayload(sources.specs, {
    ...settings, flightControllerPartId, gpsPartId, flyOnGyro: mode === 'flyOnGyro',
  }, c)
  const missing: MissingSensorInput[] = []
  if (sources.flightControllerPartId.length > 1 && !flightControllerPartId && (settings.gyro || settings.accelerometer || settings.barometer)) {
    missing.push(sourceBlocker('flightControllerPartId'))
  }
  if (sources.gpsPartId.length > 1 && !gpsPartId && settings.gps) missing.push(sourceBlocker('gpsPartId'))
  return missing.length ? { missing: [...missing, ...built.missing] } : built
}

function sourceBlocker(path: SourceKey): MissingSensorInput {
  return { path, unit: '1', enterAt: 'project-sensor-settings', message: `Choose which ${sourceLabels[path].toLowerCase()} supplies these values.` }
}

export function sensorFieldId(path: string) {
  if (path === 'conditions.ambientAltitudeM') return 'flight-altitude'
  if (path === 'conditions.temperatureC') return 'flight-temperature'
  if (path === 'flyOnGyro.notch0' || path === 'flyOnGyro.notch1') return sensorId(`${path}.frequencyHz`)
  return sensorId(path === 'flyOnGyro' ? 'gyro' : path)
}

const fieldLabels: Record<string, string> = {
  seed: 'Sensor seed', ...sourceLabels, ...sensorLabels, flyOnGyro: 'Gyro rate feedback',
  'conditions.ambientAltitudeM': 'Barometer reference altitude', 'conditions.temperatureC': 'Barometer reference temperature',
  noiseSigma: 'noise', vibrationSigma: 'vibration noise', bias: 'bias', randomWalk: 'random walk', delayMs: 'delay',
  range: 'full-scale limit', mountPositionM: 'mount position', sigmaPa: 'pressure noise', biasPa: 'pressure bias',
  periodMs: 'sample period', positionSigmaHorizontalM: 'horizontal position noise',
  positionSigmaVerticalM: 'vertical position noise', velocitySigmaMps: 'velocity noise',
  gyroCutoffHz: GYRO_REFERENCE.gyroCutoffHz.name, dgyroCutoffHz: GYRO_REFERENCE.dgyroCutoffHz.name,
  notch0: 'first notch', notch1: 'second notch', frequencyHz: 'frequency', bandwidthHz: 'bandwidth',
}

export function sensorBlockerLabel(path: string) {
  return fieldLabels[path] ?? path.split('.').map((part) => fieldLabels[part] ?? part).join(' ')
}

export const rateLoopLabel = (mode?: FlightSensorsDoc['mode']) => mode === 'flyOnGyro' ? 'modelled gyro' : 'true rates'
