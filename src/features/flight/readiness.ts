/**
 * What the live flight needs before it can start, and the engine payload built from the assembly.
 *
 * Nothing is invented (derive or ask): everything `readyToFly` lists, plus the two flight conditions no
 * source can state for this build, the ambient altitude (air density, ISA) and the battery cut-off (when the
 * run ends), are the user's entries. While anything is missing there is no payload, only the list.
 * Pure (no React, no IPC); the engine refuses an incomplete request too.
 */
import { create } from 'zustand'
import type { AssemblyDocument, FlightStartInput } from '../../../electron/ipc/contract'
import physics from '../../../database/reference/physics.v1.json'
import { airDensity, isaConstants } from '../../domain/atmosphere'
import { lowestPoint } from '../../domain/collisions'
import { simEnvironment, type SimEnvironment } from '../../domain/environment'
import { vehicleDefinition, type VehicleDefinition } from '../../domain/mass'
import { propulsionDefinition, type PropulsionDefinition, type ReadyLink } from '../../domain/propulsion'
import type { FrameGeometry } from '../../three/frame-geometry'
import { bodyAreas } from '../workshop/aero-input'
import type { AssetBounds } from '../workshop/assembly-ops'
import { linkedComponent, type ComponentIndex } from '../workshop/links'
import { massState } from '../workshop/mass-input'
import { propulsionState } from '../workshop/propulsion-input'

// ---- The user's flight conditions ----------------------------------------------------------------------

export type CutoffType = FlightStartInput['cutoff']['type']

export interface FlightConditions {
  /** Height above sea level, m; sets the air density (ISA, USSA 1976). Null = not entered. */
  ambientAltitudeM: number | null
  /** Air temperature, °C. Null = the standard atmosphere's at that altitude (not a missing value). */
  temperatureC: number | null
  /** The run ends when the pack voltage falls to this, or the charge drawn reaches it. The type is a choice; the value is the user's. */
  cutoffType: CutoffType
  cutoffValue: number | null
}

export const EMPTY_CONDITIONS: FlightConditions = { ambientAltitudeM: null, temperatureC: null, cutoffType: 'voltageV', cutoffValue: null }

interface ConditionsStore extends FlightConditions {
  set(patch: Partial<FlightConditions>): void
}
/** Held for the session (not saved with the project). */
export const useFlightConditions = create<ConditionsStore>((set) => ({ ...EMPTY_CONDITIONS, set: (patch) => set(patch) }))

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
      aero: { cdBody: cd as [number, number, number], areaM2: area },
      environment: env.environment,
      startPositionM: [0, 0, -low],
    },
  }
}

export type FlightGate = { ok: true; input: FlightStartInput } | { ok: false; blockers: FlightBlocker[] }

/** Ready to fly: the build is complete and the conditions are entered. Otherwise everything still open. */
export function flightGate(result: PayloadResult, c: FlightConditions): FlightGate {
  const missing = conditionBlockers(c)
  if (!result.ok) return { ok: false, blockers: [...result.blockers, ...missing] }
  if (missing.length > 0 || c.ambientAltitudeM === null || c.cutoffValue === null) return { ok: false, blockers: missing }
  const { payload } = result
  return {
    ok: true,
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
