/**
 * The project's flight environment as the engine takes it (`sim.run`'s `environment`,
 * engine-core `environment.rs`), and what is still missing before a simulation can start.
 * Pure (no React, three.js or IPC).
 *
 * - Ground: the plane z = 0, solid below, or a terrain grid.
 * - Obstacles: fixed boxes, vertical cylinders and convex hulls. The user gives a centre and
 *   yaw (rotation about world +Z, radians, right-hand rule); the engine takes a quaternion.
 * - Friction and restitution of the ground and of every obstacle are the user's entries:
 *   no source states them for a given surface, so nothing here has a default. Each value
 *   that is not set is listed, with where to enter it, and no environment is produced.
 *   The engine refuses an incomplete environment too (ENVIRONMENT_INCOMPLETE); this is the
 *   same rule, checked before anything is sent.
 * - The values are the coefficients of the contact between the vehicle and that surface.
 */

import type { AssetInfo, EnvironmentDoc, FlightConditionsDoc, ObstacleDoc, SurfaceValues } from '../../electron/ipc/contract'
import type { MotorSlot } from './propulsion'
import type { TerrainGrid } from './terrain'
import { dimensionOf, toSI } from './units'

export type Vec3 = [number, number, number]

type Surface = { friction: number; restitution: number }
type SimObstacleShape =
  | { type?: 'box'; halfExtents: Vec3 }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'hull'; points: Vec3[] }

type SimObstacle = SimObstacleShape & Surface & {
  id: string
  center: Vec3
  quaternion: [number, number, number, number]
}

/** engine-core/src/environment.rs:196–226,329–366,382–418. */
export interface SimEnvironment {
  ground: Surface | null
  terrain?: Omit<TerrainGrid, 'heightsM'> & Surface & { heightsM: number[] }
  obstacles: SimObstacle[]
}

export interface EnvironmentAssets {
  grids?: Readonly<Record<string, TerrainGrid | undefined>>
  models?: Readonly<Record<string, Pick<AssetInfo, 'bounds' | 'hull'> | undefined>>
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

function obstacleShape(
  obstacle: ObstacleDoc,
  models: EnvironmentAssets['models'],
  need: (value: unknown, field: string, label: string) => void,
  missingAsset: (field: string, message: string) => void,
): SimObstacleShape | undefined {
  switch (obstacle.type) {
    case undefined:
    case 'box': {
      need(obstacle.size, 'size', 'Size')
      if (obstacle.size === null) return
      return {
        ...(obstacle.type === 'box' && { type: obstacle.type }),
        halfExtents: obstacle.size.map((v) => v / 2) as Vec3,
      }
    }
    case 'cylinder':
      need(obstacle.radius, 'radius', 'Radius')
      need(obstacle.height, 'height', 'Height')
      return { type: 'cylinder', radius: obstacle.radius!, height: obstacle.height! }
    case 'hull': {
      const { assetId, units, upAxis } = obstacle
      need(assetId, 'assetId', 'Model')
      need(units, 'units', 'Model units')
      need(upAxis, 'upAxis', 'Model up axis')
      if (assetId === null) return
      const model = models?.[assetId]
      if (!model?.hull?.points || model.hull.points.length < 4) {
        missingAsset('assetId', `Select an imported model with a usable convex hull for obstacle "${obstacle.name}" under Environment in the workshop.`)
        return
      }
      if (units === null || upAxis === null) return
      // Use the file bounds for the obstacle's local origin (src/three/model-units.ts:36–53).
      const { min, max } = model.bounds
      const scale = toSI(1, units)
      const points = model.hull.points.map((point): Vec3 => {
        const x = (point[0] - (min[0] + max[0]) / 2) * scale
        const y = (point[1] - (min[1] + max[1]) / 2) * scale
        const z = (point[2] - (min[2] + max[2]) / 2) * scale
        return upAxis === 'y' ? [x, -z, y] : [x, y, z]
      })
      return { type: 'hull', points }
    }
  }
}

/** The engine's environment, or every value still missing. */
export function simEnvironment(env: EnvironmentDoc | null | undefined, assets: EnvironmentAssets = {}): EnvironmentResult {
  const e = env ?? EMPTY_ENVIRONMENT
  const missing: MissingValue[] = []
  const need = (value: unknown, field: string, label: string) => {
    if (value === null) missing.push({ field, message: `${label} is not set: ${where}.` })
  }
  const surface = (s: SurfaceValues, path: string, label: string): Surface => {
    need(s.friction, `${path}.friction`, `${label} friction`)
    need(s.restitution, `${path}.restitution`, `${label} restitution`)
    return { friction: s.friction!, restitution: s.restitution! }
  }
  const ground = e.terrain ? null : surface(e.ground, 'ground', 'Ground')
  let terrainGrid: TerrainGrid | undefined
  let terrainSurface: Surface | undefined
  if (e.terrain) {
    const { assetId } = e.terrain
    terrainSurface = surface(e.terrain, 'terrain', 'Terrain')
    need(assetId, 'terrain.assetId', 'Terrain grid')
    if (assetId !== null) {
      terrainGrid = assets.grids?.[assetId]
      if (!terrainGrid) missing.push({ field: 'terrain.assetId', message: 'Load the selected grid or import it again under Environment in the workshop.' })
    }
  }

  const obstacles: SimObstacle[] = []
  e.obstacles.forEach((o, i) => {
    const path = `obstacles[${i}]`
    const count = missing.length
    const needObstacle = (value: unknown, field: string, label: string) =>
      need(value, `${path}.${field}`, `${label} of obstacle "${o.name}"`)
    needObstacle(o.friction, 'friction', 'Friction')
    needObstacle(o.restitution, 'restitution', 'Restitution')
    needObstacle(o.center, 'center', 'Centre')
    needObstacle(o.yaw, 'yaw', 'Yaw')
    const shape = obstacleShape(o, assets.models, needObstacle, (field, message) => missing.push({ field: `${path}.${field}`, message }))
    if (shape && missing.length === count) {
      obstacles.push({
        id: o.id,
        center: [...o.center!],
        ...shape,
        quaternion: yawQuaternion(o.yaw!),
        friction: o.friction!,
        restitution: o.restitution!,
      })
    }
  })
  if (missing.length) return { ok: false, missing }
  const environment: SimEnvironment = { ground, obstacles }
  if (terrainGrid && terrainSurface) {
    const { rows, columns, cellSizeM, cornerM, heightsM } = terrainGrid
    environment.terrain = { rows, columns, cellSizeM, cornerM: [...cornerM], heightsM: Array.from(heightsM), ...terrainSurface }
  }
  return { ok: true, environment }
}

export type GroundEffectResult = { ok: true; radiiM?: number[] } | { ok: false; missing: MissingValue[] }

/** Supply slots in vehicle motor order (engine-core/src/flight.rs:303–315). */
export function simGroundEffect(
  setting: FlightConditionsDoc['groundEffect'],
  motors: readonly MotorSlot[],
): GroundEffectResult {
  if (setting === undefined || setting === false) return { ok: true }
  if (setting === null) {
    return { ok: false, missing: [{ field: 'groundEffect', message: 'Set the ground-effect switch under Flight Conditions.' }] }
  }

  const missing: MissingValue[] = []
  const radiiM: number[] = []
  for (const motor of motors) {
    // The resolved propeller component's Diameter (component-fields.ts:177;
    // propulsion.ts:739–749), including any part override or catalog fill.
    const diameter = motor.prop?.component?.specs.diameter
    const radius = diameter && typeof diameter.value === 'number' && 'unit' in diameter && dimensionOf(diameter.unit) === 'length'
      ? toSI(diameter.value, diameter.unit) / 2
      : null
    if (radius !== null && Number.isFinite(radius) && radius > 0) {
      radiiM.push(radius)
    } else {
      missing.push({
        field: `motors[${motor.partId}].prop.diameter`,
        message: `Enter the propeller Diameter in Components and link the propeller to ${motor.name} in the workshop.`,
      })
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true, radiiM }
}
