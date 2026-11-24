/**
 * The workshop's drop test: load the vehicle into the engine and run it from rest in the
 * project's environment. Everything is validated here with the protocol schemas before it
 * is sent, and again by the engine; nothing is filled in (an incomplete environment is
 * refused by the schema, then by the engine's ENVIRONMENT_INCOMPLETE).
 */
import { z } from 'zod'
import type { DropTestResult, IpcResult } from '../../ipc/contract'
import { EnvironmentSchema, StartClearanceSchema, VehicleDefinitionSchema, type SimRunParams, type SimRunResult, type VehicleDefinition, type VehicleLoadResult } from './protocol'

/** Longest drop test: well inside the engine's 120 000-step limit at the default 1 ms step. */
export const MAX_DROP_TEST_S = 10

const finite = z.number().refine(Number.isFinite, 'must be finite')
export const dropTestSchema = z.strictObject({
  vehicle: VehicleDefinitionSchema,
  environment: EnvironmentSchema,
  startPositionM: z.tuple([finite, finite, finite]),
  startClearanceM: StartClearanceSchema.optional(),
  durationS: finite.refine((v) => v > 0 && v <= MAX_DROP_TEST_S, `must be more than 0 and at most ${MAX_DROP_TEST_S} s`),
})

export interface EngineForDropTest {
  loadVehicle(vehicle: VehicleDefinition): Promise<VehicleLoadResult>
  runSim(params: SimRunParams): Promise<SimRunResult>
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')

export async function dropTest(engine: EngineForDropTest, payload: unknown): Promise<IpcResult<DropTestResult>> {
  const parsed = dropTestSchema.safeParse(payload)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: issues(parsed.error) } }
  const { vehicle, ...params } = parsed.data
  try {
    const loaded = await engine.loadVehicle(vehicle)
    if (!loaded.valid) {
      return { ok: false, error: { code: 'VALIDATION', message: `The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}` } }
    }
    const r = await engine.runSim(params)
    const startZM = params.startClearanceM === undefined ? params.startPositionM[2] : r.startZM
    if (startZM === undefined) throw new Error('The engine did not return the resolved release height')
    return {
      ok: true,
      data: {
        durationS: r.durationS,
        startZM,
        state: {
          positionM: r.state.positionM,
          quaternion: r.state.quaternion,
          linearVelocityMps: r.state.linearVelocityMps,
          angularVelocityRadps: r.state.angularVelocityRadps,
        },
        contacts: r.contacts,
        contactsDropped: r.contactsDropped,
      },
    }
  } catch (e) {
    // Engine refusals arrive as "CODE: message" (e.g. INVALID_PARAMS: the vehicle starts inside…).
    return { ok: false, error: { code: 'VALIDATION', message: (e as Error).message } }
  }
}
