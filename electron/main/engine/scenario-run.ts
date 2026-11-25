/**
 * The scenarios page's run (4.9 part B): load the vehicle with its propulsion and drag into the engine, then fly
 * one scripted scenario on it. Everything crossing IPC is validated here with the protocol schemas before it
 * reaches the engine, which validates again; nothing is filled in (the air density, the cut-off and a
 * built-in's parameters are the caller's).
 */
import { z } from 'zod'
import { recordingOptionsSchema } from '../../ipc/schemas'
import { RECORD_EVERY_STEPS, type SessionRecorder } from '../telemetry/session-recorder'
import type { CaptureRequestLine } from './supervisor'
import type { IpcResult, ScenarioRunOutput } from '../../ipc/contract'
import {
  BodyDragSchema,
  PropulsionDefinitionSchema,
  ScenarioConfigSchema,
  ScenarioRequestSchema,
  VehicleDefinitionSchema,
  type BodyDrag,
  type PropulsionDefinition,
  type ScenarioRunParams,
  type ScenarioRunResult,
  type VehicleDefinition,
  type VehicleLoadResult,
} from './protocol'

/** The scenario request plus the vehicle it flies. */
export const scenarioRunSchema = z.strictObject({
  vehicle: VehicleDefinitionSchema,
  propulsion: PropulsionDefinitionSchema,
  aero: BodyDragSchema,
  scenario: ScenarioRequestSchema,
  config: ScenarioConfigSchema,
  recording: recordingOptionsSchema,
})

export interface EngineForScenario {
  loadVehicle(vehicle: VehicleDefinition, extra: { propulsion?: PropulsionDefinition; aero?: BodyDrag }, capture?: CaptureRequestLine): Promise<VehicleLoadResult>
  runScenario(params: ScenarioRunParams, capture?: CaptureRequestLine): Promise<ScenarioRunResult>
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
const invalid = (message: string): { ok: false; error: { code: 'VALIDATION'; message: string } } => ({ ok: false, error: { code: 'VALIDATION', message } })

export async function scenarioRun(engine: EngineForScenario, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<ScenarioRunOutput>> {
  const parsed = scenarioRunSchema.safeParse(payload)
  if (!parsed.success) return invalid(issues(parsed.error))
  const { vehicle, propulsion, aero, scenario, config, recording } = parsed.data
  const run = recording && recorder?.startScenario(recording, vehicle.motors.length, scenario, config.sensors)
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero }, ...(run ? [run.captureVehicle] : []))
    if (!loaded.valid) throw new Error(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    if (!run) return { ok: true, data: await engine.runScenario({ scenario, config }) }
    const data = await engine.runScenario({ scenario, config: { ...config, sampleEverySteps: RECORD_EVERY_STEPS } }, run.captureStart)
    run.update(data.report.elapsedS, data.stateHash)
    run.sampled(data.channels, data.samples?.rows)
    const { endReason, passed } = data.report
    await run.finish('completed', endReason === 'duration' ? `duration (${passed ? 'passed' : 'failed'})` : endReason)
    if (!run.live) {
      delete data.channels
      delete data.samples
    }
    return { ok: true, data: run.reply(data, true) }
  } catch (e) {
    // Engine refusals arrive as "CODE: message" (e.g. INVALID_SCENARIO: …, CUTOFF_REQUIRED: …).
    const message = (e as Error).message
    await run?.finish('failed', message, message)
    return invalid(message)
  }
}
