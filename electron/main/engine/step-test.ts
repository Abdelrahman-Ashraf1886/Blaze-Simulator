import type { IpcResult, StepTestOutput } from '../../ipc/contract'
import { recordingOptionsSchema } from '../../ipc/schemas'
import { traceRows, type SessionRecorder } from '../telemetry/session-recorder'
import type { CaptureRequestLine } from './supervisor'
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
  recording: recordingOptionsSchema,
})

type EngineForStepTest = Pick<EngineForScenario, 'loadVehicle'> & {
  runStepTest(params: StepTestRunParams, capture?: CaptureRequestLine): Promise<StepTestRunResult>
}

export async function stepTest(engine: EngineForStepTest, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<StepTestOutput>> {
  const invalid = (message: string) => ({ ok: false, error: { code: 'VALIDATION', message } } as const)
  const parsed = stepTestInputSchema.safeParse(payload)
  if (!parsed.success) return invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  const { vehicle, propulsion, aero, recording, ...params } = parsed.data
  const run = recording && recorder?.startStepTest(recording, vehicle.motors.length, params.test)
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero }, ...(run ? [run.captureVehicle] : []))
    if (!loaded.valid) throw new Error(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    if (!run) return { ok: true, data: await engine.runStepTest(params) }
    const data = await engine.runStepTest(params, run.captureStart)
    run.update(data.elapsedS, data.stateHash)
    await run.appendBatch(() => traceRows(data.trace))
    const failed = data.endReason === 'error' || data.endReason === 'nonFinite'
    await run.finish(failed ? 'failed' : 'completed', data.error ?? data.endReason, failed ? data.error ?? data.endReason : null)
    return { ok: true, data: run.reply(data, true) }
  } catch (error) {
    const message = (error as Error).message
    await run?.finish('failed', message, message)
    return invalid(message)
  }
}
