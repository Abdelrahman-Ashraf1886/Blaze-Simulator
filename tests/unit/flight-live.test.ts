/**
 * 4.8 part B: the live flight. The engine's camelCase response maps to a FlightFrame in one adapter; the
 * source steps the engine once per animation frame with the elapsed time (capped); the page starts only
 * when the build is ready to fly; the IPC boundary validates everything; and a real engine session runs
 * through the same handlers.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FlightStartInput, FlightStepInput, FlightStepResult, IpcResult, RecordingOptions } from '../../electron/ipc/contract'
import { flightEnd, flightStart, flightStep, type EngineForFlight } from '../../electron/main/engine/flight-session'
import {
  FlightDiagnosticSchema, FlightSessionLogRequestSchema, FlightSessionLogResultSchema, FlightSessionStartParamsSchema,
  FlightSessionStartResultSchema, FlightSessionStepParamsSchema, FlightSessionStepResultSchema, MAX_SESSION_STEPS,
  MAX_SCENARIO_S, PROTOCOL_VERSION, ScenarioRunParamsSchema, ScenarioRunResultSchema, SimRunParamsSchema, SimRunResultSchema, StepTestRunParamsSchema,
  StepTestRunResultSchema, isEngineResponse, type FlightSessionStepParams,
} from '../../electron/main/engine/protocol'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import { scenarioRun } from '../../electron/main/engine/scenario-run'
import { stepTest } from '../../electron/main/engine/step-test'
import { openDatabase } from '../../electron/main/db/database'
import { createRepositories } from '../../electron/main/db/repositories'
import { Frame } from '../../electron/main/telemetry/format'
import { RECORD_EVERY_STEPS, SessionRecorder } from '../../electron/main/telemetry/session-recorder'
import { RecordingStore } from '../../electron/main/telemetry/store'
import { unwrap } from '../../src/services/api'
import type { ReadyItem } from '../../src/domain/propulsion'
import type { SensorPayload } from '../../src/domain/sensors'
import { telemetryChannels } from '../../src/domain/telemetry-channels'
import { simWind } from '../../src/domain/wind'
import { EngineFlightSource, idleFrame, MAX_STEP_MS, stepsForElapsed, toEngineSetpoint, toFlightFrame } from '../../src/features/flight/EngineFlightSource'
import { airDensityFor, conditionBlockers, EMPTY_CONDITIONS, enginePayload, flightGate, type EnginePayload, type FlightConditions } from '../../src/features/flight/readiness'
import { flightStartWithTuning } from '../../src/features/flight/flight-mode'
import { mapPx4Sticks, mapSticks } from '../../src/features/flight/sticks'
import type { AssemblyDocument, FrameParams } from '../../electron/ipc/contract'
import { buildFrame } from '../../src/three/frame-geometry'

// The 4.7 test quad (engine-core's test motor, not a catalogue part): 1 kg on 0.15 m arms, as the sidecar tests fly it.
const A = 0.15
const mount = (id: string, x: number, y: number, spin: 'cw' | 'ccw') => ({ partId: id, position: [x, y, 0], thrustAxis: [0, 0, 1], spin })
const quad = {
  vehicle: {
    version: 1,
    parts: [{ partId: 'body', massKg: 1, com: [0, 0, 0], inertia: [0.01, 0.01, 0.02, 0, 0, 0], pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, shape: { type: 'box', halfExtents: [0.05, 0.05, 0.02] } }],
    motors: [mount('m1', A, -A, 'ccw'), mount('m2', -A, A, 'ccw'), mount('m3', A, A, 'cw'), mount('m4', -A, -A, 'cw')],
    totalMassKg: 1, com: [0, 0, 0], inertia: [0.01, 0.01, 0.02, 0, 0, 0], missingMass: [],
  },
  propulsion: {
    version: 1,
    motors: ['m1', 'm2', 'm3', 'm4'].map((partId) => ({ partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: 1.225 })),
    battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 },
  },
  aero: { cdBody: [1, 1, 1], areaM2: [0.01, 0.01, 0.01] },
}
const REST_Z = 0.02 // the body's half height: resting on the ground

// ---- the engine's diagnostic and the adapter -------------------------------------------------------------

const v3 = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
const diagnostic = (overrides: Record<string, unknown> = {}) => ({
  state: { steps: 16, timeS: 0.016, positionM: [0.1, 0.2, 0.3], quaternion: [0, 0, 0.1, 0.995], comM: [0.11, 0.21, 0.31], linearVelocityMps: [1, 2, 3], angularVelocityRadps: [0, 0, 1], angularVelocityBodyRadps: [0.1, 0.2, 0.3] },
  motors: [
    { partId: 'm1', throttle: 0.5, rpm: 3820, thrustN: 3, dragTorqueNm: 0.03 },
    { partId: 'm2', throttle: 0.6, rpm: 3915, thrustN: 3.1, dragTorqueNm: 0.031 },
  ],
  battery: { voltageV: 15.2, currentA: 9, chargeUsedC: 0.144, stateOfCharge: 0.99 },
  loads: {
    thrustBodyN: v3(0, 0, 6.1), dragBodyN: v3(-0.1, 0, 0), armTorqueNm: v3(0.01, 0.02, 0), dragReactionTorqueNm: v3(0, 0, 0.03),
    spinUpReactionTorqueNm: v3(0, 0, -0.004), rotorGyroTorqueNm: v3(0.001, 0, 0), totalTorqueNm: v3(0.011, 0.02, 0.026),
    windComWorldMps: v3(0, 0, 0), groundEffectAddedThrustN: 0, groundEffectStatus: [], windAboveRange: false, windInvalid: false,
  },
  airDensityKgM3: 1.2,
  control: { torqueDemand: [0.1, 0.2, 0.3], rateIntegral: [0, 0.1, 0], collectiveThrust: 0.5, saturation: { positive: [true, false, false, false], negative: [false, false, false, true] } },
  ...overrides,
})
const stepResult = (over: Partial<FlightStepResult> = {}, diag: Record<string, unknown> = {}): FlightStepResult => ({
  stepsRun: 16,
  diagnostic: FlightDiagnosticSchema.parse(diagnostic(diag)),
  contacts: [],
  contactsDropped: 0,
  endReason: null,
  stateHash: '0123456789abcdef',
  ...over,
})

describe('the response adapter', () => {
  it('maps the engine diagnostic and contacts to a FlightFrame', () => {
    const d = FlightDiagnosticSchema.parse(diagnostic())
    const frame = toFlightFrame(d, null, [{ partId: 'frame', with: 'obstacle:wall', startS: 0.01, endS: null }, { partId: 'leg-1', with: 'ground', startS: 0, endS: 0.5 }])
    const rad = (rpm: number) => rpm * ((2 * Math.PI) / 60)
    expect(frame).toEqual({
      timeS: 0.016,
      positionM: [0.1, 0.2, 0.3],
      quaternion: [0, 0, 0.1, 0.995],
      comM: [0.11, 0.21, 0.31],
      linearVelocityMps: [1, 2, 3],
      angularVelocityBodyRadps: [0.1, 0.2, 0.3], // the body-frame rates, not the world ones
      motors: [
        { throttle: 0.5, omegaRadps: rad(3820), thrustN: 3, dragTorqueNm: 0.03 }, // rpm in, rad/s out
        { throttle: 0.6, omegaRadps: rad(3915), thrustN: 3.1, dragTorqueNm: 0.031 },
      ],
      totalThrustN: 6.1,
      thrustBodyN: { x: 0, y: 0, z: 6.1 },
      dragBodyN: { x: -0.1, y: 0, z: 0 },
      environmentLoads: {
        windComWorldMps: [0, 0, 0], groundEffectAddedThrustN: 0, groundEffectStatus: [], windAboveRange: false, windInvalid: false,
      },
      armTorqueNm: { x: 0.01, y: 0.02, z: 0 },
      dragReactionTorqueNm: { x: 0, y: 0, z: 0.03 },
      spinUpReactionTorqueNm: { x: 0, y: 0, z: -0.004 },
      rotorGyroTorqueNm: { x: 0.001, y: 0, z: 0 },
      totalTorqueNm: { x: 0.011, y: 0.02, z: 0.026 },
      packVoltageV: 15.2,
      packCurrentA: 9,
      chargeUsedMah: 0.144 / 3.6, // coulombs to mAh
      densityKgM3: 1.2,
      control: { torqueDemand: [0.1, 0.2, 0.3], rateIntegral: [0, 0.1, 0], saturation: { positive: [true, false, false, false], negative: [false, false, false, true] } },
      flightLoop: null,
      ended: null,
      contacts: [
        { part: 'frame', object: 'obstacle:wall', startS: 0.01, endS: null },
        { part: 'leg-1', object: 'ground', startS: 0, endS: 0.5 },
      ],
    })
  })

  it('maps actual PX4 mode, inactive axes and hover variance', () => {
    const flightLoop = {
      mode: 'stabilized',
      autoMode: null,
      takeoffState: 'flight',
      landState: { freefall: false, groundContact: false, maybeLanded: false, landed: false },
      commandFinished: false,
      positionSetpointM: [null, null, null],
      velocitySetpointMps: [null, 0, 1],
      accelerationSetpointMps2: [null, null, 1],
      saturation: diagnostic().control.saturation,
      hoverThrust: { estimate: 0.5, variance: 0.01, valid: false },
      velocityIntegral: [0, 0, 1],
    }
    const frame = toFlightFrame(FlightDiagnosticSchema.parse(diagnostic({ control: null, flightLoop })), null, [], 'position')
    expect(frame.flightLoop).toMatchObject({
      mode: 'stabilized', requestedMode: 'position', takeoffState: 'flight', landState: flightLoop.landState,
      positionSetpointM: [null, null, null], velocitySetpointMps: [null, 0, 1],
      accelerationSetpointMps2: [null, null, 1], velocityIntegral: [0, 0, 1],
      hoverThrust: { estimate: 0.5, standardDeviation: 0.1, valid: false },
    })
    const unavailable = { ...flightLoop, hoverThrust: { estimate: null, variance: null, valid: false } }
    expect(toFlightFrame(FlightDiagnosticSchema.parse(diagnostic({ flightLoop: unavailable })), null, []).flightLoop?.hoverThrust.standardDeviation).toBeNull()
  })

  it('maps each PX4 stick with opposing keys cancelling and no UI limits', () => {
    const positive = ['ArrowUp', 'ArrowRight', 'KeyD', 'KeyW']
    const negative = ['ArrowDown', 'ArrowLeft', 'KeyA', 'KeyS']
    const sticks = mapPx4Sticks(new Set(positive))
    expect(sticks).toEqual({ forward: 1, right: 1, yawRight: 1, throttle: 1 })
    expect(mapPx4Sticks(new Set(negative))).toEqual({ forward: -1, right: -1, yawRight: -1, throttle: -1 })
    expect(mapPx4Sticks(new Set([...positive, ...negative]))).toEqual({ forward: 0, right: 0, yawRight: 0, throttle: 0 })
    expect(toEngineSetpoint({ mode: 'altitude', sticks })).toEqual({ mode: 'altitude', sticks })
  })

  it('uses all saved overrides for PX4 and names unsupported overrides for 4.7', () => {
    const saved = { MC_ROLL_P: 7, MPC_USE_HTE: 1, MPC_THR_CURVE: 0, MC_AIRMODE: 1 }
    expect(flightStartWithTuning('position', saved)).toEqual({
      session: { gains: { ...saved, THR_MDL_FAC: 0 }, controller: { mode: 'position' } }, unsupported: [],
    })
    expect(flightStartWithTuning('attitudeHold', saved)).toEqual({
      session: { gains: { MC_ROLL_P: 7, MPC_USE_HTE: 1, THR_MDL_FAC: 0 } }, unsupported: ['MPC_THR_CURVE', 'MC_AIRMODE'],
    })
  })

  it('carries the end reason and an absent controller through, and copies rather than aliases', () => {
    const d = FlightDiagnosticSchema.parse(diagnostic({ control: null }))
    const frame = toFlightFrame(d, 'voltageCutoff', [])
    expect(frame.ended).toBe('voltageCutoff')
    expect(frame.control).toBeNull()
    frame.positionM[0] = 99
    frame.motors[0]!.thrustN = 99
    expect(d.state.positionM[0]).toBe(0.1)
    expect(d.motors[0]!.thrustN).toBe(3)
  })

  it('maps the stick setpoint to the controller setpoint as a climb-rate hold (no altitude target)', () => {
    const s = mapSticks(new Set(['KeyW', 'KeyA']), 0.3)
    const e = toEngineSetpoint(s)
    expect(e).toEqual({ attitude: s.attitude, yawRateRadps: s.yawRateRadps, climbRateMps: s.verticalVelocityMps })
    expect('altitudeM' in e).toBe(false)
    expect(FlightSessionStepParamsSchema.safeParse({ steps: 1, setpoint: e }).success).toBe(true)
  })

  it('an idle frame rests at the start position with the CoM offset applied', () => {
    const f = idleFrame(4, [0, 0, 0.05], [0.01, -0.02, 0.03])
    expect(f.positionM).toEqual([0, 0, 0.05])
    expect(f.comM).toEqual([0.01, -0.02, 0.08])
    expect(f.motors).toHaveLength(4)
    expect(f.ended).toBeNull()
  })
})

// ---- step sizing --------------------------------------------------------------------------------------

describe('step sizing', () => {
  it('sends whole milliseconds and keeps the fraction owed', () => {
    expect(stepsForElapsed(0)).toEqual({ steps: 0, owedMs: 0 })
    expect(stepsForElapsed(0.4)).toEqual({ steps: 0, owedMs: 0.4 })
    const a = stepsForElapsed(16.7)
    expect(a.steps).toBe(16)
    expect(a.owedMs).toBeCloseTo(0.7, 12)
    expect(stepsForElapsed(a.owedMs + 16.7).steps).toBe(17)
  })
  it('caps a slow frame and drops the surplus instead of catching up', () => {
    expect(stepsForElapsed(MAX_STEP_MS)).toEqual({ steps: MAX_STEP_MS, owedMs: 0 })
    expect(stepsForElapsed(MAX_STEP_MS + 0.5).steps).toBe(MAX_STEP_MS)
    expect(stepsForElapsed(5000)).toEqual({ steps: MAX_STEP_MS, owedMs: 0 })
    expect(MAX_STEP_MS).toBeLessThanOrEqual(100) // the engine's limit per request
  })
  it('ignores a clock that went backwards or is not a number', () => {
    expect(stepsForElapsed(-5)).toEqual({ steps: 0, owedMs: 0 })
    expect(stepsForElapsed(NaN)).toEqual({ steps: 0, owedMs: 0 })
  })
})

// ---- the source -----------------------------------------------------------------------------------------

const startInput = (): FlightStartInput => ({
  vehicle: quad.vehicle,
  propulsion: quad.propulsion,
  aero: quad.aero,
  environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] },
  airDensityKgM3: 1.225,
  cutoff: { type: 'chargeMah', value: 1000 },
  startPositionM: [0, 0, REST_Z],
})
const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function harness(step: (input: FlightStepInput) => IpcResult<FlightStepResult> | Promise<IpcResult<FlightStepResult>> = () => ok(stepResult())) {
  let clock = 1000
  let pending: (() => void) | null = null
  const api = {
    flightStart: vi.fn(async () => ok({ dtS: 0.001, maxStepsPerRequest: 100, diagnostic: FlightDiagnosticSchema.parse(diagnostic({ state: { ...diagnostic().state, steps: 0, timeS: 0 }, control: null })) })),
    flightStep: vi.fn(async (input: FlightStepInput) => step(input)),
    flightEnd: vi.fn(async () => ok({ ended: true })),
  }
  const source = new EngineFlightSource(api, startInput(), { now: () => clock, schedule: (cb) => { pending = cb; return () => { if (pending === cb) pending = null } } })
  const frames: ReturnType<typeof toFlightFrame>[] = []
  const errors: string[] = []
  source.subscribe((f) => frames.push(f))
  source.onError((m) => errors.push(m))
  return {
    api, source, frames, errors,
    /** One animation frame `ms` after the last, then let the request settle. */
    async frame(ms: number) {
      clock += ms
      const cb = pending
      pending = null
      cb?.()
      await flush()
    },
    hasPendingFrame: () => pending !== null,
  }
}

describe('EngineFlightSource', () => {
  it('starts a session, publishes the initial frame, then one frame per animation frame', async () => {
    const h = harness()
    h.source.start(() => mapSticks(new Set()))
    await flush()
    expect(h.api.flightStart).toHaveBeenCalledWith(startInput())
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]!.timeS).toBe(0)
    expect(h.frames[0]!.control).toBeNull()
    await h.frame(16)
    await h.frame(17)
    expect(h.api.flightStep.mock.calls.map(([i]) => i.steps)).toEqual([16, 17])
    expect(h.frames).toHaveLength(3) // never more than one frame per request
    expect(h.errors).toEqual([])
  })

  it('stops requesting steps while paused and drops time and fractions across a resume', async () => {
    const h = harness()
    const sticks = mapPx4Sticks(new Set(['ArrowUp']))
    let paused = false
    h.source.start(() => paused ? null : { mode: 'position', sticks })
    await flush()
    await h.frame(16.75)
    paused = true
    h.source.resetStepClock()
    await h.frame(5000)
    expect(h.api.flightStep.mock.calls.map(([input]) => input.steps)).toEqual([16])
    expect(h.frames).toHaveLength(2)
    paused = false
    h.source.resetStepClock()
    await h.frame(16.5)
    expect(h.api.flightStep.mock.calls.map(([input]) => input)).toEqual([
      { steps: 16, setpoint: { mode: 'position', sticks } },
      { steps: 16, setpoint: { mode: 'position', sticks } },
    ])
  })

  it('carries the current stick setpoint on every request and skips frames shorter than 1 ms', async () => {
    const h = harness()
    let keys = new Set<string>()
    h.source.start(() => mapSticks(keys))
    await flush()
    await h.frame(16)
    keys = new Set(['KeyW'])
    await h.frame(0.5)
    expect(h.api.flightStep).toHaveBeenCalledTimes(1)
    await h.frame(16)
    expect(h.api.flightStep.mock.calls[0]![0].setpoint).toMatchObject({ climbRateMps: 0 })
    expect(h.api.flightStep.mock.calls[1]![0]).toMatchObject({ steps: 16, setpoint: { climbRateMps: 2 } }) // 16.5 ms owed → 16, 0.5 kept
  })

  it('caps a slow frame (the simulation slows instead of sending a huge request)', async () => {
    const h = harness()
    h.source.start(() => mapSticks(new Set()))
    await flush()
    await h.frame(2000)
    expect(h.api.flightStep.mock.calls[0]![0].steps).toBe(MAX_STEP_MS)
    await h.frame(10)
    expect(h.api.flightStep.mock.calls[1]![0].steps).toBe(10) // no catch-up burst afterwards
  })

  it('accumulates contacts across steps, by part, object and start time', async () => {
    let n = 0
    const lists = [
      [{ partId: 'frame', with: 'ground', startS: 0, endS: null }],
      [],
      [{ partId: 'frame', with: 'ground', startS: 0, endS: 0.4 }, { partId: 'frame', with: 'obstacle:wall', startS: 0.4, endS: null }],
    ]
    const h = harness(() => ok(stepResult({ contacts: lists[n++]! })))
    h.source.start(() => mapSticks(new Set()))
    await flush()
    await h.frame(16)
    await h.frame(16)
    await h.frame(16)
    expect(h.frames.map((f) => f.contacts)).toEqual([
      [],
      [{ part: 'frame', object: 'ground', startS: 0, endS: null }],
      [{ part: 'frame', object: 'ground', startS: 0, endS: null }],
      [{ part: 'frame', object: 'ground', startS: 0, endS: 0.4 }, { part: 'frame', object: 'obstacle:wall', startS: 0.4, endS: null }],
    ])
  })

  it('publishes the cut-off frame, then ends the session and stops stepping', async () => {
    const h = harness(() => ok(stepResult({ endReason: 'voltageCutoff' })))
    h.source.start(() => mapSticks(new Set()))
    await flush()
    await h.frame(16)
    expect(h.frames.at(-1)!.ended).toBe('voltageCutoff')
    expect(h.api.flightEnd).toHaveBeenCalledTimes(1)
    expect(h.hasPendingFrame()).toBe(false)
    h.source.stop() // idempotent
    expect(h.api.flightEnd).toHaveBeenCalledTimes(1)
  })

  it('reports a refused start and stops', async () => {
    const h = harness()
    h.api.flightStart.mockResolvedValueOnce({ ok: false, error: { code: 'VALIDATION', message: 'CUTOFF_REQUIRED: cutoff is required' } } as never)
    h.source.start(() => mapSticks(new Set()))
    await flush()
    expect(h.errors).toEqual(['CUTOFF_REQUIRED: cutoff is required'])
    expect(h.frames).toHaveLength(0)
    expect(h.hasPendingFrame()).toBe(false)
    expect(h.api.flightEnd).not.toHaveBeenCalled()
  })

  it('reports a failed step (or a transport error) once and ends the session', async () => {
    let calls = 0
    const h = harness(() => { if (calls++ === 1) throw new Error('engine request flight.session.step timed out'); return ok(stepResult()) })
    h.source.start(() => mapSticks(new Set()))
    await flush()
    await h.frame(16)
    await h.frame(16)
    expect(h.errors).toEqual(['engine request flight.session.step timed out'])
    expect(h.api.flightEnd).toHaveBeenCalledTimes(1)
    expect(h.hasPendingFrame()).toBe(false)
    const count = h.frames.length
    await h.frame(16)
    expect(h.frames).toHaveLength(count)
  })

  it('reports an engine refusal of a step', async () => {
    const h = harness(() => ({ ok: false, error: { code: 'VALIDATION', message: 'NO_SESSION: start a flight session first' } }))
    h.source.start(() => mapSticks(new Set()))
    await flush()
    await h.frame(16)
    expect(h.errors).toEqual(['NO_SESSION: start a flight session first'])
  })

  it('stop ends the session and silences the source; a stop during start leaves no session behind', async () => {
    const h = harness()
    h.source.start(() => mapSticks(new Set()))
    await flush()
    h.source.stop()
    expect(h.api.flightEnd).toHaveBeenCalledTimes(1)
    const count = h.frames.length
    await h.frame(16)
    expect(h.frames).toHaveLength(count)

    const early = harness()
    early.source.start(() => mapSticks(new Set()))
    early.source.stop() // before the start request resolved
    await flush()
    expect(early.frames).toHaveLength(0)
    expect(early.api.flightEnd).toHaveBeenCalledTimes(1) // the session the engine did create is ended
  })

  it('a second start replaces the run: the old one publishes nothing more', async () => {
    const h = harness()
    h.source.start(() => mapSticks(new Set()))
    await flush()
    h.source.start(() => mapSticks(new Set()))
    await flush()
    expect(h.api.flightStart).toHaveBeenCalledTimes(2)
    expect(h.frames).toHaveLength(2) // one initial frame each
  })
})

// ---- readiness gating ---------------------------------------------------------------------------------

const readyConditions: FlightConditions = { ambientAltitudeM: 120, temperatureC: null, cutoffType: 'voltageV', cutoffValue: 13.2 }
const payload = (): EnginePayload => ({
  vehicle: quad.vehicle as unknown as EnginePayload['vehicle'],
  propulsion: quad.propulsion as unknown as EnginePayload['propulsion'],
  thrustFit: null,
  aero: { cdBody: [1, 1, 1], areaM2: [0.01, 0.01, 0.01] },
  environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] },
  startPositionM: [0, 0, REST_Z],
})

describe('readiness gating', () => {
  it('lists the flight conditions that are not entered, linked to their fields', () => {
    expect(conditionBlockers(EMPTY_CONDITIONS).map((b) => [b.id, b.link])).toEqual([
      ['flight-altitude', { to: 'flight-field', elementId: 'flight-altitude' }],
      ['flight-cutoff', { to: 'flight-field', elementId: 'flight-cutoff-value' }],
    ])
    expect(conditionBlockers({ ...readyConditions, cutoffValue: null }).map((b) => b.id)).toEqual(['flight-cutoff'])
    expect(conditionBlockers(readyConditions)).toEqual([])
  })

  it('a complete build with entered conditions builds the start request; nothing is filled in', () => {
    const gate = flightGate({ ok: true, payload: payload() }, readyConditions)
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    expect(gate.input).toMatchObject({ cutoff: { type: 'voltageV', value: 13.2 }, startPositionM: [0, 0, REST_Z] })
    expect('ambientAltitudeM' in gate.input).toBe(false) // the engine takes the density, not the altitude
    expect(gate.input.airDensityKgM3).toBe(airDensityFor(120, null))
    const hot = flightGate({ ok: true, payload: payload() }, { ...readyConditions, temperatureC: 35 })
    expect(hot.ok && hot.input.airDensityKgM3).toBeLessThan(airDensityFor(120, null))
  })

  it('the air density is the standard atmosphere at the entered altitude (USSA 1976)', () => {
    expect(airDensityFor(0, null)).toBeCloseTo(1.225, 4)
    expect(airDensityFor(1500, null)).toBeCloseTo(1.0581, 3) // USSA 1976 Table I: 1.0581 kg/m³ at 1.5 km
    expect(airDensityFor(1500, 30)).toBeLessThan(airDensityFor(1500, null))
  })

  it('a missing cut-off or altitude blocks a complete build', () => {
    for (const [missing, id] of [[{ cutoffValue: null }, 'flight-cutoff'], [{ ambientAltitudeM: null }, 'flight-altitude']] as const) {
      const gate = flightGate({ ok: true, payload: payload() }, { ...readyConditions, ...missing })
      expect(gate.ok).toBe(false)
      expect(gate.ok ? [] : gate.blockers.map((b) => b.id)).toEqual([id])
    }
  })

  it('an incomplete build lists its Ready-to-fly items first, then the conditions', () => {
    const item: ReadyItem = { id: 'ground-friction', label: 'Ground friction coefficient', detail: 'x', link: { to: 'environment', elementId: 'ground-friction' } }
    const gate = flightGate({ ok: false, blockers: [item] }, EMPTY_CONDITIONS)
    expect(gate.ok).toBe(false)
    expect(gate.ok ? [] : gate.blockers.map((b) => b.id)).toEqual(['ground-friction', 'flight-altitude', 'flight-cutoff'])
  })

  it('a real, empty assembly is not ready: the checklist, not a payload', () => {
    const frame: FrameParams = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.1 }
    const doc: AssemblyDocument = { frame, frameMass: null, motors: {}, parts: [] }
    const result = enginePayload(doc, buildFrame('quad-x', frame), {}, {})
    expect(result.ok).toBe(false)
    const ids = result.ok ? [] : result.blockers.map((b) => b.id)
    expect(ids).toEqual(expect.arrayContaining(['frame-mass', 'battery', 'body-cd', 'ground-friction', 'ground-restitution']))
  })
})

// ---- the IPC boundary ---------------------------------------------------------------------------------

function fakeEngine(overrides: Partial<EngineForFlight> = {}) {
  const calls: string[] = []
  const engine: EngineForFlight = {
    loadVehicle: vi.fn(async () => { calls.push('load'); return { valid: true as const, partCount: 1, motorCount: 4, totals: { massKg: 2, com: [0, 0, 0] as [number, number, number], inertia: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number] }, missingMass: [] } }),
    startFlightSession: vi.fn(async () => { calls.push('start'); return { dtS: 0.001, maxStepsPerRequest: 100, diagnostic: FlightDiagnosticSchema.parse(diagnostic()) } }),
    stepFlightSession: vi.fn(async () => { calls.push('step'); return stepResult() }),
    endFlightSession: vi.fn(async () => { calls.push('end'); return { ended: true } }),
    ...overrides,
  }
  return { engine, calls }
}
const err = (r: IpcResult<unknown>) => (r.ok ? null : r.error)

describe('IPC validation', () => {
  it('loads the vehicle with propulsion and aero, then starts the session with the composed request', async () => {
    const { engine, calls } = fakeEngine()
    const r = await flightStart(engine, { ...startInput(), gains: { MC_ROLL_P: 7 } })
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['load', 'start'])
    expect(engine.loadVehicle).toHaveBeenCalledWith(quad.vehicle, { propulsion: quad.propulsion, aero: quad.aero })
    const sent = vi.mocked(engine.startFlightSession).mock.calls[0]![0]
    expect(sent).toEqual({
      environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] },
      startPositionM: [0, 0, REST_Z],
      airDensityKgM3: 1.225,
      cutoff: { type: 'chargeMah', value: 1000 },
      gains: { MC_ROLL_P: 7 },
    })
    expect(FlightSessionStartParamsSchema.safeParse(sent).success).toBe(true)
  })

  it('forwards exact Return gains through Flight Start', async () => {
    const { engine } = fakeEngine()
    const gains = { RTL_RETURN_ALT: 30, RTL_DESCEND_ALT: 10, NAV_ACC_RAD: 2, NAV_MC_ALT_RAD: 0.8, MIS_YAW_ERR: 12, MPC_XY_CRUISE: 5 }
    const controller = { mode: 'position' }
    const started = await flightStart(engine, { ...startInput(), controller, gains })
    expect(started.ok).toBe(true)
    expect(engine.startFlightSession).toHaveBeenCalledWith(expect.objectContaining({ controller, gains }))
  })

  it.each([
    ['an unknown controller mode', (p: Record<string, unknown>) => { p.controller = { mode: 'attitudeHold' } }],
    ['no cut-off', (p: Record<string, unknown>) => { delete p.cutoff }],
    ['a zero cut-off', (p: Record<string, unknown>) => { p.cutoff = { type: 'voltageV', value: 0 } }],
    ['an unknown cut-off type', (p: Record<string, unknown>) => { p.cutoff = { type: 'capacity', value: 5 } }],
    ['no air density', (p: Record<string, unknown>) => { delete p.airDensityKgM3 }],
    ['a motor with a zero reference density', (p: Record<string, unknown>) => { ((p.propulsion as { motors: Record<string, unknown>[] }).motors[0]!).referenceDensityKgM3 = 0 }],
    ['a zero air density', (p: Record<string, unknown>) => { p.airDensityKgM3 = 0 }],
    ['a gain that is not a PX4 name', (p: Record<string, unknown>) => { p.gains = { mc_roll_p: 7 } }],
    ['no start position', (p: Record<string, unknown>) => { delete p.startPositionM }],
    ['a non-finite start', (p: Record<string, unknown>) => { p.startPositionM = [0, 0, NaN] }],
    ['no propulsion', (p: Record<string, unknown>) => { delete p.propulsion }],
    ['no aero', (p: Record<string, unknown>) => { delete p.aero }],
    ['an incomplete ground', (p: Record<string, unknown>) => { p.environment = { ground: { friction: 0.5 }, obstacles: [] } }],
    ['a stray key', (p: Record<string, unknown>) => { p.durationS = 5 }],
    ['not an object', (p: Record<string, unknown>) => { for (const k of Object.keys(p)) delete p[k] }],
  ])('refuses a start with %s before it reaches the engine', async (_name, mutate) => {
    const { engine, calls } = fakeEngine()
    const payload = JSON.parse(JSON.stringify(startInput()))
    mutate(payload)
    const r = await flightStart(engine, payload)
    expect(err(r)?.code).toBe('VALIDATION')
    expect(err(r)?.message.length).toBeGreaterThan(5)
    expect(calls).toEqual([])
  })

  it('reports a vehicle the engine refuses, and an engine refusal of the session', async () => {
    const refused = fakeEngine({ loadVehicle: vi.fn(async () => ({ valid: false as const, errors: [{ path: 'parts[0].massKg', message: 'must be positive' }] })) })
    expect(err(await flightStart(refused.engine, startInput()))?.message).toBe('The engine refused the vehicle: parts[0].massKg: must be positive')
    expect(refused.calls).toEqual([])
    const noGround = fakeEngine({ startFlightSession: vi.fn(async () => { throw new Error('INVALID_PARAMS: the vehicle starts inside the environment') }) })
    expect(err(await flightStart(noGround.engine, startInput()))).toEqual({ code: 'VALIDATION', message: 'INVALID_PARAMS: the vehicle starts inside the environment' })
  })

  it('bounds a step to 1..=100 whole steps with a unit attitude, before the engine', async () => {
    const { engine, calls } = fakeEngine()
    const setpoint = { attitude: [0, 0, 0, 1], yawRateRadps: 0, climbRateMps: 0 }
    for (const bad of [
      { steps: 0, setpoint }, { steps: 101, setpoint }, { steps: 1.5, setpoint }, { steps: -1, setpoint },
      { setpoint }, { steps: 5 },
      { steps: 5, setpoint: { ...setpoint, attitude: [0, 0, 0, 2] } },
      { steps: 5, setpoint: { ...setpoint, climbRateMps: NaN } },
      { steps: 5, setpoint: { ...setpoint, gains: { MC_ROLL_P: 7 } } },
      { steps: 5, setpoint: { ...setpoint, extra: 1 } },
      { steps: 5, setpoint, extra: 1 },
      null,
    ]) expect(err(await flightStep(engine, bad))?.code).toBe('VALIDATION')
    expect(calls).toEqual([])
    expect((await flightStep(engine, { steps: 100, setpoint })).ok).toBe(true)
    expect((await flightStep(engine, { steps: 1, setpoint: { altitudeM: 2, climbRateMps: 0 } })).ok).toBe(true)
    expect(calls).toEqual(['step', 'step'])
  })

  it('passes a PX4 mode change and normalized sticks through IPC validation', async () => {
    const { engine } = fakeEngine()
    const controller = { mode: 'stabilized' }
    expect((await flightStart(engine, { ...startInput(), controller })).ok).toBe(true)
    expect(engine.startFlightSession).toHaveBeenCalledWith(expect.objectContaining({ controller }))

    const setpoint = { mode: 'position', sticks: mapPx4Sticks(new Set(['ArrowUp', 'KeyD'])) }
    expect((await flightStep(engine, { steps: 1, setpoint })).ok).toBe(true)
    expect(engine.stepFlightSession).toHaveBeenCalledWith({ steps: 1, setpoint })
    expect(err(await flightStep(engine, { steps: 1, setpoint: { ...setpoint, sticks: { ...setpoint.sticks, forward: 2 } } }))?.message).toContain('setpoint.sticks.forward')
    expect(engine.stepFlightSession).toHaveBeenCalledTimes(1)
  })

  it('passes engine step errors and end through the same envelope', async () => {
    const { engine } = fakeEngine({ stepFlightSession: vi.fn(async () => { throw new Error('NO_SESSION: start a flight session first') }) })
    expect(err(await flightStep(engine, { steps: 1, setpoint: { attitude: [0, 0, 0, 1], yawRateRadps: 0, climbRateMps: 0 } }))?.message).toBe('NO_SESSION: start a flight session first')
    expect(await flightEnd(engine)).toEqual({ ok: true, data: { ended: true } })
  })
})

// PX4 gyro filter defaults from database/reference/physics.v1.json:1540–1635.
const gyroFilters = { gyroCutoffHz: 40, dgyroCutoffHz: 30, notch0: null, notch1: null }
const wireDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sensorEffects = { noiseSigma: 0.03, vibrationSigma: 0.01, bias: null, randomWalk: 0.02, delaySteps: 2, range: null }
const sensors = {
  seed: -12, gyro: sensorEffects,
  accelerometer: { ...sensorEffects, delaySteps: null, mountPositionM: v3(0.01, 0, 0) },
  barometer: { referenceAltitudeM: 1000, referenceTemperatureK: null, sigmaPa: null, biasPa: null, periodSteps: 3, delaySteps: null },
  gps: { positionSigmaHorizontalM: null, positionSigmaVerticalM: null, velocitySigmaMps: null, periodSteps: 3, delaySteps: 1 },
} satisfies SensorPayload

// ---- a real engine session through the same handlers -------------------------------------------------------

const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')

// Direct NDJSON also checks requests that Zod would refuse before the supervisor sends them.
async function withProtocol(run: (engine: {
  request: (command: object) => Promise<ReturnType<typeof decodeResponse>>
  sendLine: (line: string) => Promise<ReturnType<typeof decodeResponse>>
  result: (command: object) => Promise<unknown>
  lineBytes: (command: object) => number
  replyBytes: () => number
  replyLine: () => string
}) => Promise<void>) {
  const child = spawn(binaryPath, { stdio: ['pipe', 'pipe', 'ignore'] })
  await once(child, 'spawn')
  const closed = once(child, 'close')
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let nextId = 0
  let lastReply = ''
  const line = (id: number, command: object) => JSON.stringify({ ...command, id }) + '\n'
  const sendLine = async (requestLine: string) => {
    child.stdin.write(requestLine)
    const reply = await replies.next()
    if (reply.done) throw new Error('The engine closed stdout before replying')
    lastReply = reply.value
    return decodeResponse(reply.value)
  }
  const request = async (command: object) => {
    const id = nextId++
    const response = await sendLine(line(id, command))
    expect(response.id).toBe(id)
    return response
  }
  const result = async (command: object) => {
    const response = await request(command)
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
  try {
    await run({
      request, sendLine, result, lineBytes: (command) => Buffer.byteLength(line(nextId, command)),
      replyBytes: () => Buffer.byteLength(lastReply) + 1, // The sidecar writes LF.
      replyLine: () => lastReply,
    })
    await result({ type: 'shutdown' })
  } finally {
    child.stdin.end()
    expect((await closed)[0]).toBe(0)
  }
}

function decodeResponse(line: string) {
  const response: unknown = JSON.parse(line)
  if (!isEngineResponse(response)) throw new Error('Expected an engine response')
  return response
}

describe('6.5 on the real NDJSON engine', () => {
  const { airDensityKgM3, cutoff } = startInput()
  const plane = { ground: { friction: 0.5, restitution: 0 }, obstacles: [] } // startInput fixture
  const startPositionM = v3(0, 0, REST_Z)
  const load = { type: 'vehicle.load', ...quad }
  const free = { ground: null, obstacles: [] }
  const dtS = 0.001 // engine-core/src/sim.rs:28
  const durationS = MAX_SESSION_STEPS * dtS
  const sourceWind = simWind({
    kind: 'wind', fromDeg: 0, mean: { kind: 'constant', speedMps: 8 },
    // engine-core/src/flight/tests.rs:429–440,615–616
    gust: { kind: 'discrete', amplitudeMps: 8, lengthM: 4, startS: 1.5 * dtS },
  })
  if (!sourceWind.ok || !sourceWind.wind) throw new Error('Invalid wind fixture')
  const wind = sourceWind.wind
  // Same radius as the arm in engine-core/src/flight/tests.rs:674.
  const groundEffect = quad.vehicle.motors.map(() => A)
  // Flat terrain fixture from engine-core/src/environment/tests.rs:229–239.
  const cellSizeM = 2
  const flat = { ...plane.ground, rows: 2, columns: 2, cellSizeM, cornerM: [-cellSizeM, -cellSizeM], heightsM: [0, 0, 0, 0] }
  const terrainEnvironment = { ground: null, terrain: flat, obstacles: [] }
  const baseStart = FlightSessionStartParamsSchema.parse({ environment: plane, startPositionM, airDensityKgM3, cutoff, controller: { mode: 'position' } })
  const start = (params: unknown) => ({ type: 'flight.session.start', ...FlightSessionStartParamsSchema.parse(params) })
  const step = (steps: number, setpoint: FlightSessionStepParams['setpoint']) => ({
    type: 'flight.session.step', ...FlightSessionStepParamsSchema.parse({ steps, setpoint }),
  })
  const getLog = FlightSessionLogRequestSchema.parse({ type: 'flight.session.log' })
  const rates = { mode: 'rates', bodyRadps: v3(0, 0, 0), collective: 0.5 } as const

  it('samples the same steps and diagnostics across chunking, sampling rates and replay', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const initial = { ...baseStart, wind: { ...wind, turbulence: { kind: 'dryden', seed: 0 } }, groundEffect }
    const sticks = { forward: Math.sin(2), right: Math.cos(2), yawRight: 0.1, throttle: -1 }
    for (const sampleEverySteps of [0, 0.5, -1, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(await request({ type: 'scenario.run', scenario: { type: 'builtin', name: 'balanced_hover' }, config: {
        airDensityKgM3, cutoff, sampleEverySteps,
      } })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    const commands = [
      step(MAX_SESSION_STEPS - 1, rates),
      step(MAX_SESSION_STEPS, { mode: 'altitude', sticks }),
      step(MAX_SESSION_STEPS, { command: { type: 'return' } }),
    ]
    for (const sampleEverySteps of [0, 0.5, -1, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(FlightSessionStartParamsSchema.safeParse({ ...initial, sampleEverySteps }).success).toBe(false)
      expect(await request({ type: 'flight.session.start', ...initial, sampleEverySteps }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }

    const fly = async (chunk: number, sampleEverySteps?: number) => {
      const started = FlightSessionStartResultSchema.parse(await result(start({ ...initial, sampleEverySteps })))
      const diagnostics = [started.diagnostic]
      const steps = [...(started.samples?.steps ?? [])]
      const rows = [...(started.samples?.rows ?? [])]
      let hash = ''
      for (const input of commands) {
        for (let left = input.steps; left > 0; left -= chunk) {
          const advanced = FlightSessionStepResultSchema.parse(await result({ ...input, steps: Math.min(chunk, left) }))
          expect(advanced.stepsRun).toBe(Math.min(chunk, left))
          expect(advanced.samples !== undefined).toBe(sampleEverySteps !== undefined)
          expect(advanced.samples?.rows.every((row) => row.length === started.channels?.length) ?? true).toBe(true)
          diagnostics.push(advanced.diagnostic)
          steps.push(...(advanced.samples?.steps ?? []))
          rows.push(...(advanced.samples?.rows ?? []))
          hash = advanced.stateHash
        }
      }
      return { channels: started.channels, diagnostics, steps, rows, hash }
    }

    const off = await fly(1)
    expect(off.channels).toBeUndefined()
    expect(off.steps).toEqual([])
    const one = await fly(1, 1)
    expect(one.diagnostics).toEqual(off.diagnostics)
    expect(one.hash).toBe(off.hash)
    const columns = telemetryChannels(quad.vehicle.motors.length, 'flightLoop')
    expect(one.channels).toEqual(columns.map(({ name }) => name))
    expect(one.steps).toEqual(off.diagnostics.map(({ state }) => state.steps))

    const axis = ['x', 'y', 'z', 'w']
    for (const [i, diagnostic] of off.diagnostics.entries()) {
      const { state, motors, battery, loads, flightLoop } = diagnostic
      const row = one.rows[i]!
      const cell = (name: string) => row[columns.findIndex((column) => column.name === name)]
      const vector = (name: string, values: readonly (number | null)[]) =>
        expect(values.map((_, axisIndex) => cell(`${name}.${axis[axisIndex]}`)), name).toEqual(values)
      const code = (name: string, value: string | null | undefined) => {
        const column = columns.find((column) => column.name === name)
        if (column?.kind !== 'enum') throw new Error(`Missing enum ${name}`)
        expect(cell(name), name).toBe(value == null ? null : column.values.indexOf(value))
      }
      expect(cell('step')).toBe(state.steps)
      expect(cell('time')).toBe(state.timeS)
      vector('state.position', state.positionM)
      vector('state.com', state.comM)
      vector('state.quaternion', state.quaternion)
      vector('state.velocity', state.linearVelocityMps)
      vector('state.bodyRates', state.angularVelocityBodyRadps)
      for (const [index, motor] of motors.entries()) {
        const prefix = `motor.${index}`
        const model = quad.propulsion.motors[index]!
        const speed = motor.rpm * (2 * Math.PI / 60)
        const ground = loads.groundEffectStatus[index]
        expect(cell(`${prefix}.throttle`)).toBe(motor.throttle)
        expect(cell(`${prefix}.speed`)).toBe(speed)
        expect(cell(`${prefix}.thrust`)).toBe(motor.thrustN)
        expect(cell(`${prefix}.dragTorque`)).toBe(motor.dragTorqueNm)
        expect(cell(`${prefix}.current`)).toBeCloseTo(
          (motor.throttle * battery.voltageV - speed / model.kvRadPerSV) / model.resistanceOhm, 12,
        )
        code(`${prefix}.groundEffectStatus`, ground?.type)
        expect(cell(`${prefix}.groundEffectBelowTestedRange`)).toBe(ground?.type === 'applied' ? Number(ground.belowTestedRange) : null)
        code(`${prefix}.groundEffectInvalidReason`, ground?.type === 'invalidInput' ? ground.reason : null)
      }
      expect(cell('pack.voltage')).toBe(battery.voltageV)
      expect(cell('pack.current')).toBe(battery.currentA)
      expect(cell('pack.chargeUsed')).toBe(battery.chargeUsedC)
      vector('loads.thrust', loads.thrustBodyN)
      vector('loads.drag', loads.dragBodyN)
      vector('loads.armTorque', loads.armTorqueNm)
      vector('loads.dragReactionTorque', loads.dragReactionTorqueNm)
      vector('loads.spinUpReactionTorque', loads.spinUpReactionTorqueNm)
      vector('loads.rotorGyroTorque', loads.rotorGyroTorqueNm)
      vector('loads.totalTorque', loads.totalTorqueNm)
      vector('loads.wind', loads.windComWorldMps)
      vector('loads.turbulence', loads.turbulence?.velocityWorldMps ?? [null, null, null])
      expect(cell('loads.turbulenceBelowRange')).toBe(loads.turbulence ? Number(loads.turbulence.belowRange) : null)
      expect(cell('loads.turbulenceAboveRange')).toBe(loads.turbulence ? Number(loads.turbulence.aboveRange) : null)
      expect(cell('loads.groundEffectAddedThrust')).toBe(loads.groundEffectAddedThrustN)
      expect(cell('loads.windAboveRange')).toBe(Number(loads.windAboveRange))
      expect(cell('loads.windInvalid')).toBe(Number(loads.windInvalid))
      code('controller.mode', flightLoop?.mode)
      code('controller.autoMode', flightLoop?.autoMode)
      code('controller.takeoffState', flightLoop?.takeoffState)
      code('controller.returnState', flightLoop?.returnState)
      if (!flightLoop) continue
      for (const [field, value] of Object.entries(flightLoop.landState ?? {})) {
        expect(cell(`controller.land.${field}`)).toBe(Number(value))
      }
      vector('setpoint.position', flightLoop.positionSetpointM)
      vector('setpoint.velocity', flightLoop.velocitySetpointMps)
      vector('setpoint.acceleration', flightLoop.accelerationSetpointMps2)
      vector('controller.velocityIntegral', flightLoop.velocityIntegral)
      expect(cell('controller.hoverThrust')).toBe(flightLoop.hoverThrust.estimate)
      expect(cell('controller.hoverThrustVariance')).toBe(flightLoop.hoverThrust.variance)
      expect(cell('controller.hoverThrustValid')).toBe(Number(flightLoop.hoverThrust.valid))
      for (const [sign, flags] of Object.entries(flightLoop.saturation)) {
        for (const [demand, flag] of ['roll', 'pitch', 'yaw', 'collective'].map((name, j) => [name, flags[j]] as const)) {
          expect(cell(`controller.saturation.${sign}.${demand}`)).toBe(Number(flag))
        }
      }
      if (state.steps <= commands[0]!.steps) {
        code('input.command', 'rates')
        vector('input.rates', rates.bodyRadps)
        vector('setpoint.rates', rates.bodyRadps)
        expect(cell('input.collective')).toBe(rates.collective)
        expect(cell('setpoint.collectiveThrust')).toBe(rates.collective)
        expect(cell('input.stick.forward')).toBeNull()
      } else if (state.steps <= commands[0]!.steps + commands[1]!.steps) {
        code('input.command', 'altitude')
        // Rust and JS can round the same decimal token differently. The engine's rows below compare exactly.
        expect(cell('input.stick.forward')).toBeCloseTo(sticks.forward, 15)
        expect(cell('input.stick.right')).toBeCloseTo(sticks.right, 15)
        expect(cell('input.stick.yawRight')).toBeCloseTo(sticks.yawRight, 15)
        expect(cell('input.stick.throttle')).toBe(sticks.throttle)
      } else {
        code('input.command', 'return')
      }
    }
    const groundColumn = columns.findIndex(({ name }) => name === 'state.groundContact')
    expect(one.rows.some((row) => row[groundColumn] === 1)).toBe(true)

    for (const rate of [1, 4, 10]) {
      const expected = one.steps.filter((i) => i % rate === 0)
      for (const chunk of [1, 7, 17, MAX_SESSION_STEPS]) {
        const actual = await fly(chunk, rate)
        expect(actual.steps).toEqual(expected)
        expect(actual.rows).toEqual(expected.map((i) => one.rows[i]))
        expect(actual.hash).toBe(off.hash)
      }
    }

    const log = FlightSessionLogResultSchema.parse(await result(getLog))
    expect(log.start.sampleEverySteps).toBe(10)
    const replay = FlightSessionStartResultSchema.parse(await result(log.start))
    const replayed = [...replay.samples!.rows]
    for (const input of log.steps) {
      replayed.push(...FlightSessionStepResultSchema.parse(await result(input)).samples!.rows)
    }
    expect(replayed).toEqual(one.rows.filter((_, i) => i % 10 === 0))
  }), 30000)

  it('records post-step sensors reproducibly across chunks, recording schedules and log replay', async () => withProtocol(async ({ result }) => {
    await result(load)
    const initial = { ...baseStart, environment: free }
    const duration = 12
    const fly = async (chunk: number, model?: SensorPayload | null, sampleEverySteps?: number) => {
      const started = FlightSessionStartResultSchema.parse(await result(start({ ...initial, sensors: model, sampleEverySteps })))
      const rows = [...(started.samples?.rows ?? [])]
      let advanced!: ReturnType<typeof FlightSessionStepResultSchema.parse>
      for (let left = duration; left > 0; left -= chunk) {
        advanced = FlightSessionStepResultSchema.parse(await result(step(Math.min(left, chunk), rates)))
        rows.push(...(advanced.samples?.rows ?? []))
      }
      return { started, advanced, rows }
    }
    const off = await fly(duration)
    expect(await fly(duration, null)).toEqual(off)
    expect(await fly(duration, { seed: 9, gyro: null, accelerometer: null, barometer: null, gps: null })).toEqual(off)
    expect(off.started.channels).toBeUndefined()

    const plain = await fly(duration, undefined, 1)
    const run = await fly(duration, sensors, 1)
    // Captured with the 7.8 release sidecar, covering diagnostic, hash, channel order and row bytes.
    expect([off, plain, run].map(wireDigest)).toEqual([
      '81ae63bea365ed7bda6d567115e879a2f349e65bf460affa1e3b04f7db41cb42',
      'cb139e95513dddb361fd5dc47ecef0e36040b4b0e6f6b587a4ed42d5e8356a52',
      '7ff7613fcab4934494d0105adf40f09d0d2a04e3d79be9e8b8d474f14205e754',
    ])
    expect(run.advanced.stateHash).toBe('77549dedba77397c')
    expect(await fly(duration, { ...sensors, flyOnGyro: null }, 1)).toEqual(run)
    const { channels } = run.started
    const read = (row: number, channel: string) => run.rows[row]?.[channels!.indexOf(channel)]
    expect(channels?.slice(0, plain.started.channels!.length)).toEqual(plain.started.channels)
    expect(run.rows.map((row) => row.slice(0, plain.started.channels!.length))).toEqual(plain.rows)
    expect(run.advanced.diagnostic).toEqual(off.advanced.diagnostic)
    expect(run.advanced.stateHash).not.toBe(off.advanced.stateHash)
    expect(run.rows[0]!.slice(plain.started.channels!.length).every((value) => value === null)).toBe(true)
    expect(read(1, 'sensor.gyro.x')).toBeNull()
    expect(read(2, 'sensor.gyro.x')).toBeNull()
    expect(read(3, 'sensor.gyro.x')).toEqual(expect.any(Number))
    expect(read(1, 'sensor.gps.position.z')).toBeNull()
    expect(read(2, 'sensor.gps.position.z')).toBe(read(1, 'state.com.z'))
    expect(read(2, 'sensor.gps.velocity.z')).toBe(read(1, 'state.velocity.z'))
    expect(read(2, 'sensor.gps.velocity.z')).not.toBe(read(0, 'state.velocity.z'))
    expect(read(4, 'sensor.gps.position.z')).toBe(read(2, 'sensor.gps.position.z'))
    expect(read(5, 'sensor.gps.position.z')).toBe(read(4, 'state.com.z'))
    expect(read(1, 'sensor.barometer.altitude')).toBeCloseTo(sensors.barometer.referenceAltitudeM + read(1, 'state.com.z')!, 8)
    expect(read(3, 'sensor.barometer.pressure')).toBe(read(1, 'sensor.barometer.pressure'))
    expect(read(4, 'sensor.barometer.pressure')).not.toBe(read(3, 'sensor.barometer.pressure'))

    const otherSeed = await fly(duration, { ...sensors, seed: sensors.seed + 1 }, 1)
    const gyroX = channels!.indexOf('sensor.gyro.x')
    expect(otherSeed.rows.map((row) => row[gyroX])).not.toEqual(run.rows.map((row) => row[gyroX]))
    expect(otherSeed.advanced.stateHash).not.toBe(run.advanced.stateHash)
    expect((await fly(5, sensors)).advanced.stateHash).toBe(run.advanced.stateHash)
    const decimated = await fly(5, sensors, 3)
    expect(decimated.advanced.stateHash).toBe(run.advanced.stateHash)
    expect(decimated.rows).toEqual(run.rows.filter((_, i) => i % 3 === 0))
    const chunked = await fly(5, sensors, 1)
    expect(chunked.rows).toEqual(run.rows)
    expect(chunked.advanced.stateHash).toBe(run.advanced.stateHash)

    const log = FlightSessionLogResultSchema.parse(await result(getLog))
    expect(log.start.sensors).toEqual(sensors)
    const restarted = FlightSessionStartResultSchema.parse(await result(log.start))
    const replayed = [...restarted.samples!.rows]
    let replayedHash = ''
    for (const input of log.steps) {
      const advanced = FlightSessionStepResultSchema.parse(await result(input))
      replayed.push(...advanced.samples!.rows)
      replayedHash = advanced.stateHash
    }
    expect(replayed).toEqual(run.rows)
    expect(replayedHash).toBe(run.advanced.stateHash)
  }))

  it('uses the delayed gyro sample from the preceding row across chunk sizes and raw log replay', async () => withProtocol(async ({ result, sendLine, replyLine }) => {
    await result(load)
    // Bypass both filters to make the rate feedback directly checkable from the delayed raw column.
    const model = { ...sensors, flyOnGyro: { ...gyroFilters, gyroCutoffHz: 0, dgyroCutoffHz: 1 / dtS } }
    const fly = async (chunk: number, model: SensorPayload, sampleEverySteps?: number) => {
      const initial = FlightSessionStartResultSchema.parse(await result(start({ ...baseStart, environment: free, sensors: model, sampleEverySteps })))
      const rows = [...(initial.samples?.rows ?? [])]
      let hash = ''
      for (let left = MAX_SESSION_STEPS; left > 0; left -= chunk) {
        const next = FlightSessionStepResultSchema.parse(await result(step(Math.min(left, chunk), rates)))
        rows.push(...(next.samples?.rows ?? []))
        hash = next.stateHash
      }
      return { channels: initial.channels, rows, hash }
    }
    const whole = await fly(MAX_SESSION_STEPS, model, 1)
    for (const chunk of [1, 7, 17]) expect(await fly(chunk, model, 1)).toEqual(whole)
    expect((await fly(7, model)).hash).toBe(whole.hash)
    expect((await fly(7, model, 4)).rows).toEqual(whole.rows.filter((_, i) => i % 4 === 0))
    expect((await fly(17, { ...model, seed: model.seed + 1 })).hash).not.toBe(whole.hash)
    const at = (name: string) => whole.channels!.indexOf(name)
    const source = at('controller.rateSource')
    const raw = at('sensor.gyro.x')
    const filtered = at('sensor.gyroFiltered.x')
    const acceleration = at('sensor.angularAccelerationFiltered.x')
    const firstGyroStep = sensorEffects.delaySteps + 2
    for (const [i, row] of whole.rows.entries()) {
      expect(row[source]).toBe(Number(i >= firstGyroStep))
      if (i < firstGyroStep) {
        expect(row[filtered]).toBeNull()
      } else {
        expect(row[filtered]).toBe(Math.fround(whole.rows[i - 1]![raw]!))
        expect(row[acceleration]).toBe(i === firstGyroStep ? 0 : Math.fround(
          Math.fround(row[filtered]! - whole.rows[i - 1]![filtered]!) / dtS,
        ))
      }
    }
    const commands = [start({ ...baseStart, environment: free, sensors: model, sampleEverySteps: 1 })]
    const steps = []
    for (let left = MAX_SESSION_STEPS; left > 0; left -= 17) steps.push(step(Math.min(left, 17), rates))
    const wire = [...commands, ...steps].map((command, id) => JSON.stringify({ ...command, id }))
    for (const line of wire) expect((await sendLine(line + '\n')).ok).toBe(true)
    const log = FlightSessionLogResultSchema.parse(await result(getLog))
    expect(log.start.sensors).toEqual(model)
    // The sidecar embeds the original request lines as raw JSON (protocol.rs:422–431).
    const [loggedStart, ...loggedSteps] = wire
    expect(replyLine()).toContain('"result":{"start":' + loggedStart + ',"steps":[' + loggedSteps.join(',') + ']}')
    const replay = []
    let hash = ''
    for (const [i, line] of wire.entries()) {
      const reply = await sendLine(line + '\n')
      if (!reply.ok) throw new Error(reply.error.message)
      const value = i === 0 ? FlightSessionStartResultSchema.parse(reply.result) : FlightSessionStepResultSchema.parse(reply.result)
      replay.push(...value.samples!.rows)
      if ('stateHash' in value) hash = value.stateHash
    }
    expect(replay).toEqual(whole.rows)
    expect(hash).toBe(whole.hash)
  }))

  it('prints D20 release cost per 1 ms step for all sensor modes', async () => withProtocol(async ({ result }) => {
    await result(load)
    const modes = [undefined, sensors, { ...sensors, flyOnGyro: gyroFilters }]
    // Existing 100-step cap (flight_session.rs:30). Keep the same flight and
    // requests for all modes, with three repeats to take the median.
    const batches = 10
    const repetitions = 3
    for (const sampleEverySteps of [undefined, RECORD_EVERY_STEPS]) {
      const times: number[][] = modes.map(() => [])
      for (let repeat = 0; repeat < repetitions; repeat++) {
        for (const [index, sensors] of modes.entries()) {
          await result(start({ ...baseStart, environment: free, sensors, sampleEverySteps }))
          const input = step(MAX_SESSION_STEPS, rates)
          const began = performance.now()
          for (let i = 0; i < batches; i++) await result(input)
          times[index]!.push((performance.now() - began) * 1000 / (batches * MAX_SESSION_STEPS))
        }
      }
      const [off, recorded, flown] = times.map((runs) => runs.sort((a, b) => a - b)[1]!)
      console.info(`D20 sampleEverySteps=${sampleEverySteps ?? 'off'} µs/step off=${off!.toFixed(2)} recorded=${recorded!.toFixed(2)} flown=${flown!.toFixed(2)} flown/off=${(flown! / off!).toFixed(2)}x`)
    }
  }), 20_000)

  it('records sensors for both scenario controllers and rejects bad inputs at their paths', async () => withProtocol(async ({ request, result }) => {
    await result(load)
    const config = { airDensityKgM3, cutoff }
    const script = [{ fromS: 0, attitude: { type: 'euler', roll: 0, pitch: 0, yaw: 0 }, yawRateRadps: 0, zM: null, zVelocityMps: 0 }]
    for (const control of [
      { script },
      { script: [], flightScript: [{ fromS: 0, command: { type: 'hold' } }] },
    ]) {
      const scenario = { type: 'custom', scenario: { name: 'sensor readings', durationS: dtS * 5, modifications: [], checks: [], ...control } }
      const run = async (overrides: object) => ScenarioRunResultSchema.parse(await result({
        type: 'scenario.run', ...ScenarioRunParamsSchema.parse({ scenario, config: { ...config, ...overrides } }),
      }))
      const off = await run({})
      expect(await run({ sensors: null })).toEqual(off)
      const active = await run({ sensors, sampleEverySteps: 1 })
      // 7.8 release sidecar response snapshots for both scenario controllers.
      expect([off, active].map(wireDigest)).toEqual('flightScript' in control ? [
        '306f00c2f9e2dd817491d50ce3cb7892e4991f5e516a7171a20f0ee430d5a435',
        'dfec711e7dff74fbb9338a28180918ced69f8ea6adb35b41fcc4583fbf3d16a9',
      ] : [
        '57f5b62f159ab3569a59048f2a8d2d5d071737ba4175476c2b2f776a5dda8030',
        'd7d2e65252f1e53106d46d01f11c2d881a1c67b1e62488b54eea9ff2c271d3b5',
      ])
      expect(await run({ sensors: { ...sensors, flyOnGyro: null }, sampleEverySteps: 1 })).toEqual(active)
      expect(active.stateHash).not.toBe(off.stateHash)
      expect(active.report).toEqual({ ...off.report, finalStateHash: active.stateHash })
      expect(active.channels).toContain('sensor.gps.velocity.z')
      expect(active.samples?.steps).toEqual([0, 1, 2, 3, 4, 5])
      const gpsZ = active.channels!.indexOf('sensor.gps.velocity.z')
      const plantZ = active.channels!.indexOf('state.velocity.z')
      expect(active.samples?.rows[1]?.[gpsZ]).toBeNull()
      expect(active.samples?.rows[2]?.[gpsZ]).toBe(active.samples?.rows[1]?.[plantZ])
      expect((await run({ sensors })).stateHash).toBe(active.stateHash)
      const flown = { ...sensors, flyOnGyro: gyroFilters }
      const sampled = await run({ sensors: flown, sampleEverySteps: 1 })
      expect(sampled.stateHash).not.toBe(active.stateHash)
      expect(sampled.stateHash).toBe((await run({ sensors: flown })).stateHash)
      const rateSource = sampled.channels!.indexOf('controller.rateSource')
      expect(sampled.samples!.rows.map((row) => row[rateSource])).toEqual([0, 0, 0, 0, 1, 1])
      expect(sampled.samples!.rows.at(-1)![sampled.channels!.indexOf('sensor.gyroFiltered.x')]).not.toBe(0)
    }

    const scenario = { type: 'builtin', name: 'balanced_hover' }
    for (const [model, path] of [
      [{ ...sensors, gyro: null, flyOnGyro: gyroFilters }, 'flyOnGyro'],
      [{ ...sensors, flyOnGyro: { ...gyroFilters, gyroCutoffHz: -1 } }, 'flyOnGyro.gyroCutoffHz'],
      [{ ...sensors, flyOnGyro: { ...gyroFilters, notch1: { frequencyHz: 40 } } }, 'flyOnGyro.notch1.bandwidthHz'],
      [{ ...sensors, seed: Number.MAX_SAFE_INTEGER + 1 }, 'seed'],
      [{ ...sensors, gyro: { ...sensors.gyro, delaySteps: 0.5 } }, 'gyro.delaySteps'],
      [{ ...sensors, gyro: { ...sensors.gyro, noiseSigma: -1 } }, 'gyro.noiseSigma'],
      [{ ...sensors, gyro: { ...sensors.gyro, range: 0 } }, 'gyro.range'],
      [{ ...sensors, accelerometer: { ...sensors.accelerometer, mountPositionM: [0, 0] } }, 'accelerometer.mountPositionM'],
      [{ ...sensors, barometer: { ...sensors.barometer, referenceAltitudeM: 11001 } }, 'barometer.referenceAltitudeM'],
      [{ ...sensors, barometer: { ...sensors.barometer, referenceTemperatureK: 0 } }, 'barometer.referenceTemperatureK'],
      [{ ...sensors, barometer: { ...sensors.barometer, periodSteps: 0 } }, 'barometer.periodSteps'],
      [{ ...sensors, gps: { ...sensors.gps, velocitySigmaMps: -1 } }, 'gps.velocitySigmaMps'],
      [{ ...sensors, gps: { ...sensors.gps, delaySteps: undefined } }, 'gps.delaySteps'],
      [{ ...sensors, gps: { ...sensors.gps, delayMs: 1 } }, 'gps.delayMs'],
    ] as const) {
      const params = { ...baseStart, sensors: model }
      const scenarioParams = { scenario, config: { ...config, sensors: model } }
      expect(FlightSessionStartParamsSchema.safeParse(params).success).toBe(false)
      expect(ScenarioRunParamsSchema.safeParse(scenarioParams).success).toBe(false)
      expect(await request({ type: 'flight.session.start', ...params })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining(`sensors.${path}`) },
      })
      expect(await request({ type: 'scenario.run', ...scenarioParams })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining(`config.sensors.${path}`) },
      })
    }
  }))

  it('samples the step that reaches cut-off and sends empty arrays after it', async () => withProtocol(async ({ result }) => {
    await result(load)
    const initial = FlightSessionStartResultSchema.parse(await result(start({
      ...baseStart, environment: free, sampleEverySteps: 1,
      cutoff: { type: 'voltageV', value: quad.propulsion.battery.openCircuitVoltageV },
    })))
    expect(initial.samples?.steps).toEqual([0])
    const stopped = FlightSessionStepResultSchema.parse(await result(step(MAX_SESSION_STEPS, rates)))
    expect(stopped.stepsRun).toBe(1)
    expect(stopped.endReason).toBe('voltageCutoff')
    expect(stopped.samples?.steps).toEqual([1])
    const ended = FlightSessionStepResultSchema.parse(await result(step(1, rates)))
    expect(ended.stepsRun).toBe(0)
    expect(ended.samples).toEqual({ steps: [], rows: [] })
    expect(ended.stateHash).toBe(stopped.stateHash)
  }))

  it('prints the elapsed time and NDJSON bytes for 100 steps with and without samples', async () => withProtocol(async ({ result, request, replyBytes }) => {
    await result(load)
    for (const sampleEverySteps of [undefined, 1, 4]) {
      await result(start({ ...baseStart, environment: free, sampleEverySteps }))
      const began = performance.now()
      const reply = await request(step(MAX_SESSION_STEPS, rates))
      const elapsed = performance.now() - began
      expect(reply.ok).toBe(true)
      console.info(`100 steps, sampleEverySteps=${sampleEverySteps ?? 'off'}: ${elapsed.toFixed(2)} ms, ${replyBytes()} bytes (NDJSON including LF)`)
    }
  }))

  it('replays logged inputs, commands and mode changes at different chunk sizes', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const initial = start({ ...baseStart, environment: terrainEnvironment, wind, groundEffect })
    // Recorded analog inputs that exposed a loss of precision when the log
    // re-encoded its parsed JSON numbers (sin/cos of the fixture's two axes).
    const sticks = { forward: Math.sin(2), right: Math.cos(2), yawRight: 0.1, throttle: -1 }
    const inputs = [
      step(MAX_SESSION_STEPS, rates),
      step(MAX_SESSION_STEPS, { mode: 'altitude', sticks }),
      step(MAX_SESSION_STEPS, { command: { type: 'takeoff' } }),
      step(MAX_SESSION_STEPS, { command: { type: 'hold' } }),
      step(MAX_SESSION_STEPS, { command: { type: 'land' } }),
      step(MAX_SESSION_STEPS, { command: { type: 'return' } }),
      step(MAX_SESSION_STEPS, { sticks }),
    ]
    const started = FlightSessionStartResultSchema.parse(await result(initial))
    expect(started.diagnostic.loads.groundEffectStatus).toEqual(groundEffect.map(() => ({ type: 'inactive' })))
    let stateHash = ''
    const hashes = []
    const diagnostics = []
    for (const input of inputs) {
      const response = FlightSessionStepResultSchema.parse(await result(input))
      expect(response.stepsRun).toBe(MAX_SESSION_STEPS)
      stateHash = response.stateHash
      hashes.push(stateHash)
      diagnostics.push(response.diagnostic)
    }
    const [powered, manual, takeoff, hold, land, returning, resumed] = diagnostics
    if (!powered || !manual || !takeoff || !hold || !land || !returning || !resumed) throw new Error('A step diagnostic is missing')
    expect(powered.loads.windComWorldMps[0]).toBeLessThan(-8)
    expect(powered.loads.groundEffectAddedThrustN).toBeGreaterThan(0)
    expect(powered.loads.groundEffectStatus.every(({ type }) => type === 'applied')).toBe(true)
    expect(powered.loads.windAboveRange).toBe(false)
    expect(powered.loads.windInvalid).toBe(false)
    expect(manual.flightLoop?.mode).toBe('altitude')
    expect(takeoff.flightLoop).toMatchObject({ mode: 'position', autoMode: 'takeoff', commandFinished: false })
    expect(hold.flightLoop).toMatchObject({ mode: 'position', autoMode: 'hold', commandFinished: true })
    expect(land.flightLoop).toMatchObject({ mode: 'position', autoMode: 'land' })
    expect(returning.flightLoop).toMatchObject({ mode: 'position', autoMode: 'return', returnState: expect.any(String) })
    expect(resumed.flightLoop).toMatchObject({ mode: 'altitude', autoMode: null, commandFinished: false })

    const log = FlightSessionLogResultSchema.parse(await result(getLog))
    expect(log).toEqual({ start: { ...initial, id: 1 }, steps: inputs.map((input, index) => ({ ...input, id: index + 2 })) })
    console.info('Flight log bytes per step request (compact JSON, without LF)', log.steps.map((input) => Buffer.byteLength(JSON.stringify(input))))
    const replay = async (partition: number, changeGust = false) => {
      const replayStart = changeGust ? { ...log.start, wind: { ...wind, gust: null } } : log.start
      await result(replayStart)
      expect(FlightSessionLogResultSchema.parse(await result(getLog)).steps).toEqual([])
      const replayed = []
      for (const input of log.steps) {
        let last
        for (let remaining = input.steps; remaining > 0; remaining -= partition) {
          last = FlightSessionStepResultSchema.parse(await result({ ...input, steps: Math.min(remaining, partition) }))
        }
        replayed.push(last?.stateHash)
      }
      return replayed
    }
    expect(await replay(MAX_SESSION_STEPS)).toEqual(hashes)
    // Seven steps crosses the estimator interval (flight-live.test.ts mode chunking fixture).
    expect(await replay(7)).toEqual(hashes)
    expect((await replay(MAX_SESSION_STEPS, true)).at(-1)).not.toBe(stateHash)

    const takeoffHash = async (altitudeM?: number) => {
      await result(initial)
      return FlightSessionStepResultSchema.parse(await result(step(MAX_SESSION_STEPS, {
        command: { type: 'takeoff', ...(altitudeM === undefined ? {} : { altitudeM }) },
      }))).stateHash
    }
    // auto_modes.rs:12–14,38–43.
    expect(await takeoffHash()).toBe(await takeoffHash(2.5))
    expect(await takeoffHash(2 * 2.5)).not.toBe(await takeoffHash())
    await result({ type: 'flight.session.end' })
    expect(await request(getLog)).toMatchObject({ ok: false, error: { code: 'NO_SESSION' } })
  }))

  it('combines Dryden with mean and discrete gust, then replays the seeded session across chunk sizes', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const turbulence = { kind: 'dryden', seed: 0 } as const
    const setup = { ...baseStart, wind, groundEffect }
    const initial = start({ ...setup, wind: { ...wind, turbulence } })
    const oneStep = step(1, rates)
    const advance = async (input: typeof oneStep) => FlightSessionStepResultSchema.parse(await result(input))
    await result(start(setup))
    const baseline = await advance(oneStep)
    await result(start({ ...setup, wind: { ...wind, turbulence: null } }))
    expect(await advance(oneStep)).toEqual(baseline)
    expect(baseline.diagnostic.loads.turbulence).toBeUndefined()

    await result(initial)
    const first = await advance(oneStep)
    const sample = first.diagnostic.loads.turbulence
    expect(sample).toMatchObject({ belowRange: true, aboveRange: false })
    if (!sample) throw new Error('Dryden loads are missing')
    expect(first.diagnostic.loads.windComWorldMps).toEqual(
      baseline.diagnostic.loads.windComWorldMps.map((mean, axis) => mean + sample.velocityWorldMps[axis]!),
    )
    expect(toFlightFrame(first.diagnostic, first.endReason, first.contacts).environmentLoads?.turbulence).toEqual(sample)
    expect(first.diagnostic.loads.dragBodyN).not.toEqual(baseline.diagnostic.loads.dragBodyN)
    const full = await advance(step(MAX_SESSION_STEPS, rates))
    expect(full.diagnostic.loads.groundEffectAddedThrustN).toBeGreaterThan(0)

    const log = FlightSessionLogResultSchema.parse(await result(getLog))
    expect(log.start.wind).toEqual({ ...wind, turbulence })
    await result(log.start)
    expect(await advance(log.steps[0]!)).toEqual(first)
    expect(await advance(log.steps[1]!)).toEqual(full)

    await result(log.start)
    await advance(log.steps[0]!)
    const logged = log.steps[1]!
    let partitioned
    // The seven-step replay partition above crosses the estimator interval.
    for (let remaining = logged.steps; remaining > 0; remaining -= 7) {
      partitioned = await advance({ ...logged, steps: Math.min(remaining, 7) })
    }
    expect(partitioned?.stateHash).toBe(full.stateHash)
    expect(partitioned?.diagnostic).toEqual(full.diagnostic)

    await result(start({ ...setup, wind: { ...wind, turbulence: { ...turbulence, seed: 1 } } }))
    const different = await advance(oneStep)
    expect(different.stateHash).not.toBe(first.stateHash)
    expect(different.diagnostic.loads.turbulence).not.toEqual(sample)

    // The first step samples the height at exactly twice the 1000 ft limit.
    await result({ ...initial, startPositionM: v3(0, 0, 2 * 1000 * 0.3048) })
    expect((await advance(oneStep)).diagnostic.loads.turbulence).toMatchObject({ belowRange: false, aboveRange: true })
    for (const badWind of [
      { ...wind, mean: null, turbulence },
      { ...wind, mean: { kind: 'constant', speedMps: 0 }, turbulence },
    ]) {
      expect(await request({ ...initial, wind: badWind })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('requires a positive mean wind speed') },
      })
    }
    for (const badTurbulence of [{ kind: 'dryden' }, { ...turbulence, seed: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(await request({ ...initial, wind: { ...wind, turbulence: badTurbulence } })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('seed') },
      })
    }
  }))

  it('applies terrain and shapes and forwards the environment through batch, session and scenario', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const sim = { airDensityKgM3, durationS, startPositionM, environment: terrainEnvironment, wind, groundEffect,
      controller: rates }
    const batch = SimRunResultSchema.parse(await result({ type: 'sim.run', ...SimRunParamsSchema.parse(sim) }))
    const reset = start({ ...baseStart, environment: terrainEnvironment, wind, groundEffect, controller: { mode: rates.mode } })
    await result(reset)
    const live = FlightSessionStepResultSchema.parse(await result(step(MAX_SESSION_STEPS, rates)))
    expect(live.stateHash).toBe(batch.stateHash)
    expect(live.contacts.some(({ with: surface }) => surface === 'ground')).toBe(true)
    const noWind = SimRunResultSchema.parse(await result({ type: 'sim.run', ...sim, wind: null }))
    const noWindOmitted = SimRunResultSchema.parse(await result({ type: 'sim.run', ...sim, wind: undefined }))
    const noGroundEffect = SimRunResultSchema.parse(await result({ type: 'sim.run', ...sim, groundEffect: undefined }))
    expect(noWind.stateHash).toBe(noWindOmitted.stateHash)
    expect(noWind.stateHash).not.toBe(batch.stateHash)
    expect(noGroundEffect.stateHash).not.toBe(batch.stateHash)

    // Obstacle geometry follows environment.rs:352–366. Circumscribe the body
    // fixture with an arm-sized obstacle and approach from its upper face.
    const pose = { center: v3(0, 0, A), quaternion: [0, 0, 0, 1], ...plane.ground }
    const shapes = [
      { type: 'box', halfExtents: v3(A, A, A) },
      { type: 'cylinder', radius: A, height: 2 * A },
      { type: 'hull', points: [v3(-A, -A, A), v3(A, -A, A), v3(0, A, A), v3(0, 0, -A)] },
    ]
    for (const shape of shapes) {
      const environment = { ...terrainEnvironment, obstacles: [{ id: shape.type, ...pose, ...shape }] }
      const command = SimRunParamsSchema.parse({ ...sim, environment, startPositionM: v3(0, 0, 2 * A + REST_Z), controller: undefined })
      const contact = SimRunResultSchema.parse(await result({ type: 'sim.run', ...command }))
      const touchesObstacle = ({ with: surface }: { with: string }) => surface === `obstacle:${shape.type}`
      expect(contact.contacts.some(touchesObstacle)).toBe(true)
      await result(start({ ...baseStart, wind, groundEffect, environment, startPositionM: command.startPositionM, controller: { mode: rates.mode } }))
      const session = FlightSessionStepResultSchema.parse(await result(step(MAX_SESSION_STEPS, rates)))
      expect(session.contacts.some(touchesObstacle)).toBe(true)
    }

    const config = { environment: terrainEnvironment, startPositionM, airDensityKgM3, cutoff, wind, groundEffect }
    const scenario = { type: 'custom', scenario: {
      name: 'hold', durationS, modifications: [], checks: [],
      script: [{ fromS: 0, attitude: { type: 'euler', roll: 0, pitch: 0, yaw: 0 }, yawRateRadps: 0, zM: null, zVelocityMps: 0 }],
    } }
    const scenarioHash = async (overrides: object) => ScenarioRunResultSchema.parse(await result({
      type: 'scenario.run', ...ScenarioRunParamsSchema.parse({ scenario, config: { ...config, ...overrides } }),
    })).stateHash
    const configured = await scenarioHash({})
    expect(await scenarioHash({ wind: null })).not.toBe(configured)
    expect(await scenarioHash({ groundEffect: undefined })).not.toBe(configured)

    const invalid = { ...terrainEnvironment, terrain: { ...flat, heightsM: [null] },
      obstacles: [{ id: 'cylinder', ...pose, type: 'cylinder', height: A, radius: -A }] }
    for (const raw of [
      { type: 'sim.run', ...sim, environment: invalid },
      { ...reset, environment: invalid },
      { type: 'scenario.run', scenario, config: { ...config, environment: invalid } },
    ]) {
      const response = await request(raw)
      expect(response).toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_INCOMPLETE' } })
      if (response.ok) throw new Error('Expected environment refusal')
      for (const path of ['environment.terrain.heightsM[0]', 'environment.obstacles[0].radius']) {
        expect(response.error.message).toContain(raw.type === 'scenario.run' ? `config.${path}` : path)
      }
    }
  }))

  it('resolves terrain release height in batch and scenario runs and refuses invalid clearances', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const startClearanceM = REST_Z
    const batch = {
      type: 'sim.run', durationS: dtS, airDensityKgM3, environment: terrainEnvironment,
      startPositionM: v3(0, 0, -REST_Z), startClearanceM,
    }
    const release = SimRunResultSchema.parse(await result(batch))
    expect(release.startZM).toBeCloseTo(REST_Z + startClearanceM, 9)
    expect(release.contacts).toEqual([])
    expect(SimRunResultSchema.parse(await result(batch)).stateHash).toBe(release.stateHash)

    const scenario = {
      type: 'scenario.run', scenario: { type: 'custom', scenario: {
        name: 'lowered body', durationS: dtS, checks: [],
        modifications: [{ type: 'shiftPart', partId: 'body', deltaM: v3(0, 0, -REST_Z) }],
        script: [{ fromS: 0, attitude: { type: 'euler', roll: 0, pitch: 0, yaw: 0 }, yawRateRadps: 0, zM: null, zVelocityMps: 0 }],
      } },
      config: { airDensityKgM3, cutoff, environment: terrainEnvironment, startPositionM: batch.startPositionM, startClearanceM: 0 },
    }
    expect(ScenarioRunResultSchema.parse(await result(scenario)).report.endReason).toBe('duration')
    const shallow = { ...scenario.config, startClearanceM: undefined, startPositionM: startPositionM }
    expect(await request({ ...scenario, config: shallow })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('inside the ground') },
    })
    const refused = [
      [{ ...batch, startClearanceM: -REST_Z }, 'finite and non-negative'],
      [{ ...batch, environment: free }, 'requires a ground'],
      [{ ...batch, startPositionM: v3(cellSizeM, 0, 0) }, 'no vehicle part'],
      [{ ...start(baseStart), environment: free, startClearanceM: 0 }, 'requires a ground'],
      [{ ...scenario, config: { ...scenario.config, environment: undefined } }, 'requires config.environment'],
    ] as const
    for (const [command, message] of refused) {
      expect(await request(command)).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining(message) },
      })
    }
    for (const clearance of [NaN, Infinity, -REST_Z, null]) {
      expect(SimRunParamsSchema.shape.startClearanceM.safeParse(clearance).success).toBe(false)
      expect(FlightSessionStartParamsSchema.safeParse({ ...baseStart, startClearanceM: clearance }).success).toBe(false)
      expect(ScenarioRunParamsSchema.shape.config.safeParse({ ...scenario.config, startClearanceM: clearance }).success).toBe(false)
    }
  }))

  it('refuses bad values and auto commands outside FlightLoop and accepts optional step-test configuration', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    const legacy = start({ ...baseStart, controller: undefined })
    const off = FlightSessionStartResultSchema.parse(await result(legacy))
    expect(off.diagnostic.loads.groundEffectStatus).toEqual([])
    expect(off.diagnostic.loads.windComWorldMps).toEqual([0, 0, 0])
    const throttleRun = SimRunResultSchema.parse(await result({
      type: 'sim.run', durationS: 20 * dtS, startPositionM, airDensityKgM3, environment: free,
      throttle: quad.vehicle.motors.map(() => rates.collective),
    }))
    expect(throttleRun.stateHash).toBe('d7f97eadba824407')
    for (const type of ['takeoff', 'hold', 'land', 'return'] as const) {
      expect(await request(step(1, { command: { type } }))).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('requires a FlightLoop session') },
      })
    }
    const badAuto = { steps: 1, setpoint: { mode: 'position', command: { type: 'takeoff', altitudeM: -A } } }
    expect(FlightSessionStepParamsSchema.safeParse(badAuto).success).toBe(false)
    await result(start(baseStart))
    for (const setpoint of [
      badAuto.setpoint, { command: badAuto.setpoint.command }, { command: { type: 'hold', extra: true } },
      { command: { type: 'return', altitudeM: 2.5 } }, { command: { type: 'return' }, mode: 'position' },
    ]) {
      expect(await request({ type: 'flight.session.step', steps: 1, setpoint })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('setpoint.command') },
      })
    }
    expect(await request({ ...getLog, extra: true })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(FlightSessionLogResultSchema.parse(await result(getLog)).steps).toEqual([])
    const badWind = { ...wind, gust: { ...wind.gust, lengthM: -A } }
    const test = { step: { type: 'rate', axis: 'roll', amplitudeRadps: 10 * Math.PI / 180 }, holdS: 2 * dtS, durationS: 8 * dtS, decimationSteps: 2 }
    const config = { airDensityKgM3, cutoff }
    const stepTest = { type: 'stepTest.run', test, config }
    const unconfigured = StepTestRunResultSchema.parse(await result(stepTest))
    // 7.8 release sidecar response digest, including the true measurement column.
    expect(wireDigest(unconfigured)).toBe('2cf7b78cebd8637191797b68f5ce1b84401eac906031ba8f301203b1e21c758f')
    expect(await result({ ...stepTest, config: { ...config, sensors: null } })).toEqual(unconfigured)
    const recorded = StepTestRunResultSchema.parse(await result({ ...stepTest, config: { ...config, sensors } }))
    expect(recorded.trace).toEqual(unconfigured.trace)
    expect(recorded.rateLoopFeedback).toBeUndefined()
    const flown = StepTestRunResultSchema.parse(await result({
      ...stepTest, config: { ...config, sensors: { ...sensors, flyOnGyro: gyroFilters } },
    }))
    expect(flown.rateLoopFeedback?.map(({ fromGyro }) => fromGyro)).toEqual([false, false, true, true])
    expect(flown.trace).not.toEqual(recorded.trace)
    const allTicks = StepTestRunResultSchema.parse(await result({
      ...stepTest, test: { ...test, decimationSteps: 1 },
      config: { ...config, sensors: { ...sensors, flyOnGyro: gyroFilters } },
    }))
    expect(allTicks.stateHash).toBe(flown.stateHash)
    expect(allTicks.trace.samples.filter((_, i) => i % test.decimationSteps === 0)).toEqual(flown.trace.samples)
    expect(allTicks.rateLoopFeedback?.filter((_, i) => i % test.decimationSteps === 0)).toEqual(flown.rateLoopFeedback)
    expect(await request({ ...stepTest, config: { ...config, sensors: { ...sensors, gyro: null, flyOnGyro: gyroFilters } } })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('config.sensors.flyOnGyro') },
    })
    expect(unconfigured.stateHash).toBe('9644d51ae5ff0264')
    const configured = StepTestRunResultSchema.parse(await result({
      type: 'stepTest.run', ...StepTestRunParamsSchema.parse({ test, config: { ...config, wind, groundEffect } }),
    }))
    expect(configured.stateHash).not.toBe(unconfigured.stateHash)
    expect(await request({ ...stepTest, config: { ...config, groundEffect: [0] } })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('config.groundEffect[0]') },
    })
    expect(await request({ ...legacy, wind: badWind })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('wind.gust.lengthM') },
    })
    expect(await request({ ...legacy, groundEffect: [A] })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('groundEffect') },
    })
    await result({ type: 'vehicle.load', vehicle: quad.vehicle })
    for (const [field, value] of [['wind', null], ['groundEffect', groundEffect]] as const) {
      for (const raw of [
        { type: 'sim.run', durationS, environment: free, [field]: value },
        { ...legacy, [field]: value },
        { type: 'scenario.run', config: { [field]: value } },
        { ...stepTest, config: { ...config, [field]: value } },
      ]) {
        expect(await request(raw)).toMatchObject({ ok: false, error: { message: expect.stringContaining(field) } })
      }
    }
  }))

  it('reports takeoff completion and the landed detector state after descent', async () => withProtocol(async ({ result }) => {
    await result(load)
    await result(start(baseStart))
    const advance = async (type: 'takeoff' | 'hold' | 'land', seconds: number) => {
      let last
      for (let remaining = Math.round(seconds / dtS); remaining > 0; remaining -= MAX_SESSION_STEPS) {
        last = FlightSessionStepResultSchema.parse(await result(step(Math.min(remaining, MAX_SESSION_STEPS), { command: { type } })))
      }
      if (!last) throw new Error('Expected a completed flight step')
      return last
    }
    // TakeoffParams::default (takeoff.rs:23–26) and the settling window in flight_loop/tests.rs:307–316.
    const settlingS = 10
    const held = await advance('takeoff', 1 + 3 + settlingS)
    expect(held.diagnostic.flightLoop).toMatchObject({ takeoffState: 'flight', autoMode: 'hold', commandFinished: true, landState: { landed: false } })
    const hold = await advance('hold', settlingS)
    const landed = await advance('land', settlingS)
    expect(landed.diagnostic.flightLoop).toMatchObject({
      takeoffState: 'readyForTakeoff', autoMode: 'land', commandFinished: true,
      landState: { freefall: false, groundContact: true, maybeLanded: true, landed: true },
    })
    // Captured from the pre-6.12 engine with the same 6.7 command sequence.
    expect([held.stateHash, hold.stateHash, landed.stateHash]).toEqual([
      'fece47cf35a58a29', '007023cd74b4c922', '0163881fac232154',
    ])
  }), 20_000)

  it('validates exact Return session gains, including integer cone and fixed heading mode', async () => withProtocol(async ({ result, request }) => {
    await result(load)
    // Boundary inputs from rtl_params.c:47–138,166–176.
    const gains = {
      RTL_RETURN_ALT: 0, RTL_DESCEND_ALT: 2, RTL_LAND_DELAY: -1, RTL_MIN_DIST: 0.5, RTL_CONE_ANG: 90, RTL_HDG_MD: 0,
      NAV_ACC_RAD: 0.05, NAV_MC_ALT_RAD: 200, MIS_YAW_ERR: 90, MPC_XY_CRUISE: 3,
    }
    expect(FlightSessionStartResultSchema.parse(await result(start({ ...baseStart, gains }))).dtS).toBe(dtS)
    const grounded = FlightSessionStepResultSchema.parse(await result(step(1, { command: { type: 'return' } })))
    expect(grounded.diagnostic.flightLoop).toMatchObject({ autoMode: 'return', returnState: 'landed', commandFinished: true })
    for (const [name, value] of Object.entries({
      RTL_RETURN_ALT: -1, RTL_DESCEND_ALT: 1, RTL_LAND_DELAY: 301, RTL_MIN_DIST: 0,
      RTL_CONE_ANG: 45.5, RTL_HDG_MD: 1, rtl_return_alt: 30, RTL_TYPE: 0,
      NAV_ACC_RAD: 0, NAV_MC_ALT_RAD: 201, MIS_YAW_ERR: -1, MPC_XY_CRUISE: 21, nav_acc_rad: 2,
    })) {
      expect(await request({ ...start(baseStart), gains: { [name]: value } })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining(name) },
      })
    }
    expect(await request({ ...start(baseStart), gains: { RTL_RETURN_ALT: '30' } })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('RTL_RETURN_ALT') },
    })
  }))

  it('returns from low altitude at home without an additional climb', async () => withProtocol(async ({ result }) => {
    await result(load)
    const initial = FlightSessionStartResultSchema.parse(await result(start(baseStart)))
    const home = initial.diagnostic.state.comM
    // Same spool-up, ramp and settling window as the preceding 6.7 regression.
    let current = initial.diagnostic
    for (let remaining = (1 + 3 + 10) / dtS; remaining > 0; remaining -= MAX_SESSION_STEPS) {
      current = FlightSessionStepResultSchema.parse(await result(step(MAX_SESSION_STEPS, { command: { type: 'takeoff' } }))).diagnostic
    }
    expect(current.flightLoop?.autoMode).toBe('hold')
    const activationHeight = current.state.comM[2]
    const states = new Set<string>()
    // Keep the first samples small enough to see the two immediate waypoint transitions.
    for (let tick = 0; tick < 10 / dtS;) {
      const steps = tick < MAX_SESSION_STEPS ? 1 : MAX_SESSION_STEPS
      current = FlightSessionStepResultSchema.parse(await result(step(steps, { command: { type: 'return' } }))).diagnostic
      tick += steps
      const state = current.flightLoop?.returnState
      if (!state) throw new Error('Return diagnostic missing')
      states.add(state)
      expect(current.state.comM[2]).toBeLessThan(activationHeight + 0.01) // 6.7 hold tolerance.
      if (current.flightLoop?.commandFinished) break
    }
    expect([...states]).toEqual(['climb', 'return', 'land', 'landed'])
    expect(current.flightLoop).toMatchObject({ autoMode: 'return', commandFinished: true, landState: { landed: true } })
    expect(Math.abs(current.state.comM[2] - home[2])).toBeLessThanOrEqual(1.2e-4) // 6.7 resting height.
  }), 20_000)

  it('reports 100-step latency and passes a large terrain line through stdin', async () => withProtocol(async ({ result, lineBytes }) => {
    await result(load)
    const request = step(MAX_SESSION_STEPS, rates)
    // 512 squared samples make a line larger than 512 KiB, even with flat zero heights.
    const dimension = 512
    const large = { ...flat, rows: dimension, columns: dimension, heightsM: Array<number>(dimension ** 2).fill(0) }
    const enabled = start({ ...baseStart, environment: { ...terrainEnvironment, terrain: large }, wind, groundEffect })
    let bytes = 0
    const measure = async (params: ReturnType<typeof start>) => {
      if (params === enabled) bytes = lineBytes(params)
      await result(params)
      const before = performance.now()
      const response = await result(request)
      const elapsed = performance.now() - before
      expect(FlightSessionStepResultSchema.parse(response).stepsRun).toBe(MAX_SESSION_STEPS)
      return elapsed
    }
    const baselineMs = await measure(start({ ...baseStart, environment: free }))
    const enabledMs = await measure(enabled)
    console.info(`flight.session.step (100 steps), baseline ${baselineMs.toFixed(3)} ms, wind + ground effect + terrain ${enabledMs.toFixed(3)} ms`)
    console.info(`Terrain start NDJSON line shape ${dimension} × ${dimension}, ${bytes} bytes including LF`)
  }), 15_000)
})

const fakeBinary = 'recording-test-engine'
type StepMode = 'ok' | 'voltageCutoff' | 'chargeCutoff' | 'refused' | 'timeout' | 'crash'
let spawnRecordingFake: () => unknown

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (path: string, ...args: unknown[]) => path === fakeBinary
      ? spawnRecordingFake()
      : Reflect.apply(actual.spawn, undefined, [path, ...args]),
  }
})

function fakeRecordingEngine() {
  const wire: string[] = []
  const channels = telemetryChannels(quad.vehicle.motors.length, 'attitudeHold').map(({ name }) => name)
  let stepMode: StepMode = 'ok'
  spawnRecordingFake = () => {
    const child = new EventEmitter()
    const stdout = new PassThrough()
    let steps = 0
    let period: number | undefined
    const samples = (sampleSteps: number[]) => ({
      steps: sampleSteps,
      rows: sampleSteps.map((step) => channels.map((_, i) => i === 0 ? step * 0.001 : step + i)),
    })
    const stdin = new Writable({
      write(bytes: Buffer, _encoding, done) {
        const line = bytes.toString('utf8')
        wire.push(line)
        const { id, type, sampleEverySteps, steps: requestedSteps } = JSON.parse(line)
        const send = (result: unknown) => stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
        queueMicrotask(() => {
          switch (type) {
            case 'hello': send({ engineVersion: 'fake-engine', protocolVersion: PROTOCOL_VERSION, threads: 1 }); break
            case 'ping': send({}); break
            case 'vehicle.load': send({
              valid: true, partCount: quad.vehicle.parts.length, motorCount: quad.vehicle.motors.length, missingMass: [],
              totals: { massKg: quad.vehicle.totalMassKg, com: quad.vehicle.com, inertia: quad.vehicle.inertia },
            }); break
            case 'flight.session.start':
              steps = 0
              period = sampleEverySteps
              send({ dtS: 0.001, maxStepsPerRequest: MAX_SESSION_STEPS,
                diagnostic: diagnostic({ state: { ...diagnostic().state, steps, timeS: 0 } }),
                ...(period ? { channels, samples: samples([0]) } : {}),
              })
              break
            case 'flight.session.step': {
              if (stepMode === 'timeout') break
              if (stepMode === 'crash') { child.emit('exit', 1, null); break }
              if (stepMode === 'refused') {
                stdout.write(JSON.stringify({ id, ok: false, error: { code: 'NO_SESSION', message: 'refused step' } }) + '\n')
                break
              }
              const sampleSteps: number[] = []
              for (let i = 0; i < requestedSteps; i++) {
                steps++
                if (period && steps % period === 0) sampleSteps.push(steps)
              }
              send(stepResult({
                stepsRun: requestedSteps,
                endReason: stepMode === 'voltageCutoff' || stepMode === 'chargeCutoff' ? stepMode : null,
                stateHash: steps.toString(16).padStart(16, '0'),
                ...(period ? { samples: samples(sampleSteps) } : {}),
              }, { state: { ...diagnostic().state, steps, timeS: steps * 0.001 } }))
              break
            }
            case 'flight.session.end': send({ ended: true }); break
            case 'shutdown': send({}); child.emit('exit', 0, null); break
          }
        })
        done()
      },
    })
    return Object.assign(child, { stdout, stdin, stderr: new PassThrough() })
  }
  const engine = new EngineSupervisor({ binaryPath: fakeBinary, maxRestarts: 0, requestTimeoutMs: 150 })
  return {
    engine, wire, setStepMode: (mode: StepMode) => { stepMode = mode },
    async start() {
      engine.start()
      await vi.waitFor(() => expect(engine.status.state).toBe('connected'))
    },
  }
}

type RecordingFixture = { store: RecordingStore; recorder: SessionRecorder; recording: RecordingOptions }

async function withRecordingStore(engine: EngineSupervisor, test: (fixture: RecordingFixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'blaze-session-recorder-'))
  const db = openDatabase(':memory:')
  const repos = createRepositories(db, undefined, dir)
  const project = repos.projects.create({ name: 'Recording test quad', frameType: 'quad-x' })
  const store = new RecordingStore(dir, repos.runs)
  const recorder = new SessionRecorder(store, (id) => repos.projects.get(id).name, 'test-app', () => engine.status)
  const crash = (status: EngineSupervisor['status']) => {
    if ((status.state === 'failed' || status.state === 'restarting') && status.lastError) recorder.failFlight(status.lastError)
  }
  engine.on('status', crash)
  try {
    await test({ store, recorder, recording: { projectId: project.id, title: 'Test flight Ω' } })
  } finally {
    engine.off('status', crash)
    await recorder.shutdown('test finished')
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const recordStep = (steps = RECORD_EVERY_STEPS) => ({ steps, setpoint: { attitude: [0, 0, 0, 1], yawRateRadps: 0, climbRateMps: 0 } })
const getRecording = (store: RecordingStore, id: string) => store.read(id, async (reader) => ({
  summary: await reader.summary(),
  requests: await reader.readRequests(),
  series: await reader.readSamples({ channels: ['time'] }),
}))

describe('main recording with a fake engine transport', () => {
  async function testFlight(test: (
    fake: ReturnType<typeof fakeRecordingEngine>,
    fixture: RecordingFixture,
  ) => Promise<void>) {
    const fake = fakeRecordingEngine()
    await fake.start()
    try {
      await withRecordingStore(fake.engine, (fixture) => test(fake, fixture))
    } finally {
      await fake.engine.stop()
    }
  }

  it('saves the stdin bytes, writes rows in order across chunks and hides samples unless requested', async () => testFlight(async ({ engine, wire }, { store, recorder, recording }) => {
    const started = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
    const { recordingId } = started
    expect(recordingId).toBeDefined()
    expect(started).not.toHaveProperty('samples')
    expect(started).not.toHaveProperty('channels')
    const first = unwrap(await flightStep(engine, recordStep(RECORD_EVERY_STEPS - 1), recorder))
    const last = unwrap(await flightStep(engine, recordStep(RECORD_EVERY_STEPS + 1), recorder))
    expect(first).not.toHaveProperty('samples')
    expect(last).not.toHaveProperty('samples')
    unwrap(await flightEnd(engine, recorder))
    const { summary, requests, series } = await getRecording(store, recordingId!)
    const sent = wire.filter((line) => ['vehicle.load', 'flight.session.start', 'flight.session.step'].includes(JSON.parse(line).type))
    expect([summary.header?.vehicleLoad, summary.header?.startRequest, ...requests].map((line) => Buffer.from(line!)))
      .toEqual(sent.map((line) => Buffer.from(line)))
    expect(summary.header).toMatchObject({
      appVersion: 'test-app', engineVersion: 'fake-engine', protocolVersion: PROTOCOL_VERSION,
      kind: 'flight', projectId: recording.projectId, projectName: 'Recording test quad', title: recording.title,
      samplePeriodSteps: RECORD_EVERY_STEPS, firstSampleStep: 0, stepLengthS: started.dtS,
    })
    expect(JSON.parse(sent[1]!).sampleEverySteps).toBe(RECORD_EVERY_STEPS)
    expect(summary).toMatchObject({ sampleCount: 3, requestCount: 2, incomplete: false,
      end: { status: 'completed', reason: 'stopped', finalStateHash: last.stateHash, elapsedS: 0.008 },
    })
    expect(series[0]?.points.map(({ value }) => value)).toEqual([0, 0.004, 0.008])

    const live = unwrap(await flightStart(engine, { ...startInput(), recording: { ...recording, live: true } }, recorder))
    expect(live.channels).toEqual(summary.header?.channels.map(({ name }) => name))
    expect(live.samples?.steps).toEqual([0])
    expect(unwrap(await flightStep(engine, recordStep(), recorder)).samples?.steps).toEqual([RECORD_EVERY_STEPS])
    unwrap(await flightEnd(engine, recorder))
  }))

  it('sends and returns identical bytes when recording is off, even with a recorder wired', async () => {
    async function fly(wired: boolean) {
      let output: unknown
      await testFlight(async ({ engine, wire }, { recorder, store }) => {
        const useRecorder = wired ? recorder : undefined
        const results = [
          await flightStart(engine, startInput(), useRecorder),
          await flightStep(engine, recordStep(), useRecorder),
          await flightEnd(engine, useRecorder),
        ]
        expect(await store.listRecent(10)).toEqual([])
        output = [wire.filter((line) => !['hello', 'ping'].includes(JSON.parse(line).type)), JSON.stringify(results)]
      })
      return output
    }
    expect(await fly(true)).toEqual(await fly(false))
  })

  it.each([
    ['voltageCutoff', 'completed', 'voltageCutoff'],
    ['chargeCutoff', 'completed', 'chargeCutoff'],
    ['refused', 'failed', 'NO_SESSION: refused step'],
    ['timeout', 'failed', 'engine request flight.session.step timed out'],
    ['crash', 'failed', 'Engine exited unexpectedly (exit code 1)'],
  ] as const)('closes on %s with the last received hash', async (mode, status, reason) => testFlight(async ({ engine, setStepMode }, { store, recorder, recording }) => {
    const { recordingId } = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
    const first = unwrap(await flightStep(engine, recordStep(), recorder))
    setStepMode(mode)
    const last = await flightStep(engine, recordStep(), recorder)
    expect(last.ok).toBe(status === 'completed')
    await vi.waitFor(async () => expect((await store.get(recordingId!)).open).toBe(false))
    const { summary, requests } = await getRecording(store, recordingId!)
    expect(requests).toHaveLength(2)
    expect(summary.end).toMatchObject({ status, reason, finalStateHash: last.ok ? last.data.stateHash : first.stateHash,
      engineError: status === 'failed' ? reason : null,
    })
  }))

  it.each(['app quit', 'window closed'])('aborts the replaced flight and waits for the active writer on %s', async (reason) => testFlight(async ({ engine }, { store, recorder, recording }) => {
    const before = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
    const lastBefore = unwrap(await flightStep(engine, recordStep(), recorder))
    const after = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
    const lastAfter = unwrap(await flightStep(engine, recordStep(), recorder))
    await recorder.shutdown(reason)
    const beforeSummary = (await getRecording(store, before.recordingId!)).summary
    const afterSummary = (await getRecording(store, after.recordingId!)).summary
    expect(beforeSummary.end).toMatchObject({ status: 'aborted', reason: 'replaced by a new start', finalStateHash: lastBefore.stateHash })
    expect(afterSummary.end).toMatchObject({ status: 'aborted', reason, finalStateHash: lastAfter.stateHash })
  }))

  it('starts and steps while the file opens, then drains buffered data on stop', async () => testFlight(async ({ engine }, { store, recorder, recording }) => {
    let release!: () => void
    const opening = new Promise<void>((resolve) => { release = resolve })
    const start = store.start.bind(store)
    const spy = vi.spyOn(store, 'start').mockImplementation(async (header, options) => {
      await opening
      return start(header, options)
    })
    try {
      const { recordingId } = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
      const last = unwrap(await flightStep(engine, recordStep(), recorder))
      const stopped = flightEnd(engine, recorder)
      release()
      unwrap(await stopped)
      const { summary, series } = await getRecording(store, recordingId!)
      expect(summary).toMatchObject({ sampleCount: 2, requestCount: 1, end: { reason: 'stopped', finalStateHash: last.stateHash } })
      expect(series[0]?.points.map(({ value }) => value)).toEqual([0, 0.004])
    } finally {
      release()
      spy.mockRestore()
    }
  }))

  it('aborts the recorded flight when a start with recording off replaces it', async () => testFlight(async ({ engine }, { store, recorder, recording }) => {
    const before = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
    const inFlight = flightStep(engine, recordStep(), recorder)
    const after = unwrap(await flightStart(engine, startInput(), recorder))
    const last = unwrap(await inFlight)
    expect(after).not.toHaveProperty('recordingId')
    expect(unwrap(await flightStep(engine, recordStep(), recorder))).not.toHaveProperty('samples')
    await vi.waitFor(async () => expect((await store.get(before.recordingId!)).open).toBe(false))
    const { summary } = await getRecording(store, before.recordingId!)
    expect(summary.end).toMatchObject({ status: 'aborted', finalStateHash: last.stateHash })
    unwrap(await flightEnd(engine, recorder))
  }))

  it('reports a failing writer and continues stepping the engine', async () => testFlight(async ({ engine }, { store, recorder, recording }) => {
    const start = store.start.bind(store)
    const spy = vi.spyOn(store, 'start').mockImplementation((header, options) => start(header, {
      ...options,
      openFile: async (path, flags) => {
        const file = await open(path, flags)
        let writeCount = 0
        return {
          write: (buffer, offset, length) => {
            // Prefix, header and initial row succeed; fail the first flight-step request frame.
            if (++writeCount > 3 && buffer[0] === Frame.request) return Promise.reject(new Error('ENOSPC: test disk full'))
            return file.write(buffer, offset, length)
          },
          sync: () => file.sync(),
          close: () => file.close(),
        }
      },
    }))
    try {
      const { recordingId } = unwrap(await flightStart(engine, { ...startInput(), recording }, recorder))
      const first = unwrap(await flightStep(engine, recordStep(), recorder))
      expect(first.stepsRun).toBe(RECORD_EVERY_STEPS)
      await vi.waitFor(async () => expect(await store.get(recordingId!)).toMatchObject({ open: false, status: 'failed', sampleCount: 1 }))
      unwrap(await flightStep(engine, recordStep(), recorder))
      const next = unwrap(await flightStep(engine, recordStep(), recorder))
      expect(next).toMatchObject({ recordingError: 'ENOSPC: test disk full', stepsRun: RECORD_EVERY_STEPS })
      expect(next).not.toHaveProperty('samples')
      unwrap(await flightEnd(engine, recorder))
    } finally {
      spy.mockRestore()
    }
  }))
})

const sup = new EngineSupervisor({ binaryPath })
afterAll(() => sup.stop())

describe('a real engine session', () => {
  beforeAll(async () => {
    sup.start()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`engine start timed out: ${JSON.stringify(sup.status)}`)), 8000)
      const check = () => {
        if (sup.status.state === 'connected') { clearTimeout(timer); sup.off('status', check); resolve() }
        if (sup.status.state === 'failed') { clearTimeout(timer); reject(new Error(sup.status.lastError ?? 'engine failed')) }
      }
      sup.on('status', check)
      check()
    })
  }, 10000)

  it('replays saved wind and Dryden turbulence lines in a fresh engine with the recorded hash', async () => withRecordingStore(sup, async ({ store, recorder, recording }) => {
    // Same fixed wind seed as the raw sampling/replay test above.
    const started = unwrap(await flightStart(sup, { ...startInput(), recording, wind: {
      fromDeg: 0, mean: { kind: 'constant', speedMps: 8 }, gust: null, turbulence: { kind: 'dryden', seed: 0 },
    } }, recorder))
    unwrap(await flightStep(sup, recordStep(MAX_SESSION_STEPS - 1), recorder))
    const last = unwrap(await flightStep(sup, recordStep(MAX_SESSION_STEPS), recorder))
    unwrap(await flightEnd(sup, recorder))
    const { summary, requests, series } = await getRecording(store, started.recordingId!)
    expect(summary.sampleCount).toBe(1 + Math.floor((2 * MAX_SESSION_STEPS - 1) / RECORD_EVERY_STEPS))
    expect(series[0]?.points).toHaveLength(summary.sampleCount)
    expect(summary.end?.finalStateHash).toBe(last.stateHash)

    await withProtocol(async ({ sendLine }) => {
      let final: unknown
      for (const line of [summary.header!.vehicleLoad, summary.header!.startRequest, ...requests]) {
        const response = await sendLine(line)
        if (!response.ok) throw new Error(response.error.message)
        final = response.result
      }
      expect(FlightSessionStepResultSchema.parse(final).stateHash).toBe(summary.end?.finalStateHash)
    })
  }))

  it('records the sensor channels of flights and scenarios, and none when every sensor is off', async () => withRecordingStore(sup, async ({ store, recorder, recording }) => {
    const { airDensityKgM3, cutoff } = startInput()
    const record = async (model: SensorPayload) => {
      const flight = unwrap(await flightStart(sup, { ...startInput(), recording, sensors: model }, recorder))
      const step = unwrap(await flightStep(sup, recordStep(), recorder))
      expect([flight, step]).not.toContainEqual(expect.objectContaining({ recordingError: expect.anything() }))
      unwrap(await flightEnd(sup, recorder))
      const scenario = unwrap(await scenarioRun(sup, { ...quad, recording, config: { airDensityKgM3, cutoff, sensors: model },
        scenario: { type: 'builtin', name: 'balanced_hover' },
      }, recorder))
      return Promise.all([flight, scenario].map(async ({ recordingId }) => (await getRecording(store, recordingId!)).summary))
    }
    const named = (summary: Awaited<ReturnType<typeof record>>[number]) => summary.header!.channels.filter(({ name }) => name.startsWith('sensor.')).length
    for (const summary of await record(sensors)) {
      expect(summary.end?.status).toBe('completed')
      expect(named(summary)).toBeGreaterThan(0)
    }
    for (const summary of await record({ seed: 1, gyro: null, accelerometer: null, barometer: null, gps: null })) {
      expect(summary.end?.status).toBe('completed')
      expect(named(summary)).toBe(0)
    }
  }))

  it('reads scenario samples and step-test trace channels from disk', async () => withRecordingStore(sup, async ({ store, recorder, recording }) => {
    const { airDensityKgM3, cutoff } = startInput()
    const config = { airDensityKgM3, cutoff }
    const scenario = unwrap(await scenarioRun(sup, { ...quad, config, recording,
      scenario: { type: 'builtin', name: 'balanced_hover' },
    }, recorder))
    const saved = await getRecording(store, scenario.recordingId!)
    expect(scenario).not.toHaveProperty('samples')
    expect(scenario).not.toHaveProperty('channels')
    expect(saved.summary).toMatchObject({ requestCount: 0, header: { kind: 'scenario', samplePeriodSteps: RECORD_EVERY_STEPS },
      end: { reason: 'duration (passed)', status: 'completed', finalStateHash: scenario.stateHash },
    })
    expect(saved.series[0]?.points).toHaveLength(Math.floor(scenario.report.elapsedS / (0.001 * RECORD_EVERY_STEPS)) + 1)

    // Same AttitudeLost threshold as engine-core/src/scenario/builtins.rs:388-390.
    const failed = unwrap(await scenarioRun(sup, { ...quad, config, recording, scenario: { type: 'custom', scenario: {
      ...scenario.scenario, checks: [{ type: 'attitudeLost', afterS: 0, aboveDeg: 30 }],
    } } }, recorder))
    expect(failed.report.passed).toBe(false)
    expect((await getRecording(store, failed.recordingId!)).summary.end).toMatchObject({ status: 'completed', reason: 'duration (failed)' })

    // Same step and decimation as the raw step-test wind/terrain check above.
    const test = { step: { type: 'rate', axis: 'roll', amplitudeRadps: 10 * Math.PI / 180 }, holdS: 0.002, durationS: 0.008, decimationSteps: 2 }
    const stepped = unwrap(await stepTest(sup, { ...quad, config, recording, test }, recorder))
    const trace = await getRecording(store, stepped.recordingId!)
    expect(trace.summary).toMatchObject({ sampleCount: stepped.trace.samples.length, requestCount: 0,
      header: { kind: 'step-test', samplePeriodSteps: test.decimationSteps },
      end: { reason: 'duration', status: 'completed', finalStateHash: stepped.stateHash },
    })
    const measured = await store.read(stepped.recordingId!, (reader) => reader.readSamples({ channels: ['stepTest.measured'] }))
    expect(measured[0]?.points.map(({ value }) => value)).toEqual(stepped.trace.samples.map(({ signal }) => signal.kind === 'rate' ? signal.measuredRadps : null))
  }))

  it('measures the actual 60 s scenario NDJSON response sampled every fourth step', async () => {
    const { airDensityKgM3, cutoff } = startInput()
    const config = { airDensityKgM3, cutoff, wind: {
      fromDeg: 0, mean: { kind: 'constant', speedMps: 8 }, gust: null, turbulence: { kind: 'dryden', seed: 0 },
    } }
    const scenario = { type: 'custom', scenario: {
      name: '60 s position hold', durationS: MAX_SCENARIO_S, modifications: [], checks: [], script: [],
      flightScript: [{ fromS: 0, command: { type: 'position', forward: 0, right: 0, yawRight: 0, throttle: 0 } }],
    } }
    const expectedRows = MAX_SCENARIO_S / (0.001 * RECORD_EVERY_STEPS) + 1
    await withProtocol(async ({ result, replyBytes }) => {
      await result({ type: 'vehicle.load', ...quad })
      const params = ScenarioRunParamsSchema.parse({ scenario, config: { ...config, sampleEverySteps: RECORD_EVERY_STEPS } })
      const start = performance.now()
      const raw = await result({ type: 'scenario.run', ...params })
      const wireMs = performance.now() - start
      const data = ScenarioRunResultSchema.parse(raw)
      expect(data.report.elapsedS).toBeCloseTo(MAX_SCENARIO_S)
      expect(data.samples?.rows).toHaveLength(expectedRows)
      console.info(`60 s scenario at 250 Hz: ${replyBytes()} NDJSON bytes, ${data.channels?.length} columns, ${wireMs.toFixed(0)} ms through stdout and JSON parse`)
    })

    await withRecordingStore(sup, async ({ store, recorder, recording }) => {
      const start = performance.now()
      const data = unwrap(await scenarioRun(sup, { ...quad, config, scenario, recording }, recorder))
      const endToEndMs = performance.now() - start
      expect(data).not.toHaveProperty('samples')
      const summary = await store.read(data.recordingId!, (reader) => reader.summary())
      expect(summary).toMatchObject({ sampleCount: expectedRows, end: { status: 'completed', finalStateHash: data.stateHash } })
      console.info(`60 s scenario through main and recording close: ${endToEndMs.toFixed(0)} ms, ${summary.bytes} saved bytes`)
    })
  })

  it('starts, steps in chunks (contacts and a valid last diagnostic) and ends, through the IPC handlers', async () => {
    const setpoint = { attitude: [0, 0, 0, 1] as [number, number, number, number], yawRateRadps: 0, climbRateMps: 0 }
    expect(err(await flightStep(sup, { steps: 1, setpoint }))?.message).toMatch(/^NO_SESSION/)
    const input = startInput()
    expect(err(await flightStart(sup, { ...input, startPositionM: [0, 0, 0] }))?.message).toMatch(/^INVALID_PARAMS/) // inside the ground
    expect(err(await flightStep(sup, { steps: 1, setpoint }))?.message).toMatch(/^NO_SESSION/) // a refused start leaves no session
    // 2000 m: not the density of the propeller data, so the scaled coefficients are flown in both paths.
    const started = await flightStart(sup, { ...input, airDensityKgM3: 1.0066 })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.data.diagnostic.state.steps).toBe(0)
    let last: FlightStepResult | null = null
    for (let i = 0; i < 4; i++) {
      const r = await flightStep(sup, { steps: 25, setpoint })
      expect(r.ok).toBe(true)
      if (r.ok) last = FlightSessionStepResultSchema.parse(r.data)
    }
    expect(last!.diagnostic.state.steps).toBe(100)
    expect(last!.endReason).toBeNull()
    const frame = toFlightFrame(last!.diagnostic, last!.endReason, last!.contacts)
    expect(frame.timeS).toBeCloseTo(0.1, 12)
    expect(frame.motors).toHaveLength(4)
    expect(frame.totalThrustN).toBeGreaterThan(0)
    expect(frame.packVoltageV).toBeLessThan(10)
    expect(frame.densityKgM3).toBe(1.0066)
    expect(await flightEnd(sup)).toEqual({ ok: true, data: { ended: true } })
    // The same 100 steps in one batch run (sim.run in controller mode) end in the same state hash.
    await sup.loadVehicle(quad.vehicle as never, { propulsion: quad.propulsion as never, aero: quad.aero as never })
    const batch = await sup.runSim(SimRunParamsSchema.parse({
      durationS: 0.1, environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] }, startPositionM: [0, 0, REST_Z],
      airDensityKgM3: 1.0066, controller: { climbRateMps: 0 },
    }))
    // Captured with the unchanged 204382e engine and this same quad and request.
    expect(batch.stateHash).toBe('c4a35c8e9770cbcc')
    expect(last!.stateHash).toBe(batch.stateHash)
    expect(batch.flightLoop).toBeUndefined()
    expect(last!.diagnostic.flightLoop).toBeUndefined()
  }, 20000)

  const air = { environment: { ground: null, obstacles: [] }, startPositionM: v3(0, 0, REST_Z), airDensityKgM3: 1.225 }
  const centeredSticks = { forward: 0, right: 0, yawRight: 0, throttle: 0 }
  const steps = 20
  // A full estimator interval spans multiple requests (PX4 ekf2_params.c:53).
  const durationS = steps * 0.001

  it.each([
    { mode: 'rates', bodyRadps: v3(0, 0, 0), collective: 0.5, expectedHash: 'd95d572fc0d2a4f0' },
    { mode: 'stabilized', sticks: centeredSticks, expectedHash: 'b8a0f3a48d69bce5' },
    { mode: 'altitude', sticks: centeredSticks, expectedHash: 'e3296f1362f98f46' },
    { mode: 'position', sticks: centeredSticks, expectedHash: '81c577ddd5cc29e7' },
  ] as const)('parses actual $mode diagnostics and hashes the same in chunks and one run', async ({ mode, expectedHash, ...setpoint }) => {
    const gains = {
      MC_ROLL_P: 7, MPC_XY_P: 1, MPC_POS_MODE: 0, MPC_THR_HOVER: 0.55, MPC_USE_HTE: 0,
      MC_AIRMODE: 2, THR_MDL_FAC: 0.5, HTE_HT_ERR_INIT: 0.2,
    }
    const mixer = { airmode: 2, thrustModelFactor: gains.THR_MDL_FAC }
    const started = await flightStart(sup, { ...startInput(), ...air, gains, controller: { mode, ...mixer } })
    if (!started.ok) throw new Error(started.error.message)
    expect(started.data.diagnostic.flightLoop).toBeUndefined()

    const first = await flightStep(sup, { steps: 7, setpoint })
    if (!first.ok) throw new Error(first.error.message)
    const last = await flightStep(sup, { steps: steps - 7, setpoint })
    if (!last.ok) throw new Error(last.error.message)
    expect(last.data.diagnostic.control).toBeNull()
    const diag = FlightSessionStepResultSchema.parse(last.data).diagnostic.flightLoop!
    expect(diag.mode).toBe(mode)
    // No ground: the estimator runs from the start. Only the position loop gives it a thrust to fuse;
    // the rotors start at rest, so it is pushed to HTE_THR_RANGE (0.2) and is not valid, hence unused.
    expect(Math.abs(diag.hoverThrust.estimate! - gains.MPC_THR_HOVER)).toBeLessThanOrEqual(0.2 + 1e-9)
    if (mode === 'rates' || mode === 'stabilized') {
      expect(diag.hoverThrust.estimate).toBeCloseTo(gains.MPC_THR_HOVER)
      expect(diag.hoverThrust.variance).toBeGreaterThanOrEqual(gains.HTE_HT_ERR_INIT ** 2)
    }
    expect(diag.hoverThrust.valid).toBe(false)
    if (mode === 'rates' || mode === 'stabilized') {
      expect(diag.positionSetpointM).toEqual([null, null, null])
      expect(diag.velocitySetpointMps).toEqual([null, null, null])
      expect(diag.accelerationSetpointMps2).toEqual([null, null, null])
    } else {
      expect(diag.accelerationSetpointMps2.every(Number.isFinite)).toBe(true)
      if (mode === 'altitude') expect(diag.positionSetpointM.slice(0, 2)).toEqual([null, null])
    }
    expect(await flightEnd(sup)).toEqual({ ok: true, data: { ended: true } })

    const batch = SimRunResultSchema.parse(await sup.runSim({
      ...air, durationS, controller: { mode, ...setpoint, ...mixer, gains },
    }))
    expect(batch.controller).toBeUndefined()
    expect(batch.flightLoop).toEqual(diag)
    expect(batch.stateHash).toBe(expectedHash)
    expect(batch.stateHash).toBe(last.data.stateHash)
  })

  it('changes modes within a session and keeps the mode on the ground (6.7 removed the Stabilized stand-in)', async () => {
    const started = await flightStart(sup, { ...startInput(), controller: { mode: 'rates' } })
    if (!started.ok) throw new Error(started.error.message)
    const settled = await sup.stepFlightSession({ steps, setpoint: { bodyRadps: v3(0, 0, 0), collective: 0 } })
    expect(settled.diagnostic.flightLoop?.mode).toBe('rates')
    const hold = await sup.stepFlightSession({ steps, setpoint: { mode: 'position', sticks: { ...centeredSticks, throttle: -1 } } })
    // On the ground PX4 resets the setpoints (MulticopterPositionControl.cpp:422-432).
    expect(hold.diagnostic.flightLoop?.mode).toBe('position')
    expect(hold.diagnostic.flightLoop?.positionSetpointM).toEqual([null, null, null])
    expect(hold.diagnostic.state.steps).toBe(2 * steps)
    expect(await flightEnd(sup)).toEqual({ ok: true, data: { ended: true } })
  })

  it('names refused mode inputs and parameter overrides', async () => {
    const controller = { mode: 'position', sticks: centeredSticks } as const
    const request = { ...air, durationS, controller }
    for (const [gains, message] of [
      [{ MPC_XY_P: -1 }, /MPC_XY_P/],
      [{ MC_ROLL_P: -1 }, /MC_ROLL_P/],
      [{ MPC_POS_MODE: 3 }, /MPC_POS_MODE/],
      [{ HTE_ACC_GATE: 0 }, /HTE_ACC_GATE/],
      [{ HTE_UNKNOWN: 1 }, /HTE_UNKNOWN/],
      [{ MPC_USE_HTE: -1 }, /MPC_USE_HTE/],
      [{ MC_AIRMODE: 3 }, /MC_AIRMODE/],
      [{ THR_MDL_FAC: 2 }, /THR_MDL_FAC.*\[0, 1\]/],
    ] as const) {
      await expect(sup.runSim({ ...request, controller: { ...controller, gains } })).rejects.toThrow(message)
    }
    await expect(sup.runSim({ ...request, controller: { ...controller, airmode: 0, gains: { MC_AIRMODE: 1 } } })).rejects.toThrow(/airmode and MC_AIRMODE/)
    await expect(sup.runSim({ ...request, controller: { ...controller, airmode: 1.5 } })).rejects.toThrow(/airmode/)
    await expect(sup.runSim({ ...request, controller: {
      ...controller, thrustModelFactor: 0.5, gains: { THR_MDL_FAC: 0 },
    } })).rejects.toThrow(/thrustModelFactor and THR_MDL_FAC must agree/)
    await expect(sup.runSim({ ...request, dtS: 0.004 })).rejects.toThrow(/dtS.*divide 10 ms/s)
    await expect(sup.runSim({ ...request, controller: { ...controller, sticks: { ...centeredSticks, yawRight: 2 } } })).rejects.toThrow(/yawRight/)
    expect(FlightSessionStepParamsSchema.safeParse({ steps, setpoint: { mode: 'rates', collective: 0.5 } }).success).toBe(false)
    expect(FlightSessionStepParamsSchema.safeParse({ steps, setpoint: { mode: 'position', sticks: centeredSticks, gains: {} } }).success).toBe(false)
  })

  it('reports a FlightLoop step error and discards the session', async () => {
    // Reproduce the allowed gains / infeasible horizontal thrust case in position_control/tests.rs:135-150.
    const gains = { MPC_THR_HOVER: 0.1, MPC_THR_MIN: 0.05, MPC_THR_MAX: 0.2, MPC_TILTMAX_AIR: 89, MPC_MAN_TILT_MAX: 89 }
    const mode = 'altitude' as const
    const setpoint = { sticks: { ...centeredSticks, forward: 1, throttle: 1 } }
    const started = await flightStart(sup, { ...startInput(), ...air, controller: { mode }, gains })
    if (!started.ok) throw new Error(started.error.message)
    const failure = /INVALID_PARAMS: nonfinite thrust\/integral/
    await expect(sup.stepFlightSession({ steps, setpoint })).rejects.toThrow(failure)
    await expect(sup.stepFlightSession({ steps, setpoint })).rejects.toThrow(/NO_SESSION/)
    await expect(sup.runSim({ ...air, durationS, controller: { mode, ...setpoint, gains } })).rejects.toThrow(failure)
  })
})
