import type { AssemblyDocument, AssetInfo, ObstacleDoc } from '../../../../electron/ipc/contract'
import { placeModel, placePoint } from '../../../three/model-units'

export function newObstacle(id: string, index: number, shape: 'box' | 'cylinder' | 'hull'): ObstacleDoc {
  const base = { id, name: `Obstacle ${index + 1}`, friction: null, restitution: null }
  // Preserve the existing workshop starting box (EnvironmentPanel.tsx, original add action).
  if (shape === 'box') return { ...base, center: [1, 0, 0.1], size: [0.4, 0.4, 0.2], yaw: 0 }
  const incomplete = { ...base, center: null, yaw: null }
  return shape === 'cylinder'
    ? { ...incomplete, type: shape, height: null, radius: null }
    : { ...incomplete, type: shape, assetId: null, units: null, upAxis: null }
}

export function projectHullModels(parts: AssemblyDocument['parts'], assets: Readonly<Record<string, AssetInfo>>) {
  return parts.flatMap(({ id, name, shape }) => {
    if (shape.type !== 'model') return []
    const points = assets[shape.assetId]?.hull?.points
    return points && points.length >= 4 ? [{ id, name, shape }] : []
  })
}

export function hullPoints(obstacle: Extract<ObstacleDoc, { type: 'hull' }>, model: AssetInfo | undefined) {
  const { units, upAxis } = obstacle
  if (!model?.hull?.points || model.hull.points.length < 4 || units === null || upAxis === null) return null
  // Same bounds-centred mesh placement as src/domain/environment.ts:98–108.
  const placement = placeModel(model.bounds, units, upAxis)
  return model.hull.points.map((point) => placePoint(point, placement))
}
