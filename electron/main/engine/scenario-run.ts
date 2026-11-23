/**
 * The scenarios page's run (4.9 part B): load the vehicle with its propulsion and drag into the engine, then fly
 * one scripted scenario on it. Everything crossing IPC is validated here with the protocol schemas before it
 * reaches the engine, which validates again; nothing is filled in (the air density, the cut-off and a
 * built-in's parameters are the caller's).
 */
import { z } from 'zod'
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
})

export interface EngineForScenario {
  loadVehicle(vehicle: VehicleDefinition, extra: { propulsion?: PropulsionDefinition; aero?: BodyDrag }): Promise<VehicleLoadResult>
  runScenario(params: ScenarioRunParams): Promise<ScenarioRunResult>
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
const invalid = (message: string): { ok: false; error: { code: 'VALIDATION'; message: string } } => ({ ok: false, error: { code: 'VALIDATION', message } })

export async function scenarioRun(engine: EngineForScenario, payload: unknown): Promise<IpcResult<ScenarioRunOutput>> {
  const parsed = scenarioRunSchema.safeParse(payload)
  if (!parsed.success) return invalid(issues(parsed.error))
  const { vehicle, propulsion, aero, scenario, config } = parsed.data
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero })
    if (!loaded.valid) return invalid(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    return { ok: true, data: await engine.runScenario({ scenario, config }) }
  } catch (e) {
    // Engine refusals arrive as "CODE: message" (e.g. INVALID_SCENARIO: …, CUTOFF_REQUIRED: …).
    return invalid((e as Error).message)
  }
}
