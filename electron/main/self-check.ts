import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isEngineResponse, PROTOCOL_VERSION, VehicleLoadResultSchema } from './engine/protocol'

export function releaseLaunchOptions(isPackaged: boolean, env: NodeJS.ProcessEnv) {
  return {
    testHooks: !isPackaged && env.BLAZE_UAV_TEST_HOOKS === '1',
    userData: isPackaged ? undefined : env.BLAZE_UAV_USER_DATA,
    engine: isPackaged ? undefined : env.BLAZE_UAV_ENGINE,
    devTools: !isPackaged,
  }
}

export function selfCheckPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged ? join(resourcesPath, 'build', 'self-check', 'self-check.json')
    : join(appPath, 'scripts', 'release', 'fixtures', 'self-check.json')
}

const hash = z.string().regex(/^[0-9a-f]{16}$/)
const command = <T extends string>(type: T) => z.looseObject({ type: z.literal(type) })
const baseline = z.object({
  engineVersion: z.string(),
  vehicleLoad: command('vehicle.load'),
  scenario: z.object({ requests: z.tuple([command('scenario.run')]), expectedHash: hash }),
  flight: z.object({
    requests: z.tuple([command('flight.session.start'), command('flight.session.step')], command('flight.session.step')),
    expectedHash: hash,
  }),
  stepTest: z.object({ requests: z.tuple([command('stepTest.run')]), expectedHash: hash }),
})
const hello = z.object({ engineVersion: z.string(), protocolVersion: z.number() })
const resultHash = z.object({ stateHash: hash })
const labels = { scenario: 'Balanced hover scenario', flight: 'Flight log with sensors', stepTest: 'Roll rate step test' } as const

type Outcome = { status: 'same' | 'different'; actualHash: string } | { status: 'could not check'; error: string }
type Report = {
  cpu: string
  runs: ({ name: string; expectedHash: string } & Outcome)[]
}
type Request = { type: string; id: number }
type Exchange = (binary: string, requests: readonly Request[]) => Promise<string>

const runEngine: Exchange = (binary, requests) => new Promise((resolve, reject) => {
  // Same per-request allowance as engine/supervisor.ts, for this finite batch.
  const child = execFile(binary, { windowsHide: true, timeout: 3000 * requests.length }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
  child.stdin!.on('error', reject)
  child.stdin!.end(requests.map((request) => JSON.stringify(request) + '\n').join(''))
})

export async function replaySelfCheck(
  binary: string, input: unknown, appVersion: string, cpu: string, exchange = runEngine,
): Promise<Report> {
  const fixture = baseline.parse(input)
  if (fixture.engineVersion !== appVersion) {
    throw new Error('Self-check inputs do not match this release')
  }
  const runs: Report['runs'] = []
  for (const kind of ['scenario', 'flight', 'stepTest'] as const) {
    const { requests, expectedHash } = fixture[kind]
    const batch = [{ type: 'hello' }, fixture.vehicleLoad, ...requests].map((request, id) => ({ ...request, id }))
    let outcome: Outcome
    try {
      const lines = (await exchange(binary, batch)).trimEnd().split(/\r?\n/)
      if (lines.length !== batch.length) throw new Error('Incomplete engine response')
      const results = lines.map((line, id) => {
        const response: unknown = JSON.parse(line)
        if (!isEngineResponse(response) || response.id !== id) throw new Error('Unexpected engine response')
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        return response.result
      })
      const version = hello.parse(results[0])
      if (version.engineVersion !== fixture.engineVersion || version.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error('Engine version or protocol differs')
      }
      if (!VehicleLoadResultSchema.parse(results[1]).valid) throw new Error('Engine refused the self-check vehicle')
      const actualHash = resultHash.parse(results.at(-1)).stateHash
      outcome = { status: actualHash === expectedHash ? 'same' : 'different', actualHash }
    } catch (error) {
      outcome = { status: 'could not check', error: error instanceof Error ? error.message : String(error) }
    }
    runs.push({ name: labels[kind], expectedHash, ...outcome })
  }
  return { cpu, runs }
}

export async function checkComputer(binary: string, file: string, version: string): Promise<Report> {
  return replaySelfCheck(binary, JSON.parse(await readFile(file, 'utf8')), version, cpus()[0]?.model || 'Unavailable')
}

export function formatComputerCheck(report: Report): string {
  return [`CPU: ${report.cpu}`, ...report.runs.map((run) => [
    `${run.name}: ${run.status}`,
    `Expected hash: ${run.expectedHash}`,
    run.status === 'could not check' ? run.error : `Actual hash: ${run.actualHash}`,
  ].join('\n'))].join('\n\n')
}
