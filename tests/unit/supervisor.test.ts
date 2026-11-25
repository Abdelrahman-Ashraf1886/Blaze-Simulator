import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineStatus } from '../../electron/ipc/contract'
import type { SimRunParams, VehicleDefinition } from '../../electron/main/engine/protocol'
import { EngineSupervisor, describeStartError } from '../../electron/main/engine/supervisor'
import { dropTest } from '../../electron/main/engine/drop-test'
import { lowestPoint } from '../../src/domain/collisions'
import { simEnvironment } from '../../src/domain/environment'

/** Free space, stated (sim.run has no default environment). */
const FREE = { ground: null, obstacles: [] }

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
    expect(s.protocolVersion).toBe(2)
    expect(s.engineVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(s.threads).toBeGreaterThanOrEqual(1)
    expect(s.latencyMs).toBeGreaterThan(0)
  })


  it('requests sent while the engine is dying fail on their own, not as an uncaught pipe error', async () => {
    const uncaught: Error[] = []
    const onUncaught = (e: Error) => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      sup = new EngineSupervisor({ binaryPath, backoffMs: [50] })
      sup.start()
      // Several deaths: the write has to fall between the process ending and its 'exit' event.
      for (let death = 0; death < 3; death++) {
        await waitFor(sup, (s) => s.state === 'connected')
        process.kill(sup.pid!)
        const requests: Promise<unknown>[] = []
        while (sup.status.state === 'connected') {
          requests.push(sup.ping().catch((e: Error) => e))
          await new Promise((r) => setImmediate(r))
        }
        for (const outcome of await Promise.all(requests)) expect(outcome).toBeDefined()
      }
      await waitFor(sup, (s) => s.state === 'connected')
      await new Promise((r) => setTimeout(r, 50)) // let a late pipe error surface
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  }, 20_000)

  it('refuses requests while it is stopping', async () => {
    sup = new EngineSupervisor({ binaryPath })
    sup.start()
    await waitFor(sup, (s) => s.state === 'connected')
    const stopped = sup.stop()
    await expect(sup.ping()).rejects.toThrow('engine is stopping')
    await stopped
    expect(sup.status.state).toBe('stopped')
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

/** Two parts; totals worked by hand in engine-core's `two_part_totals_match_hand_calculation`. */
function twoPartVehicle(): VehicleDefinition {
  return {
    version: 1,
    parts: [
      {
        partId: 'a',
        massKg: 1,
        com: [0.1, 0, 0],
        inertia: [0.001, 0.002, 0.003, 0, 0, 0],
        pose: { position: [0.1, 0, 0], quaternion: [0, 0, 0, 1] },
        shape: { type: 'box', halfExtents: [0.05, 0.03, 0.02] },
      },
      {
        partId: 'b',
        massKg: 3,
        com: [-0.1, 0, 0.05],
        inertia: [0.004, 0.005, 0.006, 0, 0, 0],
        pose: { position: [-0.1, 0, 0.05], quaternion: [0, 0, 0, 1] },
        shape: { type: 'cylinder', radius: 0.02, halfHeight: 0.04 },
      },
    ],
    motors: [{ partId: 'm1', position: [0.1, 0.1, 0.03], thrustAxis: [0, 0, 1], spin: 'ccw' }],
    totalMassKg: 4,
    com: [-0.05, 0, 0.0375],
    inertia: [0.006875, 0.038875, 0.039, 0, 0.0075, 0],
    missingMass: [],
  }
}

describe('EngineSupervisor protocol v2 (real engine binary)', () => {
  async function connected() {
    const s = new EngineSupervisor({ binaryPath })
    sup = s
    s.start()
    await waitFor(s, (st) => st.state === 'connected')
    return s
  }

  it('loads a vehicle and returns the recomputed totals', async () => {
    const s = await connected()
    const r = await s.loadVehicle(twoPartVehicle())
    expect(r.valid).toBe(true)
    if (!r.valid) return
    expect(r.partCount).toBe(2)
    expect(r.motorCount).toBe(1)
    expect(r.totals.massKg).toBe(4)
    expect(r.totals.com[0]).toBeCloseTo(-0.05, 15)
    expect(r.totals.inertia[4]).toBeCloseTo(0.0075, 15)
  })

  it('returns every validation error instead of loading a bad vehicle', async () => {
    const s = await connected()
    const v = twoPartVehicle()
    v.parts[0]!.massKg = -1
    v.motors[0]!.thrustAxis = [0, 0, 2]
    const r = await s.loadVehicle(v)
    expect(r.valid).toBe(false)
    if (r.valid) return
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['parts[0].massKg', 'motors[0].thrustAxis']))
    await expect(s.runSim({ environment: FREE, durationS: 1 })).rejects.toThrow(/^NO_VEHICLE/)
  })

  it('runs free fall: v = −g·t, z within the symplectic-Euler bound ½·g·t·(dt/4)', async () => {
    const s = await connected()
    await s.loadVehicle(twoPartVehicle())
    const g = 9.80665
    const r = await s.runSim({ environment: FREE, durationS: 1 })
    expect(r.steps).toBe(1000)
    expect(r.gravityMps2).toBe(g)
    expect(Math.abs(r.state.linearVelocityMps[2] + g)).toBeLessThan(1e-12)
    const dz = r.state.comM[2] - 0.0375
    expect(Math.abs(dz + 0.5 * g)).toBeLessThanOrEqual(0.5 * g * 0.25e-3 * (1 + 1e-9))
    // Deterministic: the same run gives the same hash.
    const again = await s.runSim({ environment: FREE, durationS: 1 })
    expect(again.stateHash).toBe(r.stateHash)
    // A body-frame force of m·g along +Z hovers.
    const hover = await s.runSim({ environment: FREE, durationS: 0.5, forceBodyN: [0, 0, 4 * g] })
    expect(Math.abs(hover.state.linearVelocityMps[2])).toBeLessThan(1e-12)
  })

  it('validates requests before sending and reports engine-side refusals', async () => {
    const s = await connected()
    await s.loadVehicle(twoPartVehicle())
    await expect(s.runSim({ environment: FREE, durationS: -1 })).rejects.toThrow(/must be positive/)
    const bad = { ...twoPartVehicle(), version: 2 } as unknown as VehicleDefinition
    await expect(s.loadVehicle(bad)).rejects.toThrow()
    await expect(s.runSim({ environment: FREE, durationS: 1.0005 })).rejects.toThrow(/^INVALID_PARAMS: .*whole number of steps/)
    await s.loadVehicle({ ...twoPartVehicle(), missingMass: ['camera'] })
    await expect(s.runSim({ environment: FREE, durationS: 1 })).rejects.toThrow(/^VEHICLE_INCOMPLETE: 1 part\(s\) have no mass: camera/)
  })

  it('drop test (the workshop IPC): the project environment reaches the engine unchanged; incomplete ones are refused', async () => {
    const s = await connected()
    const incomplete = simEnvironment({ ground: { friction: 0.5, restitution: null }, obstacles: [] })
    expect(incomplete.ok).toBe(false)
    const env = simEnvironment({ ground: { friction: 0.5, restitution: 0 }, obstacles: [] })
    if (!env.ok) throw new Error('complete environment refused')
    const v = twoPartVehicle()
    // Lowest point: part a's box bottom at -20 mm. Released 100 mm above the ground.
    const low = lowestPoint(v.parts.map((p) => ({ shape: p.shape, ...p.pose })))
    expect(low).toBeCloseTo(-0.02, 12)
    const r = await dropTest(s, { vehicle: v, environment: env.environment, startPositionM: [0, 0, 0.1 - low], durationS: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.contacts.length).toBeGreaterThan(0)
    expect(r.data.contacts.every((c) => c.with === 'ground')).toBe(true)
    // An environment with a value missing never reaches the engine.
    const bad = await dropTest(s, { vehicle: v, environment: { ground: { friction: 0.5 }, obstacles: [] }, startPositionM: [0, 0, 0.12], durationS: 1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toMatch(/environment\.ground\.restitution/)
    // Released inside the ground: the engine's refusal comes back with the part named.
    const inside = await dropTest(s, { vehicle: v, environment: env.environment, startPositionM: [0, 0, 0], durationS: 1 })
    expect(inside.ok).toBe(false)
    if (!inside.ok) expect(inside.error.message).toMatch(/^INVALID_PARAMS: .*a is 20\.000 mm inside the ground/)
  })

  it('needs the ground friction and restitution; reports contacts with the ground and obstacles', async () => {
    const s = await connected()
    await s.loadVehicle(twoPartVehicle())
    // No defaults: a missing value is refused here, before it reaches the engine.
    const noRestitution = { environment: { ground: { friction: 0.5 }, obstacles: [] }, durationS: 1 } as unknown as SimRunParams
    await expect(s.runSim(noRestitution)).rejects.toThrow(/restitution/)
    const ground = { ground: { friction: 0.5, restitution: 0 }, obstacles: [] }
    // At the origin part a's box (bottom at −20 mm) starts inside the ground: refused, naming it.
    await expect(s.runSim({ environment: ground, durationS: 1 })).rejects.toThrow(/^INVALID_PARAMS: .*a is 20\.000 mm inside the ground/)
    const r = await s.runSim({ environment: ground, startPositionM: [0, 0, 0.5], durationS: 2 })
    expect(r.contacts.length).toBeGreaterThan(0)
    expect(r.contacts.every((c) => c.with === 'ground' && c.startS > 0.25)).toBe(true)
    expect(r.contacts.some((c) => c.endS === null)).toBe(true)
    expect(r.contactsDropped).toBe(0)
    const table = { ...ground, obstacles: [{ id: 'table', center: [0, 0, 0.1] as [number, number, number], halfExtents: [0.5, 0.5, 0.1] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], friction: 0.6, restitution: 0 }] }
    const onTable = await s.runSim({ environment: table, startPositionM: [0, 0, 0.5], durationS: 1 })
    expect(onTable.contacts.map((c) => c.with)).toContain('obstacle:table')
  })
})
