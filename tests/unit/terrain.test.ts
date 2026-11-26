import { describe, expect, it } from 'vitest'
import { parseAsciiGrid, terrainHeightAt, terrainLandingSlope, type TerrainFootprint } from '../../src/domain/terrain'

// All coordinates and expected heights use exact binary fractions. Tolerance: zero.
const header = 'NCOLS 2\nNROWS 2\nXLLCORNER 10\nYLLCORNER 20\nCELLSIZE 2\nNODATA_VALUE -7'
const data = '2 8\n0 4'

describe('terrain landing slope', () => {
  const footprint: TerrainFootprint = { min: [11.5, 21.5], max: [12.5, 22.5] }
  const grid = { rows: 2, columns: 2, cornerM: [10, 20] as const, cellSizeM: 2 }

  it.each([
    [0, 0, false],
    [30, 2 / Math.sqrt(3), true],
    [45, 2, true],
  ])('measures a %i° plane against both friction limits', (angle, rise, slidesAtPointFour) => {
    const plane = { ...grid, heightsM: new Float64Array([0, rise, 0, rise]) }
    const low = terrainLandingSlope(plane, footprint, 0.4)!
    const high = terrainLandingSlope(plane, footprint, 1)!
    expect(low.slopeDeg).toBeCloseTo(angle)
    expect(low.limitDeg).toBeCloseTo(21.801409486)
    expect(low.exceedsLimit).toBe(slidesAtPointFour)
    expect(high.slopeDeg).toBeCloseTo(angle)
    expect(high.limitDeg).toBe(45)
    expect(high.exceedsLimit).toBe(false)
  })

  it('uses only triangles the footprint touches and includes the steeper face on a shared edge', () => {
    // The northwest face is flat. On the southeast face z = u*2 - v*2 in cell coordinates.
    const crease = { ...grid, heightsM: new Float64Array([0, 0, 0, 2]) }
    const insideFlat = terrainLandingSlope(crease, { min: [11.25, 22.25], max: [11.75, 22.75] }, 1)
    expect(insideFlat).toEqual({ slopeDeg: 0, limitDeg: 45, exceedsLimit: false })
    const atCrease = terrainLandingSlope(crease, { min: [11.5, 22], max: [12, 22.5] }, 1)
    expect(atCrease?.slopeDeg).toBeCloseTo(54.735610317)
    expect(atCrease?.exceedsLimit).toBe(true)
  })

  it('clips the footprint to the sample centres and checks adjoining cells', () => {
    const strip = { ...grid, columns: 3, heightsM: new Float64Array([0, 0, 2, 0, 0, 2]) }
    expect(terrainLandingSlope(strip, { min: [10, 20], max: [10.5, 24] }, 0.4)).toBeUndefined()
    expect(terrainLandingSlope(strip, { min: [10, 20], max: [11.5, 24] }, 0.4)?.slopeDeg).toBe(0)
    expect(terrainLandingSlope(strip, { min: [12, 21], max: [14, 23] }, 0.4)?.slopeDeg).toBe(45)
    expect(terrainLandingSlope(strip, { min: [15, 23], max: [16, 24] }, 0.4)?.slopeDeg).toBe(45)
    expect(terrainLandingSlope(strip, { min: [15.5, 23], max: [16, 24] }, 0.4)).toBeUndefined()
  })
})

describe('Esri ASCII terrain', () => {
  it('refuses a finite header whose cell bounds collapse at engine precision', () => {
    const text = 'ncols 2 nrows 2 xllcorner 1e20 yllcorner 0 cellsize 1 nodata_value -42 1 2 3 4'
    expect(parseAsciiGrid(text, 'm')).toEqual({ ok: false, reason: 'invalid-extent' })
  })
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
