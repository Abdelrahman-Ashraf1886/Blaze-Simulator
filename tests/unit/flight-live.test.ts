/**
 * 4.8 part B: the live flight. The engine's camelCase response maps to a FlightFrame in one adapter; the
 * source steps the engine once per animation frame with the elapsed time (capped); the page starts only
 * when the build is ready to fly; the IPC boundary validates everything; and a real engine session runs
 * through the same handlers.
 */
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FlightStartInput, FlightStepInput, FlightStepResult, IpcResult } from '../../electron/ipc/contract'
import { flightEnd, flightStart, flightStep, type EngineForFlight } from '../../electron/main/engine/flight-session'
import { FlightDiagnosticSchema, FlightSessionStartParamsSchema, FlightSessionStepParamsSchema, FlightSessionStepResultSchema, SimRunParamsSchema } from '../../electron/main/engine/protocol'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import type { ReadyItem } from '../../src/domain/propulsion'
import { EngineFlightSource, idleFrame, MAX_STEP_MS, stepsForElapsed, toEngineSetpoint, toFlightFrame } from '../../src/features/flight/EngineFlightSource'
import { airDensityFor, conditionBlockers, EMPTY_CONDITIONS, enginePayload, flightGate, type EnginePayload, type FlightConditions } from '../../src/features/flight/readiness'
import { mapSticks } from '../../src/features/flight/sticks'
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
    motors: ['m1', 'm2', 'm3', 'm4'].map((partId) => ({ partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5 })),
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
      ended: null,
      contacts: [
        { part: 'frame', object: 'obstacle:wall', startS: 0.01, endS: null },
        { part: 'leg-1', object: 'ground', startS: 0, endS: 0.5 },
      ],
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
    ['no cut-off', (p: Record<string, unknown>) => { delete p.cutoff }],
    ['a zero cut-off', (p: Record<string, unknown>) => { p.cutoff = { type: 'voltageV', value: 0 } }],
    ['an unknown cut-off type', (p: Record<string, unknown>) => { p.cutoff = { type: 'capacity', value: 5 } }],
    ['no air density', (p: Record<string, unknown>) => { delete p.airDensityKgM3 }],
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

  it('passes engine step errors and end through the same envelope', async () => {
    const { engine } = fakeEngine({ stepFlightSession: vi.fn(async () => { throw new Error('NO_SESSION: start a flight session first') }) })
    expect(err(await flightStep(engine, { steps: 1, setpoint: { attitude: [0, 0, 0, 1], yawRateRadps: 0, climbRateMps: 0 } }))?.message).toBe('NO_SESSION: start a flight session first')
    expect(await flightEnd(engine)).toEqual({ ok: true, data: { ended: true } })
  })
})

// ---- a real engine session through the same handlers -------------------------------------------------------

const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')
const sup = new EngineSupervisor({ binaryPath })
afterAll(() => sup.stop())

describe('a real engine session', () => {
  it('starts, steps in chunks (contacts and a valid last diagnostic) and ends, through the IPC handlers', async () => {
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
    const setpoint = { attitude: [0, 0, 0, 1] as [number, number, number, number], yawRateRadps: 0, climbRateMps: 0 }
    expect(err(await flightStep(sup, { steps: 1, setpoint }))?.message).toMatch(/^NO_SESSION/)
    const input = startInput()
    expect(err(await flightStart(sup, { ...input, startPositionM: [0, 0, 0] }))?.message).toMatch(/^INVALID_PARAMS/) // inside the ground
    expect(err(await flightStep(sup, { steps: 1, setpoint }))?.message).toMatch(/^NO_SESSION/) // a refused start leaves no session
    const started = await flightStart(sup, input)
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
    expect(frame.densityKgM3).toBe(1.225)
    expect(await flightEnd(sup)).toEqual({ ok: true, data: { ended: true } })
    // The same 100 steps in one batch run (sim.run in controller mode) end in the same state hash.
    await sup.loadVehicle(quad.vehicle as never, { propulsion: quad.propulsion as never, aero: quad.aero as never })
    const batch = await sup.runSim(SimRunParamsSchema.parse({
      durationS: 0.1, environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] }, startPositionM: [0, 0, REST_Z],
      airDensityKgM3: 1.225, controller: { climbRateMps: 0 },
    }))
    expect(batch.stateHash).toBe(last!.stateHash)
  }, 20000)
})
