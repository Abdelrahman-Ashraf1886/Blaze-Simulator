import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'

// Run once for a reviewed baseline. The release build only reads the saved hashes.
const root = new URL('../../', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const engine = fileURLToPath(new URL('simulation-engine/target/release/drone-engine.exe', root))

// Vehicle, propulsion and drag from tests/unit/flight-live.test.ts:50–66.
const arm = 0.15
const inertia = [0.01, 0.01, 0.02, 0, 0, 0]
const mount = (partId, x, y, spin) => ({ partId, position: [x, y, 0], thrustAxis: [0, 0, 1], spin })
const motors = [mount('m1', arm, -arm, 'ccw'), mount('m2', -arm, arm, 'ccw'), mount('m3', arm, arm, 'cw'), mount('m4', -arm, -arm, 'cw')]
const airDensityKgM3 = 1.225
const vehicleLoad = {
  type: 'vehicle.load',
  vehicle: {
    version: 1,
    parts: [{
      partId: 'body', massKg: 1, com: [0, 0, 0], inertia,
      pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      shape: { type: 'box', halfExtents: [0.05, 0.05, 0.02] },
    }],
    motors, totalMassKg: 1, com: [0, 0, 0], inertia, missingMass: [],
  },
  propulsion: {
    version: 1,
    motors: motors.map(({ partId }) => ({
      partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5,
      thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: airDensityKgM3,
    })),
    battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 },
  },
  aero: { cdBody: [1, 1, 1], areaM2: [0.01, 0.01, 0.01] },
}
// simulation-engine/engine-host/tests/scenario_run.rs:74–85,109.
const config = { airDensityKgM3, cutoff: { type: 'chargeMah', value: 1000 } }
const scenario = { type: 'scenario.run', scenario: { type: 'builtin', name: 'balanced_hover' }, config }
// tests/unit/flight-live.test.ts:236–244,666–672,731–758,924–951.
const gyro = { noiseSigma: 0.03, vibrationSigma: 0.01, bias: null, randomWalk: 0.02, delaySteps: 2, range: null }
const sensors = {
  seed: -12, gyro,
  accelerometer: { ...gyro, delaySteps: null, mountPositionM: [0.01, 0, 0] },
  barometer: { referenceAltitudeM: 1000, referenceTemperatureK: null, sigmaPa: null, biasPa: null, periodSteps: 3, delaySteps: null },
  gps: { positionSigmaHorizontalM: null, positionSigmaVerticalM: null, velocitySigmaMps: null, periodSteps: 3, delaySteps: 1 },
}
const start = {
  type: 'flight.session.start', ...config, environment: { ground: null, obstacles: [] },
  startPositionM: [0, 0, 0.02], controller: { mode: 'position' }, sensors, sampleEverySteps: 1,
}
const step = { type: 'flight.session.step', steps: 12, setpoint: { mode: 'rates', bodyRadps: [0, 0, 0], collective: 0.5 } }
// tests/unit/step-test-protocol.test.ts:51–64,69,201.
const dtS = 1e-3
const rate = {
  type: 'stepTest.run',
  test: { step: { type: 'rate', axis: 'roll', amplitudeRadps: 10 * Math.PI / 180 }, holdS: 2 * dtS, durationS: 8 * dtS, decimationSteps: 2 },
  config: { ...config, gains: { MC_ROLL_P: 7, MC_AIRMODE: 1 }, airmode: 1, thrustModelFactor: 0 },
}

function capture(...requests) {
  const input = [{ type: 'hello' }, vehicleLoad, ...requests].map((request, id) => JSON.stringify({ ...request, id }) + '\n').join('')
  const result = spawnSync(engine, [], { input, windowsHide: true, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr)
  const replies = result.stdout.trim().split(/\r?\n/).map(JSON.parse)
  if (replies.length !== requests.length + 2 || replies.some((reply, id) => !reply.ok || reply.id !== id)) {
    throw new Error('Self-check capture failed: ' + JSON.stringify(replies.filter((reply) => !reply.ok)))
  }
  if (replies[0].result.engineVersion !== version || !replies[1].result.valid) throw new Error('Unexpected engine version or invalid vehicle')
  return replies.slice(2).map(({ result }) => result)
}

const [hover] = capture(scenario)
const [flightStart, flightStep, log] = capture(start, step, { type: 'flight.session.log' })
const [test] = capture(rate)
if (!hover.report.passed || !flightStart.channels.includes('sensor.gyro.x') ||
    !flightStep.samples.rows.length || test.endReason !== 'duration') throw new Error('Baseline verification failed')
const flightRequests = [log.start, ...log.steps].map(({ id, ...request }) => {
  if (!Number.isInteger(id)) throw new Error('Flight log is missing a request ID')
  return request
})
const fixture = {
  engineVersion: version, vehicleLoad,
  scenario: { requests: [scenario], expectedHash: hover.stateHash },
  flight: { requests: flightRequests, expectedHash: flightStep.stateHash },
  stepTest: { requests: [rate], expectedHash: test.stateHash },
}
const dir = new URL('./fixtures/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('self-check.json', dir), JSON.stringify(fixture, null, 2).replaceAll('\n', '\r\n') + '\r\n', {
  encoding: 'utf8', flag: 'wx',
})
console.log(cpus()[0].model, [hover.stateHash, flightStep.stateHash, test.stateHash].join(', '))
