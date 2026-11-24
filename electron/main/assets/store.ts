/**
 * The asset store: validated model files in `<userData>/assets/<sha256>.<format>`.
 * Content addressed, so importing the same bytes twice stores them once.
 * No Electron imports; main wires the dialog and the `blaze-asset://` protocol.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ASSET_SCHEME, MAX_ASSET_BYTES, type AssetInfo, type IpcResult } from '../../ipc/contract'
import type { Repositories } from '../db/repositories'
import { AssetError, inspectGltf, tooLarge } from './gltf'
import { modelHull } from './hull'
import { modelHullAsync } from './hull-async'

/** Reads, validates and stores the file; everything but the hull. Throws AssetError for a bad file. */
function stageAsset(path: string, dir: string) {
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

  const target = join(dir, `${id}.${facts.format}`)
  if (!existsSync(target)) writeAssetFile(target, bytes)
  return { id, filename, bytes, facts }
}

export function writeAssetFile(target: string, bytes: Buffer): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function failure(e: unknown): IpcResult<never> {
  if (e instanceof AssetError) return { ok: false, error: { code: 'VALIDATION', message: e.message } }
  console.error('[assets] import failed', e)
  return { ok: false, error: { code: 'INTERNAL', message: 'The model could not be imported. See application log.' } }
}

/** Imports a model, computing its hull on the calling thread (blocks it; see `importAssetFileAsync`). */
export function importAssetFile(path: string, dir: string, repos: Repositories): IpcResult<AssetInfo> {
  try {
    const { id, filename, bytes, facts } = stageAsset(path, dir)
    const hull = modelHull(bytes, facts.format, facts.bounds)
    return { ok: true, data: repos.assets.add({ id, filename: filename.slice(0, 255), bytes: bytes.byteLength, ...facts, hull }) }
  } catch (e) {
    return failure(e)
  }
}

/** As `importAssetFile`, with the hull computed on a worker thread so main's event loop stays free. */
export async function importAssetFileAsync(path: string, dir: string, repos: Repositories): Promise<IpcResult<AssetInfo>> {
  try {
    const { id, filename, bytes, facts } = stageAsset(path, dir)
    const size = bytes.byteLength // the worker takes the bytes
    const hull = await modelHullAsync(bytes, facts.format, facts.bounds)
    return { ok: true, data: repos.assets.add({ id, filename: filename.slice(0, 255), bytes: size, ...facts, hull }) }
  } catch (e) {
    return failure(e)
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

/**
 * Computes the hull of every stored model imported before hulls existed (hull_json NULL),
 * from its file in the store. Returns the ids done. A missing file is skipped (its parts
 * keep colliding as their bounding box).
 */
export function backfillHulls(dir: string, repos: Repositories): string[] {
  const done: string[] = []
  for (const a of repos.assets.list()) {
    if (a.hull) continue
    const file = join(dir, `${a.id}.${a.format}`)
    if (!existsSync(file)) continue
    repos.assets.setHull(a.id, modelHull(readFileSync(file), a.format, a.bounds))
    done.push(a.id)
  }
  return done
}

/**
 * As `backfillHulls`, one model at a time on a worker thread, so startup does not wait for
 * it and main's event loop stays free. The first failure rejects (the models after it are
 * left for the next start), as `backfillHulls` throws.
 */
export async function backfillHullsAsync(dir: string, repos: Repositories): Promise<string[]> {
  const done: string[] = []
  for (const a of repos.assets.list()) {
    if (a.hull) continue
    const file = join(dir, `${a.id}.${a.format}`)
    if (!existsSync(file)) continue
    repos.assets.setHull(a.id, await modelHullAsync(readFileSync(file), a.format, a.bounds))
    done.push(a.id)
  }
  return done
}

/** Deletes stored files whose asset no longer exists (after `repos.assets.collectGarbage`). */
export function removeAssetFiles(dir: string, ids: readonly string[]): void {
  for (const id of ids) {
    for (const ext of ['glb', 'gltf', 'asc']) {
      try {
        unlinkSync(join(dir, `${id}.${ext}`))
      } catch {
        // already gone
      }
    }
  }
}
