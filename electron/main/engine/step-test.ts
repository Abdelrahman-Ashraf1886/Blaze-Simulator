import type { IpcResult, StepTestOutput } from '../../ipc/contract'
import type { EngineForScenario } from './scenario-run'
import {
  BodyDragSchema,
  PropulsionDefinitionSchema,
  VehicleDefinitionSchema,
  StepTestRunParamsSchema,
  StepTestRunResultSchema,
  type EngineCommand,
  type StepTestRunParams,
  type StepTestRunResult,
} from './protocol'

type StepTestRequest = (command: Extract<EngineCommand, { type: 'stepTest.run' }>) => Promise<unknown>

/** Run on a vehicle already loaded by the caller, using its engine request transport. */
export async function runStepTest(request: StepTestRequest, params: unknown): Promise<StepTestRunResult> {
  const checked = StepTestRunParamsSchema.parse(params)
  return StepTestRunResultSchema.parse(await request({ type: 'stepTest.run', ...checked }))
}

const stepTestInputSchema = StepTestRunParamsSchema.extend({
  vehicle: VehicleDefinitionSchema,
  propulsion: PropulsionDefinitionSchema,
  aero: BodyDragSchema,
})

type EngineForStepTest = Pick<EngineForScenario, 'loadVehicle'> & {
  runStepTest(params: StepTestRunParams): Promise<StepTestRunResult>
}

export async function stepTest(engine: EngineForStepTest, payload: unknown): Promise<IpcResult<StepTestOutput>> {
  const invalid = (message: string) => ({ ok: false, error: { code: 'VALIDATION', message } } as const)
  const parsed = stepTestInputSchema.safeParse(payload)
  if (!parsed.success) return invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  const { vehicle, propulsion, aero, ...params } = parsed.data
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero })
    if (!loaded.valid) return invalid(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    return { ok: true, data: await engine.runStepTest(params) }
  } catch (error) {
    return invalid((error as Error).message)
  }
}
