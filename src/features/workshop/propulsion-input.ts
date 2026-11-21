/**
 * The assembly as the propulsion models (src/domain/propulsion.ts) see it: one slot
 * per motor mount with its motor and propeller parts and their linked components,
 * the battery, and the inputs the Ready-to-fly checklist needs. Pure.
 */
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { analyseMotor, batteryModel, readyToFly, type MotorPropulsion, type MotorSlot, type ReadyInput, type ReadyItem } from '../../domain/propulsion'
import type { FrameGeometry } from '../../three/frame-geometry'
import { linkedComponent, type ComponentIndex } from './links'
import { massState } from './mass-input'

export function motorSlots(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex): MotorSlot[] {
  return geo.motors.map((mount) => {
    const motor = doc.parts.find((p) => p.kind === 'motor' && p.parentId === null && p.mountId === mount.id)
    const prop = motor && doc.parts.find((p) => p.kind === 'propeller' && p.parentId === motor.id)
    return {
      // Same id as the VehicleDefinition's motor (mass-input.ts motorInputs).
      partId: motor?.id ?? mount.id,
      name: `Motor ${mount.number}`,
      motor: motor ? { partId: motor.id, name: motor.name, component: linkedComponent(motor, components) } : null,
      prop: prop ? { partId: prop.id, name: prop.name, component: linkedComponent(prop, components) } : null,
    }
  })
}

export interface PropulsionState {
  motors: MotorPropulsion[]
  ready: ReadyItem[]
}

export function propulsionState(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  components: ComponentIndex,
  ground?: ReadyInput['ground'],
): PropulsionState {
  const slots = motorSlots(doc, geo, components)
  const battery = doc.parts.find((p) => p.kind === 'battery')
  const { mp } = massState(doc, geo, components)
  const input: ReadyInput = {
    frameMassSet: !!doc.frameMass,
    partsWithoutMass: mp.missingMass.filter((m) => !m.id.startsWith('frame')),
    motors: slots,
    battery: battery ? { partId: battery.id, name: battery.name, component: linkedComponent(battery, components) } : null,
    bodyCd: doc.bodyDrag?.value ?? null,
    ...(ground ? { ground } : {}),
  }
  const pack = input.battery?.component ? batteryModel(input.battery.component) : null
  const supply = pack?.ok ? pack.value.openCircuitVoltage : null
  return { motors: slots.map((s) => analyseMotor(s, supply)), ready: readyToFly(input) }
}
