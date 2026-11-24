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
import { simGroundEffect, type MissingValue, type SimEnvironment, type SimFlightEnvironment } from '../../domain/environment'
import { vehicleDefinition, type VehicleDefinition } from '../../domain/mass'
import { propulsionDefinition, type PropulsionDefinition, type ReadyLink } from '../../domain/propulsion'
import { fitBuildThrustCurve, type BuildThrustCurveFit } from '../../domain/thrust-curve'
import { simWind } from '../../domain/wind'
import type { FrameGeometry } from '../../three/frame-geometry'
import { bodyAreas } from '../workshop/aero-input'
import type { AssetBounds } from '../workshop/assembly-ops'
import { linkedComponent, type ComponentIndex } from '../workshop/links'
import { massState } from '../workshop/mass-input'
import { motorSlots, propulsionState } from '../workshop/propulsion-input'
import { startEnvironment } from '../workshop/environment/start-environment'
import type { GridRead } from '../workshop/environment/terrain-preview'

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
export interface EnginePayload extends SimFlightEnvironment {
  vehicle: VehicleDefinition
  propulsion: PropulsionDefinition
  thrustFit: BuildThrustCurveFit | null
  aero: { cdBody: [number, number, number]; areaM2: [number, number, number] }
  environment: SimEnvironment
  /** The lowest point of the vehicle starts at the surface height under the start XY. */
  startPositionM: [number, number, number]
}

export type PayloadResult = { ok: true; payload: EnginePayload } | { ok: false; blockers: FlightBlocker[] }

function surfaceBlocker({ field, message }: MissingValue): FlightBlocker {
  const obstacle = field.match(/^obstacles\[(\d+)\]\.(\w+)$/)
  const id = obstacle ? `obstacle-${Number(obstacle[1]) + 1}-${obstacle[2]}` : field === 'terrain.assetId' ? 'terrain-grid' : field.replace('.', '-')
  const surface = obstacle ? `Obstacle ${Number(obstacle[1]) + 1}` : field.startsWith('terrain.') ? 'Terrain' : 'Ground'
  const coefficient = field.match(/\.(friction|restitution)$/)?.[1]
  const label = coefficient ? `${surface} ${coefficient} coefficient` : surface
  return { id, label, detail: message, link: { to: 'environment', elementId: id } }
}

const environmentControls: Record<string, string> = {
  wind: 'wind-setting',
  'wind.fromDeg': 'wind-from',
  'wind.mean': 'wind-mean',
  'wind.mean.speedMps': 'wind-speed',
  'wind.mean.speedAt20FtMps': 'wind-speed-20ft',
  'wind.mean.roughness': 'wind-roughness',
  'wind.mean.roughness.lengthM': 'wind-roughness-length',
  'wind.gust': 'wind-gust',
  'wind.gust.amplitudeMps': 'wind-gust-amplitude',
  'wind.gust.lengthM': 'wind-gust-length',
  'wind.gust.startS': 'wind-gust-start',
  groundEffect: 'ground-effect',
}

/** Flight and scenarios supply the loaded terrain state. The step-test caller keeps its existing readiness. */
export function enginePayload(
  doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds,
  environmentInput?: { terrain?: GridRead },
): PayloadResult {
  const { mp, motors } = massState(doc, geo, components, assets)
  const propulsion = propulsionState(doc, geo, components)
  const blockers: FlightBlocker[] = environmentInput
    ? propulsion.ready.filter(({ link }) => link?.to !== 'environment')
    : propulsion.ready
  const env = startEnvironment(doc.environment, environmentInput && assets, environmentInput?.terrain)
  if (environmentInput && !env.ok) blockers.push(...env.missing.map(surfaceBlocker))

  const wind = simWind(environmentInput ? doc.flight?.wind : undefined)
  const setting = environmentInput ? doc.flight?.groundEffect : undefined
  const groundEffect = simGroundEffect(setting, setting === true ? motorSlots(doc, geo, components) : [])
  for (const missing of [wind, groundEffect]) {
    if (missing.ok) continue
    for (const { field, message } of missing.missing) {
      const elementId = environmentControls[field]
      blockers.push({
        id: elementId ?? field,
        label: field.startsWith('wind') ? 'Wind' : 'Ground effect',
        detail: message,
        link: elementId ? { to: 'flight-field', elementId } : null,
      })
    }
  }
  if (blockers.length || !wind.ok || !groundEffect.ok) return { ok: false, blockers }
  const battery = doc.parts.find((p) => p.kind === 'battery')
  const vehicle = vehicleDefinition(mp, motors)
  const definition = propulsionDefinition(propulsion.motors, battery ? linkedComponent(battery, components) : null)
  const cd = doc.bodyDrag?.cd
  const area = bodyAreas(doc, geo, components, assets).area
  if (!vehicle || !definition || !cd || cd.some((v) => v === null) || !env.ok || area.some((a) => !(a > 0))) {
    // `readyToFly` is empty, so this cannot happen for a consistent assembly; refuse rather than guess.
    return { ok: false, blockers: [{ id: 'incomplete', label: 'The build is not complete', detail: 'The engine payload could not be built from this assembly.', link: null }] }
  }
  const low = lowestPoint(vehicle.parts.map((p) => ({ shape: p.shape, ...p.pose })))
  const { surfaceHeightM } = env
  return {
    ok: true,
    payload: {
      vehicle,
      propulsion: definition,
      // Fixed sea-level ISA reference from the 4.9 baseline (scenarios.spec.ts:104).
      thrustFit: fitBuildThrustCurve(propulsion.motors, definition.battery, airDensityFor(0, null)),
      aero: { cdBody: cd as [number, number, number], areaM2: area },
      environment: env.environment,
      ...(wind.wind === undefined ? {} : { wind: wind.wind }),
      ...(groundEffect.radiiM === undefined ? {} : { groundEffect: groundEffect.radiiM }),
      startPositionM: [0, 0, surfaceHeightM === 0 ? -low : surfaceHeightM - low],
    },
  }
}

export type FlightGate = { ok: true; input: FlightStartInput & Pick<EnginePayload, 'environment'>; thrustFit: BuildThrustCurveFit | null } | { ok: false; blockers: FlightBlocker[] }

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
      ...(payload.wind === undefined ? {} : { wind: payload.wind }),
      ...(payload.groundEffect === undefined ? {} : { groundEffect: payload.groundEffect }),
      airDensityKgM3: airDensityFor(c.ambientAltitudeM, c.temperatureC),
      cutoff: { type: c.cutoffType, value: c.cutoffValue },
      startPositionM: payload.startPositionM,
    },
  }
}
