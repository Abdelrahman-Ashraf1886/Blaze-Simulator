/**
 * 4.9 part B: running the scenarios from the app. The protocol schemas check what is sent and what the engine
 * answers; the IPC handler validates everything before the engine and passes its refusals through; and a real
 * engine flies a built-in through the same handler (the engine's own tests fly every built-in).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import seed from '../../database/seed/components.v1.json'
import type { Component } from '../../electron/ipc/component-fields'
import type { AssemblyDocument, IpcResult } from '../../electron/ipc/contract'
import { STARTING_FRAME } from '../../electron/main/db/repositories'
import {
  BUILTIN_SCENARIO_NAMES,
  ScenarioReportSchema,
  ScenarioRunParamsSchema,
  ScenarioRunResultSchema,
  type Scenario,
  type ScenarioRunResult,
} from '../../electron/main/engine/protocol'
import { scenarioRun, scenarioRunSchema, type EngineForScenario } from '../../electron/main/engine/scenario-run'
import { stepTest } from '../../electron/main/engine/step-test'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import { RECOMMENDED_STEP_METRICS_OPTIONS, stepMetrics } from '../../src/domain/step-response'
import { thrustFactor, thrustFactorReadout } from '../../src/domain/thrust-curve'
import { enginePayload, flightGate } from '../../src/features/flight/readiness'
import { BUILTINS, scenarioRunInput } from '../../src/features/scenarios/scenarios'
import { measuredSamples, stepTestInput } from '../../src/features/tuning/step-test-input'
import { addPart, updatePart, type AttachTarget } from '../../src/features/workshop/assembly-ops'
import { effectiveShape } from '../../src/features/workshop/links'
import { placeClear, reseat } from '../../src/features/workshop/placement'
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
const config = { airDensityKgM3: 1.225, cutoff: { type: 'chargeMah', value: 1000 } }
const hover = { type: 'builtin', name: 'balanced_hover' }
const request = (over: Record<string, unknown> = {}) => ({ ...quad, scenario: hover, config, ...over })

// Headless copy of the 4.9 catalogue quad and its user entries in
// tests/e2e/scenarios.spec.ts:33–65,104,115,142,164.
function catalogueQuad() {
  const named = (name: string) => (seed.components as unknown as Component[]).find((c) => c.name === name)!
  const motor = named('MN3110 KV470')
  const prop = named('P13*4.4 CF propeller')
  const battery = named('Tattu G-Tech 5200mAh 4S 35C')
  const components = {
    [motor.id]: { ...motor, specs: { ...motor.specs,
      rotorInertia: { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' },
      referenceDensity: { value: 1.225, unit: 'kg/m³', source: 'user', condition: 'bench air, as stated by the user' },
    } },
    [prop.id]: prop,
    [battery.id]: { ...battery, specs: { ...battery.specs,
      internalResistance: { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire AC, 1 kHz, 25 °C' },
    } },
  } satisfies Record<string, Component>
  const frame = { ...STARTING_FRAME['quad-x'], motorDiagonal: 0.55 }
  const geo = buildFrame('quad-x', frame)
  const frameTop = geo.plates.find(({ id }) => id === 'plate-top')!.position[2]
  let doc: AssemblyDocument = {
    frame, frameMass: { valueKg: 0.3, source: 'user' }, motors: {}, parts: [],
    bodyDrag: { cd: [1.1, 1.1, 1.1], source: 'user' }, // FrameEditor.tsx:90–95
    environment: { ground: { friction: 0.6, restitution: 0.1 }, obstacles: [] },
  }
  const attach = (kind: 'motor' | 'propeller' | 'battery', target: AttachTarget, id: string, componentId: string) => {
    const added = addPart(doc, kind, target, frameTop, id, {}, (part) => effectiveShape(part, components))
    const placed = placeClear(added.doc, geo, id, components, {})
    if (!placed.ok) throw new Error(placed.reason)
    doc = reseat(placed.doc, updatePart(placed.doc, id, { componentId }), geo, id, components, {})
    const linked = placeClear(doc, geo, id, components, {})
    if (linked.ok) doc = linked.doc
  }
  for (const mount of geo.motors) {
    attach('motor', { kind: 'mount', id: mount.id }, mount.id, motor.id)
    attach('propeller', { kind: 'part', id: mount.id }, `prop-${mount.number}`, prop.id)
  }
  attach('battery', { kind: 'none' }, 'battery', battery.id)
  const gate = flightGate(enginePayload(doc, geo, components, {}), {
    ambientAltitudeM: 0, temperatureC: null, cutoffType: 'voltageV', cutoffValue: 12,
  })
  if (!gate.ok) throw new Error(gate.blockers.map(({ id }) => id).join(', '))
  return gate
}

const holdLevel: Scenario = {
  name: 'hold', durationS: 1, modifications: [{ type: 'payload', partId: 'p', massKg: 0.1, positionM: [0, 0, 0], boxSizeM: null }, { type: 'shiftPart', partId: 'body', deltaM: [0, 0, 0] }],
  script: [{ fromS: 0, attitude: { type: 'euler', roll: 0, pitch: 0, yaw: 0 }, yawRateRadps: 0, zM: null, zVelocityMps: 0 }, { fromS: 0.5, attitude: { type: 'quaternion', xyzw: [0, 0, 0, 1] }, yawRateRadps: 0, zM: 0.1, zVelocityMps: 0 }],
  checks: [
    { type: 'altitude', afterS: 0.5, toleranceM: 0.02 }, { type: 'attitude', afterS: 0.5, maxDeg: 1 }, { type: 'noSustainedSaturation', afterS: 0.5, maxDurationS: 0.01 },
    { type: 'saturationObserved', afterS: 0 }, { type: 'attitudeLost', afterS: 0, aboveDeg: 30 }, { type: 'cannotClimb', afterS: 0, minThrottle: 0.9 },
    { type: 'hoverThrottle', afterS: 0.5, min: 0.4, max: 0.6 }, { type: 'rateTrim', afterS: 0.5, axis: 1, expected: 0, tolerance: 0.001 },
    { type: 'thrustBalance', afterS: 0.5, weights: [1, 1, 1, 1], expectedN: 9.8, toleranceN: 0.1 },
  ],
}
const validCustom = holdLevel

describe('the scenario.run request schema', () => {
  const ok = (v: unknown) => ScenarioRunParamsSchema.safeParse(v).success
  const params = (over: Record<string, unknown> = {}): unknown => ({ scenario: hover, config, ...over })

  it('takes every built-in with its own parameter, and a full scenario', () => {
    for (const name of BUILTIN_SCENARIO_NAMES) expect(ok(params({ scenario: { type: 'builtin', name } })), name).toBe(true)
    expect(ok(params({ scenario: { type: 'builtin', name: 'payload', massKg: 0.5 } }))).toBe(true)
    expect(ok(params({ scenario: { type: 'builtin', name: 'com_offset', offsetM: -0.02 } }))).toBe(true)
    expect(ok(params({ scenario: { type: 'custom', scenario: validCustom } }))).toBe(true)
  })
  it('takes a voltage or charge cut-off, gains, and a ground with its start', () => {
    expect(ok(params({ config: { ...config, cutoff: { type: 'voltageV', value: 9 } } }))).toBe(true)
    expect(ok(params({ config: { ...config, gains: { MC_ROLL_P: 7 } } }))).toBe(true)
    expect(ok(params({ config: { ...config, environment: { ground: { friction: 0.5, restitution: 0 }, obstacles: [] }, startPositionM: [0, 0, 0.02] } }))).toBe(true)
  })
  it('refuses what the engine would refuse, here first', () => {
    for (const [what, bad] of Object.entries({
      'an unknown built-in': params({ scenario: { type: 'builtin', name: 'spin' } }),
      'a negative payload': params({ scenario: { type: 'builtin', name: 'payload', massKg: -1 } }),
      'a zero payload': params({ scenario: { type: 'builtin', name: 'payload', massKg: 0 } }),
      'a non-numeric offset': params({ scenario: { type: 'builtin', name: 'com_offset', offsetM: '2cm' } }),
      'an unknown scenario field': params({ scenario: { type: 'builtin', name: 'payload', mass: 1 } }),
      'no cut-off': params({ config: { airDensityKgM3: 1.225 } }),
      'a zero cut-off': params({ config: { ...config, cutoff: { type: 'voltageV', value: 0 } } }),
      'an unknown cut-off type': params({ config: { ...config, cutoff: { type: 'capacity', value: 5 } } }),
      'no air density': params({ config: { cutoff: config.cutoff } }),
      'a zero air density': params({ config: { ...config, airDensityKgM3: 0 } }),
      'an unknown config key': params({ config: { ...config, dtS: 0.002 } }),
      'a lower-case gain name': params({ config: { ...config, gains: { mc_roll_p: 7 } } }),
      'a non-finite start': params({ config: { ...config, startPositionM: [0, 0, Number.NaN] } }),
      'an unknown check': params({ scenario: { type: 'custom', scenario: { ...validCustom, checks: [{ type: 'smooth', afterS: 0 }] } } }),
      'an unknown top-level key': params({ durationS: 5 }),
      'no scenario': { config },
    })) expect(ok(bad), what).toBe(false)
  })
})

describe('the scenario.run result schema', () => {
  const report = {
    name: 'balanced_hover', passed: true,
    checks: [
      { check: { type: 'altitude', afterS: 19, toleranceM: 0.02 }, measured: 0.001, limits: [0, 0.02], passed: true, samples: 1000 },
      { check: { type: 'cannotClimb', afterS: 1, minThrottle: 0.9 }, measured: null, limits: [-1.7976931348623157e308, 0], passed: false, samples: 0 },
    ],
    elapsedS: 20, maxAttitudeErrorDeg: 1.2, finalAltitudeErrorM: null, meanThrottle: [0.5, 0.5], maxThrottle: [0.6, 0.6], firstThrottle: [0.5, 0.5],
    saturatedFraction: 0, chargeUsedMah: 12, endReason: 'duration', finalStateHash: '0123456789abcdef',
  }
  it('takes the report as engine-core serialises it, including a check with no value', () => {
    expect(ScenarioReportSchema.safeParse(report).success).toBe(true)
    expect(ScenarioRunResultSchema.safeParse({ scenario: { ...holdLevel, checks: [] }, report, stateHash: report.finalStateHash }).success).toBe(true)
  })
  it('refuses a report the engine could not have written', () => {
    for (const bad of [
      { ...report, endReason: 'landed' },
      { ...report, finalStateHash: 'xyz' },
      { ...report, extra: 1 },
      { ...report, checks: [{ ...report.checks[0], limits: [0] }] },
      { ...report, checks: [{ ...report.checks[0], measured: 'n/a' }] },
    ]) expect(ScenarioReportSchema.safeParse(bad)).toHaveProperty('success', false)
  })
})

describe('the scenario IPC handler', () => {
  const result = (over: Partial<ScenarioRunResult> = {}): ScenarioRunResult => ({
    scenario: { ...holdLevel, checks: [] }, report: { name: 'balanced_hover', passed: true, checks: [], elapsedS: 20, maxAttitudeErrorDeg: 0, finalAltitudeErrorM: null, meanThrottle: [], maxThrottle: [], firstThrottle: [], saturatedFraction: 0, chargeUsedMah: 0, endReason: 'duration', finalStateHash: '0123456789abcdef' }, stateHash: '0123456789abcdef', ...over,
  })
  const fake = (over: Partial<EngineForScenario> = {}) => {
    const engine = {
      loadVehicle: vi.fn(async () => ({ valid: true as const, partCount: 1, motorCount: 4, totals: { massKg: 1, com: [0, 0, 0] as [number, number, number], inertia: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number] }, missingMass: [] })),
      runScenario: vi.fn(async () => result()),
      ...over,
    } satisfies EngineForScenario
    return engine
  }
  const err = (r: IpcResult<unknown>) => (r.ok ? null : r.error)

  it('loads the vehicle with its propulsion and runs the scenario, sending exactly what was validated', async () => {
    const engine = fake()
    const r = await scenarioRun(engine, request())
    expect(r).toEqual({ ok: true, data: result() })
    expect(engine.loadVehicle).toHaveBeenCalledWith(quad.vehicle, { propulsion: quad.propulsion, aero: quad.aero })
    expect(engine.runScenario).toHaveBeenCalledWith({ scenario: hover, config })
  })
  it('refuses a bad request before the engine, naming the field; nothing is filled in', async () => {
    const engine = fake()
    for (const [bad, mentions] of [
      [request({ config: { airDensityKgM3: 1.225 } }), 'config.cutoff'],
      [request({ config: { ...config, airDensityKgM3: 0 } }), 'config.airDensityKgM3'],
      [request({ scenario: { type: 'builtin', name: 'nope' } }), 'scenario'],
      [request({ aero: undefined }), 'aero'],
      [request({ propulsion: undefined }), 'propulsion'],
      [request({ vehicle: { ...quad.vehicle, version: 2 } }), 'vehicle'],
      [{ ...request(), extra: 1 }, 'extra'],
      [null, 'input'],
    ] as const) {
      const e = err(await scenarioRun(engine, bad))
      expect(e?.code).toBe('VALIDATION')
      expect(e?.message, JSON.stringify(mentions)).toContain(mentions)
    }
    expect(engine.loadVehicle).not.toHaveBeenCalled()
    expect(scenarioRunSchema.safeParse(request()).success).toBe(true)
  })
  it('passes the engine’s refusals through with their codes', async () => {
    const refused = fake({ runScenario: vi.fn(async () => { throw new Error('INVALID_SCENARIO: payload needs massKg: the mass added at the CoM, kg') }) })
    expect(err(await scenarioRun(refused, request({ scenario: { type: 'builtin', name: 'payload' } })))?.message).toBe('INVALID_SCENARIO: payload needs massKg: the mass added at the CoM, kg')
    const invalid = fake({ loadVehicle: vi.fn(async () => ({ valid: false as const, errors: [{ path: 'parts[0].massKg', message: 'must be positive' }] })) })
    expect(err(await scenarioRun(invalid, request()))?.message).toMatch(/^The engine refused the vehicle: parts\[0\]\.massKg: must be positive/)
    expect(invalid.runScenario).not.toHaveBeenCalled()
  })
})

// ---- a real engine, through the same handler -----------------------------------------------------------------

const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')
const sup = new EngineSupervisor({ binaryPath })
afterAll(() => sup.stop())

describe('a real engine', () => {
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
  })

  it('flies balanced hover and passes, flies it again to the same hash, and refuses with the engine’s codes', async () => {
    const first = await scenarioRun(sup, request())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.report.name).toBe('balanced_hover')
    expect(first.data.report.passed).toBe(true)
    expect(first.data.report.endReason).toBe('duration')
    expect(first.data.report.checks.length).toBeGreaterThan(0)
    expect(first.data.report.checks.every((c) => c.passed && c.measured !== null)).toBe(true)
    expect(first.data.stateHash).toBe(first.data.report.finalStateHash)
    const second = await scenarioRun(sup, request())
    expect(second).toEqual(first)

    const refused = async (over: Record<string, unknown>) => err(await scenarioRun(sup, request(over)))?.message ?? ''
    expect(await refused({ config: { ...config, thrustModelFactor: 0.5, gains: { THR_MDL_FAC: 0 } } }))
      .toMatch(/^INVALID_PARAMS: .*thrustModelFactor and THR_MDL_FAC must agree/)
    expect(await refused({ scenario: { type: 'builtin', name: 'payload' } })).toMatch(/^INVALID_SCENARIO: .*massKg/)
    expect(await refused({ scenario: { type: 'builtin', name: 'payload', massKg: 0.5 }, config: { ...config, gains: { MC_NOPE: 1 } } })).toMatch(/^INVALID_PARAMS: .*unknown PX4 parameter/)
    const noReference = { ...quad.propulsion, motors: quad.propulsion.motors.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'referenceDensityKgM3'))) }
    // The schema asks for the density too: a definition without it is refused before the engine.
    expect(await refused({ propulsion: noReference })).toContain('referenceDensityKgM3')
    // After the refusals the engine still flies.
    expect((await scenarioRun(sup, request({ scenario: { type: 'builtin', name: 'payload', massKg: 0.5 } }))).ok).toBe(true)
  }, 60000)

  it('runs every 4.9 catalogue baseline with the curve off and with the derived factor', async () => {
    const gate = catalogueQuad()
    expect(gate.thrustFit?.factor).toBeGreaterThan(0)
    expect(thrustFactorReadout(gate.thrustFit, {})).toMatch(/derived.*RMS.*Nominal pack 14.8 V with sag/)
    expect(thrustFactorReadout(gate.thrustFit, { THR_MDL_FAC: 0 })).toMatch(/user override.*RMS/)
    const entries = { payloadMassKg: 0.2, comOffsetM: 0.005 }
    for (const info of BUILTINS) {
      const on = scenarioRunInput(gate, info, entries)!
      const off = scenarioRunInput(gate, info, entries, { THR_MDL_FAC: 0 })!
      const runs = []
      for (const input of [off, on]) {
        const response = await scenarioRun(sup, input)
        if (!response.ok) throw new Error(response.error.message)
        runs.push(response.data.report)
      }
      expect(runs[0]?.passed, info.name).toBe(true)
      expect(runs[1]?.finalStateHash, info.name).not.toBe(runs[0]?.finalStateHash)
      if (process.env.BLAZE_SCENARIO_BASELINES) {
        console.info('BASELINE ' + JSON.stringify({ fit: gate.thrustFit?.factor, rms: gate.thrustFit?.rmsError, max: gate.thrustFit?.maxAbsError, runs }))
      }
    }
    // 2 m acceptance steps (phase-5-flight-control.md:362–364). Timing and
    // roll amplitude come from step_test/tests.rs:44–47,234.
    for (const { step, amplitude, holdS, durationS } of [
      { step: { type: 'position', axis: 'x', amplitudeM: 2 }, amplitude: 2, holdS: 5, durationS: 15 },
      { step: { type: 'altitude', amplitudeM: 2 }, amplitude: 2, holdS: 5, durationS: 15 },
      { step: { type: 'rate', axis: 'roll', amplitudeRadps: Math.PI / 18 }, amplitude: Math.PI / 18, holdS: 1, durationS: 10 },
    ] as const) {
      for (const factor of [0, thrustFactor(gate.thrustFit)]) {
        const input = stepTestInput(gate, { step, holdS, durationS, decimationSteps: 10 }, { THR_MDL_FAC: factor })
        const response = await stepTest(sup, input)
        if (!response.ok) throw new Error(response.error.message)
        const { endReason, error, trace, stepTimeS, gains } = response.data
        if (endReason !== 'duration') throw new Error(`${step.type}: ${endReason}: ${error}`)
        const samples = measuredSamples(trace)
        const metrics = stepMetrics(samples, { t0: stepTimeS, y0: 0, y1: amplitude }, RECOMMENDED_STEP_METRICS_OPTIONS)
        expect(metrics.status).toBe('ok')
        if (process.env.BLAZE_SCENARIO_BASELINES && metrics.status === 'ok') {
          console.info('BASELINE ' + JSON.stringify({ step: step.type, factor: gains.THR_MDL_FAC, finalError: amplitude - samples.at(-1)!.y, metrics }))
        }
      }
    }
  }, 60000)
})

function err(r: IpcResult<unknown>) {
  return r.ok ? null : r.error
}
