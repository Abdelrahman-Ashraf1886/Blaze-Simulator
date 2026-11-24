/**
 * The built-in scenarios of the scenarios page (4.9 part B): what each one tests, the parameter the user must
 * enter for it (and nothing else: no defaults), and the engine request built from the build and the flight
 * conditions. Pure (no React, no IPC); the engine refuses an incomplete or invalid request too.
 */
import type { ScenarioRunInput } from '../../../electron/ipc/contract'
import type { TuningOverrides } from '../../domain/controller-params'
import { thrustFactor } from '../../domain/thrust-curve'
import type { BuiltinScenarioName } from '../../../electron/main/engine/protocol'
import type { FlightGate, FlightLink, PayloadResult } from '../flight/readiness'

/** What the user enters for a scenario. null = not entered. SI (kg, m); the page converts from g and mm. */
export interface ScenarioEntries {
  payloadMassKg: number | null
  comOffsetM: number | null
}
export const NO_ENTRIES: ScenarioEntries = { payloadMassKg: null, comOffsetM: null }

export interface BuiltinInfo {
  name: BuiltinScenarioName
  title: string
  /** Plain wording of what it tests; the numbers (tolerances, durations) are the engine's, shown with the result. */
  tests: string
  /** The entry this scenario needs, if any; every other value is derived from the build. */
  entry: 'payloadMassKg' | 'comOffsetM' | null
  /** True when the scenario passes by showing the failure it predicts (so a pass is not a flight that holds). */
  expectsFailure: boolean
  projectInput?: 'meanWind' | 'gust' | 'terrain'
}

export const BUILTINS: readonly BuiltinInfo[] = [
  {
    name: 'balanced_hover',
    title: 'Balanced hover',
    tests:
      'The controller holds a level hover at the build’s own height. Near the end of the run the altitude and tilt must be inside their tolerances, the motor commands must not stay at their limits, and the mean throttle must match the hover throttle predicted from the motor and battery data.',
    entry: null,
    expectsFailure: false,
  },
  {
    name: 'payload',
    title: 'Added payload',
    tests:
      'A mass you enter is added at the centre of mass. The controller is not told about it, so its altitude loop has to find the higher hover throttle itself. The same hover checks apply, against the throttle predicted for the heavier build.',
    entry: 'payloadMassKg',
    expectsFailure: false,
  },
  {
    name: 'overweight_payload',
    title: 'Too heavy to climb',
    tests:
      'A mass is added so that the weight is twice the most thrust the motors can give. With every motor at the controller’s maximum throttle the vehicle must not climb. The mass is derived from this build’s motors and battery.',
    entry: null,
    expectsFailure: true,
  },
  {
    name: 'com_offset',
    title: 'Centre of mass off-centre',
    tests:
      'The centre of mass is moved forward by the distance you enter. The controller must still hold a level hover, the motors must share thrust as the moment balance predicts, and the rate controller’s trim must match the prediction.',
    entry: 'comOffsetM',
    expectsFailure: false,
  },
  {
    name: 'com_offset_beyond_authority',
    title: 'Centre of mass out of reach',
    tests:
      'The centre of mass is moved past the outermost motors, further than the pitch controller can trim, so no positive motor thrust can balance it. The distance is derived from this build’s geometry and the controller’s limits. The motors must saturate and the vehicle must tilt past the loss-of-attitude limit.',
    entry: null,
    expectsFailure: true,
  },
  {
    name: 'wind_hold', title: 'Wind hold', entry: null, expectsFailure: false, projectInput: 'meanWind',
    tests: 'Centred Position sticks hold in the saved mean wind in free space. The engine compares settled tilt with the body-drag force balance and checks the position error.',
  },
  {
    name: 'gust', title: 'Gust recovery', entry: null, expectsFailure: false, projectInput: 'gust',
    tests: 'Centred Position sticks hold in free space for 10 s, then the saved gust clock starts. The report shows peak displacement and the time to recover after the gust reaches full strength.',
  },
  {
    name: 'takeoff_hold_land', title: 'Takeoff, hold and land', entry: null, expectsFailure: false,
    tests: 'The PX4 modes take off from a ground plane, hold, and land. The engine checks state order, hold error and pre-contact vertical speed.',
  },
  {
    name: 'terrain', title: 'Takeoff and land on terrain', entry: null, expectsFailure: false, projectInput: 'terrain',
    tests: 'The same sequence runs on the saved terrain grid at the project’s flight start clearance. Heights are relative to where the run started.',
  },
]

export const PROJECT_INPUTS = {
  meanWind: { label: 'Mean wind', link: { to: 'flight-field', elementId: 'wind-setting' } },
  gust: { label: 'Gust', link: { to: 'flight-field', elementId: 'wind-gust' } },
  terrain: { label: 'Terrain grid', link: { to: 'environment', elementId: 'terrain-grid' } },
} satisfies Record<NonNullable<BuiltinInfo['projectInput']>, { label: string; link: FlightLink }>

function hasProjectInput(info: BuiltinInfo, input: Pick<Extract<PayloadResult, { ok: true }>['payload'], 'wind' | 'environment'>) {
  switch (info.projectInput) {
    case 'meanWind': return !!input.wind?.mean
    case 'gust': return !!input.wind?.gust
    case 'terrain': return !!input.environment.terrain
    default: return true
  }
}

export function missingProjectInput(info: BuiltinInfo, payload: PayloadResult): string | null {
  if (!info.projectInput || !payload.ok || hasProjectInput(info, payload.payload)) return null
  return `Save a project setting for ${PROJECT_INPUTS[info.projectInput].label.toLowerCase()} to run this scenario.`
}

/** What a scenario still needs from the user before it can run, or null. */
export function missingEntry(info: BuiltinInfo, entries: ScenarioEntries): string | null {
  if (info.entry === 'payloadMassKg' && entries.payloadMassKg === null) return 'Enter the payload mass to run this scenario.'
  if (info.entry === 'comOffsetM' && entries.comOffsetM === null) return 'Enter the centre-of-mass offset to run this scenario.'
  return null
}

/**
 * The engine request for one built-in, from the flight gate (the build and the flight conditions: air density
 * and cut-off) and the user's entries. Null while the build or the conditions are not ready, or an entry is missing.
 * The baseline uses the PX4 gains with the build's effective thrust factor.
 */
export function scenarioRunInput(gate: FlightGate, info: BuiltinInfo, entries: ScenarioEntries, saved?: TuningOverrides): ScenarioRunInput | null {
  if (!gate.ok || missingEntry(info, entries) || !hasProjectInput(info, gate.input)) return null
  return scenarioRequest(gate, {
    type: 'builtin',
    name: info.name,
    ...(info.entry === 'payloadMassKg' ? { massKg: entries.payloadMassKg! } : {}),
    ...(info.entry === 'comOffsetM' ? { offsetM: entries.comOffsetM! } : {}),
  }, info.name === 'terrain' ? 'saved-environment' : 'free-space', saved)
}

/** Keep a scenario's existing start type. The host needs both the environment and start for surface runs. */
export function scenarioRequest(
  gate: FlightGate, scenario: ScenarioRunInput['scenario'], start: 'free-space' | 'saved-environment', saved?: TuningOverrides,
): ScenarioRunInput | null {
  if (!gate.ok) return null
  const { vehicle, propulsion, aero, airDensityKgM3, cutoff, wind, groundEffect, environment, startPositionM, startClearanceM } = gate.input
  const { terrain, ...surface } = environment
  const geometry: ScenarioRunInput['config']['environment'] = start === 'saved-environment'
    ? { ...surface, ...(terrain && { terrain: { ...terrain, cornerM: [...terrain.cornerM] } }) }
    : undefined
  return {
    vehicle,
    propulsion,
    aero,
    scenario,
    config: {
      airDensityKgM3, cutoff, thrustModelFactor: thrustFactor(gate.thrustFit, saved),
      ...(wind === undefined ? {} : { wind }),
      ...(groundEffect === undefined ? {} : { groundEffect }),
      ...(geometry ? { environment: geometry, startPositionM, ...(startClearanceM === undefined ? {} : { startClearanceM }) } : {}),
    },
  }
}
