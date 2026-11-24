import { expect, it, vi } from 'vitest'
import { checkAxis, createAxisSweep, createDraft } from '../../src/features/input/calibration-draft'
import { readSticks, STANDARD_AXES } from '../../src/features/input/calibration'
import { createGamepadService, type GamepadSource } from '../../src/features/input/gamepads'

function fakeSource() {
  type Sample = ReturnType<GamepadSource['read']>[number]
  type Listener = Parameters<GamepadSource['listen']>[0]
  let devices: Sample[] = []
  let listener: Listener | undefined
  let nextFrame = 0
  const frames = new Map<number, () => void>()
  const source: GamepadSource = {
    read: vi.fn(() => devices),
    requestFrame(callback) {
      frames.set(++nextFrame, callback)
      return nextFrame
    },
    cancelFrame: (frame) => { frames.delete(frame) },
    listen(callback) {
      listener = callback
      return () => { listener = undefined }
    },
  }
  return {
    source, frames,
    set: (...samples: Sample[]) => { devices = samples },
    event: (event: Parameters<Listener>[0]) => listener?.(event),
    tick() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id)
        callback()
      }
    },
  }
}

const pad = (id: string, index: number, axes = [0, 0, 0, 0], mapping = 'standard') =>
  ({ id, index, axes, mapping, connected: true, buttons: [{ value: 0, pressed: false }] })

it('polls only on frames with subscribers and tracks simultaneous and duplicate IDs by index', () => {
  const fake = fakeSource()
  const service = createGamepadService(fake.source)
  const events = vi.fn()
  const stop = service.subscribe(events)
  const stopSecond = service.subscribe(vi.fn())
  expect(fake.frames.size).toBe(1)
  expect(fake.source.read).not.toHaveBeenCalled()
  fake.tick()
  expect(service.getDevices()).toEqual([])
  fake.set(pad('Pad', 0), null, pad('Radio', 2, [0, 0, 0, 0], ''), pad('Pad', 3))
  fake.event({ type: 'connect' })
  fake.tick()
  const initial = service.getDevices()
  expect(initial.map(({ id, index, mapping }) => [id, index, mapping])).toEqual([
    ['Pad', 0, 'standard'], ['Radio', 2, ''], ['Pad', 3, 'standard'],
  ])
  expect(events).toHaveBeenCalledExactlyOnceWith('connect')
  fake.tick()
  expect(service.getDevices()).toBe(initial)

  fake.event({ type: 'blur' })
  expect(events).toHaveBeenLastCalledWith('blur')
  fake.event({ type: 'disconnect', id: 'Pad', index: 0 })
  expect(events).toHaveBeenLastCalledWith('disconnect')
  expect(service.getDevices()).toEqual(initial.slice(1))
  fake.tick()
  expect(service.getDevices()[0]?.connection).not.toBe(initial[0]?.connection)
  expect(service.getDevices()[2]).toBe(initial[2])

  stop()
  expect(fake.frames.size).toBe(1)
  stopSecond()
  expect(fake.frames.size).toBe(0)
  expect(service.getDevices()).toEqual([])
  fake.tick()
  expect(fake.source.read).toHaveBeenCalledTimes(4)
})

it('measures only the selected axis and connection and handles neutral axis noise explicitly', () => {
  const fake = fakeSource()
  const service = createGamepadService(fake.source)
  const events = vi.fn()
  const stop = service.subscribe(events)
  const axes = [0, 0, 0, 0]
  fake.set(pad('Pad', 0, axes), pad('Pad', 1))
  fake.tick()
  const device = service.getDevices()[0]!
  const sweep = createAxisSweep(device, STANDARD_AXES.forward)
  const stopSweeping = service.subscribe(() => {
    for (const sample of service.getDevices()) sweep.add(sample)
  })
  axes[3] = -0.8
  fake.tick()
  expect(device.axes[3]).toBe(0)
  expect(events).toHaveBeenLastCalledWith('sample')
  axes[3] = 0.9
  fake.tick()
  fake.set(null, pad('Pad', 1, [0, 0, 0, -1]))
  fake.tick()
  expect(events).toHaveBeenLastCalledWith('disconnect')
  fake.set(pad('Pad', 0, [0, 0, 0, 1]), pad('Pad', 1))
  fake.tick()
  expect(sweep.finish()).toEqual({ min: -0.8, max: 0.9 })

  const draft = createDraft()
  draft.forward = { ...draft.forward, axis: STANDARD_AXES.forward, range: sweep.finish(), trim: 0, deadZone: '0.05' }
  draft.throttle = { ...draft.throttle, axis: STANDARD_AXES.throttle, range: { min: -0.8, max: 1 } }
  expect(checkAxis(draft, 'throttle', 4).errors.trim).toBe('Choose how to set throttle trim.')
  draft.throttle.trimMethod = 'midpoint'
  expect(checkAxis(draft, 'throttle', 4).binding?.trim).toBeCloseTo(0.1)
  const binding = checkAxis(draft, 'forward', 4).binding!
  draft.forward.deadZone = '1e'
  expect(checkAxis(draft, 'forward', 4).errors.deadZone).toBe('Enter a finite, non-negative dead zone.')
  const calibration = {
    forward: binding,
    right: { ...binding, axis: STANDARD_AXES.right },
    yawRight: { ...binding, axis: STANDARD_AXES.yawRight },
    throttle: { ...binding, axis: STANDARD_AXES.throttle },
  }
  expect(readSticks({ ...device, axes: [0, 0, 0, 0.03] }, calibration)?.forward).toBe(0)
  expect(readSticks({ ...device, axes: [0.9, -0.8, 0.9, -0.8] }, calibration)).toEqual({
    forward: 1, right: 1, yawRight: 1, throttle: 1,
  })
  expect(readSticks({ ...device, axes: [0] }, calibration)).toBeNull()
  stopSweeping()
  stop()
})
