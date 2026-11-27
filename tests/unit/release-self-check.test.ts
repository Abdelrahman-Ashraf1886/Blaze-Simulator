import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { version } from '../../package.json'
import fixture from '../../scripts/release/fixtures/self-check.json'
import { PROTOCOL_VERSION } from '../../electron/main/engine/protocol'
import { checkComputer, formatComputerCheck, releaseLaunchOptions, replaySelfCheck } from '../../electron/main/self-check'

const root = join(__dirname, '../..')
const engine = join(root, 'simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')

describe('release launch options', () => {
  const env = { BLAZE_UAV_TEST_HOOKS: '1', BLAZE_UAV_USER_DATA: 'test-data', BLAZE_UAV_ENGINE: 'test-engine' }

  it('ignores test overrides and disables DevTools when packaged', () => {
    expect(releaseLaunchOptions(true, env)).toEqual({
      testHooks: false, userData: undefined, engine: undefined, devTools: false,
    })
  })

  it('keeps development and unpackaged end-to-end overrides', () => {
    expect(releaseLaunchOptions(false, env)).toEqual({
      testHooks: true, userData: env.BLAZE_UAV_USER_DATA, engine: env.BLAZE_UAV_ENGINE, devTools: true,
    })
    expect(releaseLaunchOptions(false, { BLAZE_UAV_TEST_HOOKS: '0' }).testHooks).toBe(false)
  })
})

it('matches the app version, inherited Cargo version and real engine hello, then replays the shipped inputs', async () => {
  const manifest = (crate = '') => readFileSync(join(root, 'simulation-engine', crate, 'Cargo.toml'), 'utf8')
  expect(manifest().match(/^\[workspace\.package\]\r?\nversion = "([^"]+)"/m)?.[1]).toBe(version)
  for (const crate of ['engine-core', 'engine-host']) {
    expect(manifest(crate)).toMatch(/^version\.workspace = true$/m)
  }
  const report = await checkComputer(engine, join(root, 'scripts/release/fixtures/self-check.json'), version)
  expect(report.cpu).toBeTruthy()
  expect(report.runs).toEqual([fixture.scenario, fixture.flight, fixture.stepTest].map(({ expectedHash }) =>
    expect.objectContaining({ status: 'same', expectedHash, actualHash: expectedHash }),
  ))
})

it('reports same, different and a failed engine separately with the available hashes', async () => {
  const cpu = 'Fake CPU'
  const vehicle = fixture.vehicleLoad.vehicle
  const exchange = vi.fn(async (_binary: string, requests: readonly { type: string; id: number }[]) => {
    const terminal = requests.at(-1)?.type
    if (terminal === 'stepTest.run') throw new Error('Engine closed')
    return requests.map(({ id, type }) => {
      const data = {
        hello: { engineVersion: version, protocolVersion: PROTOCOL_VERSION },
        'vehicle.load': {
          valid: true, partCount: vehicle.parts.length, motorCount: vehicle.motors.length,
          totals: { massKg: vehicle.totalMassKg, com: vehicle.com, inertia: vehicle.inertia },
          missingMass: vehicle.missingMass,
        },
        'scenario.run': { stateHash: fixture.scenario.expectedHash },
        'flight.session.step': { stateHash: fixture.scenario.expectedHash },
      }
      return JSON.stringify({ id, ok: true, result: data[type as keyof typeof data] ?? {} })
    }).join('\n')
  })

  const report = await replaySelfCheck('fake-engine', fixture, version, cpu, exchange)
  expect(exchange.mock.calls.map(([binary, requests]) => [binary, ...requests.map(({ type }) => type)])).toEqual([
    ['fake-engine', 'hello', 'vehicle.load', 'scenario.run'],
    ['fake-engine', 'hello', 'vehicle.load', 'flight.session.start', 'flight.session.step'],
    ['fake-engine', 'hello', 'vehicle.load', 'stepTest.run'],
  ])
  expect(report).toEqual({ cpu, runs: [
    { name: 'Balanced hover scenario', status: 'same', expectedHash: fixture.scenario.expectedHash, actualHash: fixture.scenario.expectedHash },
    { name: 'Flight log with sensors', status: 'different', expectedHash: fixture.flight.expectedHash, actualHash: fixture.scenario.expectedHash },
    { name: 'Roll rate step test', status: 'could not check', expectedHash: fixture.stepTest.expectedHash, error: 'Engine closed' },
  ] })
  const detail = formatComputerCheck(report)
  expect(detail).toContain(cpu)
  expect(detail).toContain(`Expected hash: ${fixture.flight.expectedHash}`)
  expect(detail).toContain(`Actual hash: ${fixture.scenario.expectedHash}`)
  expect(detail).toContain('Engine closed')
})
