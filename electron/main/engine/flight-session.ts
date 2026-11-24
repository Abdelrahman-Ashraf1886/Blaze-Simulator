/**
 * The flight test's live session (4.8 part B): load the vehicle with its propulsion and drag, start a
 * controlled flight, step it in lockstep with the renderer's frames, end it. Everything crossing IPC is
 * validated here with the protocol schemas before it reaches the engine, which validates again; nothing is
 * filled in (the cut-off, the air density's altitude and every surface coefficient are the user's entries).
 */
import { z } from 'zod'
import type { FlightEndResult, FlightStartResult, FlightStepResult, IpcResult } from '../../ipc/contract'
import {
  BodyDragSchema,
  FlightSessionStartParamsSchema,
  FlightSessionStepParamsSchema,
  PropulsionDefinitionSchema,
  VehicleDefinitionSchema,
  type BodyDrag,
  type FlightSessionEndResult,
  type FlightSessionStartParams,
  type FlightSessionStartResult,
  type FlightSessionStepParams,
  type FlightSessionStepResult,
  type PropulsionDefinition,
  type VehicleDefinition,
  type VehicleLoadResult,
} from './protocol'

const finite = z.number().refine(Number.isFinite, 'must be finite')

/** The session's start request, including optional FlightLoop settings, plus the vehicle it loads first.
 * The start position is required here.
 */
export const flightStartSchema = FlightSessionStartParamsSchema.extend({
  vehicle: VehicleDefinitionSchema,
  propulsion: PropulsionDefinitionSchema,
  aero: BodyDragSchema,
  startPositionM: z.tuple([finite, finite, finite]),
})

export interface EngineForFlight {
  loadVehicle(vehicle: VehicleDefinition, extra: { propulsion?: PropulsionDefinition; aero?: BodyDrag }): Promise<VehicleLoadResult>
  startFlightSession(params: FlightSessionStartParams): Promise<FlightSessionStartResult>
  stepFlightSession(params: FlightSessionStepParams): Promise<FlightSessionStepResult>
  endFlightSession(): Promise<FlightSessionEndResult>
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
const invalid = (message: string): { ok: false; error: { code: 'VALIDATION'; message: string } } => ({ ok: false, error: { code: 'VALIDATION', message } })

export async function flightStart(engine: EngineForFlight, payload: unknown): Promise<IpcResult<FlightStartResult>> {
  const parsed = flightStartSchema.safeParse(payload)
  if (!parsed.success) return invalid(issues(parsed.error))
  const { vehicle, propulsion, aero, ...session } = parsed.data
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero })
    if (!loaded.valid) return invalid(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    return { ok: true, data: await engine.startFlightSession(session) }
  } catch (e) {
    // Engine refusals arrive as "CODE: message" (e.g. CUTOFF_REQUIRED, INVALID_PARAMS: starts inside the ground…).
    return invalid((e as Error).message)
  }
}

export async function flightStep(engine: EngineForFlight, payload: unknown): Promise<IpcResult<FlightStepResult>> {
  const parsed = FlightSessionStepParamsSchema.safeParse(payload)
  if (!parsed.success) return invalid(issues(parsed.error))
  try {
    return { ok: true, data: await engine.stepFlightSession(parsed.data) }
  } catch (e) {
    return invalid((e as Error).message)
  }
}

export async function flightEnd(engine: EngineForFlight): Promise<IpcResult<FlightEndResult>> {
  try {
    return { ok: true, data: await engine.endFlightSession() }
  } catch (e) {
    return invalid((e as Error).message)
  }
}
