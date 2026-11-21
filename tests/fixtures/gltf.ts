/**
 * Builds small glTF 2.0 test files in memory: a box mesh with real vertex and
 * index data, so the same fixture is valid for the validator and for three.js.
 */

export interface BoxOptions {
  /** Box size along the file's X, Y, Z, in file units. */
  size: [number, number, number]
  /** Centre of the box in file coordinates. */
  centre?: [number, number, number]
  /** Optional node transform. */
  node?: { translation?: number[]; rotation?: number[]; scale?: number[] }
}

function boxData({ size, centre = [0, 0, 0] }: BoxOptions) {
  const h = size.map((v) => v / 2)
  const min = centre.map((c, i) => c - h[i]!)
  const max = centre.map((c, i) => c + h[i]!)
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0]! : min[0]!
    positions[i * 3 + 1] = i & 2 ? max[1]! : min[1]!
    positions[i * 3 + 2] = i & 4 ? max[2]! : min[2]!
  }
  // prettier-ignore
  const indices = new Uint16Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, // -Z, +Z
    0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, // -Y, +Y
    0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5, // -X, +X
  ])
  const bin = new Uint8Array(96 + 72)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 96)
  return { bin, min, max }
}

function boxJson(opts: BoxOptions, buffer: Record<string, unknown>) {
  const { min, max } = boxData(opts)
  return {
    asset: { version: '2.0', generator: 'Blaze UAV test fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...opts.node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 72, target: 34963 },
    ],
    buffers: [{ byteLength: 168, ...buffer }],
  }
}

/** Packs a glTF JSON object and an optional binary chunk into a GLB container. */
export function packGlb(json: unknown, bin?: Uint8Array): Buffer {
  const pad = (n: number) => (4 - (n % 4)) % 4
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad(jsonBytes.length), 0x20)])
  const parts: Buffer[] = []
  const header = Buffer.alloc(12)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonBytes.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  parts.push(header, jsonHeader, jsonBytes)
  if (bin) {
    const binBytes = Buffer.concat([Buffer.from(bin), Buffer.alloc(pad(bin.length))])
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binBytes.length, 0)
    binHeader.writeUInt32LE(0x004e4942, 4)
    parts.push(binHeader, binBytes)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  return Buffer.concat(parts)
}

/** A valid GLB containing one box. */
export function boxGlb(opts: BoxOptions): Buffer {
  return packGlb(boxJson(opts, {}), boxData(opts).bin)
}

/** A valid self-contained .gltf (buffer embedded as a data URI). */
export function boxGltf(opts: BoxOptions): Buffer {
  const uri = `data:application/octet-stream;base64,${Buffer.from(boxData(opts).bin).toString('base64')}`
  return Buffer.from(JSON.stringify(boxJson(opts, { uri })), 'utf8')
}

/** A .gltf whose buffer points at another file: must be rejected. */
export function externalBufferGltf(uri = 'box.bin'): Buffer {
  return Buffer.from(JSON.stringify(boxJson({ size: [1, 1, 1] }, { uri })), 'utf8')
}

/** Box GLB with extra JSON merged in (e.g. an external image or a required extension). */
export function boxGlbWith(extra: Record<string, unknown>, opts: BoxOptions = { size: [1, 1, 1] }): Buffer {
  return packGlb({ ...boxJson(opts, {}), ...extra }, boxData(opts).bin)
}
