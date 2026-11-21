/**
 * TypeScript mirror of `simulation-engine/engine-host/src/protocol.rs`.
 * Both sides must change together; bump PROTOCOL_VERSION on breaking changes.
 *
 * v2 adds `vehicle.load` and `sim.run`. Everything crossing this boundary is
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
    }),
  ),
  battery: z.strictObject({ openCircuitVoltageV: positive, internalResistanceOhm: positive, capacityC: positive }),
})
export type PropulsionDefinition = z.infer<typeof PropulsionDefinitionSchema>

// ---------------------------------------------------------------------------
// Commands

export const SimRunParamsSchema = z.strictObject({
  durationS: num.refine((v) => v > 0, 'must be positive'),
  dtS: num.refine((v) => v > 0, 'must be positive').optional(),
  forceBodyN: vec3.optional(),
  torqueBodyNm: vec3.optional(),
})
export type SimRunParams = z.infer<typeof SimRunParamsSchema>

export type EngineCommand =
  | { type: 'hello' }
  | { type: 'ping' }
  | { type: 'shutdown' }
  | { type: 'vehicle.load'; vehicle: VehicleDefinition; propulsion?: PropulsionDefinition }
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
})
export type SimRunResult = z.infer<typeof SimRunResultSchema>

export interface EngineErrorBody {
  code: 'INVALID_JSON' | 'INVALID_REQUEST' | 'INVALID_PARAMS' | 'NO_VEHICLE' | 'VEHICLE_INCOMPLETE'
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
