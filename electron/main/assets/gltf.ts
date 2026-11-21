/**
 * Validation and inspection of glTF 2.0 files before they enter the asset store.
 * Pure: takes bytes, returns facts or throws `AssetError` with a message meant
 * for the user. No Electron imports, so it is unit tested directly.
 *
 * Accepted: binary .glb, or .gltf whose buffers and images are all embedded
 * (data: URIs or GLB buffer views). Anything that references another file or a
 * URL is rejected, as are compression extensions the renderer has no decoder for.
 * References: Khronos glTF 2.0 specification, sections 3.6 (buffers), 3.7
 * (accessors; POSITION min/max are required) and 4.4 (GLB container).
 */
import { MAX_ASSET_BYTES, type Bounds3 } from '../../ipc/contract'

export class AssetError extends Error {}

const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a // "JSON"
const CHUNK_BIN = 0x004e4942 // "BIN\0"

/** Required extensions the renderer cannot decode (no decoders are bundled). */
const UNSUPPORTED_REQUIRED: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'meshopt compression',
  KHR_meshopt_compression: 'meshopt compression',
  KHR_texture_basisu: 'Basis Universal (KTX2) textures',
}

export interface GltfFacts {
  format: 'glb' | 'gltf'
  triangles: number
  bounds: Bounds3
}

export type Mat4 = number[] // 16 numbers, column-major as in glTF

export interface Gltf {
  asset?: { version?: unknown }
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[]
  accessors?: {
    count?: number
    min?: number[]
    max?: number[]
    bufferView?: number
    byteOffset?: number
    componentType?: number
    normalized?: boolean
    type?: string
    sparse?: {
      count: number
      indices: { bufferView: number; byteOffset?: number; componentType: number }
      values: { bufferView: number; byteOffset?: number }
    }
  }[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  buffers?: { uri?: string; byteLength?: number }[]
  images?: { uri?: string; bufferView?: number }[]
  extensionsRequired?: string[]
}

export function inspectGltf(bytes: Uint8Array, filename: string): GltfFacts {
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new AssetError(tooLarge(bytes.byteLength))
  if (bytes.byteLength === 0) throw new AssetError('The file is empty.')
  const ext = filename.toLowerCase().match(/\.(glb|gltf)$/)?.[1] as 'glb' | 'gltf' | undefined
  if (!ext) throw new AssetError('Only .glb and .gltf files can be imported.')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const isGlb = bytes.byteLength >= 4 && view.getUint32(0, true) === GLB_MAGIC
  let json: Gltf
  let binLength = 0
  if (ext === 'glb') {
    if (!isGlb) throw new AssetError('This is not a GLB file: it does not start with the "glTF" signature.')
    ;({ json, binLength } = readGlb(bytes, view))
  } else {
    if (isGlb) throw new AssetError('This file is binary GLB data; rename it to .glb.')
    json = parseJson(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  }

  if (typeof json.asset?.version !== 'string' || !json.asset.version.startsWith('2.')) {
    throw new AssetError('Only glTF 2.0 files are supported.')
  }
  for (const name of json.extensionsRequired ?? []) {
    const what = UNSUPPORTED_REQUIRED[name]
    if (what) throw new AssetError(`The file uses ${what} (${name}), which is not supported. Export it without compression.`)
  }
  checkBuffers(json, ext, binLength)
  checkImages(json)
  return { format: ext, ...measure(json) }
}

export const tooLarge = (bytes: number) =>
  `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB.`

export function readGlb(bytes: Uint8Array, view: DataView): { json: Gltf; binLength: number } {
  if (bytes.byteLength < 20) throw new AssetError('The GLB file is truncated.')
  const version = view.getUint32(4, true)
  if (version !== 2) throw new AssetError(`GLB version ${version} is not supported; only version 2 is.`)
  const length = view.getUint32(8, true)
  if (length !== bytes.byteLength) throw new AssetError('The GLB file is truncated or has trailing data.')
  const jsonLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > length) {
    throw new AssetError('The GLB file has no valid JSON chunk.')
  }
  const json = parseJson(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)))
  let binLength = 0
  const next = 20 + jsonLength
  if (next + 8 <= length) {
    const chunkLength = view.getUint32(next, true)
    if (view.getUint32(next + 4, true) === CHUNK_BIN) {
      if (next + 8 + chunkLength > length) throw new AssetError('The GLB binary chunk is truncated.')
      binLength = chunkLength
    }
  }
  return { json, binLength }
}

export function parseJson(text: string): Gltf {
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Gltf
  } catch {
    // fall through
  }
  throw new AssetError('The file is not valid glTF: its JSON could not be read.')
}

const isDataUri = (uri: string) => /^data:[^,]*,/i.test(uri)

function checkBuffers(json: Gltf, ext: 'glb' | 'gltf', binLength: number): void {
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (b.uri === undefined) {
      // Only the first buffer of a GLB may omit its URI: it is the binary chunk.
      if (ext !== 'glb' || i !== 0) throw new AssetError(`Buffer ${i} has no data.`)
      if ((b.byteLength ?? 0) > binLength) throw new AssetError('The GLB binary chunk is smaller than its buffer.')
    } else if (!isDataUri(b.uri)) {
      throw new AssetError(
        `The file references an external file or URL ("${short(b.uri)}"). Only self-contained files can be imported: export as .glb or with embedded buffers.`,
      )
    }
  }
}

function checkImages(json: Gltf): void {
  for (const img of json.images ?? []) {
    if (img.uri !== undefined && !/^data:image\/[a-z0-9.+-]+[;,]/i.test(img.uri)) {
      throw new AssetError(
        `The file references an external image ("${short(img.uri)}"). Only self-contained files can be imported: export as .glb or with embedded textures.`,
      )
    }
  }
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s)

// ---- Bounds and triangle count -------------------------------------------------

export function nodeMatrix(n: NonNullable<Gltf['nodes']>[number]): Mat4 {
  if (n.matrix?.length === 16) return n.matrix
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  // Column-major T * R * S.
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ]
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      out[c * 4 + r] = s
    }
  return out
}

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function primitiveTriangles(json: Gltf, p: NonNullable<NonNullable<Gltf['meshes']>[number]['primitives']>[number]): number {
  const mode = p.mode ?? 4
  const pos = p.attributes?.POSITION
  const count = p.indices !== undefined ? json.accessors?.[p.indices]?.count : pos !== undefined ? json.accessors?.[pos]?.count : 0
  const n = count ?? 0
  if (mode === 4) return Math.floor(n / 3)
  if (mode === 5 || mode === 6) return Math.max(0, n - 2)
  return 0 // points and lines
}

function measure(json: Gltf): { triangles: number; bounds: Bounds3 } {
  const nodes = json.nodes ?? []
  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene?.nodes ?? (json.scenes?.length ? [] : rootNodes(json))
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  let depth = 0

  const visit = (index: number, parent: Mat4) => {
    const node = nodes[index]
    if (!node) throw new AssetError(`The file refers to node ${index}, which does not exist.`)
    if (++depth > 1000) throw new AssetError('The node hierarchy is too deep or contains a loop.')
    const m = multiply(parent, nodeMatrix(node))
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]
      if (!mesh) throw new AssetError(`The file refers to mesh ${node.mesh}, which does not exist.`)
      for (const p of mesh.primitives ?? []) {
        triangles += primitiveTriangles(json, p)
        const pos = p.attributes?.POSITION
        if (pos === undefined) continue
        const acc = json.accessors?.[pos]
        if (!acc?.min || !acc.max || acc.min.length < 3 || acc.max.length < 3) {
          throw new AssetError('A mesh has no position bounds (accessor min/max, required by glTF 2.0). Re-export the file.')
        }
        for (const corner of corners(acc.min, acc.max)) {
          const w = transform(m, corner)
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i]!, w[i]!)
            max[i] = Math.max(max[i]!, w[i]!)
          }
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m)
    depth--
  }
  for (const r of roots) visit(r, IDENTITY)

  if (!Number.isFinite(min[0]!) || !Number.isFinite(max[0]!)) throw new AssetError('The file contains no meshes to display.')
  if (![...min, ...max].every(Number.isFinite)) throw new AssetError('The model has invalid coordinates.')
  return {
    triangles,
    bounds: { min: min as [number, number, number], max: max as [number, number, number] },
  }
}

/** Nodes that are nobody's child (used when a file has no scenes). */
export function rootNodes(json: Gltf): number[] {
  const children = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []))
  return (json.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i))
}

function corners(a: number[], b: number[]): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const x of [a[0]!, b[0]!]) for (const y of [a[1]!, b[1]!]) for (const z of [a[2]!, b[2]!]) out.push([x, y, z])
  return out
}

export function transform(m: Mat4, [x, y, z]: [number, number, number]): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}
