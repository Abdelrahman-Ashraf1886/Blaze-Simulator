import { STANDARD_AXES, stickNames, type Stick } from './calibration'
import { createAxisSweep, createDraft } from './calibration-draft'
import type { InputDevice } from './gamepads'

// Starting from Mode 2 (calibration.ts:20), Mode 1 swaps vertical channels,
// Mode 4 swaps horizontal channels, and Mode 3 swaps both pairs.
export const PLAYSTATION_MODES = {
  '1': { ...STANDARD_AXES, throttle: STANDARD_AXES.forward, forward: STANDARD_AXES.throttle },
  '2': STANDARD_AXES,
  '3': { throttle: STANDARD_AXES.forward, forward: STANDARD_AXES.throttle, right: STANDARD_AXES.yawRight, yawRight: STANDARD_AXES.right },
  '4': { ...STANDARD_AXES, right: STANDARD_AXES.yawRight, yawRight: STANDARD_AXES.right },
}

export type StickMode = keyof typeof PLAYSTATION_MODES

export function createGuidedCapture(device: InputDevice, mode: StickMode) {
  const axes = PLAYSTATION_MODES[mode]
  const makeSweeps = () => {
    const sweep = (stick: Stick) => createAxisSweep(device, axes[stick])
    return { forward: sweep('forward'), right: sweep('right'), yawRight: sweep('yawRight'), throttle: sweep('throttle') }
  }
  const endpoints = makeSweeps()
  let rangeFinished = false
  let rest: ReturnType<typeof makeSweeps> | null = null

  function add(sample: InputDevice) {
    const sweeps = rest ?? (rangeFinished ? null : endpoints)
    if (sweeps) for (const sweep of Object.values(sweeps)) sweep.add(sample)
  }

  add(device)
  return {
    add,
    finishRange(sample: InputDevice) {
      if (sample.connection !== device.connection) return
      add(sample)
      rangeFinished = true
    },
    startRest(sample: InputDevice) {
      if (!rangeFinished || rest || sample.connection !== device.connection) return
      rest = makeSweeps()
      add(sample)
    },
    finish(sample: InputDevice | undefined) {
      if (!rest || sample?.connection !== device.connection) return null
      add(sample)
      const restingSweeps = rest
      const draft = createDraft()
      const spreads: Partial<Record<Stick, number>> = {}
      for (const stick of stickNames) {
        const resting = restingSweeps[stick].finish()
        // Midpoint minimizes the dead zone needed to cover all captured rest samples.
        const trim = resting ? (resting.min + resting.max) / 2 : null
        if (resting && trim !== null) spreads[stick] = Math.max(trim - resting.min, resting.max - trim)
        draft[stick] = { ...draft[stick], axis: axes[stick], range: endpoints[stick].finish(), trim, trimMethod: 'centre' }
      }
      return { draft, spreads }
    },
  }
}
