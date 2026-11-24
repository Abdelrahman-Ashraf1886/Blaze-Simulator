import type { EnvironmentDoc } from '../../../../electron/ipc/contract'
import { simEnvironment, type EnvironmentAssets, type MissingValue, type SimEnvironment } from '../../../domain/environment'
import type { GridRead } from './terrain-preview'

export type StartEnvironment =
  | { ok: true; environment: SimEnvironment }
  | { ok: false; missing: MissingValue[] }

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

  return result
}
