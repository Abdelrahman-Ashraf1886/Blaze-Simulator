import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  BUILTIN_SCENARIO_NAMES, FlightSessionStartResultSchema, FlightSessionStepResultSchema,
  isEngineResponse, PROTOCOL_VERSION, ScenarioRunResultSchema, StepTestRunResultSchema,
  VehicleLoadResultSchema, type EngineCommand, type HelloResult, type StepTestRunParams,
} from '../../electron/main/engine/protocol'
import { RECOMMENDED_STEP_METRICS_OPTIONS, stepMetrics } from '../../src/domain/step-response'
import { measuredSamples } from '../../src/features/tuning/step-test-input'
import { simWind } from '../../src/domain/wind'

const root = resolve(import.meta.dirname, '../..')
// Reuse the release self-check's vehicle and flight inputs (capture-self-check.mjs:11–53).
const fixture = JSON.parse(readFileSync(resolve(root, 'scripts/release/fixtures/self-check.json'), 'utf8')) as {
  vehicleLoad: Extract<EngineCommand, { type: 'vehicle.load' }>
  scenario: { requests: [Extract<EngineCommand, { type: 'scenario.run' }>] }
  flight: { requests: [Extract<EngineCommand, { type: 'flight.session.start' }>, ...EngineCommand[]] }
  stepTest: { requests: [Extract<EngineCommand, { type: 'stepTest.run' }>] }
}
const { config } = fixture.scenario.requests[0]
const stepTest = fixture.stepTest.requests[0]
const [flightStart, ...flightSteps] = fixture.flight.requests

// tests/unit/flight-live.test.ts:731–751. Grounded built-ins need an explicit start
// position and terrain also needs a clearance (engine-host/src/scenario_run.rs:395–409).
const surface = { friction: 0.5, restitution: 0 }
const cellSizeM = 2
const wind = simWind({
  kind: 'wind', fromDeg: 0, mean: { kind: 'constant', speedMps: 8 },
  gust: { kind: 'discrete', amplitudeMps: 8, lengthM: 4, startS: 1.5 * 0.001 },
})
if (!wind.ok || !wind.wind) throw new Error('Invalid regression wind fixture')
const scenarioConfig = {
  wind_hold: { wind: { ...wind.wind, gust: null } },
  gust: { wind: wind.wind },
  // The self-check starts at the box's lower-face contact height (capture-self-check.mjs:24,51).
  takeoff_hold_land: { environment: { ground: surface, obstacles: [] }, startPositionM: flightStart.startPositionM },
  terrain: {
    environment: {
      ground: null, obstacles: [],
      terrain: { ...surface, rows: 2, columns: 2, cellSizeM, cornerM: [-cellSizeM, -cellSizeM], heightsM: [0, 0, 0, 0] },
    },
    startPositionM: [0, 0, 0], startClearanceM: 0, // tests/unit/scenario-protocol.test.ts:248
  },
} satisfies Partial<Record<(typeof BUILTIN_SCENARIO_NAMES)[number], object>>
const scenarioInputs = {
  payload: { massKg: 0.5 },
  com_offset: { offsetM: 0.02 },
} // simulation-engine/engine-host/tests/scenario_run.rs:108–114

if (stepTest.test.step.type !== 'rate' || !flightStart.sensors) throw new Error('Unexpected self-check fixture')
const stepInputs: StepTestRunParams['test']['step'][] = [
  stepTest.test.step,
  // tests/unit/step-test-protocol.test.ts:147–157
  { type: 'attitude', axis: 'yaw', amplitudeRad: stepTest.test.step.amplitudeRadps },
  { type: 'altitude', amplitudeM: 1 },
  { type: 'position', axis: 'y', amplitudeM: 1 },
]
const steps = stepInputs.map((step) => {
  // Use the full rotation and translation windows from engine-core/src/step_test/tests.rs:40–48,234.
  const translation = step.type === 'altitude' || step.type === 'position'
  return {
    step,
    holdS: translation ? 5 : 1,
    durationS: translation ? 15 : 10,
    decimationSteps: translation ? 10 : 1,
  }
})

function capture(requests: { label: string; command: object }[]) {
  const binary = process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine'
  const scratch = mkdtempSync(join(tmpdir(), 'blaze-regression-'))
  const input = join(scratch, 'requests.ndjson')
  const output = join(scratch, 'replies.ndjson')
  const descriptors: number[] = []
  let lines: string[]
  try {
    // File-backed stdio follows scripts/validation-report.mjs:22–44.
    writeFileSync(input, requests.map(({ command }, id) => JSON.stringify({ ...command, id }) + '\n').join(''), 'utf8')
    descriptors.push(openSync(input, 'r'))
    descriptors.push(openSync(output, 'w'))
    const child = spawnSync(resolve(root, 'simulation-engine/target/release', binary), [], {
      stdio: [descriptors[0]!, descriptors[1]!, 'inherit'], windowsHide: true,
    })
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(`Engine exited with ${child.status ?? child.signal}`)
    lines = readFileSync(output, 'utf8').trim().split(/\r?\n/)
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor)
    rmSync(scratch, { recursive: true, force: true })
  }
  if (lines.length !== requests.length) throw new Error(`Engine returned ${lines.length} replies for ${requests.length} requests`)
  return requests.map(({ label }, id) => {
    if (!lines[id]) throw new Error(`${label}: engine reply missing`)
    const reply: unknown = JSON.parse(lines[id])
    if (!isEngineResponse(reply) || reply.id !== id) throw new Error(`${label}: invalid engine reply`)
    if (!reply.ok) throw new Error(`${label}: ${reply.error.code}: ${reply.error.message}`)
    return reply.result
  })
}

function flightNumbers(start: unknown, replies: unknown[], fromGyro: boolean) {
  const started = FlightSessionStartResultSchema.parse(start)
  const advanced = replies.map((reply) => FlightSessionStepResultSchema.parse(reply))
  const terminal = advanced.at(-1)
  if (!terminal || !started.channels) throw new Error('Sensor flight did not return telemetry')
  const rows = [started, ...advanced].flatMap((reply) => reply.samples?.rows ?? [])
  const columns = started.channels.filter((name) => name.startsWith('sensor.') || name === 'controller.rateSource')
  const lastRow = rows.at(-1)
  if (!lastRow || !columns.includes('sensor.gyro.x')) throw new Error('Sensor flight has no gyro samples')
  // tests/unit/flight-live.test.ts:1019–1048 and 1116–1123.
  const gyroRows = rows.filter((row) => row[started.channels!.indexOf('controller.rateSource')] === 1).length
  expect(gyroRows > 0, 'sampled gyro feedback').toBe(fromGyro)
  expect(terminal.endReason).toBeNull()
  return {
    diagnostic: terminal.diagnostic, sampleCount: rows.length, gyroRows,
    finalSensors: Object.fromEntries(columns.map((name) => [name, lastRow[started.channels!.indexOf(name)]])),
    stateHash: terminal.stateHash,
  }
}

type Difference = { path: string; expected: unknown; actual: unknown }

function* differences(expected: unknown, actual: unknown, path: string): Generator<Difference> {
  if (Object.is(expected, actual)) return
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' &&
      Array.isArray(expected) === Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of keys) {
      yield* differences(expected[key as keyof typeof expected], actual[key as keyof typeof actual],
        Array.isArray(actual) ? `${path}[${key}]` : `${path}.${key}`)
    }
    return
  }
  yield { path, expected, actual }
}

it('matches the versioned real-engine golden results', () => {
  const flightCases = ['flight/sensors', 'flight/gyro-feedback'].map((label, index) => ({
    label,
    command: index === 0 ? flightStart : {
      ...flightStart,
      // Filter fixture from tests/unit/flight-live.test.ts:664,1116–1123.
      sensors: { ...flightStart.sensors, flyOnGyro: { gyroCutoffHz: 40, dgyroCutoffHz: 30, notch0: null, notch1: null } },
    },
  }))
  const [hello, load, ...replies] = capture([
    { label: 'hello', command: { type: 'hello' } },
    { label: 'vehicle.load', command: fixture.vehicleLoad },
    ...BUILTIN_SCENARIO_NAMES.map((name) => ({
      label: `scenario/${name}`,
      command: {
        type: 'scenario.run',
        scenario: { type: 'builtin', name, ...scenarioInputs[name as keyof typeof scenarioInputs] },
        config: { ...config, ...scenarioConfig[name as keyof typeof scenarioConfig] },
      },
    })),
    ...steps.map((test) => ({ label: `step/${test.step.type}`, command: { ...stepTest, test } })),
    ...flightCases.flatMap(({ label, command }) => [
      { label, command },
      ...flightSteps.map((step) => ({ label, command: step })),
      { label, command: { type: 'flight.session.end' } },
    ]),
  ])
  const { engineVersion, protocolVersion } = hello as HelloResult
  expect(engineVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/)
  expect(protocolVersion).toBe(PROTOCOL_VERSION)
  expect(VehicleLoadResultSchema.parse(load).valid).toBe(true)

  const cases: Record<string, unknown> = {}
  for (const name of BUILTIN_SCENARIO_NAMES) {
    const { report, stateHash } = ScenarioRunResultSchema.parse(replies.shift())
    const { finalStateHash, ...measurements } = report
    expect(finalStateHash, name).toBe(stateHash)
    cases[`scenario/${name}`] = { ...measurements, stateHash }
  }
  for (const { step } of steps) {
    const result = StepTestRunResultSchema.parse(replies.shift())
    const amplitude = 'amplitudeRadps' in step ? step.amplitudeRadps : 'amplitudeRad' in step ? step.amplitudeRad : step.amplitudeM
    const metrics = stepMetrics(measuredSamples(result.trace), { t0: result.stepTimeS, y0: 0, y1: amplitude }, RECOMMENDED_STEP_METRICS_OPTIONS)
    expect(result.endReason, step.type).toBe('duration')
    expect(metrics.status, step.type).toBe('ok')
    cases[`step/${step.type}`] = {
      metrics, elapsedS: result.elapsedS, hoverCollective01: result.hoverCollective01,
      startImbalanceNm: result.startImbalanceNm, stateHash: result.stateHash,
    }
  }
  for (const [index, { label }] of flightCases.entries()) {
    cases[label] = flightNumbers(replies.shift(), replies.splice(0, flightSteps.length), index !== 0)
    replies.shift() // flight.session.end
  }

  const path = resolve(root, 'tests/golden', `${engineVersion}.json`)
  const reason = process.env.BLAZE_GOLDEN_UPDATE_REASON?.trim()
  // Compare the JSON representation so -0 and 0 follow the same serialization rule.
  const current = JSON.parse(JSON.stringify({ engineVersion, cases }))
  if (reason) {
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ reason, ...current }, null, 2).replaceAll('\n', '\r\n') + '\r\n',
      { encoding: 'utf8', flag: 'wx' })
    try {
      renameSync(temporary, path)
    } catch (error) {
      unlinkSync(temporary)
      throw error
    }
    return
  }
  const golden = JSON.parse(readFileSync(path, 'utf8'))
  expect(golden.reason?.trim(), 'golden update reason').toBeTruthy()
  const expected = golden
  for (const name of new Set([...Object.keys(current.cases), ...Object.keys(expected.cases)])) {
    const changes = [...differences(expected.cases[name], current.cases[name], name)]
    const first = changes.find(({ expected, actual }) => typeof expected === 'number' || typeof actual === 'number') ?? changes[0]
    if (first) throw new Error(`${first.path}: expected ${JSON.stringify(first.expected)}, got ${JSON.stringify(first.actual)}`)
  }
  expect(current.engineVersion).toBe(expected.engineVersion)
})
