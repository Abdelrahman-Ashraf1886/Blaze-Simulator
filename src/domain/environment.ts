/**
 * The project's flight environment as the engine takes it (`sim.run`'s `environment`,
 * engine-core `environment.rs`), and what is still missing before a simulation can start.
 * Pure (no React, three.js or IPC).
 *
 * - Ground: the plane z = 0, solid below.
 * - Obstacles: fixed boxes. The user gives a centre, a size and a yaw (rotation about the
 *   world +Z axis, radians, right-hand rule); the engine takes half extents and a quaternion.
 * - Friction and restitution of the ground and of every obstacle are the user's entries:
 *   no source states them for a given surface, so nothing here has a default. Each value
 *   that is not set is listed, with where to enter it, and no environment is produced.
 *   The engine refuses an incomplete environment too (ENVIRONMENT_INCOMPLETE); this is the
 *   same rule, checked before anything is sent.
 * - The values are the coefficients of the contact between the vehicle and that surface.
 */

import type { EnvironmentDoc } from '../../electron/ipc/contract'

export type Vec3 = [number, number, number]

/** The engine's environment (mirrors `EnvironmentSchema` in electron/main/engine/protocol.ts). */
export interface SimEnvironment {
  ground: { friction: number; restitution: number } | null
  obstacles: {
    id: string
    center: Vec3
    halfExtents: Vec3
    quaternion: [number, number, number, number]
    friction: number
    restitution: number
  }[]
}

export interface MissingValue {
  /** Path in the document, e.g. `ground.friction` or `obstacles[1].restitution`. */
  field: string
  /** What to do, for the readiness list. */
  message: string
}

export type EnvironmentResult = { ok: true; environment: SimEnvironment } | { ok: false; missing: MissingValue[] }

/** Rotation by `yaw` radians about +Z, as a unit quaternion x, y, z, w. */
export function yawQuaternion(yaw: number): [number, number, number, number] {
  return [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)]
}

/** An empty environment: a ground whose values are not set, no obstacles. */
export const EMPTY_ENVIRONMENT: EnvironmentDoc = { ground: { friction: null, restitution: null }, obstacles: [] }

const where = 'enter it under Environment in the workshop'

/** The engine's environment, or every value still missing. */
export function simEnvironment(env: EnvironmentDoc | null | undefined): EnvironmentResult {
  const e = env ?? EMPTY_ENVIRONMENT
  const missing: MissingValue[] = []
  const need = (value: number | null, field: string, label: string) => {
    if (value === null) missing.push({ field, message: `${label} is not set: ${where}.` })
  }
  need(e.ground.friction, 'ground.friction', 'Ground friction')
  need(e.ground.restitution, 'ground.restitution', 'Ground restitution')
  e.obstacles.forEach((o, i) => {
    need(o.friction, `obstacles[${i}].friction`, `Friction of obstacle "${o.name}"`)
    need(o.restitution, `obstacles[${i}].restitution`, `Restitution of obstacle "${o.name}"`)
  })
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    environment: {
      ground: { friction: e.ground.friction!, restitution: e.ground.restitution! },
      obstacles: e.obstacles.map((o) => ({
        id: o.id,
        center: [...o.center],
        halfExtents: o.size.map((v) => v / 2) as Vec3,
        quaternion: yawQuaternion(o.yaw),
        friction: o.friction!,
        restitution: o.restitution!,
      })),
    },
  }
}
