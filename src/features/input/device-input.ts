import { readInputCalibration } from '@/lib/prefs'
import { readSticks, type DeviceCalibration, type InputSticks } from './calibration'
import { createGamepadService, type DeviceHandle } from './gamepads'

// Let Chromium expose devices after interaction (phase-6-flight-environment.md:240–243).
export const gamepads = createGamepadService({
  read: () => navigator.getGamepads?.() ?? [],
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  listen(callback) {
    const connect = () => callback({ type: 'connect' })
    const disconnect = ({ gamepad }: GamepadEvent) =>
      callback({ type: 'disconnect', id: gamepad.id, index: gamepad.index })
    const blur = () => callback({ type: 'blur' })
    window.addEventListener('gamepadconnected', connect)
    window.addEventListener('gamepaddisconnected', disconnect)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('gamepadconnected', connect)
      window.removeEventListener('gamepaddisconnected', disconnect)
      window.removeEventListener('blur', blur)
    }
  },
})

export interface CalibratedInput {
  readonly connected: boolean
  readonly sticks: InputSticks | null
}

function deviceState(handle: DeviceHandle, calibration: DeviceCalibration | undefined): CalibratedInput {
  const device = gamepads.getDevices().find(({ connection, id, index }) =>
    connection === handle.connection && id === handle.id && index === handle.index)
  return { connected: device !== undefined, sticks: device && calibration ? readSticks(device, calibration) : null }
}

/** Read the selected connection during an active gamepad or calibrated-input subscription. */
export function getCalibratedInput(handle: DeviceHandle): CalibratedInput {
  const saved = readInputCalibration(handle.id)
  return deviceState(handle, saved.status === 'saved' ? saved.calibration : undefined)
}

/** A subscription uses the saved calibration at start. Re-select after reconnecting. */
export function subscribeCalibratedInput(
  handle: DeviceHandle,
  listener: (event: 'sample' | 'disconnect' | 'blur', input: CalibratedInput) => void,
) {
  const saved = readInputCalibration(handle.id)
  const calibration = saved.status === 'saved' ? saved.calibration : undefined
  let wasConnected = deviceState(handle, calibration).connected
  return gamepads.subscribe((event) => {
    const input = deviceState(handle, calibration)
    const disconnected = wasConnected && !input.connected
    wasConnected = input.connected
    if (event === 'blur') listener('blur', input)
    else if (disconnected) listener('disconnect', input)
    else if (input.connected) listener('sample', input)
  })
}
