import { describe, expect, it } from 'vitest'
import { FlightSessionSetpointSchema } from '../../electron/main/engine/protocol'
import { toEngineSetpoint } from '../../src/features/flight/EngineFlightSource'
import { flightPause, inputBlocker, selectFlightCommand, takeoffCommand } from '../../src/features/flight/flight-controls'

const sticks = { forward: 0.37, right: -0.19, yawRight: 0.04, throttle: -0.52 }
const connected = { connected: true, sticks }
const disconnected = { connected: false, sticks: null }
const stale = { connected: true, sticks: null }

describe('flight pause', () => {
  it('latches a device disconnect mid-flight and requires explicit resume with a focused window and fresh sample', () => {
    const running = flightPause(null, 'input', inputBlocker(connected, true))
    expect(running).toBeNull()
    const paused = flightPause(running, 'input', inputBlocker(disconnected, true))
    expect(paused).toBe('disconnect')
    for (const blocker of [inputBlocker(disconnected, true), inputBlocker(connected, false), inputBlocker(stale, true)]) {
      expect(flightPause(paused, 'resume', blocker)).toBe('disconnect')
    }
    expect(flightPause(paused, 'input', inputBlocker(connected, true))).toBe('disconnect')
    expect(flightPause(paused, 'resume', inputBlocker(connected, true))).toBeNull()
  })

  it('pauses on stale samples and blur in a device run, with manual pause for either input source', () => {
    expect(flightPause(null, 'input', inputBlocker(stale, true))).toBe('stale')
    expect(flightPause(null, 'input', inputBlocker(connected, false))).toBe('blur')
    expect(flightPause(null, 'input', inputBlocker(null, false))).toBeNull()
    for (const input of [null, connected]) {
      const blocker = inputBlocker(input, true)
      expect(flightPause(null, 'pause', blocker)).toBe('manual')
      expect(flightPause('manual', 'resume', blocker)).toBeNull()
    }
  })
})

describe('flight command selection and requests', () => {
  it('keeps a command across a pause and returns to the selected mode on Manual', () => {
    const takeoff = selectFlightCommand(null, takeoffCommand(''), 'position', null)
    expect(takeoff).toEqual({ type: 'takeoff' })
    expect(selectFlightCommand(takeoff, { type: 'land' }, 'position', 'manual')).toBe(takeoff)
    expect(selectFlightCommand(takeoff, null, 'position', 'manual')).toBe(takeoff)
    expect(selectFlightCommand(takeoff, null, 'position', null)).toBeNull()
    expect(selectFlightCommand(null, takeoff, 'attitudeHold', null)).toBeNull()
  })

  it('builds command-only requests and preserves exact calibrated sticks in manual mode', () => {
    for (const command of [takeoffCommand(''), takeoffCommand('3.25'), { type: 'land' }, { type: 'hold' }] as const) {
      if (!command) throw new Error('Expected valid command')
      const request = toEngineSetpoint({ command })
      expect(FlightSessionSetpointSchema.parse(request)).toEqual({ command })
    }
    expect(takeoffCommand('3.25')).toEqual({ type: 'takeoff', altitudeM: 3.25 })
    for (const invalid of ['0', '-1', 'Infinity', 'invalid']) expect(takeoffCommand(invalid)).toBeNull()
    const request = toEngineSetpoint({ mode: 'position', sticks })
    expect(request).toEqual({ mode: 'position', sticks })
    expect(request.sticks).toBe(sticks)
  })
})
