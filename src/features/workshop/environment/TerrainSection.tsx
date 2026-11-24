import { useEffect, useMemo, useState } from 'react'
import type { TerrainAssetInfo } from '../../../../electron/ipc/contract'
import { Button } from '@/components/ui/button'
import type { TerrainGrid } from '@/domain/terrain'
import { getApi } from '@/services/api'
import { ChoiceField, optionalNumber } from './fields'

function heightRange(grid: TerrainGrid) {
  let min = Infinity
  let max = -Infinity
  for (const height of grid.heightsM) {
    min = Math.min(min, height)
    max = Math.max(max, height)
  }
  return [min, max]
}

export function TerrainSection({ selectedId, onSelect, grid, readError }: {
  selectedId?: string | null
  onSelect: (id: string | null) => void
  grid?: TerrainGrid
  readError?: string
}) {
  const [assets, setAssets] = useState<TerrainAssetInfo[]>([])
  const [listError, setListError] = useState('')
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const [metres, setMetres] = useState(false)
  const [needsNoData, setNeedsNoData] = useState(false)
  const [noData, setNoData] = useState('')
  const range = useMemo(() => grid && heightRange(grid), [grid])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await getApi().terrain.list()
        if (!active) return
        if (result.ok) {
          setAssets((existing) => [
            ...result.data,
            ...existing.filter((asset) => !result.data.some(({ id }) => id === asset.id)),
          ])
        } else setListError(result.error.message)
      } catch (error) {
        if (active) setListError(String(error))
      }
    })()
    return () => { active = false }
  }, [])

  const importGrid = async () => {
    const parsed = optionalNumber(noData)
    if (needsNoData && (!parsed.ok || parsed.value === null)) {
      setImportError('Enter the file’s NODATA sentinel.')
      return
    }
    setImporting(true)
    setImportError('')
    try {
      const result = await getApi().terrain.import({
        verticalUnit: 'm',
        ...(needsNoData && parsed.ok && parsed.value !== null ? { noDataValue: parsed.value } : {}),
      })
      if (!result.ok) {
        setImportError(result.error.message)
        setNeedsNoData(needsNoData || !!result.error.errors?.some(({ name }) => name === 'noDataValue'))
      } else if (result.data) {
        const asset = result.data
        setAssets((existing) => existing.some(({ id }) => id === asset.id) ? existing : [...existing, asset])
        setNeedsNoData(false)
        setNoData('')
        setMetres(false)
      }
    } catch (error) {
      setImportError(String(error))
    } finally {
      setImporting(false)
    }
  }

  const missingSelection = selectedId && !assets.some(({ id }) => id === selectedId)
  return <section aria-labelledby="terrain-heading" className="mt-3" data-testid="terrain-section">
    <h3 id="terrain-heading" className="text-[12px] font-medium text-fg-muted">Terrain</h3>
    <ChoiceField id="terrain-grid" label="Stored grid" value={selectedId ?? ''} onChange={(id) => onSelect(id || null)}
      options={[
        ['', 'None (ground plane)'],
        ...(missingSelection ? [[selectedId, 'Selected grid'] as const] : []),
        ...assets.map(({ id, filename }) => [id, filename] as const),
      ]} />
    {selectedId && !grid && !readError && <p role="status" className="text-[11.5px] text-fg-subtle">Loading terrain…</p>}
    {grid && range && <div data-testid="terrain-details" className="space-y-1 py-1 text-[11.5px] text-fg-muted">
      <p>{grid.columns} columns × {grid.rows} rows · {grid.cellSizeM} m cells</p>
      <p>Elevation {range[0]} to {range[1]} m</p>
      <p>File’s southwest offset in world metres ({grid.cornerM[0]}, {grid.cornerM[1]}). Columns increase along +X. Up the file is +Y.</p>
    </div>}
    {listError && <p role="alert" className="text-[11.5px] text-fault">{listError}</p>}
    {readError && <p role="alert" className="text-[11.5px] text-fault">{readError}</p>}
    <label className="mt-2 flex items-start gap-2 text-[12px] text-fg-muted">
      <input type="checkbox" checked={metres} disabled={importing} onChange={(event) => setMetres(event.currentTarget.checked)} />
      The .asc file’s elevations are in metres
    </label>
    {needsNoData && <label className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
      File’s NODATA sentinel
      <input value={noData} onChange={(event) => setNoData(event.currentTarget.value)} inputMode="decimal" disabled={importing}
        className="num h-7 min-w-0 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-fg" />
    </label>}
    {importError && <p role="alert" className="mt-1 text-[11.5px] text-fault" data-testid="terrain-import-error">{importError}</p>}
    <div className="flex flex-wrap gap-1 py-1">
      <Button size="sm" variant="ghost" data-testid="import-terrain" disabled={!metres || importing} onClick={() => void importGrid()}>
        {needsNoData ? 'Retry .asc import' : 'Import .asc'}
      </Button>
      {selectedId && <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>Remove terrain from project</Button>}
      {needsNoData && <Button size="sm" variant="ghost" disabled={importing}
        onClick={() => { setNeedsNoData(false); setNoData(''); setImportError(''); setMetres(false) }}>Cancel retry</Button>}
    </div>
  </section>
}
