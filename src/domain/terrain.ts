export interface TerrainGrid {
  readonly rows: number
  readonly columns: number
  readonly cellSizeM: number
  /** Outer lower-left corner [world X, world Y]; samples are at cell centres. */
  readonly cornerM: readonly [number, number]
  /** Row-major, starting at the top of the file (+Y), per the plan, lines 103–107. */
  readonly heightsM: Float64Array
}

export type TerrainParseResult =
  | { ok: true; grid: TerrainGrid }
  | { ok: false; reason: 'invalid-header' | 'wrong-count' | 'nodata-cell' | 'non-number'
      | 'non-positive-cell-size' | 'grid-too-small' | 'vertical-unit' | 'missing-nodata-value' | 'invalid-extent' }

const HEADER_KEYS = new Set([
  'ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'nodata_value',
])

function decimal(token: string): number {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token) ? Number(token) : NaN
}

/** Phase 6 plan D10 (line 70): the caller supplies the vertical unit for the grid. */
export function parseAsciiGrid(
  text: string,
  verticalUnit: string,
  implicitNoDataValue?: number,
): TerrainParseResult {
  if (verticalUnit !== 'm') return { ok: false, reason: 'vertical-unit' }

  const tokens = text.match(/\S+/g) ?? []
  const header = new Map<string, number>()
  let offset = 0
  while (offset < tokens.length) {
    const key = tokens[offset]?.toLowerCase()
    if (key === undefined || !HEADER_KEYS.has(key)) break
    const token = tokens[offset + 1]
    if (header.has(key) || token === undefined) return { ok: false, reason: 'invalid-header' }
    const value = decimal(token)
    if (!Number.isFinite(value)) return { ok: false, reason: 'non-number' }
    header.set(key, value)
    offset += 2
  }

  const rows = header.get('nrows')
  const columns = header.get('ncols')
  const cellSizeM = header.get('cellsize')
  const xCorner = header.get('xllcorner')
  const yCorner = header.get('yllcorner')
  const xCentre = header.get('xllcenter')
  const yCentre = header.get('yllcenter')
  if (rows === undefined || columns === undefined || cellSizeM === undefined
      || !Number.isInteger(rows) || !Number.isInteger(columns)) {
    return { ok: false, reason: 'invalid-header' }
  }
  if (rows < 2 || columns < 2) return { ok: false, reason: 'grid-too-small' }
  if (cellSizeM <= 0) return { ok: false, reason: 'non-positive-cell-size' }
  if (tokens.length - offset !== rows * columns) return { ok: false, reason: 'wrong-count' }

  let cornerM: TerrainGrid['cornerM']
  if (xCorner !== undefined && yCorner !== undefined && xCentre === undefined && yCentre === undefined) {
    cornerM = [xCorner, yCorner]
  } else if (xCentre !== undefined && yCentre !== undefined && xCorner === undefined && yCorner === undefined) {
    cornerM = [xCentre - cellSizeM / 2, yCentre - cellSizeM / 2]
  } else {
    return { ok: false, reason: 'invalid-header' }
  }

  // engine-core/src/environment.rs:228–245 requires finite, distinct sample bounds.
  const west = cornerM[0] + cellSizeM / 2
  const south = cornerM[1] + cellSizeM / 2
  const east = west + (columns - 1) * cellSizeM
  const north = south + (rows - 1) * cellSizeM
  if (!Number.isFinite(east) || !Number.isFinite(north) || east <= west || north <= south) {
    return { ok: false, reason: 'invalid-extent' }
  }

  const noData = header.get('nodata_value') ?? implicitNoDataValue
  if (noData === undefined) return { ok: false, reason: 'missing-nodata-value' }
  if (!Number.isFinite(noData)) return { ok: false, reason: 'non-number' }
  const heightsM = new Float64Array(tokens.length - offset)
  for (let index = 0; index < heightsM.length; index++) {
    const height = decimal(tokens[offset + index]!)
    if (!Number.isFinite(height)) return { ok: false, reason: 'non-number' }
    if (height === noData) return { ok: false, reason: 'nodata-cell' }
    heightsM[index] = height
  }

  return { ok: true, grid: { rows, columns, cellSizeM, cornerM, heightsM } }
}

/** Height on the surface spanned by the sample centres, or undefined outside it. */
export function terrainHeightAt(grid: TerrainGrid, xM: number, yM: number): number | undefined {
  const { rows, columns, cellSizeM, cornerM, heightsM } = grid
  const west = cornerM[0] + cellSizeM / 2
  const south = cornerM[1] + cellSizeM / 2
  if (!Number.isFinite(xM) || !Number.isFinite(yM)
      || xM < west || xM > west + (columns - 1) * cellSizeM
      || yM < south || yM > south + (rows - 1) * cellSizeM) {
    return undefined
  }

  const x = Math.min((xM - west) / cellSizeM, columns - 1)
  const y = Math.min((yM - south) / cellSizeM, rows - 1)
  const column = Math.min(Math.floor(x), columns - 2)
  const rowFromBottom = Math.min(Math.floor(y), rows - 2)
  const u = x - column
  const v = y - rowFromBottom
  const top = (rows - 2 - rowFromBottom) * columns + column
  const bottom = top + columns
  const sw = heightsM[bottom]
  const se = heightsM[bottom + 1]
  const nw = heightsM[top]
  const ne = heightsM[top + 1]
  if (sw === undefined || se === undefined || nw === undefined || ne === undefined) return undefined

  // parry-heightfield3.rs:101–106,355–369,391–402:
  // Parry (x, y, z) maps to world (x, -z, y), so p00 is NW and
  // the default p10–p01 diagonal runs from SW to NE.
  return u <= v
    ? (1 - v) * sw + u * ne + (v - u) * nw
    : (1 - u) * sw + (u - v) * se + v * ne
}
