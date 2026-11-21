/**
 * The propulsion definition built from the seed (src/domain/propulsion.ts) reaches
 * the real engine through `vehicle.load` (additive `propulsion` field, 4.5).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { Component, QuantityValue } from '../../electron/ipc/component-fields'
import type { PropulsionDefinition as EngineDef } from '../../electron/main/engine/protocol'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import { massProperties, vehicleDefinition, type BodyInput, type MotorInput } from '../../src/domain/mass'
import { analyseMotor, propulsionDefinition, type MotorSlot, type PropulsionDefinition } from '../../src/domain/propulsion'

// Type-level: the domain's definition and the engine's zod type are assignable both ways.
const toEngine = (v: PropulsionDefinition): EngineDef => v
const fromEngine = (v: EngineDef): PropulsionDefinition => v
void toEngine
void fromEngine

const binaryPath = join(__dirname, '../../simulation-engine/target/release', process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine')
const sup = new EngineSupervisor({ binaryPath })
afterAll(() => sup.stop())

const seed = JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: Component[] }
const named = (name: string) => seed.components.find((c) => c.name === name)!
const withSpec = (c: Component, key: string, spec: QuantityValue): Component => ({ ...c, specs: { ...c.specs, [key]: spec } })

it('a seed quad with the missing values entered loads with its propulsion in the engine', async () => {
  // Values a user would enter (measured): no source states them.
  const motor = withSpec(named('MN3110 KV470'), 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured' })
  const battery = withSpec(named('Tattu G-Tech 5200mAh 4S 35C'), 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured' })
  const prop = named('P13*4.4 CF propeller')

  const bodies: BodyInput[] = [
    { id: 'frame:plate', name: 'plate', massKg: 0.5, model: 'solid', shape: { type: 'box', halfExtents: [0.1, 0.1, 0.01] }, position: [0, 0, 0.01], quaternion: [0, 0, 0, 1] },
  ]
  const motors: MotorInput[] = [0, 1, 2, 3].map((k) => {
    const a = Math.PI / 4 + (k * Math.PI) / 2
    return { partId: `motor-${k + 1}`, name: 'm', position: [0.25 * Math.cos(a), 0.25 * Math.sin(a), 0.05], thrustAxis: [0, 0, 1], spin: k % 2 ? 'cw' : 'ccw' }
  })
  const vehicle = vehicleDefinition(massProperties(bodies), motors)!
  const slots: MotorSlot[] = motors.map((m) => ({
    partId: m.partId,
    name: m.partId,
    motor: { partId: m.partId, name: m.partId, component: motor },
    prop: { partId: `p-${m.partId}`, name: 'prop', component: prop },
  }))
  const propulsion = propulsionDefinition(slots.map(analyseMotor), battery)!
  expect(propulsion).not.toBeNull()

  sup.start()
  await new Promise<void>((r) => {
    const f = () => {
      if (sup.status.state === 'connected') {
        sup.off('status', f)
        r()
      }
    }
    sup.on('status', f)
    f()
  })
  const ok = await sup.loadVehicle(vehicle, propulsion)
  expect(ok.valid ? ok.propulsion : ok.errors).toEqual({ motorCount: 4 })

  // Without propulsion the 4.3 result is unchanged.
  const plain = await sup.loadVehicle(vehicle)
  expect(plain.valid && plain.propulsion).toBeUndefined()

  // A motor the vehicle does not have is refused by the engine.
  const wrong = { ...propulsion, motors: propulsion.motors.map((m, i) => (i === 0 ? { ...m, partId: 'nope' } : m)) }
  const bad = await sup.loadVehicle(vehicle, wrong)
  expect(bad.valid ? [] : bad.errors.map((e) => e.path)).toEqual(['propulsion.motors[0].partId', 'propulsion.motors'])
})
