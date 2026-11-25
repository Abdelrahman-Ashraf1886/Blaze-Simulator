import type { AutoCommand, FlightMode, Px4Sticks } from './frame'

export const pauseLabels = {
  manual: 'Paused manually',
  disconnect: 'Input device disconnected',
  blur: 'Window lost focus',
  stale: 'Input device reading unavailable or stale',
}
export type PauseReason = keyof typeof pauseLabels
export type InputBlocker = Exclude<PauseReason, 'manual'>

export function inputBlocker(input: { connected: boolean; sticks: Px4Sticks | null } | null, focused: boolean): InputBlocker | null {
  if (input === null) return null
  if (!focused) return 'blur'
  if (!input.connected) return 'disconnect'
  return input.sticks === null ? 'stale' : null
}

export function flightPause(
  paused: PauseReason | null, event: 'pause' | 'resume' | 'input', blocker: InputBlocker | null,
): PauseReason | null {
  if (event === 'resume' && blocker === null) return null
  return paused ?? blocker ?? (event === 'pause' ? 'manual' : null)
}

// The engine owns the default (auto_modes.rs:12–14). Omit altitudeM to use it.
export const MIS_TAKEOFF_ALT_M = 2.5

export function takeoffCommand(height: string): AutoCommand | null {
  if (height.trim() === '') return { type: 'takeoff' }
  const altitudeM = Number(height)
  return Number.isFinite(altitudeM) && altitudeM > 0 ? { type: 'takeoff', altitudeM } : null
}

export function selectFlightCommand(
  current: AutoCommand | null, next: AutoCommand | null, mode: FlightMode, paused: PauseReason | null,
): AutoCommand | null {
  if (mode === 'attitudeHold') return null
  return paused === null ? next : current
}

export function flightPauseAction(paused: PauseReason | null, blocker: InputBlocker | null, onToggle: () => void) {
  return { label: paused ? 'Resume' : 'Pause', disabled: paused !== null && blocker !== null, run: onToggle }
}

export function flightCommandActions(command: AutoCommand | null, height: string | null, paused: boolean,
  onCommand: (command: AutoCommand | null) => void,
) {
  const takeoff = height === null ? null : takeoffCommand(height)
  const actions = {
    takeoff: { label: 'Takeoff', disabled: paused || takeoff === null, run: () => { if (takeoff) onCommand(takeoff) } },
    hold: { label: 'Hold', disabled: paused, run: () => onCommand({ type: 'hold' }) },
    land: { label: 'Land', disabled: paused, run: () => onCommand({ type: 'land' }) },
    return: { label: 'Return', disabled: paused, run: () => onCommand({ type: 'return' }) },
    manual: { label: 'Manual', disabled: paused || command === null, run: () => onCommand(null) },
  }
  return { actions, invalidAltitude: takeoff === null }
}
