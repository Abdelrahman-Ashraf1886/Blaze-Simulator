import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import type { VehicleDefinition as EngineDef } from '../../electron/main/engine/protocol'
import { massProperties, vehicleDefinition, type BodyInput, type MotorInput, type Quat, type Vec3, type VehicleDefinition } from '../../src/domain/mass'

/** Free space, stated (sim.run has no default environment). */
const FREE = { ground: null, obstacles: [] }

// Type-level: mass.ts's VehicleDefinition must be assignable to the engine's zod type and back.
const toEngine = (v: VehicleDefinition): EngineDef => v
const fromEngine = (v: EngineDef): VehicleDefinition => v
void toEngine; void fromEngine

/**
 * Cross-check (plan 4.1 × 4.3): mass properties computed by `src/domain/mass.ts`
 * load in the real engine, whose rapier-based totals agree to 1e-9 relative.
 */
const binaryPath = join(
  __dirname,
  '../../simulation-engine/target/release',
  process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine',
)
const sup = new EngineSupervisor({ binaryPath })
afterAll(() => sup.stop())

function quatAxisAngle([x, y, z]: Vec3, a: number): Quat {
  const s = Math.sin(a / 2)
  return [x * s, y * s, z * s, Math.cos(a / 2)]
}
function mulQ(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

function quad(tiltDeg: number, batteryX: number) {
  const bodies: BodyInput[] = [
    { id: 'frame:plate', name: 'plate', massKg: 0.12, model: 'solid', shape: { type: 'box', halfExtents: [0.06, 0.06, 0.0015] }, position: [0, 0, 0.0015], quaternion: [0, 0, 0, 1] },
    { id: 'battery', name: 'battery', massKg: 0.52, model: 'solid', shape: { type: 'box', halfExtents: [0.07, 0.0225, 0.0175] }, position: [batteryX, 0, 0.03], quaternion: [0, 0, 0, 1] },
    { id: 'gps', name: 'gps', massKg: 0.03, model: 'solid', shape: { type: 'hull', points: [[-0.02, -0.02, 0], [0.02, -0.02, 0], [0, 0.02, 0], [0, 0, 0.015]] }, position: [-0.04, 0, 0.06], quaternion: [0, 0, 0, 1] },
  ]
  const motors: MotorInput[] = []
  for (let k = 0; k < 4; k++) {
    const yaw = Math.PI / 4 + (k * Math.PI) / 2
    const [cx, cy] = [Math.cos(yaw), Math.sin(yaw)]
    const armQ = quatAxisAngle([0, 0, 1], yaw)
    bodies.push({ id: `frame:arm-${k + 1}`, name: 'arm', massKg: 0.025, model: 'solid', shape: { type: 'box', halfExtents: [0.07, 0.01, 0.002] }, position: [0.09 * cx, 0.09 * cy, 0.002], quaternion: armQ })
    // Motor tilted inward about the arm's tangent axis.
    const tilt = mulQ(quatAxisAngle([-cy, cx, 0], (-tiltDeg * Math.PI) / 180), [0, 0, 0, 1])
    const p: Vec3 = [0.16 * cx, 0.16 * cy, 0.02]
    bodies.push({ id: `motor-${k + 1}`, name: 'motor', massKg: 0.035, model: 'solid', shape: { type: 'cylinder', radius: 0.014, halfHeight: 0.01 }, position: p, quaternion: tilt })
    bodies.push({ id: `prop-${k + 1}`, name: 'prop', massKg: 0.012, model: 'propeller', shape: { type: 'cylinder', radius: 0.127, halfHeight: 0.004 }, position: [p[0], p[1], 0.035], quaternion: tilt })
    const r = tiltDeg * Math.PI / 180
    const axis: Vec3 = [-Math.sin(r) * cx, -Math.sin(r) * cy, Math.cos(r)]
    const n = Math.hypot(...axis)
    motors.push({ partId: `motor-${k + 1}`, name: 'm', position: [p[0], p[1], 0.035], thrustAxis: axis.map((v) => v / n) as Vec3, spin: k % 2 ? 'cw' : 'ccw' })
  }
  return vehicleDefinition(massProperties(bodies), motors)!
}

it('mass.ts output loads in the real engine, and the engine totals agree to 1e-9', async () => {
  sup.start()
  await new Promise<void>((r) => { const f = () => { if (sup.status.state === 'connected') { sup.off('status', f); r() } }; sup.on('status', f); f() })
  for (const [tilt, bx] of [[0, 0], [0, 0.03], [5, 0], [10, 0.012], [-7, -0.02]] as const) {
    const def = quad(tilt, bx)
    const r = await sup.loadVehicle(def)
    const where = `tilt ${tilt}°, battery x ${bx} m`
    expect(r.valid ? [] : r.errors, where).toEqual([])
    if (!r.valid) continue
    expect(Math.abs(r.totals.massKg - def.totalMassKg) / def.totalMassKg, where).toBeLessThan(1e-9)
    const comScale = Math.max(...def.com.map(Math.abs), 0.16)
    r.totals.com.forEach((c, i) => expect(Math.abs(c - def.com[i]!) / comScale, where).toBeLessThan(1e-9))
    const norm = Math.hypot(...def.inertia)
    expect(Math.hypot(...r.totals.inertia.map((v, i) => v - def.inertia[i]!)) / norm, where).toBeLessThan(1e-9)
  }
  // Hover force through the CoM for 1 s: no vertical velocity builds up.
  const run = await sup.runSim({ environment: FREE, durationS: 1, forceBodyN: [0, 0, quad(0, 0).totalMassKg * 9.80665] })
  expect(Math.abs(run.state.linearVelocityMps[2])).toBeLessThan(1e-12)
}, 20_000)
