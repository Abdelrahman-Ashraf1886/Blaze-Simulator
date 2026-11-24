import {
  StepTestRunParamsSchema,
  StepTestRunResultSchema,
  type EngineCommand,
  type StepTestRunResult,
} from './protocol'

type StepTestRequest = (command: Extract<EngineCommand, { type: 'stepTest.run' }>) => Promise<unknown>

/** Run on a vehicle already loaded by the caller, using its engine request transport. */
export async function runStepTest(request: StepTestRequest, params: unknown): Promise<StepTestRunResult> {
  const checked = StepTestRunParamsSchema.parse(params)
  return StepTestRunResultSchema.parse(await request({ type: 'stepTest.run', ...checked }))
}
