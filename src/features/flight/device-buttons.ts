import type { FlightMode } from './frame'
import { FLIGHT_MODE_LABELS } from './flight-mode'
import type { flightCommandActions, flightPauseAction } from './flight-controls'

// Canonical indices: gamepad_standard_mappings.h:54–58, :64, :69–70.
// Action bindings and ordering of the PX4 modes follow the requested layout.
export const DEVICE_BUTTONS = {
  0: { name: 'Cross', action: 'takeoff', label: 'Takeoff' },
  1: { name: 'Circle', action: 'land', label: 'Land' },
  2: { name: 'Square', action: 'hold', label: 'Hold' },
  3: { name: 'Triangle', action: 'manual', label: 'Manual' },
  9: { name: 'Options', action: 'pause', label: 'Pause / Resume' },
  14: { name: 'D-pad Left', action: 'previous', label: 'Previous PX4 mode' },
  15: { name: 'D-pad Right', action: 'next', label: 'Next PX4 mode' },
} as const

type ButtonAction = (typeof DEVICE_BUTTONS)[keyof typeof DEVICE_BUTTONS]['action']
type ControlActions = ReturnType<typeof flightCommandActions>['actions'] & { pause: ReturnType<typeof flightPauseAction> }
const bindings = Object.entries(DEVICE_BUTTONS)

export function createDeviceButtonEdges() {
  let previous: readonly boolean[] | undefined
  return (buttons: readonly { pressed: boolean }[] | undefined, baseline = false): ButtonAction[] => {
    const current = buttons && bindings.map(([index]) => buttons[Number(index)]?.pressed === true)
    const before = previous
    previous = current
    if (!current || !before || baseline) return []
    return bindings.flatMap(([, { action }], index) => current[index] && !before[index] ? [action] : [])
  }
}

const px4Modes = (Object.keys(FLIGHT_MODE_LABELS) as FlightMode[]).filter((mode) => mode !== 'attitudeHold')

export function runDeviceButton(action: ButtonAction, controls: ControlActions, mode: FlightMode,
  onMode: (mode: FlightMode) => void,
) {
  if (mode === 'attitudeHold') return
  if (action === 'previous' || action === 'next') {
    const next = px4Modes[px4Modes.indexOf(mode) + (action === 'previous' ? -1 : 1)]
    if (next) onMode(next)
  } else {
    const control = controls[action]
    if (!control.disabled) control.run()
  }
}
