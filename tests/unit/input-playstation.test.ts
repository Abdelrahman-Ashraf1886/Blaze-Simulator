import { expect, it } from 'vitest'
import { checkAxis } from '../../src/features/input/calibration-draft'
import { createGuidedCapture, PLAYSTATION_MODES } from '../../src/features/input/playstation-capture'
import type { InputDevice } from '../../src/features/input/gamepads'
import { identifyPlayStation, PLAYSTATION_AXES, playStationButtons } from '../../src/features/input/playstation'

const id = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'
const sample = (axes: readonly number[], connection = 1): InputDevice => ({
  id, index: 0, connection, mapping: 'standard', axes, buttons: [],
})

it.each([
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)', 'DualShock 4'],
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054C Product: 09CC)', 'DualShock 4'],
  ['DUALSHOCK 4 USB Wireless Adaptor (Vendor: 054c Product: 0ba0)', 'DualShock 4'],
  [id, 'DualSense'],
  ['DualSense Edge Wireless Controller (Vendor: 054c Product: 0df2)', 'DualSense Edge'],
  ['Access Controller (Vendor: 054c Product: 0e5f)', null],
  ['Unknown (Vendor: 054c Product: ffff)', null],
  ['Other controller (Vendor: 045e Product: 0ce6)', null],
  ['DualSense Wireless Controller', null],
])('recognizes Chromium vendor and product in %s', (value, expected) => {
  expect(identifyPlayStation(value)).toBe(expected)
})

it('labels every canonical index and the Chromium touchpad extension', () => {
  const names = [
    'Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2',
    'Create', 'Options', 'L3', 'R3', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'PS', 'Touchpad',
  ]
  expect(playStationButtons('DualSense')).toEqual(names)
  expect(playStationButtons('DualSense Edge')).toEqual(names)
  expect(playStationButtons('DualShock 4')).toEqual(names.map((name) => name === 'Create' ? 'Share' : name))
  expect(PLAYSTATION_AXES).toEqual(['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'])
})

it.each([
  ['1', { yawRight: 0, forward: 1, right: 2, throttle: 3 }],
  ['2', { yawRight: 0, throttle: 1, right: 2, forward: 3 }],
  ['3', { right: 0, forward: 1, yawRight: 2, throttle: 3 }],
  ['4', { right: 0, throttle: 1, yawRight: 2, forward: 3 }],
] as const)('assigns the channels for Mode %s', (mode, axes) => {
  expect(PLAYSTATION_MODES[mode]).toEqual(axes)
})

it('captures all four ranges, trims, and rest spreads in one sweep with dead zones off', () => {
  const starting = sample([0, 0, 0, 0])
  const capture = createGuidedCapture(starting, '2')
  capture.add(sample([-1, -0.75, -0.5, -0.25]))
  capture.finishRange(sample([1, 0.75, 0.5, 0.25]))
  capture.add(sample([0, 0, 0, 1])) // Releasing is outside the endpoint and rest stages.
  capture.startRest(sample([0, 0.125, 0, 0]))
  capture.add(sample([-0.125, 0.25, 0.125, 0]))
  const result = capture.finish(sample([0.125, 0, 0.25, 0.125]))!
  expect(result.draft).toMatchObject({
    yawRight: { axis: 0, range: { min: -1, max: 1 }, trim: 0, deadZone: '0' },
    throttle: { axis: 1, range: { min: -0.75, max: 0.75 }, trim: 0.125, trimMethod: 'centre', deadZone: '0' },
    right: { axis: 2, range: { min: -0.5, max: 0.5 }, trim: 0.125, deadZone: '0' },
    forward: { axis: 3, range: { min: -0.25, max: 0.25 }, trim: 0.0625, deadZone: '0' },
  })
  expect(result.spreads).toEqual({ yawRight: 0.125, throttle: 0.125, right: 0.125, forward: 0.0625 })
  expect(checkAxis(result.draft, 'throttle', 4).binding?.trim).toBe(0.125)
})

it('rejects a disconnected capture and validates an axis that never moved', () => {
  const rest = sample([0, 0, 0, 0])
  const capture = createGuidedCapture(rest, '2')
  capture.add(sample([-1, -1, -1, 0]))
  capture.finishRange(sample([1, 1, 1, 0]))
  capture.startRest(rest)
  expect(capture.finish(undefined)).toBeNull()
  expect(capture.finish(sample([0, 0, 0, 0], 2))).toBeNull()

  const next = createGuidedCapture(rest, '2')
  next.add(sample([-1, -1, -1, 0]))
  next.finishRange(sample([1, 1, 1, 0]))
  next.startRest(rest)
  expect(checkAxis(next.finish(rest)!.draft, 'forward', 4).errors.range).toBe('Measure two distinct endpoints.')
})
