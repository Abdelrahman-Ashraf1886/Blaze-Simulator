/**
 * The flight test's live session (4.8 part B): load the vehicle with its propulsion and drag, start a
 * controlled flight, step it in lockstep with the renderer's frames, end it. Everything crossing IPC is
 * validated here with the protocol schemas before it reaches the engine, which validates again; nothing is
 * filled in (the cut-off, the air density's altitude and every surface coefficient are the user's entries).
 */
import { z } from 'zod'
import { recordingOptionsSchema } from '../../ipc/schemas'
import { RECORD_EVERY_STEPS, type SessionRecorder } from '../telemetry/session-recorder'
import type { CaptureRequestLine } from './supervisor'
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
  recording: recordingOptionsSchema,
})

export interface EngineForFlight {
  loadVehicle(vehicle: VehicleDefinition, extra: { propulsion?: PropulsionDefinition; aero?: BodyDrag }, capture?: CaptureRequestLine): Promise<VehicleLoadResult>
  startFlightSession(params: FlightSessionStartParams, capture?: CaptureRequestLine): Promise<FlightSessionStartResult>
  stepFlightSession(params: FlightSessionStepParams, capture?: CaptureRequestLine): Promise<FlightSessionStepResult>
  endFlightSession(): Promise<FlightSessionEndResult>
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
const invalid = (message: string): { ok: false; error: { code: 'VALIDATION'; message: string } } => ({ ok: false, error: { code: 'VALIDATION', message } })

export async function flightStart(engine: EngineForFlight, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<FlightStartResult>> {
  const parsed = flightStartSchema.safeParse(payload)
  if (!parsed.success) return invalid(issues(parsed.error))
  const { vehicle, propulsion, aero, recording, ...session } = parsed.data
  const run = recording && recorder?.startFlight(recording, vehicle.motors.length, session.controller !== undefined)
  try {
    const loaded = await engine.loadVehicle(vehicle, { propulsion, aero }, ...(run ? [run.captureVehicle] : []))
    if (!loaded.valid) throw new Error(`The engine refused the vehicle: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    if (!run) {
      recorder?.replaceFlight(undefined)
      return { ok: true, data: await engine.startFlightSession(session) }
    }
    const data = await engine.startFlightSession({ ...session, sampleEverySteps: RECORD_EVERY_STEPS }, (line) => {
      recorder?.replaceFlight(run)
      run.captureStart(line)
    })
    run.sampled(data.channels, data.samples?.rows)
    if (!run.live) {
      delete data.channels
      delete data.samples
    }
    return { ok: true, data: run.reply(data, true) }
  } catch (e) {
    // Engine refusals arrive as "CODE: message" (e.g. CUTOFF_REQUIRED, INVALID_PARAMS: starts inside the ground…).
    const message = (e as Error).message
    await run?.finish('failed', message, message)
    return invalid(message)
  }
}

export async function flightStep(engine: EngineForFlight, payload: unknown, recorder?: SessionRecorder): Promise<IpcResult<FlightStepResult>> {
  const run = recorder?.flight
  const parsed = FlightSessionStepParamsSchema.safeParse(payload)
  if (!parsed.success) {
    const message = issues(parsed.error)
    void run?.finish('failed', message, message)
    return invalid(message)
  }
  try {
    if (!run) return { ok: true, data: await engine.stepFlightSession(parsed.data) }
    const data = await run.trackStep(engine.stepFlightSession(parsed.data, run.captureStep))
    run.update(data.diagnostic.state.timeS, data.stateHash)
    run.append(data.samples?.rows)
    if (data.endReason) void run.finish('completed', data.endReason)
    if (!run.live) delete data.samples
    return { ok: true, data: run.reply(data) }
  } catch (e) {
    const message = (e as Error).message
    void run?.finish('failed', message, message)
    return invalid(message)
  }
}

export async function flightEnd(engine: EngineForFlight, recorder?: SessionRecorder): Promise<IpcResult<FlightEndResult>> {
  const run = recorder?.flight
  try {
    const data = await engine.endFlightSession()
    if (!run) return { ok: true, data }
    await run.finish('completed', 'stopped')
    return { ok: true, data: run.reply(data, true) }
  } catch (e) {
    const message = (e as Error).message
    void run?.finish('failed', message, message)
    return invalid(message)
  } finally {
    if (recorder?.flight === run && recorder) recorder.flight = undefined
  }
}
