/**
 * 4.8 part B: the live flight. The engine's camelCase response maps to a FlightFrame in one adapter; the
 * source steps the engine once per animation frame with the elapsed time (capped); the page starts only
 * when the build is ready to fly; the IPC boundary validates everything; and a real engine session runs
 * through the same handlers.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FlightStartInput, FlightStepInput, FlightStepResult, IpcResult } from '../../electron/ipc/contract'
import { flightEnd, flightStart, flightStep, type EngineForFlight } from '../../electron/main/engine/flight-session'
import {
  FlightDiagnosticSchema, FlightSessionLogRequestSchema, FlightSessionLogResultSchema, FlightSessionStartParamsSchema,
  FlightSessionStartResultSchema, FlightSessionStepParamsSchema, FlightSessionStepResultSchema, MAX_SESSION_STEPS,
  ScenarioRunParamsSchema, ScenarioRunResultSchema, SimRunParamsSchema, SimRunResultSchema, StepTestRunParamsSchema,
  StepTestRunResultSchema, isEngineResponse, type FlightSessionStepParams,
} from '../../electron/main/engine/protocol'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import type { ReadyItem } from '../../src/domain/propulsion'
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

// ---- a real engine session through the same handlers -------------------------------------------------------

const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')

// Direct NDJSON also checks requests that Zod would refuse before the supervisor sends them.
async function withProtocol(run: (engine: {
  request: (command: object) => Promise<ReturnType<typeof decodeResponse>>
  result: (command: object) => Promise<unknown>
  lineBytes: (command: object) => number
}) => Promise<void>) {
  const child = spawn(binaryPath, { stdio: ['pipe', 'pipe', 'ignore'] })
  await once(child, 'spawn')
  const closed = once(child, 'close')
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let nextId = 0
  const line = (id: number, command: object) => JSON.stringify({ ...command, id }) + '\n'
  const request = async (command: object) => {
    const id = nextId++
    child.stdin.write(line(id, command))
    const reply = await replies.next()
    if (reply.done) throw new Error('The engine closed stdout before replying')
    const response = decodeResponse(reply.value)
    expect(response.id).toBe(id)
    return response
  }
  const result = async (command: object) => {
    const response = await request(command)
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
  try {
    await run({ request, result, lineBytes: (command) => Buffer.byteLength(line(nextId, command)) })
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
    const [powered, manual, takeoff, hold, land, resumed] = diagnostics
    if (!powered || !manual || !takeoff || !hold || !land || !resumed) throw new Error('A step diagnostic is missing')
    expect(powered.loads.windComWorldMps[0]).toBeLessThan(-8)
    expect(powered.loads.groundEffectAddedThrustN).toBeGreaterThan(0)
    expect(powered.loads.groundEffectStatus.every(({ type }) => type === 'applied')).toBe(true)
    expect(powered.loads.windAboveRange).toBe(false)
    expect(powered.loads.windInvalid).toBe(false)
    expect(manual.flightLoop?.mode).toBe('altitude')
    expect(takeoff.flightLoop).toMatchObject({ mode: 'position', autoMode: 'takeoff', commandFinished: false })
    expect(hold.flightLoop).toMatchObject({ mode: 'position', autoMode: 'hold', commandFinished: true })
    expect(land.flightLoop).toMatchObject({ mode: 'position', autoMode: 'land' })
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
    for (const type of ['takeoff', 'hold', 'land'] as const) {
      expect(await request(step(1, { command: { type } }))).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('requires a FlightLoop session') },
      })
    }
    const badAuto = { steps: 1, setpoint: { mode: 'position', command: { type: 'takeoff', altitudeM: -A } } }
    expect(FlightSessionStepParamsSchema.safeParse(badAuto).success).toBe(false)
    await result(start(baseStart))
    for (const setpoint of [badAuto.setpoint, { command: badAuto.setpoint.command }, { command: { type: 'hold', extra: true } }]) {
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
    const advance = async (type: 'takeoff' | 'land', seconds: number) => {
      let last
      for (let remaining = Math.round(seconds / dtS); remaining > 0; remaining -= MAX_SESSION_STEPS) {
        last = FlightSessionStepResultSchema.parse(await result(step(Math.min(remaining, MAX_SESSION_STEPS), { command: { type } })))
      }
      return last?.diagnostic.flightLoop
    }
    // TakeoffParams::default (takeoff.rs:23–26) and the settling window in flight_loop/tests.rs:307–316.
    const settlingS = 10
    const held = await advance('takeoff', 1 + 3 + settlingS)
    expect(held).toMatchObject({ takeoffState: 'flight', autoMode: 'hold', commandFinished: true, landState: { landed: false } })
    const landed = await advance('land', settlingS)
    expect(landed).toMatchObject({
      takeoffState: 'readyForTakeoff', autoMode: 'land', commandFinished: true,
      landState: { freefall: false, groundContact: true, maybeLanded: true, landed: true },
    })
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
