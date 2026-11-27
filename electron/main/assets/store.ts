/**
 * The asset store: validated model files in `<userData>/assets/<sha256>.<format>`.
 * Content addressed, so importing the same bytes twice stores them once.
 * No Electron imports; main wires the dialog and the `blaze-asset://` protocol.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ASSET_SCHEME, MAX_ASSET_BYTES, type AssetInfo, type IpcResult } from '../../ipc/contract'
import type { Repositories } from '../db/repositories'
import { BoundedFileError, readBoundedFile, readBoundedFileSync } from './bounded-file'
import { AssetError } from './gltf'
import { inspectModel, modelHull } from './hull'
import { inspectModelAsync, modelHullAsync } from './hull-async'

function modelReadError(error: unknown, filename: string): AssetError {
  return new AssetError(error instanceof BoundedFileError ? `${error.message} The limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB.` : `The file "${filename}" could not be read.`)
}

function storeModel(bytes: Buffer, filename: string, dir: string, repos: Repositories, { facts, hull }: ReturnType<typeof inspectModel>): AssetInfo {
  const id = createHash('sha256').update(bytes).digest('hex')
  const target = join(dir, `${id}.${facts.format}`)
  if (!existsSync(target)) writeAssetFile(target, bytes)
  return repos.assets.add({ id, filename: filename.slice(0, 255), bytes: bytes.byteLength, ...facts, hull })
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
    const filename = basename(path)
    let bytes: Buffer
    try {
      bytes = readBoundedFileSync(path, MAX_ASSET_BYTES)
    } catch (error) {
      throw modelReadError(error, filename)
    }
    return { ok: true, data: storeModel(bytes, filename, dir, repos, inspectModel(bytes, filename)) }
  } catch (e) {
    return failure(e)
  }
}

/** As `importAssetFile`, with the hull computed on a worker thread so main's event loop stays free. */
export async function importAssetFileAsync(path: string, dir: string, repos: Repositories): Promise<IpcResult<AssetInfo>> {
  try {
    const filename = basename(path)
    const bytes = await readBoundedFile(path, MAX_ASSET_BYTES).catch((error: unknown) => { throw modelReadError(error, filename) })
    const inspected = await inspectModelAsync(bytes, filename)
    const data = inspected.bytes
    return { ok: true, data: storeModel(Buffer.from(data.buffer, data.byteOffset, data.byteLength), filename, dir, repos, inspected.model) }
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
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat?.isFile() && stat.nlink === 1 && stat.size <= MAX_ASSET_BYTES) return file
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
    repos.assets.setHull(a.id, modelHull(readBoundedFileSync(file, MAX_ASSET_BYTES), a.format, a.bounds))
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
    repos.assets.setHull(a.id, await modelHullAsync(await readBoundedFile(file, MAX_ASSET_BYTES), a.format, a.bounds))
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
