import type { EnvironmentDoc } from '../../../../electron/ipc/contract'
import { simEnvironment, type EnvironmentAssets, type MissingValue, type SimEnvironment } from '../../../domain/environment'
import { terrainHeightAt } from '../../../domain/terrain'
import type { GridRead } from './terrain-preview'

export type StartEnvironment =
  | { ok: true; environment: SimEnvironment; surfaceHeightM: number }
  | { ok: false; missing: MissingValue[] }

/** The existing start XY is (0, 0); terrain replaces the z = 0 reference there. */
export function startEnvironment(doc: EnvironmentDoc | null | undefined, models: EnvironmentAssets['models'], terrain: GridRead | undefined): StartEnvironment {
  const id = doc?.terrain?.assetId
  const selected = id && terrain?.id === id ? terrain : undefined
  const grid = selected?.grid
  const result = simEnvironment(doc, { models, grids: id && grid ? { [id]: grid } : undefined })
  if (!result.ok) {
    return {
      ok: false,
      missing: result.missing.map((item) => item.field === 'terrain.assetId' && id && !grid
        ? { ...item, message: selected?.error ? `Could not load the selected terrain grid. ${selected.error}` : 'Loading the selected terrain grid…' }
        : item),
    }
  }

  // Use the same sample-centre bounds and triangle interpolation as the collider.
  const surfaceHeightM = grid ? terrainHeightAt(grid, 0, 0) : 0
  if (surfaceHeightM === undefined) {
    return { ok: false, missing: [{ field: 'terrain.assetId', message: 'The start point (0, 0) is outside the terrain grid. Select a grid that covers it in Environment.' }] }
  }
  return { ...result, surfaceHeightM }
}
