import type { StepTestInput, StepTestOutput } from '../../../electron/ipc/contract'
import { StepTestRunParamsSchema } from '../../../electron/main/engine/protocol'
import type { TuningOverrides } from '../../domain/controller-params'
import { thrustFactor } from '../../domain/thrust-curve'
import type { StepSample } from '../../domain/step-response'
import type { FlightGate } from '../flight/readiness'
import { readNumber } from './tuning-values'

type Step = StepTestInput['test']['step']
type Selection<T = Step> = T extends Step ? Omit<T, 'amplitudeRadps' | 'amplitudeRad' | 'amplitudeM'> : never
type Choice = Selection & { label: string; unit: string }

export const STEP_CHOICES: readonly Choice[] = [
  { label: 'Roll rate', type: 'rate', axis: 'roll', unit: 'rad/s' },
  { label: 'Pitch rate', type: 'rate', axis: 'pitch', unit: 'rad/s' },
  { label: 'Yaw rate', type: 'rate', axis: 'yaw', unit: 'rad/s' },
  { label: 'Roll attitude', type: 'attitude', axis: 'roll', unit: 'rad' },
  { label: 'Pitch attitude', type: 'attitude', axis: 'pitch', unit: 'rad' },
  { label: 'Yaw attitude', type: 'attitude', axis: 'yaw', unit: 'rad' },
  { label: 'Altitude', type: 'altitude', unit: 'm' },
  { label: 'Position X', type: 'position', axis: 'x', unit: 'm' },
  { label: 'Position Y', type: 'position', axis: 'y', unit: 'm' },
]

export const EMPTY_STEP_TEST = { step: '', amplitude: '', holdS: '', durationS: '', decimationSteps: '' }
export type StepTestDraft = typeof EMPTY_STEP_TEST
export type StepTestErrors = Partial<Record<keyof StepTestDraft, string>>
type Test = StepTestInput['test']

export function readStepTest(draft: StepTestDraft): { test: Test | null; errors: StepTestErrors } {
  const choice = STEP_CHOICES.find(({ label }) => label === draft.step)
  const amplitude = readNumber(draft.amplitude)
  let step: Step | undefined
  switch (choice?.type) {
    case 'rate': step = { type: 'rate', axis: choice.axis, amplitudeRadps: amplitude }; break
    case 'attitude': step = { type: 'attitude', axis: choice.axis, amplitudeRad: amplitude }; break
    case 'altitude': step = { type: 'altitude', amplitudeM: amplitude }; break
    case 'position': step = { type: 'position', axis: choice.axis, amplitudeM: amplitude }; break
  }
  const parsed = StepTestRunParamsSchema.shape.test.safeParse({
    step, holdS: readNumber(draft.holdS), durationS: readNumber(draft.durationS), decimationSteps: readNumber(draft.decimationSteps),
  })
  if (parsed.success) return { test: parsed.data, errors: {} }

  const errors: StepTestErrors = {}
  for (const issue of parsed.error.issues) {
    const field = issue.path[0]
    if (field === 'step') {
      if (!choice) errors.step = 'Choose a step.'
      else errors.amplitude = issue.message
    } else if (field === 'holdS' || field === 'durationS' || field === 'decimationSteps') {
      errors[field] = draft[field].trim() === '' ? 'Enter a value.' : issue.message
    }
  }
  if (draft.amplitude.trim() === '') errors.amplitude = 'Enter an amplitude.'
  return { test: null, errors }
}

// Same vehicle, ISA air density and project cut-off as scenarios.ts:83–97.
export function stepTestInput(gate: FlightGate, test: Test | null, saved: TuningOverrides | null): StepTestInput | null {
  if (!gate.ok || !test || saved === null) return null
  const { vehicle, propulsion, aero, airDensityKgM3, cutoff, sensors } = gate.input
  return { vehicle, propulsion, aero, test, config: {
    airDensityKgM3, cutoff, gains: { ...saved, THR_MDL_FAC: thrustFactor(gate.thrustFit, saved) },
    ...(sensors === undefined ? {} : { sensors }),
  } }
}

export function measuredSamples(trace: StepTestOutput['trace']): StepSample[] {
  const samples: StepSample[] = []
  for (const { timeS, signal } of trace.samples) {
    const y = signal.kind === 'rate' ? signal.measuredRadps : signal.kind === 'attitude' ? signal.measuredRad : signal.measuredM
    if (y !== null) samples.push({ t: timeS, y })
  }
  return samples
}

/** The engine aligns filtered rate feedback with the true-state trace (protocol.ts:803–821). */
export function gyroRateSamples(result: StepTestOutput, step: Test['step']): StepSample[] {
  if (step.type !== 'rate' || !result.rateLoopFeedback) return []
  const axis = { roll: 0, pitch: 1, yaw: 2 } as const
  return result.rateLoopFeedback.flatMap(({ fromGyro, rateUsedRadps }, i) =>
    fromGyro ? [{ t: result.trace.samples[i]!.timeS, y: rateUsedRadps[axis[step.axis]] }] : [])
}
