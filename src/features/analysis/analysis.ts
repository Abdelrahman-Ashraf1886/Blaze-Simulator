/**
 * Everything the Engineering Analysis page shows, derived from the saved assembly by the functions the
 * workshop, the electrical designer and the flight page already use. Nothing is calculated here: each field
 * is the result of one of those functions (named in its comment); this file only wires them together the way
 * the flight page does, so the page and its sources cannot disagree. Pure (no React, no IPC).
 */
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { runChecks, type Finding } from '../../domain/checks'
import { calculate, DEFAULT_LOAD_CASE, type ElectricalResult, type LoadCase } from '../../domain/electrical'
import { horizontalOffset, massFindings, principalAxes, type Vec3 } from '../../domain/mass'
import type { ReferenceDensity, ReadyItem } from '../../domain/propulsion'
import { wiringFindings, escOfMotor } from '../../domain/wiring'
import type { FrameGeometry } from '../../three/frame-geometry'
import { checkInput } from '../workshop/check-input'
import type { AssetBounds } from '../workshop/assembly-ops'
import type { ComponentIndex } from '../workshop/links'
import { massState, type MassState } from '../workshop/mass-input'
import { wiringParts } from '../workshop/wiring-input'
import { assemblyThrust, type Indicator, type MaxThrust } from '../flight/indicators'
import { conditionBlockers, conditionsOf, type FlightBlocker, type FlightConditions } from '../flight/readiness'

export interface MotorDensity {
  partId: string
  name: string
  /** `PairFit.referenceDensity`: the density the motor's thrust data was taken at, and where that comes from. */
  density: ReferenceDensity | null
}

export interface Analysis {
  /** `massState`: mass properties, motor thrust points and hover balance, as the workshop's Mass panel. */
  mass: MassState
  /** `horizontalOffset(com)`, metres; null while the CoM is unknown. */
  comOffsetM: number | null
  /** `massFindings` (the workshop adds them once the build has a part). */
  hoverFindings: Finding[]
  /** The user's hover-share margin the findings were judged with, in percent. */
  tolerancePct: number
  conditions: FlightConditions
  /** `airDensityFor`: null until the ambient altitude is entered. */
  airDensityKgM3: number | null
  /** `thrustIndicator`: the flight page's maximum T/W (4.5 solver, pack sag, air density of the flight). */
  thrust: Indicator
  /** `maxThrust`: the numbers behind the indicator (per motor, pack, total, T/W); null while the indicator is unknown. */
  maxThrust: MaxThrust | null
  /** `principalAxes` of the inertia tensor; null with the inertia. */
  principal: ReturnType<typeof principalAxes> | null
  motorDensities: MotorDensity[]
  /** `calculate` with the Electrical Designer's starting load case. */
  loadCase: LoadCase
  electrical: ElectricalResult
  /** `wiringFindings`: the electrical checks. */
  wiringFindings: Finding[]
  /** `runChecks`: the assembly checks the workshop's Checks panel lists. */
  assemblyFindings: Finding[]
  /** `readyToFly`: what the build still lacks before it can fly. */
  ready: ReadyItem[]
  /** `conditionBlockers`: the flight conditions still to enter. */
  conditionBlockers: FlightBlocker[]
}

export function analyse(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds, tolerancePct: number): Analysis {
  const mass = massState(doc, geo, components, assets)
  const { mp, motors, hover } = mass
  const conditions = conditionsOf(doc)
  const { indicator: thrust, numbers: maxThrustNumbers, propulsion, air: airDensityKgM3 } = assemblyThrust(doc, geo, components, mass, conditions)
  const parts = wiringParts(doc, geo, components)
  const wires = doc.wires ?? []
  return {
    mass,
    comOffsetM: mp.com ? horizontalOffset(mp.com as Vec3) : null,
    hoverFindings: doc.parts.length > 0 ? massFindings(mp, motors, hover, tolerancePct) : [],
    tolerancePct,
    conditions,
    airDensityKgM3,
    thrust,
    maxThrust: maxThrustNumbers,
    principal: mp.inertia ? principalAxes(mp.inertia) : null,
    motorDensities: propulsion.motors.map((m) => ({ partId: m.slot.partId, name: m.slot.name, density: m.fit?.referenceDensity ?? null })),
    loadCase: DEFAULT_LOAD_CASE,
    electrical: calculate(parts, wires, DEFAULT_LOAD_CASE),
    wiringFindings: wiringFindings(parts, wires),
    assemblyFindings: runChecks({ ...checkInput(doc, geo, components), escOfMotor: escOfMotor(parts, wires) }),
    ready: propulsion.ready,
    conditionBlockers: conditionBlockers(conditions),
  }
}
