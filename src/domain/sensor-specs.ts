import type { AssemblyPart } from '../../electron/ipc/contract'
import type { Component, FieldDef, SpecValue } from '../../electron/ipc/component-fields'
import { resolveSpec, type SpecLayer } from './spec-resolution'

export const FLIGHT_CONTROLLER_SENSOR_FIELDS = [
  // Use the catalogue text field length (component-fields.ts).
  { key: 'imuName', label: 'IMU name', kind: 'text', maxLength: 200, help: 'The IMU these gyro and accelerometer specifications describe' },
  { key: 'gyroNoiseDensity', label: 'Gyro noise density', kind: 'quantity', dimension: 'angularSpeedNoiseDensity', unit: 'deg/s/√Hz' },
  { key: 'accelNoiseDensity', label: 'Accelerometer noise density', kind: 'quantity', dimension: 'accelerationNoiseDensity', unit: 'm/s²/√Hz' },
  { key: 'gyroFullScaleRange', label: 'Gyro full-scale range', kind: 'quantity', dimension: 'angularSpeed', unit: 'deg/s', help: 'Positive limit of the configured ± range' },
  { key: 'accelFullScaleRange', label: 'Accelerometer full-scale range', kind: 'quantity', dimension: 'acceleration', unit: 'g₀', help: 'Positive limit of the configured ± range' },
  { key: 'baroRmsNoise', label: 'Barometer RMS noise', kind: 'quantity', dimension: 'pressure', unit: 'Pa', help: 'Put the oversampling setting in the condition' },
  { key: 'baroOutputRate', label: 'Barometer output rate', kind: 'quantity', dimension: 'frequency', unit: 'Hz', help: 'At the configured oversampling setting' },
] as const satisfies readonly FieldDef[]

/** Optional specifications for peripherals whose role is GPS. */
export const GPS_SENSOR_FIELDS = [
  { key: 'gpsHorizontalCep', label: 'GPS horizontal position CEP', kind: 'quantity', dimension: 'length', unit: 'm', help: 'Radius containing 50% of horizontal position errors' },
  { key: 'gpsVerticalAccuracy', label: 'GPS vertical position accuracy', kind: 'quantity', dimension: 'length', unit: 'm', help: 'Put the stated confidence or statistic in the condition' },
  { key: 'gpsVelocityAccuracy', label: 'GPS velocity accuracy', kind: 'quantity', dimension: 'speed', unit: 'm/s', help: 'Put the stated confidence or statistic in the condition' },
  { key: 'gpsUpdateRate', label: 'GPS update rate', kind: 'quantity', dimension: 'frequency', unit: 'Hz', help: 'At the configured receiver settings' },
  { key: 'gpsPositionDelay', label: 'GPS position delay', kind: 'quantity', dimension: 'time', unit: 'ms', help: 'GPS measurement delay relative to IMU measurements' },
] as const satisfies readonly FieldDef[]

type SensorPart = Pick<AssemblyPart, 'id' | 'name' | 'kind' | 'componentId' | 'overrides'>

interface SensorField {
  partId: string
  partName: string
  componentId: string | null
  field: FieldDef
}

export interface SensorValue extends SensorField {
  value: SpecValue
  layer: SpecLayer
}

export interface MissingSensorSpec extends SensorField {
  enterAt: 'catalog-fill' | 'component-editor' | 'duplicate-component' | 'link-component'
}

export interface SensorSpecs {
  values: SensorValue[]
  missing: MissingSensorSpec[]
}

export function resolveSensorSpecs(
  build: { parts: readonly SensorPart[] },
  components: Readonly<Record<string, Component>>,
): SensorSpecs {
  const values: SensorValue[] = []
  const missing: MissingSensorSpec[] = []

  for (const part of build.parts) {
    const component = part.componentId ? components[part.componentId] : undefined
    // A linked peripheral's role identifies GPS even when the workshop part is custom.
    let fields: readonly FieldDef[]
    if (component) {
      if (component.category === 'flight-controller') fields = FLIGHT_CONTROLLER_SENSOR_FIELDS
      else if (component.category === 'peripheral' && resolveSpec(component, part.overrides, 'role').value?.value === 'gps') {
        fields = GPS_SENSOR_FIELDS
      } else continue
    } else if (part.kind === 'flight-controller') fields = FLIGHT_CONTROLLER_SENSOR_FIELDS
    else if (part.kind === 'gps') fields = GPS_SENSOR_FIELDS
    else continue

    for (const field of fields) {
      const entry = { partId: part.id, partName: part.name, componentId: component?.id ?? null, field }
      if (!component) {
        missing.push({ ...entry, enterAt: 'link-component' })
        continue
      }
      const { value, layer } = resolveSpec(component, part.overrides, field.key)
      if (value && layer !== 'missing') {
        values.push({ ...entry, value, layer })
      } else {
        const enterAt = component.origin !== 'built-in' ? 'component-editor'
          : field.kind === 'text' ? 'duplicate-component' : 'catalog-fill'
        missing.push({ ...entry, enterAt })
      }
    }
  }

  return { values, missing }
}

/** One-sided white amplitude density through the Nyquist frequency (phase-7-telemetry.md:81–84).
 * Integrating the power density N² from 0 to sampleRateHz/2 gives the sample variance.
 * The result uses the density's amplitude unit, with the per-√Hz removed.
 */
export function noiseDensityToSampleSigma(density: number, sampleRateHz: number): number {
  return density * Math.sqrt(sampleRateHz / 2)
}

/** With independent isotropic Gaussian axes, the radius is Rayleigh:
 * P(R ≤ r) = 1 − exp(−r²/(2σ²)). At r = CEP this is 1/2, so r²/(2σ²) = ln 2.
 */
export function cepToAxisSigma(cep: number): number {
  return cep / Math.sqrt(2 * Math.LN2)
}
