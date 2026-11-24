import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseAsciiGrid, type TerrainGrid, type TerrainParseResult } from '../../../src/domain/terrain'
import type { IpcResult, TerrainAssetInfo, TerrainImportInput } from '../../ipc/contract'
import { NotFoundError, ValidationError, type Repositories } from '../db/repositories'
import { writeAssetFile } from './store'

const parseMessages: Record<Extract<TerrainParseResult, { ok: false }>['reason'], string> = {
  'invalid-header': 'The Esri ASCII grid header is invalid.',
  'wrong-count': 'The number of heights must match the grid rows × columns.',
  'nodata-cell': 'The grid contains a NODATA cell. Import a grid with every height specified.',
  'non-number': 'The grid header and heights must contain finite numbers.',
  'non-positive-cell-size': 'The grid cell size must be positive.',
  'grid-too-small': 'The grid must have at least two rows and two columns.',
  'vertical-unit': 'Confirm the terrain elevations are in metres.',
  'missing-nodata-value': 'The header omits NODATA_VALUE. Enter the file’s NODATA sentinel and retry import.',
  'invalid-extent': 'The terrain sample bounds must be finite and distinct along both axes.',
}

export function importTerrainFile(
  path: string,
  dir: string,
  repos: Repositories,
  input: TerrainImportInput,
): IpcResult<TerrainAssetInfo> {
  const filename = basename(path)
  if (extname(filename).toLowerCase() !== '.asc') {
    return { ok: false, error: { code: 'VALIDATION', message: 'Choose an Esri ASCII grid (.asc).' } }
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return { ok: false, error: { code: 'VALIDATION', message: `The file "${filename}" could not be read.` } }
  }

  try {
    const parsed = parseAsciiGrid(bytes.toString('utf8'), input.verticalUnit, input.noDataValue)
    if (!parsed.ok) {
      const message = parseMessages[parsed.reason]
      const errors = parsed.reason === 'missing-nodata-value' ? [{ name: 'noDataValue', message }] : undefined
      return { ok: false, error: { code: 'VALIDATION', message, ...(errors && { errors }) } }
    }
    const id = createHash('sha256').update(bytes).digest('hex')
    const target = join(dir, `${id}.asc`)
    const stored = existsSync(target) ? readFileSync(target) : undefined
    if (!stored?.equals(bytes)) writeAssetFile(target, bytes)
    try {
      const data = repos.terrain.add({ id, filename: filename.slice(0, 255), bytes: bytes.byteLength }, input.noDataValue)
      return { ok: true, data }
    } catch (error) {
      if (!stored) rmSync(target, { force: true })
      throw error
    }
  } catch (e) {
    console.error('[terrain] import failed', e)
    return { ok: false, error: { code: 'INTERNAL', message: 'The terrain grid could not be stored. See application log.' } }
  }
}

export function readTerrainFile(id: string, dir: string, repos: Repositories): TerrainGrid {
  const { asset, noDataValue } = repos.terrain.get(id)
  let bytes: Buffer
  try {
    bytes = readFileSync(join(dir, `${asset.id}.${asset.format}`))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('The stored terrain file is missing.')
    throw e
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.id) {
    throw new ValidationError('The stored terrain file has changed. Import the grid again.')
  }
  // Import requires confirmed metres. Keep the user’s sentinel across restarts.
  const parsed = parseAsciiGrid(bytes.toString('utf8'), 'm', noDataValue)
  if (!parsed.ok) throw new ValidationError(parseMessages[parsed.reason])
  return parsed.grid
}
