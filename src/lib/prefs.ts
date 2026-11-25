import { isDeviceCalibration, type DeviceCalibration } from '../features/input/calibration'
import { isTelemetryLayout, type TelemetryLayout } from '../features/telemetry/layout'

/**
 * Per-user UI conveniences (sidebar state and similar). Stored in localStorage;
 * every access is guarded because storage can be unavailable or cleared, and the
 * UI must work without it. Never use this for project data — that lives in SQLite.
 */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* preference is simply not remembered */
  }
}

// Phase 6 plan D14 (phase-6-flight-environment.md:74).
const inputCalibrationKey = (deviceId: string) => `input.calibration.${deviceId}`

export type InputCalibrationPref =
  | { status: 'missing' | 'invalid' | 'unavailable' }
  | { status: 'saved'; calibration: DeviceCalibration }

export function readInputCalibration(deviceId: string): InputCalibrationPref {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(inputCalibrationKey(deviceId))
  } catch {
    return { status: 'unavailable' }
  }
  if (raw === null) return { status: 'missing' }
  try {
    const calibration: unknown = JSON.parse(raw)
    if (isDeviceCalibration(calibration)) return { status: 'saved', calibration }
  } catch {
    return { status: 'invalid' }
  }
  return { status: 'invalid' }
}

export function writeInputCalibration(deviceId: string, calibration: DeviceCalibration): boolean {
  if (!isDeviceCalibration(calibration)) return false
  try {
    window.localStorage.setItem(inputCalibrationKey(deviceId), JSON.stringify(calibration))
    return true
  } catch {
    return false
  }
}

// Flight device buttons are a per-user view preference. The requested default is on.
export function readFlightDeviceButtons(): boolean {
  const saved = readPref<unknown>('flight.deviceButtons', true)
  return typeof saved === 'boolean' ? saved : true
}

export function writeFlightDeviceButtons(enabled: boolean): void {
  writePref('flight.deviceButtons', enabled)
}

// Phase 7 telemetry D10 (documentation/plans/phase-7-telemetry.md:46).
export function readRecordRuns(): boolean {
  const saved = readPref<unknown>('record-runs', true)
  return typeof saved === 'boolean' ? saved : true
}

export function writeRecordRuns(enabled: boolean): void {
  writePref('record-runs', enabled)
}

const telemetryLayoutKey = 'telemetry.layout'

export function readTelemetryLayout(): TelemetryLayout | undefined {
  const saved = readPref<unknown>(telemetryLayoutKey, undefined)
  return isTelemetryLayout(saved) ? saved : undefined
}

export function writeTelemetryLayout(layout: TelemetryLayout): void {
  if (isTelemetryLayout(layout)) writePref(telemetryLayoutKey, layout)
}
