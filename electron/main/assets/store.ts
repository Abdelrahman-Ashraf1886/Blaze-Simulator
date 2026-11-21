/**
 * The asset store: validated model files in `<userData>/assets/<sha256>.<format>`.
 * Content addressed, so importing the same bytes twice stores them once.
 * No Electron imports; main wires the dialog and the `blaze-asset://` protocol.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ASSET_SCHEME, MAX_ASSET_BYTES, type AssetInfo, type IpcResult } from '../../ipc/contract'
import type { Repositories } from '../db/repositories'
import { AssetError, inspectGltf, tooLarge } from './gltf'

export function importAssetFile(path: string, dir: string, repos: Repositories): IpcResult<AssetInfo> {
  try {
    const filename = basename(path)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw new AssetError(`The file "${filename}" could not be read.`)
    }
    // Checked before reading, so an oversized file is never loaded into memory.
    if (size > MAX_ASSET_BYTES) throw new AssetError(tooLarge(size))
    const bytes = readFileSync(path)
    const facts = inspectGltf(bytes, filename)
    const id = createHash('sha256').update(bytes).digest('hex')

    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${id}.${facts.format}`)
    if (!existsSync(target)) {
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, target)
    }
    const info = repos.assets.add({ id, filename: filename.slice(0, 255), bytes: bytes.byteLength, ...facts })
    return { ok: true, data: info }
  } catch (e) {
    if (e instanceof AssetError) return { ok: false, error: { code: 'VALIDATION', message: e.message } }
    console.error('[assets] import failed', e)
    return { ok: false, error: { code: 'INTERNAL', message: 'The model could not be imported. See application log.' } }
  }
}

/**
 * Maps `blaze-asset://model/<sha256>` to a file in the store, or null. Only ids
 * of the exact form are accepted, so no request can reach outside the folder.
 */
export function resolveAssetUrl(url: string, dir: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== 'model') return null
  const id = /^\/([0-9a-f]{64})$/.exec(parsed.pathname)?.[1]
  if (!id) return null
  for (const ext of ['glb', 'gltf']) {
    const file = join(dir, `${id}.${ext}`)
    if (existsSync(file)) return file
  }
  return null
}

/** Deletes stored files whose asset no longer exists (after `repos.assets.collectGarbage`). */
export function removeAssetFiles(dir: string, ids: readonly string[]): void {
  for (const id of ids) {
    for (const ext of ['glb', 'gltf']) {
      try {
        unlinkSync(join(dir, `${id}.${ext}`))
      } catch {
        // already gone
      }
    }
  }
}
