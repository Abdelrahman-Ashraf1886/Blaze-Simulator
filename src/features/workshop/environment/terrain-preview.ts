import { useEffect, useState } from 'react'
import type { TerrainDoc } from '../../../../electron/ipc/contract'
import type { TerrainGrid } from '../../../domain/terrain'
import { getApi } from '../../../services/api'

export function selectTerrain(current: TerrainDoc | null | undefined, assetId: string | null): TerrainDoc | null {
  return assetId === null ? null : { friction: null, restitution: null, ...current, assetId }
}

type GridRead =
  | { id: string; grid: TerrainGrid; error?: undefined }
  | { id: string; grid?: undefined; error: string }

export function useTerrainGrid(id: string | null | undefined) {
  const [result, setResult] = useState<GridRead>()
  useEffect(() => {
    if (!id) return
    let active = true
    void (async () => {
      try {
        const read = await getApi().terrain.read(id)
        if (active) setResult(read.ok ? { id, grid: read.data } : { id, error: read.error.message })
      } catch (error) {
        if (active) setResult({ id, error: String(error) })
      }
    })()
    return () => { active = false }
  }, [id])
  return result?.id === id ? result : undefined
}
