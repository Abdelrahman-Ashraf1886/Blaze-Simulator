import { applyGamepadAxisSign, mapAxis, validateAxisCalibration, type AxisCalibration } from '../../domain/input-mapping'
import type { InputDevice } from './gamepads'

// Same stick directions as src/features/flight/sticks.ts:9–17.
export const STICKS = {
  forward: 'Forward',
  right: 'Right',
  yawRight: 'Yaw right',
  throttle: 'Throttle',
} as const
export type Stick = keyof typeof STICKS
export const stickNames = Object.keys(STICKS) as Stick[]
export type AxisBinding = AxisCalibration & { readonly axis: number }
export type DeviceCalibration = Readonly<Record<Stick, AxisBinding>>
export type InputSticks = Readonly<Record<Stick, number>>

// W3C Gamepad § Standard Gamepad layout: left X/Y = 0/1, right X/Y = 2/3.
// Pair yaw/throttle and right/forward as in the keyboard controls cited above.
// The direction of the vertical axes comes from phase-6-flight-environment.md:240–243.
export const STANDARD_AXES: Readonly<Record<Stick, number>> = { forward: 3, right: 2, yawRight: 0, throttle: 1 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Raw samples and their measured endpoints are in [-1, 1] per the plan:240.
export function isAxisSample(value: unknown): value is number {
  return typeof value === 'number' && value >= -1 && value <= 1
}

export function isDeviceCalibration(value: unknown): value is DeviceCalibration {
  if (!isRecord(value)) return false
  const axes = new Set<number>()
  return stickNames.every((stick) => {
    const binding = value[stick]
    if (!isRecord(binding)) return false
    const { axis, min, trim, max, reverse, deadZone } = binding
    if (typeof axis !== 'number' || !Number.isSafeInteger(axis) || axis < 0 || axes.has(axis)
      || !isAxisSample(min) || !isAxisSample(trim) || !isAxisSample(max)
      || typeof reverse !== 'boolean' || typeof deadZone !== 'number'
      || validateAxisCalibration({ min, trim, max, reverse, deadZone })) return false
    axes.add(axis)
    return true
  })
}

export function readStick(device: InputDevice, binding: AxisBinding): number | null {
  const sample = device.axes[binding.axis]
  if (!isAxisSample(sample)) return null
  return applyGamepadAxisSign(mapAxis(sample, binding), binding.axis, device.mapping)
}

export function readSticks(device: InputDevice, calibration: DeviceCalibration): InputSticks | null {
  const forward = readStick(device, calibration.forward)
  const right = readStick(device, calibration.right)
  const yawRight = readStick(device, calibration.yawRight)
  const throttle = readStick(device, calibration.throttle)
  if (forward === null || right === null || yawRight === null || throttle === null) return null
  return { forward, right, yawRight, throttle }
}
