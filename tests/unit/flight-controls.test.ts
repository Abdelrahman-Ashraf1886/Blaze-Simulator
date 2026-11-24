import { describe, expect, it, vi } from 'vitest'
import { FlightSessionSetpointSchema } from '../../electron/main/engine/protocol'
import { toEngineSetpoint } from '../../src/features/flight/EngineFlightSource'
import { createDeviceButtonEdges, runDeviceButton } from '../../src/features/flight/device-buttons'
import { flightCommandActions, flightPauseAction, flightPause, inputBlocker, selectFlightCommand, takeoffCommand } from '../../src/features/flight/flight-controls'

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

it('fires only fresh PlayStation button presses across start, pause, resume, and reconnect', () => {
  const edges = createDeviceButtonEdges()
  const buttons = (...held: number[]) => Array.from({ length: 18 }, (_, index) => ({ pressed: held.includes(index) }))
  expect(edges(buttons(0))).toEqual([])
  expect(edges(buttons(0))).toEqual([])
  expect(edges(buttons())).toEqual([])
  expect(edges(buttons(0, 9))).toEqual(['takeoff', 'pause'])
  expect(edges(buttons(0, 9), true)).toEqual([]) // Pause transition.
  expect(edges(buttons(0, 9))).toEqual([])
  expect(edges(buttons(0))).toEqual([])
  expect(edges(buttons(0, 9))).toEqual(['pause'])
  expect(edges(buttons(0, 9), true)).toEqual([]) // Resume transition.
  expect(edges(buttons(0, 9))).toEqual([])
  expect(edges(undefined)).toEqual([]) // Disconnect or keyboard.
  expect(edges(buttons(0, 9, 1))).toEqual([]) // Reconnect with buttons held.
  expect(edges(buttons())).toEqual([])
  expect(edges(buttons(1, 2, 3, 14, 15))).toEqual(['land', 'hold', 'manual', 'previous', 'next'])
})

it('routes all bindings through the on-screen actions and honours disabled controls', () => {
  const onCommand = vi.fn()
  const onToggle = vi.fn()
  const onMode = vi.fn()
  const command = { type: 'hold' } as const
  const controls = { ...flightCommandActions(command, '3.4', false, onCommand).actions, pause: flightPauseAction(null, null, onToggle) }
  for (const action of ['takeoff', 'land', 'hold', 'manual', 'pause'] as const) {
    runDeviceButton(action, controls, 'position', onMode)
  }
  expect(onCommand.mock.calls).toEqual([[{ type: 'takeoff', altitudeM: 3.4 }], [{ type: 'land' }], [{ type: 'hold' }], [null]])
  expect(onToggle).toHaveBeenCalledOnce()

  runDeviceButton('previous', controls, 'stabilized', onMode)
  runDeviceButton('previous', controls, 'altitude', onMode)
  runDeviceButton('previous', controls, 'position', onMode)
  runDeviceButton('next', controls, 'stabilized', onMode)
  runDeviceButton('next', controls, 'altitude', onMode)
  runDeviceButton('next', controls, 'position', onMode)
  runDeviceButton('next', controls, 'attitudeHold', onMode)
  expect(onMode.mock.calls).toEqual([['stabilized'], ['altitude'], ['altitude'], ['position']])

  onCommand.mockClear()
  onToggle.mockClear()
  const paused = { ...flightCommandActions(command, '3.4', true, onCommand).actions, pause: flightPauseAction('manual', 'disconnect', onToggle) }
  for (const action of ['takeoff', 'land', 'hold', 'manual', 'pause'] as const) {
    runDeviceButton(action, paused, 'position', onMode)
    runDeviceButton(action, controls, 'attitudeHold', onMode)
  }
  const unavailable = { ...controls, ...flightCommandActions(null, '-1', false, onCommand).actions }
  runDeviceButton('takeoff', unavailable, 'position', onMode)
  runDeviceButton('manual', unavailable, 'position', onMode)
  expect(onCommand).not.toHaveBeenCalled()
  expect(onToggle).not.toHaveBeenCalled()
  const resumable = { ...paused, pause: flightPauseAction('manual', null, onToggle) }
  runDeviceButton('pause', resumable, 'position', onMode)
  expect(onToggle).toHaveBeenCalledOnce()
})
