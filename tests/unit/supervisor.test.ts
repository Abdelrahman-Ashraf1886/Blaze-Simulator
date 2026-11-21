import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineStatus } from '../../electron/ipc/contract'
import { EngineSupervisor, describeStartError } from '../../electron/main/engine/supervisor'

const binaryPath = join(
  __dirname,
  '../../simulation-engine/target/release',
  process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine',
)

function waitFor(sup: EngineSupervisor, pred: (s: EngineStatus) => boolean, timeoutMs = 8000) {
  return new Promise<EngineStatus>((resolve, reject) => {
    if (pred(sup.status)) return resolve(sup.status)
    const timer = setTimeout(() => {
      sup.off('status', onStatus)
      reject(new Error(`timed out; last status ${JSON.stringify(sup.status)}`))
    }, timeoutMs)
    const onStatus = (s: EngineStatus) => {
      if (!pred(s)) return
      clearTimeout(timer)
      sup.off('status', onStatus)
      resolve(s)
    }
    sup.on('status', onStatus)
  })
}

let sup: EngineSupervisor | null = null
afterEach(async () => {
  await sup?.stop()
  sup = null
})

describe('EngineSupervisor (real engine binary)', () => {
  it('requires the release engine build', () => {
    expect(existsSync(binaryPath), `run "npm run engine:build" first (${binaryPath})`).toBe(true)
  })

  it('connects, reports engine info and measures latency', async () => {
    sup = new EngineSupervisor({ binaryPath, healthIntervalMs: 200 })
    const revisions: number[] = []
    sup.on('status', (s) => revisions.push(s.revision))
    sup.start()
    const s = await waitFor(sup, (s) => s.state === 'connected' && s.latencyMs !== null)
    // Every emitted status carries a strictly increasing revision.
    expect(revisions.length).toBeGreaterThanOrEqual(2)
    expect(revisions.every((r, i) => i === 0 || r > revisions[i - 1]!)).toBe(true)
    expect(s.protocolVersion).toBe(1)
    expect(s.engineVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(s.threads).toBeGreaterThanOrEqual(1)
    expect(s.latencyMs).toBeGreaterThan(0)
  })

  it('restarts the engine after a crash', async () => {
    sup = new EngineSupervisor({ binaryPath, healthIntervalMs: 200, backoffMs: [50] })
    sup.start()
    await waitFor(sup, (s) => s.state === 'connected')
    const firstPid = sup.pid
    process.kill(firstPid!)
    await waitFor(sup, (s) => s.state === 'restarting')
    const s = await waitFor(sup, (s) => s.state === 'connected')
    expect(s.restarts).toBe(1)
    expect(sup.pid).not.toBe(firstPid)
  })

  it('stops cleanly', async () => {
    sup = new EngineSupervisor({ binaryPath })
    sup.start()
    await waitFor(sup, (s) => s.state === 'connected')
    await sup.stop()
    expect(sup.status.state).toBe('stopped')
    expect(sup.pid).toBeUndefined()
  })

  it('gives up with state "failed" when the binary cannot start', async () => {
    sup = new EngineSupervisor({ binaryPath: join(__dirname, 'no-such-engine.exe'), backoffMs: [10], maxRestarts: 2 })
    sup.start()
    const s = await waitFor(sup, (s) => s.state === 'failed')
    expect(s.lastError).toMatch(/^Engine executable not found: .*no-such-engine\.exe$/)
    expect(s.restarts).toBe(2)
  })
})

describe('describeStartError', () => {
  const err = (code: string, message = `${code} message`) => Object.assign(new Error(message), { code })

  it('explains the common Windows start failures in plain language', () => {
    expect(describeStartError(err('ENOENT'), 'C:\\x\\engine.exe')).toBe('Engine executable not found: C:\\x\\engine.exe')
    expect(describeStartError(err('EPERM'), 'C:\\x\\engine.exe')).toBe(
      'Not allowed to start the engine executable (EPERM): C:\\x\\engine.exe',
    )
    expect(describeStartError(err('EIO', 'disk error'), 'p')).toBe('Engine could not start: disk error')
  })
})
