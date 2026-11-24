/**
 * What the live flight needs before it can start, and the engine payload built from the assembly.
 *
 * Nothing is invented (derive or ask): everything `readyToFly` lists, plus the two flight conditions no
 * source can state for this build, the ambient altitude (air density, ISA) and the battery cut-off (when the
 * run ends), are the user's entries. While anything is missing there is no payload, only the list.
 * Pure (no React, no IPC); the engine refuses an incomplete request too.
 */
import type { AssemblyDocument, FlightConditionsDoc, FlightStartInput } from '../../../electron/ipc/contract'
import physics from '../../../database/reference/physics.v1.json'
import { airDensity, isaConstants } from '../../domain/atmosphere'
import { lowestPoint } from '../../domain/collisions'
import { simEnvironment, type SimEnvironment } from '../../domain/environment'
import { vehicleDefinition, type VehicleDefinition } from '../../domain/mass'
import { propulsionDefinition, type PropulsionDefinition, type ReadyLink } from '../../domain/propulsion'
import { fitBuildThrustCurve, type BuildThrustCurveFit } from '../../domain/thrust-curve'
import type { FrameGeometry } from '../../three/frame-geometry'
import { bodyAreas } from '../workshop/aero-input'
import type { AssetBounds } from '../workshop/assembly-ops'
import { linkedComponent, type ComponentIndex } from '../workshop/links'
import { massState } from '../workshop/mass-input'
import { propulsionState } from '../workshop/propulsion-input'

// ---- The user's flight conditions ----------------------------------------------------------------------

export type CutoffType = FlightStartInput['cutoff']['type']

/**
 * The user's flight conditions, saved with the project (`assembly.flight`, schema v12). No defaults; null =
 * not entered. (The air density each motor's propeller data was taken at is not here: it belongs to that
 * data, `ReferenceDensity` in src/domain/propulsion.ts, and rides in the propulsion definition per motor.)
 */
export type FlightConditions = FlightConditionsDoc

export const EMPTY_CONDITIONS: FlightConditions = { ambientAltitudeM: null, temperatureC: null, cutoffType: 'voltageV', cutoffValue: null }

/** The project's flight conditions, or nothing entered. */
export const conditionsOf = (doc: AssemblyDocument): FlightConditions => doc.flight ?? EMPTY_CONDITIONS

const ISA = isaConstants(physics)
/** Air density for the user's altitude and temperature (`src/domain/atmosphere.ts`). */
export const airDensityFor = (altitudeM: number, temperatureC: number | null) => airDensity(ISA, altitudeM, temperatureC ?? undefined)

// ---- The checklist -------------------------------------------------------------------------------------

export type FlightLink = ReadyLink | { to: 'flight-field'; elementId: string }
export interface FlightBlocker {
  id: string
  label: string
  detail: string
  link: FlightLink | null
}

/** The flight conditions still missing, each linked to its field on the flight page. */
export function conditionBlockers(c: FlightConditions): FlightBlocker[] {
  const items: FlightBlocker[] = []
  if (c.ambientAltitudeM === null) {
    items.push({ id: 'flight-altitude', label: 'Ambient altitude', detail: 'Sets the air density (standard atmosphere); enter it under Flight setup.', link: { to: 'flight-field', elementId: 'flight-altitude' } })
  }
  if (c.cutoffValue === null) {
    items.push({
      id: 'flight-cutoff',
      label: 'Battery cut-off',
      detail: 'The pack voltage, or the charge drawn, at which the run ends. No source states it for your pack; enter it under Flight setup.',
      link: { to: 'flight-field', elementId: 'flight-cutoff-value' },
    })
  }
  return items
}

// ---- The engine payload --------------------------------------------------------------------------------

/** What the assembly gives the engine; the user's flight conditions are added by `flightGate`. */
export interface EnginePayload {
  vehicle: VehicleDefinition
  propulsion: PropulsionDefinition
  thrustFit: BuildThrustCurveFit | null
  aero: { cdBody: [number, number, number]; areaM2: [number, number, number] }
  environment: SimEnvironment
  /** The vehicle resting on the ground: its lowest point at z = 0. */
  startPositionM: [number, number, number]
}

export type PayloadResult = { ok: true; payload: EnginePayload } | { ok: false; blockers: FlightBlocker[] }

/**
 * The vehicle, propulsion, drag and environment payloads, built from the assembly the way the workshop's
 * drop test and its Ready-to-fly checklist read it (`massState`, `propulsionState`, `simEnvironment`), or
 * the checklist items that are still open.
 */
export function enginePayload(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds): PayloadResult {
  const { mp, motors } = massState(doc, geo, components, assets)
  const propulsion = propulsionState(doc, geo, components)
  if (propulsion.ready.length > 0) return { ok: false, blockers: propulsion.ready }
  const battery = doc.parts.find((p) => p.kind === 'battery')
  const vehicle = vehicleDefinition(mp, motors)
  const definition = propulsionDefinition(propulsion.motors, battery ? linkedComponent(battery, components) : null)
  const cd = doc.bodyDrag?.cd
  const env = simEnvironment(doc.environment)
  const area = bodyAreas(doc, geo, components, assets).area
  if (!vehicle || !definition || !cd || cd.some((v) => v === null) || !env.ok || area.some((a) => !(a > 0))) {
    // `readyToFly` is empty, so this cannot happen for a consistent assembly; refuse rather than guess.
    return { ok: false, blockers: [{ id: 'incomplete', label: 'The build is not complete', detail: 'The engine payload could not be built from this assembly.', link: null }] }
  }
  const low = lowestPoint(vehicle.parts.map((p) => ({ shape: p.shape, ...p.pose })))
  return {
    ok: true,
    payload: {
      vehicle,
      propulsion: definition,
      // Fixed sea-level ISA reference from the 4.9 baseline (scenarios.spec.ts:104).
      thrustFit: fitBuildThrustCurve(propulsion.motors, definition.battery, airDensityFor(0, null)),
      aero: { cdBody: cd as [number, number, number], areaM2: area },
      environment: env.environment,
      startPositionM: [0, 0, -low],
    },
  }
}

export type FlightGate = { ok: true; input: FlightStartInput; thrustFit: BuildThrustCurveFit | null } | { ok: false; blockers: FlightBlocker[] }

/** Ready to fly: the build is complete and the conditions are entered. Otherwise everything still open. */
export function flightGate(result: PayloadResult, c: FlightConditions): FlightGate {
  const missing = conditionBlockers(c)
  if (!result.ok) return { ok: false, blockers: [...result.blockers, ...missing] }
  if (missing.length > 0 || c.ambientAltitudeM === null || c.cutoffValue === null) return { ok: false, blockers: missing }
  const { payload } = result
  return {
    ok: true,
    thrustFit: payload.thrustFit,
    input: {
      vehicle: payload.vehicle,
      propulsion: payload.propulsion,
      aero: payload.aero,
      environment: payload.environment,
      airDensityKgM3: airDensityFor(c.ambientAltitudeM, c.temperatureC),
      cutoff: { type: c.cutoffType, value: c.cutoffValue },
      startPositionM: payload.startPositionM,
    },
  }
}
