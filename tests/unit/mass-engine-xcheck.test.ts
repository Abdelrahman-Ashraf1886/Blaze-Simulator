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

/**
 * 4.6 end to end: a mass.ts vehicle with a propulsion definition and body drag
 * flies its throttles in the real engine. The motor values are the test motor of
 * engine-core `flight/tests.rs` (not a catalogue part); the air density is the
 * ISA value from the cited reference data.
 */
it('flies throttles through the supervisor: motor and battery readings, ISA density for the drag', async () => {
  const { readFileSync } = await import('node:fs')
  const { airDensity, isaConstants } = await import('../../src/domain/atmosphere')
  const rho = airDensity(isaConstants(JSON.parse(readFileSync(join(__dirname, '../../database/reference/physics.v1.json'), 'utf8'))), 500)
  // The motor data is taken to be from the flight's own density here, so the coefficients stay as stated.
  const def = quad(0, 0)
  const motor = (partId: string) => ({ partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: rho })
  const propulsion = { version: 1 as const, motors: def.motors.map((m) => motor(m.partId)), battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 } }
  const aero = { cdBody: [1.1, 1.1, 1.2] as Vec3, areaM2: [0.02, 0.02, 0.05] as Vec3 }
  const loaded = await sup.loadVehicle(def, { propulsion, aero })
  expect(loaded.valid).toBe(true)
  const run = await sup.runSim({ environment: FREE, durationS: 0.5, throttle: [0.7, 0.7, 0.7, 0.7], airDensityKgM3: rho })
  expect(run.motors!.map((m) => m.partId)).toEqual(def.motors.map((m) => m.partId))
  for (const m of run.motors!) {
    const w = (m.rpm * Math.PI) / 30
    expect(Math.abs(m.thrustN - 2e-5 * w * w)).toBeLessThan(1e-9 * m.thrustN)
  }
  // Equal thrust climbs; with the CoM aft of the motor centre (the GPS sits at x = −40 mm),
  // r × F pitches the nose up (−y in FLU), with no roll (everything is on y = 0).
  // Nothing holds it level until the controller (4.7).
  expect(def.com[0]).toBeLessThan(0)
  expect(run.state.linearVelocityMps[2]).toBeGreaterThan(0)
  expect(run.state.angularVelocityBodyRadps[1]).toBeLessThan(0)
  expect(Math.abs(run.state.angularVelocityBodyRadps[0])).toBeLessThan(1e-9)
  const b = run.battery!
  expect(Math.abs(b.voltageV - (10 - 0.01 * b.currentA))).toBeLessThan(1e-9)
  expect(b.stateOfCharge).toBeLessThan(1)
  // Drag without the density is refused.
  await expect(sup.runSim({ environment: FREE, durationS: 0.1, throttle: [0.7, 0.7, 0.7, 0.7] })).rejects.toThrow(/air density/)
}, 20_000)

/**
 * 4.7 end to end: the PX4 controller in the engine holds the same quad level at 1 m. Its CoM is
 * aft of the motor centre (the 30 g GPS at x = −40 mm moves it ≈1.4 mm), which pitched it nose-up
 * at fixed throttle. The controller never sees the CoM: the pitch rate integrator holds the trim.
 */
it('the controller holds the offset-CoM quad level at the altitude setpoint', async () => {
  const def = quad(0, 0)
  const motor = (partId: string) => ({ partId, kvRadPerSV: 100, resistanceOhm: 0.1, noLoadCurrentA: 0.5, thrustCoefNs2: 2e-5, torqueCoefNms2: 1e-7, inertiaKgM2: 2e-5, referenceDensityKgM3: 1.225 })
  const propulsion = { version: 1 as const, motors: def.motors.map((m) => motor(m.partId)), battery: { openCircuitVoltageV: 10, internalResistanceOhm: 0.01, capacityC: 18720 } }
  expect((await sup.loadVehicle(def, { propulsion })).valid).toBe(true)
  const run = await sup.runSim({ environment: FREE, durationS: 10, controller: { altitudeM: 1 }, airDensityKgM3: 1.225 })
  expect(Math.abs(run.state.comM[2] - 1)).toBeLessThan(0.01)
  const tilt = 2 * Math.acos(Math.min(1, Math.abs(run.state.quaternion[3])))
  expect(tilt).toBeLessThan((0.1 * Math.PI) / 180)
  expect(def.com[0]).toBeLessThan(0)
  expect(Math.abs(run.controller!.rateIntegral[1])).toBeGreaterThan(1e-3)
  await expect(sup.runSim({ environment: FREE, durationS: 0.1, controller: { gains: { MC_NOPE: 1 } }, airDensityKgM3: 1.225 })).rejects.toThrow(/unknown PX4 parameter/)
}, 20_000)
