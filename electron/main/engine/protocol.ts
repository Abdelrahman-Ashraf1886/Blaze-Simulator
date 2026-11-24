/**
 * TypeScript mirror of `simulation-engine/engine-host/src/protocol.rs`.
 * Both sides must change together; bump PROTOCOL_VERSION on breaking changes.
 *
 * v2 adds `vehicle.load` and `sim.run`; 4.4 adds the required `environment`
 * (ground and box obstacles, each with the user's friction and restitution),
 * `startPositionM` and the reported `contacts` to `sim.run`. Everything crossing this boundary is
 * checked with zod: what we send (so a bad request fails here, with a
 * TypeScript-side message) and what the engine answers (a separate process
 * we do not trust blindly).
 */
import { z } from 'zod'

export const PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// VehicleDefinition (pinned in documentation/plans/phase-4-physics.md,
// "Shared interface"; produced by src/domain/mass.ts, validated again in full
// by engine-core/src/vehicle.rs). Body axes per ADR 0003, SI units.

const num = z.number().refine(Number.isFinite, 'must be finite')
const vec3 = z.tuple([num, num, num])
const quat = z.tuple([num, num, num, num]) // x, y, z, w (three.js order)
/** [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] kg·m², tensor sign convention (Ixy = −Σ m·x·y). */
const inertia6 = z.tuple([num, num, num, num, num, num])

export const CollisionShapeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('box'), halfExtents: vec3 }),
  z.strictObject({ type: z.literal('cylinder'), radius: num, halfHeight: num }), // axis = local Z
  z.strictObject({ type: z.literal('hull'), points: z.array(vec3) }),
])

export const PartBodySchema = z.strictObject({
  partId: z.string().min(1),
  massKg: num,
  com: vec3,
  inertia: inertia6,
  pose: z.strictObject({ position: vec3, quaternion: quat }),
  shape: CollisionShapeSchema,
})

export const MotorBodySchema = z.strictObject({
  partId: z.string().min(1),
  position: vec3,
  thrustAxis: vec3,
  spin: z.enum(['cw', 'ccw']),
})

export const VehicleDefinitionSchema = z.strictObject({
  version: z.literal(1),
  parts: z.array(PartBodySchema),
  motors: z.array(MotorBodySchema),
  totalMassKg: num,
  com: vec3,
  inertia: inertia6,
  missingMass: z.array(z.string()),
})
export type VehicleDefinition = z.infer<typeof VehicleDefinitionSchema>

// ---------------------------------------------------------------------------
// PropulsionDefinition (4.5, additive): optional with `vehicle.load`, separate
// from the pinned VehicleDefinition. Built by src/domain/propulsion.ts
// (`propulsionDefinition`), validated again by engine-core/src/propulsion.rs.

const positive = num.refine((v) => v > 0, 'must be positive')
export const PropulsionDefinitionSchema = z.strictObject({
  version: z.literal(1),
  motors: z.array(
    z.strictObject({
      partId: z.string().min(1),
      kvRadPerSV: positive,
      resistanceOhm: positive,
      noLoadCurrentA: num.refine((v) => v >= 0, 'must be ≥ 0'),
      thrustCoefNs2: positive,
      torqueCoefNms2: positive,
      inertiaKgM2: positive,
      /** The air density (kg/m³) the thrust and torque data was measured or computed at; a flight scales both by its own density relative to it. */
      referenceDensityKgM3: positive,
      /** [throttle, effective duty] pairs (an empirical bench ratio); absent = ideal ESC. */
      throttleMap: z.array(z.tuple([num, num])).min(1).optional(),
    }),
  ),
  battery: z.strictObject({ openCircuitVoltageV: positive, internalResistanceOhm: positive, capacityC: positive }),
})
export type PropulsionDefinition = z.infer<typeof PropulsionDefinitionSchema>

/** Body drag (4.5, additive): per-axis C_d (entered) and projected areas (derived, src/domain/aero.ts). */
export const BodyDragSchema = z.strictObject({
  cdBody: z.tuple([positive, positive, positive]),
  areaM2: z.tuple([positive, positive, positive]),
})
export type BodyDrag = z.infer<typeof BodyDragSchema>

// ---------------------------------------------------------------------------
// Commands

/**
 * A surface's friction and restitution: the user's entries (no source states them,
 * so there are no defaults). They are the coefficients of the contact between the
 * vehicle and that surface (engine-core `environment.rs`).
 */
const SurfaceSchema = { friction: num.refine((v) => v >= 0, 'cannot be negative'), restitution: num.refine((v) => v >= 0 && v <= 1, 'must be between 0 and 1') }

/** Ground plane z = 0 (or null: free space) and fixed box obstacles, world frame. */
export const EnvironmentSchema = z.strictObject({
  ground: z.strictObject(SurfaceSchema).nullable(),
  obstacles: z.array(
    z.strictObject({
      id: z.string().min(1),
      center: vec3,
      halfExtents: z.tuple([num, num, num]).refine((h) => h.every((v) => v > 0), 'must all be positive'),
      quaternion: quat,
      ...SurfaceSchema,
    }),
  ),
})
export type Environment = z.infer<typeof EnvironmentSchema>

/**
 * The PX4 controller's setpoint and gain overrides (`sim.run`'s `controller`, and the live flight's
 * setpoint and gains). `altitudeM` is the CoM height (null/absent = hold `climbRateMps`); `attitude` a
 * unit quaternion x y z w (absent = level); `gains` overrides by exact PX4 name, e.g. { MC_ROLL_P: 7 }.
 */
const flightMode = z.enum(['rates', 'stabilized', 'altitude', 'position'])
// FlightModes::step checks the four PX4 axes and the normalized rates collective.
const stickAxis = num.min(-1).max(1)
const controllerSetpointShape = {
  altitudeM: num.nullable().optional(),
  climbRateMps: num.optional(),
  attitude: quat.optional(),
  yawRateRadps: num.optional(),
  mode: flightMode.optional(),
  sticks: z.strictObject({ forward: stickAxis, right: stickAxis, yawRight: stickAxis, throttle: stickAxis }).optional(),
  bodyRadps: vec3.optional(),
  collective: num.min(0).max(1).optional(),
}
const gains = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'use the exact PX4 parameter name'), num).optional()
// database/reference/physics.v1.json:1084-1109 gives the mixer enum and factor bounds.
const mixerShape = {
  airmode: num.int().min(0).max(2).optional(),
  thrustModelFactor: num.min(0).max(1).refine((v): boolean => v === 0, 'must be zero until thrust-model support in milestone 5.9').optional(),
}

const controllerSetpoint = z.strictObject(controllerSetpointShape)
type ControllerSetpoint = z.infer<typeof controllerSetpoint>

function checkControllerSetpoint(c: ControllerSetpoint, ctx: z.RefinementCtx, canInheritMode: boolean) {
  const issue = (field: keyof ControllerSetpoint, message: string) => ctx.addIssue({ code: 'custom', path: [field], message })
  const hasRates = c.bodyRadps !== undefined || c.collective !== undefined
  const hasModeInput = hasRates || c.sticks !== undefined
  const mode = c.mode ?? (canInheritMode && hasModeInput ? (hasRates ? 'rates' : 'sticks') : undefined)
  if (mode === undefined) {
    if (hasModeInput) issue('mode', 'required for sticks, bodyRadps or collective')
    return
  }
  if (c.altitudeM != null) issue('altitudeM', 'for the 4.7 controller')
  if (c.climbRateMps !== undefined) issue('climbRateMps', 'for the 4.7 controller')
  if (c.attitude !== undefined) issue('attitude', 'for the 4.7 controller')
  if (c.yawRateRadps !== undefined) issue('yawRateRadps', 'for the 4.7 controller')
  if (mode === 'rates') {
    if (c.sticks !== undefined) issue('sticks', 'requires stabilized, altitude or position mode')
    if (c.bodyRadps === undefined) issue('bodyRadps', 'required in rates mode')
    if (c.collective === undefined) issue('collective', 'required in rates mode')
  } else {
    if (c.sticks === undefined) issue('sticks', 'required in stabilized, altitude and position modes')
    if (hasRates) issue('bodyRadps', 'bodyRadps and collective require rates mode')
  }
}

export const ControllerRequestSchema = z.strictObject({
  ...controllerSetpointShape,
  ...mixerShape,
  gains,
}).superRefine((c, ctx) => {
  checkControllerSetpoint(c, ctx, false)
  if (c.mode === undefined) {
    if (c.airmode !== undefined) ctx.addIssue({ code: 'custom', path: ['airmode'], message: 'requires mode' })
    if (c.thrustModelFactor !== undefined) ctx.addIssue({ code: 'custom', path: ['thrustModelFactor'], message: 'requires mode' })
  }
})

export const SimRunParamsSchema = z.strictObject({
  durationS: num.refine((v) => v > 0, 'must be positive'),
  environment: EnvironmentSchema,
  /** Body origin at the start, world frame (default the origin). */
  startPositionM: vec3.optional(),
  dtS: num.refine((v) => v > 0, 'must be positive').optional(),
  /** Body loads, only for a vehicle loaded without propulsion. */
  forceBodyN: vec3.optional(),
  torqueBodyNm: vec3.optional(),
  /** With propulsion (4.6): throttle per motor in [0, 1], vehicle motor order, held over the run. */
  throttle: z.array(num.refine((v) => v >= 0 && v <= 1, 'must be within 0 and 1')).optional(),
  /** With propulsion: rotor speeds at the start, rad/s (default at rest). */
  rotorSpeedsRadps: z.array(num.refine((v) => v >= 0, 'must not be negative')).optional(),
  /** Air density for the body drag, kg/m³ (`src/domain/atmosphere.ts`); required with body drag. */
  airDensityKgM3: num.refine((v) => v > 0, 'must be positive').optional(),
  /** With propulsion (4.7): the PX4 v1.13.3 controller flies to this setpoint instead of fixed throttles. */
  controller: ControllerRequestSchema.optional(),
}).refine(({ controller, dtS }) => {
  if (controller?.mode === undefined || dtS === undefined) return true
  // Same cadence check as FlightLoop::step (ekf2_params.c:53).
  const intervalS = 10_000 / 1_000_000
  return intervalS / Math.round(intervalS / dtS) === dtS
}, { path: ['dtS'], message: 'must divide 10 ms when controller.mode is given' })
export type SimRunParams = z.infer<typeof SimRunParamsSchema>

export type EngineCommand =
  | { type: 'hello' }
  | { type: 'ping' }
  | { type: 'shutdown' }
  | { type: 'vehicle.load'; vehicle: VehicleDefinition; propulsion?: PropulsionDefinition; aero?: BodyDrag }
  | ({ type: 'sim.run' } & SimRunParams)
  | ({ type: 'flight.session.start' } & FlightSessionStartParams)
  | ({ type: 'flight.session.step' } & FlightSessionStepParams)
  | { type: 'flight.session.end' }
  | ({ type: 'scenario.run' } & ScenarioRunParams)

// ---------------------------------------------------------------------------
// Results

export interface HelloResult {
  engineVersion: string
  protocolVersion: number
  threads: number
}

export interface PongResult {
  engineUptimeUs: number
}

const MassTotalsSchema = z.strictObject({ massKg: num, com: vec3, inertia: inertia6 })

export const VehicleLoadResultSchema = z.union([
  z.strictObject({
    valid: z.literal(true),
    partCount: z.number().int().nonnegative(),
    motorCount: z.number().int().nonnegative(),
    totals: MassTotalsSchema,
    missingMass: z.array(z.string()),
    /** Present when a propulsion definition was sent and accepted. */
    propulsion: z.strictObject({ motorCount: z.number().int().nonnegative() }).optional(),
  }),
  z.strictObject({
    valid: z.literal(false),
    errors: z.array(z.strictObject({ path: z.string(), message: z.string() })).min(1),
  }),
])
export type VehicleLoadResult = z.infer<typeof VehicleLoadResultSchema>

export const SimStateSchema = z.strictObject({
  steps: z.number().int().nonnegative(),
  timeS: num,
  positionM: vec3,
  quaternion: quat,
  comM: vec3,
  linearVelocityMps: vec3,
  angularVelocityRadps: vec3,
  angularVelocityBodyRadps: vec3,
})

const saturationFlags = z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean()])
const saturation = z.strictObject({ positive: saturationFlags, negative: saturationFlags })
const nullableVec3 = z.tuple([num.nullable(), num.nullable(), num.nullable()])
const FlightLoopDiagnosticSchema = z.strictObject({
  mode: flightMode,
  positionSetpointM: nullableVec3,
  velocitySetpointMps: nullableVec3,
  accelerationSetpointMps2: nullableVec3,
  saturation,
  hoverThrust: z.strictObject({ estimate: num.nullable(), variance: num.nullable(), valid: z.boolean() }),
  velocityIntegral: nullableVec3,
})

export const SimRunResultSchema = z.strictObject({
  steps: z.number().int().positive(),
  dtS: num,
  durationS: num,
  gravityMps2: num,
  state: SimStateSchema,
  stateHash: z.string().regex(/^[0-9a-f]{16}$/),
  /** Which part touched what, and when (s); `endS` null = still touching at the end. */
  contacts: z.array(z.strictObject({ partId: z.string(), with: z.string(), startS: num, endS: num.nullable() })),
  contactsDropped: z.number().int().nonnegative(),
  /** With propulsion (4.6): each motor at the end of the run. */
  motors: z
    .array(z.strictObject({ partId: z.string(), throttle: num, rpm: num, thrustN: num, dragTorqueNm: num }))
    .optional(),
  /** With propulsion: the pack at the end of the run (V = V_oc − R_int·I). */
  battery: z.strictObject({ voltageV: num, currentA: num, chargeUsedC: num, stateOfCharge: num }).optional(),
  /** With the controller (4.7): steps with a saturated demand, rate integrators, last collective. */
  controller: z
    .strictObject({ saturatedSteps: z.number().int().nonnegative(), rateIntegral: vec3, collectiveThrust: num })
    .optional(),
  flightLoop: FlightLoopDiagnosticSchema.optional(),
})
export type SimRunResult = z.infer<typeof SimRunResultSchema>

export interface EngineErrorBody {
  code: 'INVALID_JSON' | 'INVALID_REQUEST' | 'INVALID_PARAMS' | 'NO_VEHICLE' | 'VEHICLE_INCOMPLETE' | 'ENVIRONMENT_INCOMPLETE' | 'RUN_TOO_LONG' | 'CUTOFF_REQUIRED' | 'NO_SESSION' | 'NO_PROPULSION' | 'REFERENCE_DENSITY_REQUIRED' | 'INVALID_SCENARIO'
  message: string
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: EngineErrorBody }

export function isEngineResponse(v: unknown): v is EngineResponse {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.ok === 'boolean' && (typeof o.id === 'number' || o.id === null)
}

// ---------------------------------------------------------------------------
// Live flight session (4.8 part B): the renderer drives the PX4 controller flying the loaded vehicle
// in lockstep. `start` takes what a controller `sim.run` takes (environment, start position, air density,
// gain overrides) plus the user's battery cut-off, and no duration; `step` advances 1..=100 fixed 1 ms
// steps with one setpoint held and returns the last diagnostic. The loaded vehicle needs propulsion.

export const MAX_SESSION_STEPS = 100

export const FlightSessionStartParamsSchema = z.strictObject({
  environment: EnvironmentSchema,
  /** Body origin at the start, world frame. */
  startPositionM: vec3.optional(),
  /** ISA density at the user's altitude (src/domain/atmosphere.ts), kg/m³; each motor's thrust and torque scale by it relative to that motor's own reference density (propulsion definition). */
  airDensityKgM3: num.refine((v) => v > 0, 'must be positive'),
  /** The user's choice; no default. */
  cutoff: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('voltageV'), value: num.refine((v) => v > 0, 'must be positive') }),
    z.strictObject({ type: z.literal('chargeMah'), value: num.refine((v) => v > 0, 'must be positive') }),
  ]),
  gains,
  /** Selects FlightLoop for the session, with the initial mode and fixed mixer settings. */
  controller: z.strictObject({ mode: flightMode, ...mixerShape }).optional(),
})
export type FlightSessionStartParams = z.infer<typeof FlightSessionStartParamsSchema>

export const FlightSessionSetpointSchema = controllerSetpoint
  .refine(
    (c) => c.attitude === undefined || Math.abs(c.attitude.reduce((n, x) => n + x * x, 0) - 1) < 1e-9,
    'attitude must be a unit quaternion',
  )
  .superRefine((c, ctx) => checkControllerSetpoint(c, ctx, true))
export type FlightSessionSetpoint = z.infer<typeof FlightSessionSetpointSchema>
export const FlightSessionStepParamsSchema = z.strictObject({
  steps: num.int().min(1).max(MAX_SESSION_STEPS),
  setpoint: FlightSessionSetpointSchema,
})
export type FlightSessionStepParams = z.infer<typeof FlightSessionStepParamsSchema>

const cutoffReason = z.enum(['voltageCutoff', 'chargeCutoff'])

/** Everything the debug panel shows for one moment of the flight (engine-host `flight_session.rs`). */
export const FlightDiagnosticSchema = z.strictObject({
  state: SimStateSchema,
  /** Vehicle motor order. Speed in rpm; `dragTorqueNm` is the air's drag torque k_Q ω² the motor holds. */
  motors: z.array(z.strictObject({ partId: z.string(), throttle: num, rpm: num, thrustN: num, dragTorqueNm: num })),
  battery: z.strictObject({ voltageV: num, currentA: num, chargeUsedC: num, stateOfCharge: num }),
  /** What acted on the body over the last step, body axes, by source; zero before the first step. */
  loads: z.strictObject({
    thrustBodyN: vec3,
    dragBodyN: vec3,
    armTorqueNm: vec3,
    dragReactionTorqueNm: vec3,
    spinUpReactionTorqueNm: vec3,
    rotorGyroTorqueNm: vec3,
    totalTorqueNm: vec3,
  }),
  airDensityKgM3: num,
  /** The 4.7 controller's last step; null until it has stepped. */
  control: z
    .strictObject({
      torqueDemand: vec3,
      rateIntegral: vec3,
      collectiveThrust: num,
      saturation,
    })
    .nullable(),
  flightLoop: FlightLoopDiagnosticSchema.optional(),
})
export type FlightDiagnostic = z.infer<typeof FlightDiagnosticSchema>

export const FlightSessionStartResultSchema = z.strictObject({
  dtS: num,
  maxStepsPerRequest: z.number().int().positive(),
  /** The state before the first step. */
  diagnostic: FlightDiagnosticSchema,
})
export type FlightSessionStartResult = z.infer<typeof FlightSessionStartResultSchema>

export const FlightSessionStepResultSchema = z.strictObject({
  /** Fewer than asked only when the cut-off ended the run (an ended run runs none). */
  stepsRun: z.number().int().nonnegative(),
  diagnostic: FlightDiagnosticSchema,
  /** Contacts whose start or end time falls in the steps just run (an event can repeat across requests). */
  contacts: z.array(z.strictObject({ partId: z.string(), with: z.string(), startS: num, endS: num.nullable() })),
  contactsDropped: z.number().int().nonnegative(),
  endReason: cutoffReason.nullable(),
  stateHash: z.string().regex(/^[0-9a-f]{16}$/),
})
export type FlightSessionStepResult = z.infer<typeof FlightSessionStepResultSchema>

export const FlightSessionEndResultSchema = z.strictObject({ ended: z.boolean() })
export type FlightSessionEndResult = z.infer<typeof FlightSessionEndResultSchema>

// ---------------------------------------------------------------------------
// Scripted scenarios (4.9 part B): `scenario.run` flies one of engine-core's scenarios (`scenario.rs`) on the
// loaded vehicle, which needs propulsion. The scenario is a built-in with its parameters, built for this
// vehicle by the engine, or a full scenario. The config carries what a scenario does not own: the air density
// (from the flight conditions), the battery cut-off (the user's entry; no default), gain overrides, and
// optionally a ground with its start position (absent = free space from the origin). Longest scenario: 60 s,
// or 10 s with a ground (engine-host `scenario_run.rs`).

export const MAX_SCENARIO_S = 60
export const MAX_SCENARIO_WITH_GROUND_S = 10

export const BUILTIN_SCENARIO_NAMES = ['balanced_hover', 'payload', 'overweight_payload', 'com_offset', 'com_offset_beyond_authority'] as const
export type BuiltinScenarioName = (typeof BUILTIN_SCENARIO_NAMES)[number]

const afterS = num.refine((v) => v >= 0, 'cannot be negative')
/** A check of a scenario, camelCase as engine-core serialises it. */
export const ScenarioCheckSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('altitude'), afterS, toleranceM: num }),
  z.strictObject({ type: z.literal('attitude'), afterS, maxDeg: num }),
  z.strictObject({ type: z.literal('noSustainedSaturation'), afterS, maxDurationS: num }),
  z.strictObject({ type: z.literal('saturationObserved'), afterS }),
  z.strictObject({ type: z.literal('attitudeLost'), afterS, aboveDeg: num }),
  z.strictObject({ type: z.literal('cannotClimb'), afterS, minThrottle: num }),
  z.strictObject({ type: z.literal('hoverThrottle'), afterS, min: num, max: num }),
  z.strictObject({ type: z.literal('rateTrim'), afterS, axis: z.number().int().min(0).max(2), expected: num, tolerance: num }),
  z.strictObject({ type: z.literal('thrustBalance'), afterS, weights: z.array(num), expectedN: num, toleranceN: num }),
])
export type ScenarioCheck = z.infer<typeof ScenarioCheckSchema>

export const ScenarioSchema = z.strictObject({
  name: z.string().min(1),
  durationS: num,
  modifications: z.array(
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('payload'), partId: z.string().min(1), massKg: num, positionM: vec3, boxSizeM: vec3.nullable().optional() }),
      z.strictObject({ type: z.literal('shiftPart'), partId: z.string().min(1), deltaM: vec3 }),
    ]),
  ),
  script: z.array(
    z.strictObject({
      fromS: num,
      attitude: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('quaternion'), xyzw: quat }),
        z.strictObject({ type: z.literal('euler'), roll: num, pitch: num, yaw: num }),
      ]),
      yawRateRadps: num,
      zM: num.nullable().optional(),
      zVelocityMps: num,
    }),
  ),
  checks: z.array(ScenarioCheckSchema),
})
export type Scenario = z.infer<typeof ScenarioSchema>

export const ScenarioRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('builtin'),
    name: z.enum(BUILTIN_SCENARIO_NAMES),
    /** `payload` only: the mass added at the CoM, kg (the user's entry). */
    massKg: positive.optional(),
    /** `com_offset` only: the CoM's displacement along +x, m (the user's entry). */
    offsetM: num.optional(),
  }),
  z.strictObject({ type: z.literal('custom'), scenario: ScenarioSchema }),
])
export type ScenarioRequest = z.infer<typeof ScenarioRequestSchema>

export const ScenarioConfigSchema = z.strictObject({
  /** ISA density at the user's altitude (src/domain/atmosphere.ts), kg/m³. */
  airDensityKgM3: positive,
  /** The user's choice; no default. */
  cutoff: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('voltageV'), value: positive }),
    z.strictObject({ type: z.literal('chargeMah'), value: positive }),
  ]),
  gains: ControllerRequestSchema.shape.gains,
  environment: EnvironmentSchema.optional(),
  /** With an environment: the body origin at the start, world frame. */
  startPositionM: vec3.optional(),
})
export type ScenarioConfigParams = z.infer<typeof ScenarioConfigSchema>

export const ScenarioRunParamsSchema = z.strictObject({ scenario: ScenarioRequestSchema, config: ScenarioConfigSchema })
export type ScenarioRunParams = z.infer<typeof ScenarioRunParamsSchema>

export const ScenarioReportSchema = z.strictObject({
  name: z.string(),
  passed: z.boolean(),
  checks: z.array(
    z.strictObject({
      check: ScenarioCheckSchema,
      /** null = the check's observation window was never reached. */
      measured: num.nullable(),
      limits: z.tuple([num, num]),
      passed: z.boolean(),
      samples: z.number().int().nonnegative(),
    }),
  ),
  elapsedS: num,
  maxAttitudeErrorDeg: num,
  finalAltitudeErrorM: num.nullable(),
  meanThrottle: z.array(num),
  maxThrottle: z.array(num),
  firstThrottle: z.array(num),
  saturatedFraction: num,
  chargeUsedMah: num,
  endReason: z.enum(['duration', 'voltageCutoff', 'chargeCutoff']),
  /** FNV-1a of the rigid body, rotor speeds and charge used; 16 hex digits. */
  finalStateHash: z.string().regex(/^[0-9a-f]{16}$/),
})
export type ScenarioReport = z.infer<typeof ScenarioReportSchema>

export const ScenarioRunResultSchema = z.strictObject({
  /** What was flown: the built-in as built for this vehicle (its derived values), or the scenario given. */
  scenario: ScenarioSchema,
  report: ScenarioReportSchema,
  /** The report's `finalStateHash`. */
  stateHash: z.string().regex(/^[0-9a-f]{16}$/),
})
export type ScenarioRunResult = z.infer<typeof ScenarioRunResultSchema>
