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
  /**
   * With propulsion (4.7): the PX4 v1.13.3 controller flies to this setpoint instead of fixed
   * throttles. `altitudeM` is the CoM height (null/absent = hold `climbRateMps`); `attitude` a unit
   * quaternion x y z w (absent = level); `gains` overrides by exact PX4 name, e.g. { MC_ROLL_P: 7 }.
   */
  controller: z
    .strictObject({
      altitudeM: num.nullable().optional(),
      climbRateMps: num.optional(),
      attitude: quat.optional(),
      yawRateRadps: num.optional(),
      gains: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'use the exact PX4 parameter name'), num).optional(),
    })
    .optional(),
})
export type SimRunParams = z.infer<typeof SimRunParamsSchema>

export type EngineCommand =
  | { type: 'hello' }
  | { type: 'ping' }
  | { type: 'shutdown' }
  | { type: 'vehicle.load'; vehicle: VehicleDefinition; propulsion?: PropulsionDefinition; aero?: BodyDrag }
  | ({ type: 'sim.run' } & SimRunParams)

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
})
export type SimRunResult = z.infer<typeof SimRunResultSchema>

export interface EngineErrorBody {
  code: 'INVALID_JSON' | 'INVALID_REQUEST' | 'INVALID_PARAMS' | 'NO_VEHICLE' | 'VEHICLE_INCOMPLETE' | 'ENVIRONMENT_INCOMPLETE' | 'RUN_TOO_LONG'
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
