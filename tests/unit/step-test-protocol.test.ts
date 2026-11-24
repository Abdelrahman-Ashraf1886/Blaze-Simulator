import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  isEngineResponse,
  MAX_SCENARIO_S,
  PROTOCOL_VERSION,
  StepTestRunParamsSchema,
  StepTestRunResultSchema,
  VehicleLoadResultSchema,
  type StepTestRunParams,
} from '../../electron/main/engine/protocol'
import { runStepTest, stepTest } from '../../electron/main/engine/step-test'
import { Channels, type DesktopApi } from '../../electron/ipc/contract'
import type { FlightGate } from '../../src/features/flight/readiness'
import { EMPTY_STEP_TEST, measuredSamples, readStepTest, STEP_CHOICES, stepTestInput } from '../../src/features/tuning/step-test-input'

// The scenario protocol's quad and propulsion fixture (scenario-protocol.test.ts:20–37).
const armM = 0.15
const mount = (partId: string, x: number, y: number, spin: 'cw' | 'ccw') => ({
  partId, position: [x, y, 0], thrustAxis: [0, 0, 1], spin,
})
const inertia = [0.01, 0.01, 0.02, 0, 0, 0]
const airDensityKgM3 = 1.225
const load = {
  type: 'vehicle.load',
  vehicle: {
    version: 1,
    parts: [{
      partId: 'body', massKg: 1, com: [0, 0, 0], inertia,
      pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      shape: { type: 'box', halfExtents: [0.05, 0.05, 0.02] },
    }],
    motors: [
      mount('m1', armM, -armM, 'ccw'), mount('m2', -armM, armM, 'ccw'),
      mount('m3', armM, armM, 'cw'), mount('m4', -armM, -armM, 'cw'),
    ],
    totalMassKg: 1, com: [0, 0, 0], inertia, missingMass: [],
  },
  propulsion: {
    version: 1,
    motors: ['m1', 'm2', 'm3', 'm4'].map((partId) => ({
      partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5,
      thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5,
      referenceDensityKgM3: airDensityKgM3,
    })),
    battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 },
  },
}
const dtS = 1e-3 // simulation-engine/engine-core/src/sim.rs:28
const angleRad = 10 * Math.PI / 180 // controller/tests.rs:494-508
const params: StepTestRunParams = {
  test: { step: { type: 'rate', axis: 'roll', amplitudeRadps: angleRad }, holdS: 2 * dtS, durationS: 8 * dtS, decimationSteps: 2 },
  config: {
    airDensityKgM3,
    cutoff: { type: 'chargeMah', value: 1000 },
    // PX4 parameter example (protocol.ts:122) and the mixer enum (physics.v1.json:1084-1092).
    gains: { MC_ROLL_P: 7, MC_AIRMODE: 1 },
    airmode: 1,
    thrustModelFactor: 0,
  },
}
const aero = { cdBody: [1, 1, 1], areaM2: [0.01, 0.01, 0.01] } // flight-live.test.ts:35
const { vehicle, propulsion } = load
const gate: FlightGate = { ok: true, thrustFit: null, input: {
  vehicle, propulsion, aero, ...params.config, environment: { ground: null, obstacles: [] }, startPositionM: [0, 0, 0],
} }
const command = { type: 'stepTest.run', ...params } as const
const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')

function engine(...commands: object[]) {
  const input = commands.map((message, id) => JSON.stringify({ id, ...message })).join('\n') + '\n'
  const child = spawnSync(binaryPath, { input, encoding: 'utf8' })
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  return child.stdout.trim().split('\n').map((line, id) => {
    const response: unknown = JSON.parse(line)
    if (!isEngineResponse(response)) throw new Error('Expected an engine response')
    expect(response.id).toBe(id)
    return response
  })
}

function result(response: ReturnType<typeof engine>[number] | undefined) {
  if (response === undefined) throw new Error('The engine omitted a response')
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

describe('step test form and request', () => {
  const draft = {
    step: 'Roll rate', amplitude: String(angleRad), holdS: String(params.test.holdS),
    durationS: String(params.test.durationS), decimationSteps: String(params.test.decimationSteps),
  }

  it('starts blank and maps every choice and SI amplitude to the protocol', () => {
    expect(readStepTest(EMPTY_STEP_TEST)).toEqual({ test: null, errors: {
      step: 'Choose a step.', amplitude: 'Enter an amplitude.', holdS: 'Enter a value.',
      durationS: 'Enter a value.', decimationSteps: 'Enter a value.',
    } })
    for (const { label, unit, ...selection } of STEP_CHOICES) {
      const amplitudeKey = unit === 'rad/s' ? 'amplitudeRadps' : unit === 'rad' ? 'amplitudeRad' : 'amplitudeM'
      expect(readStepTest({ ...draft, step: label })).toEqual({
        test: { ...params.test, step: { ...selection, [amplitudeKey]: angleRad } }, errors: {},
      })
    }
  })

  it('uses the protocol bounds and names the field that needs correcting', () => {
    expect(readStepTest({ ...draft, step: 'Yaw attitude', amplitude: String(Math.PI * 2) }).errors.amplitude).toBeDefined()
    expect(readStepTest({ ...draft, holdS: draft.durationS }).errors.holdS).toContain('at least one simulation step')
    expect(readStepTest({ ...draft, durationS: String(MAX_SCENARIO_S + dtS) }).errors.durationS).toBeDefined()
    expect(readStepTest({ ...draft, decimationSteps: '1.5' }).errors.decimationSteps).toBeDefined()
  })

  it('uses saved gains and the flight gate for the vehicle, air density and cut-off', () => {
    const { test } = readStepTest(draft)
    expect(stepTestInput(gate, test, params.config.gains!)).toEqual({
      vehicle, propulsion, aero, test: params.test,
      config: { airDensityKgM3, cutoff: params.config.cutoff, gains: params.config.gains },
    })
    expect(stepTestInput({ ok: false, blockers: [] }, test, {})).toBeNull()
    expect(stepTestInput(gate, test, null)).toBeNull()
    expect(stepTestInput(gate, null, {})).toBeNull()
  })
})

describe('stepTest.run protocol', () => {
  it('requires explicit timing, step and conditions and bounds free-space runs', () => {
    const { test, config } = params
    expect(StepTestRunParamsSchema.safeParse(params).success).toBe(true)
    for (const bad of [
      { test: { ...test, durationS: MAX_SCENARIO_S + dtS }, config },
      { test: { ...test, decimationSteps: 1.5 }, config },
      { test: { ...test, decimationSteps: undefined }, config },
      { test: { ...test, holdS: test.durationS - dtS / 2 }, config },
      { test: { ...test, step: { type: 'rate', axis: 'roll' } }, config },
      { test, config: { ...config, cutoff: undefined } },
      { test, config: { ...config, airDensityKgM3: undefined } },
    ]) {
      expect(StepTestRunParamsSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('parses real engine traces, a nonzero factor, resolved gains and repeatable hashes', async () => {
    const steps: StepTestRunParams['test']['step'][] = [
      { type: 'attitude', axis: 'yaw', amplitudeRad: angleRad },
      { type: 'altitude', amplitudeM: 1 }, // controller/tests.rs:494-508
      { type: 'position', axis: 'y', amplitudeM: 1 },
    ]
    const curvedParams = { ...params, config: { ...params.config, thrustModelFactor: 0.5 } }
    const curved = { ...command, ...curvedParams }
    const [hello, loaded, first, replay, linear, ...others] = engine(
      { type: 'hello' }, load, curved, curved, command,
      ...steps.map((step) => ({ ...command, test: { ...params.test, step } })),
    )
    expect(result(hello)).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
    expect(VehicleLoadResultSchema.parse(result(loaded)).valid).toBe(true)
    const run = await runStepTest(async (request) => {
      expect(request).toEqual(curved)
      return result(first)
    }, curvedParams)
    expect(run).toEqual(StepTestRunResultSchema.parse(result(replay)))
    expect(measuredSamples(run.trace).map(({ t }) => t)).toEqual(run.trace.samples.map(({ timeS }) => timeS))
    const lastSignal = run.trace.samples.at(-1)?.signal
    expect(lastSignal?.kind).toBe('rate')
    expect(measuredSamples(run.trace).at(-1)?.y).toBe(lastSignal?.kind === 'rate' ? lastSignal.measuredRadps : undefined)
    expect(run.endReason).toBe('duration')
    expect(run.error).toBeNull()
    expect(run.stepTimeS).toBe(params.test.holdS)
    expect(run.gains).toMatchObject({
      MC_ROLL_P: 7, MC_AIRMODE: 1, THR_MDL_FAC: 0.5,
      MC_YAWRATE_K: 1, MPC_THR_HOVER: 0.5, HTE_THR_RANGE: 0.2,
    })
    const linearRun = StepTestRunResultSchema.parse(result(linear))
    expect(run.hoverCollective01).toBeLessThan(linearRun.hoverCollective01)
    expect(run.trace.samples[0]!.motorCommands01).toEqual(
      linearRun.trace.samples[0]!.motorCommands01.map((value) => expect.closeTo(value!, 12)),
    )
    expect(run.trace.samples.map((sample) => sample.timeS)).toEqual([0, 2 * dtS, 4 * dtS, 6 * dtS])
    expect(run.trace.samples[1]).toMatchObject({
      signal: { kind: 'rate', setpointRadps: angleRad },
      commandedAttitudeXyzw: null,
      commandedBodyRatesRadps: [angleRad, 0, 0],
    })
    for (const [index, response] of others.entries()) {
      const report = StepTestRunResultSchema.parse(result(response))
      expect(report.endReason).toBe('duration')
      expect(report.trace.samples[0]?.motorCommands01).toHaveLength(load.vehicle.motors.length)
      for (const throttle of report.trace.samples[0]?.motorCommands01 ?? []) {
        expect(throttle).toBeCloseTo(report.hoverCollective01, 12)
      }
      expect(report.trace.samples[1]?.signal.kind).toBe(index === 0 ? 'attitude' : 'position')
      expect(report.trace.samples[1]?.commandedAttitudeXyzw).toHaveLength(4)
    }
  })

  it('round-trips preload IPC with a validated vehicle, test and real engine response', async () => {
    const [loaded, flown] = engine({ ...load, aero }, command)
    const output = StepTestRunResultSchema.parse(result(flown))
    const engineApi = {
      loadVehicle: vi.fn(async () => VehicleLoadResultSchema.parse(result(loaded))),
      runStepTest: vi.fn(async (payload: StepTestRunParams) => runStepTest(async () => result(flown), payload)),
    }
    const invoke = vi.fn(async (_channel: string, payload: unknown) => stepTest(engineApi, payload))
    const expose = vi.fn()
    vi.doMock('electron', () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }))
    try {
      await import('../../electron/preload/index')
      const api = expose.mock.calls[0]![1] as DesktopApi
      const payload = { vehicle, propulsion, aero, ...params }
      expect(await api.engine.stepTest(payload)).toEqual({ ok: true, data: output })
      expect(invoke).toHaveBeenCalledWith(Channels.engineStepTest, payload)
      expect(engineApi.loadVehicle).toHaveBeenCalledWith(vehicle, { propulsion, aero })
      expect(engineApi.runStepTest).toHaveBeenCalledWith(params)
      expect(await api.engine.stepTest({ ...payload, test: { ...params.test, decimationSteps: 0 } }))
        .toMatchObject({ ok: false, error: { code: 'VALIDATION', message: expect.stringContaining('test.decimationSteps') } })
      expect(engineApi.loadVehicle).toHaveBeenCalledTimes(1)
      engineApi.runStepTest.mockRejectedValueOnce(new Error('INVALID_PARAMS: engine refused the run'))
      expect(await api.engine.stepTest(payload)).toMatchObject({ ok: false, error: { message: 'INVALID_PARAMS: engine refused the run' } })
    } finally {
      vi.doUnmock('electron')
    }
  })

  it('names a missing cut-off or inertia and keeps early battery traces', () => {
    const motors = load.propulsion.motors.map((m, i) => i === 0 ? { ...m, inertiaKgM2: undefined } : m)
    const [, cutoff, early, badLoad] = engine(
      load,
      { ...command, config: { ...params.config, cutoff: undefined } },
      { ...command, config: { ...params.config, cutoff: { type: 'voltageV', value: 11 } } }, // scenario/tests.rs:338-347
      { ...load, propulsion: { ...load.propulsion, motors } },
    )
    expect(cutoff).toMatchObject({ ok: false, error: { code: 'CUTOFF_REQUIRED', message: expect.stringContaining('config.cutoff') } })
    const report = StepTestRunResultSchema.parse(result(early))
    expect(report.endReason).toBe('voltageCutoff')
    expect(report.elapsedS).toBe(dtS)
    expect(report.trace.samples).toHaveLength(1)
    expect(VehicleLoadResultSchema.parse(result(badLoad))).toMatchObject({
      valid: false, errors: [expect.objectContaining({ message: expect.stringContaining('inertiaKgM2') })],
    })
  })
})
