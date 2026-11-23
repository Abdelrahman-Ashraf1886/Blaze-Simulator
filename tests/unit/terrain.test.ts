import { describe, expect, it } from 'vitest'
import { parseAsciiGrid, terrainHeightAt } from '../../src/domain/terrain'

// All coordinates and expected heights use exact binary fractions. Tolerance: zero.
const header = 'NCOLS 2\nNROWS 2\nXLLCORNER 10\nYLLCORNER 20\nCELLSIZE 2\nNODATA_VALUE -7'
const data = '2 8\n0 4'

describe('Esri ASCII terrain', () => {
  it('maps both registrations and both keyword cases to the same grid', () => {
    const corner = parseAsciiGrid(`${header}\n${data}`, 'm')
    const centre = parseAsciiGrid(`${header.toLowerCase().replace('xllcorner 10', 'xllcenter 11')
      .replace('yllcorner 20', 'yllcenter 21')}\n${data}`, 'm')
    expect(corner).toEqual({
      ok: true,
      grid: { rows: 2, columns: 2, cornerM: [10, 20], cellSizeM: 2, heightsM: new Float64Array([2, 8, 0, 4]) },
    })
    expect(centre).toEqual(corner)
  })

  it('preserves nodes and follows the two Parry triangle planes', () => {
    const result = parseAsciiGrid(`${header}\n${data}`, 'm')
    if (!result.ok) throw new Error(result.reason)
    const { grid } = result
    expect(terrainHeightAt(grid, 11, 21)).toBe(0)
    expect(terrainHeightAt(grid, 13, 21)).toBe(4)
    expect(terrainHeightAt(grid, 11, 23)).toBe(2)
    expect(terrainHeightAt(grid, 13, 23)).toBe(8)
    expect(terrainHeightAt(grid, 11.5, 22.5)).toBe(3)
    expect(terrainHeightAt(grid, 12, 22)).toBe(4)
    expect(terrainHeightAt(grid, 12.5, 21.5)).toBe(4)
    expect(terrainHeightAt(grid, 10, 20)).toBeUndefined()
  })

  it.each([
    [header, '2 8 0', 'wrong-count'],
    [header, '2 8 0 4 5', 'wrong-count'],
    [header, '2 -7 0 4', 'nodata-cell'],
    [header, '2 NaN 0 4', 'non-number'],
    [header.replace('CELLSIZE 2', 'CELLSIZE bad'), data, 'non-number'],
    [header.replace('CELLSIZE 2', 'CELLSIZE 0'), data, 'non-positive-cell-size'],
    [header.replace('CELLSIZE 2', 'CELLSIZE -2'), data, 'non-positive-cell-size'],
    [header.replace('NROWS 2', 'NROWS 1'), '2 8', 'grid-too-small'],
    [header.replace('NCOLS 2', 'NCOLS 1'), '2 0', 'grid-too-small'],
  ])('returns a typed refusal for %s / %s', (configuration, cells, reason) => {
    expect(parseAsciiGrid(`${configuration}\n${cells}`, 'm')).toEqual({ ok: false, reason })
  })

  it('requires a known sentinel and metre elevations', () => {
    const withoutSentinel = `${header.replace('NODATA_VALUE -7', '')}\n${data}`
    expect(parseAsciiGrid(withoutSentinel, 'm')).toEqual({ ok: false, reason: 'missing-nodata-value' })
    expect(parseAsciiGrid(withoutSentinel, 'm', -7).ok).toBe(true)
    expect(parseAsciiGrid(`${header}\n${data}`, 'ft')).toEqual({ ok: false, reason: 'vertical-unit' })
  })
})
