/**
 * .blazeproj v1 is uncompressed. ASCII BLAZEPROJ and a uint32 LE manifest length
 * precede a UTF-8 JSON manifest. Raw entries follow in manifest order, with no
 * padding or footer. The manifest has version, appVersion, engineVersion and
 * entries, which lists each name, byte count and SHA-256 hex digest. project.json
 * comes first and follows the schema in document.ts. Assets and recordings
 * use their store file names, under assets/ and recordings/ respectively.
 *
 * JSON uses the component-pack limit (main/components/pack.ts:22). Assets use
 * the model-import limit (ipc/contract.ts:243), also applied to terrain in transit.
 * Recordings stream with a uint32 entry size (telemetry/format.ts:31).
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDefaultHighWaterMark } from 'node:stream'
import { z } from 'zod'
import { MAX_ASSET_BYTES } from '../../ipc/contract'
import { MAX_PACK_BYTES } from '../components/pack'
import { ValidationError } from '../db/repositories'
import { MAX_FRAME_PAYLOAD, RECORDING_EXTENSION, recordingFileName, runIdSchema } from '../telemetry/format'

export const PROJECT_EXTENSION = 'blazeproj'
export const PROJECT_FILE = 'project.json'
const FORMAT_VERSION = 1
const MAGIC = Buffer.from('BLAZEPROJ', 'ascii')
const PREFIX_BYTES = MAGIC.length + Uint32Array.BYTES_PER_ELEMENT
const BLOCK_BYTES = getDefaultHighWaterMark(false)
const decoder = new TextDecoder('utf-8', { fatal: true })
const recordingPrefix = 'recordings/'
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const recordingEntry = (id: string): string => recordingPrefix + recordingFileName(id)

function checkEntry(name: string, bytes: number): void {
  let limit: number
  if (name === PROJECT_FILE) limit = MAX_PACK_BYTES
  else if (/^assets\/[a-f0-9]{64}\.(asc|glb|gltf)$/.test(name)) limit = MAX_ASSET_BYTES
  else if (
    name.startsWith(recordingPrefix) && name.endsWith(RECORDING_EXTENSION) &&
    runIdSchema.safeParse(name.slice(recordingPrefix.length, -RECORDING_EXTENSION.length)).success
  ) limit = MAX_FRAME_PAYLOAD
  else throw new ValidationError(`Invalid project entry path "${name}".`)
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) {
    throw new ValidationError(`Invalid or oversized entry "${name}" (limit ${limit} bytes).`)
  }
}

const manifestSchema = z.strictObject({
  version: z.literal(FORMAT_VERSION, { message: `Only project format version ${FORMAT_VERSION} is supported.` }),
  appVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  entries: z.array(z.strictObject({
    name: z.string().max('assets/'.length + 64 + '.gltf'.length),
    bytes: z.int().positive(),
    sha256: sha256Schema,
  })).nonempty(),
})
type Manifest = z.infer<typeof manifestSchema>
export type ProjectVersions = Pick<Manifest, 'appVersion' | 'engineVersion'>
type Entry = Manifest['entries'][number]
export type EntrySource = { name: string; bytes: Buffer } | { name: string; path: string; sha256?: string; size: number }

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export function parseJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw new ValidationError(`Invalid UTF-8 JSON in ${name}.`)
  }
}

export function checked<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]!
    throw new ValidationError(`${label} ${issue.path.join('.')}: ${issue.message}`)
  }
  return result.data
}

export async function readExactly(file: FileHandle, bytes: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(bytes)
  for (let offset = 0; offset < bytes;) {
    const { bytesRead } = await file.read(buffer, offset, bytes - offset, position + offset)
    if (bytesRead === 0) throw new ValidationError('The file ended unexpectedly.')
    offset += bytesRead
  }
  return buffer
}

export async function* fileBlocks(file: FileHandle, bytes: number, position = 0): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes;) {
    const block = await readExactly(file, Math.min(BLOCK_BYTES, bytes - offset), position + offset)
    yield block
    offset += block.length
  }
}

async function openRegular(path: string): Promise<FileHandle> {
  if (!(await lstat(path)).isFile()) throw new ValidationError('Choose a regular file.')
  return open(path, 'r')
}

async function transfer(blocks: AsyncIterable<Buffer>, destination?: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const block of blocks) {
    hash.update(block)
    if (destination) await destination.writeFile(block)
  }
  return hash.digest('hex')
}

async function transferSource(source: EntrySource, destination?: FileHandle): Promise<Entry> {
  if ('bytes' in source) {
    checkEntry(source.name, source.bytes.length)
    await destination?.writeFile(source.bytes)
    return { name: source.name, bytes: source.bytes.length, sha256: sha256(source.bytes) }
  }
  const file = await openRegular(source.path)
  try {
    const { size } = await file.stat()
    if (size !== source.size) throw new ValidationError(`"${source.name}" changed size or is incomplete.`)
    checkEntry(source.name, size)
    const digest = await transfer(fileBlocks(file, size), destination)
    if (source.sha256 !== undefined && digest !== source.sha256) {
      throw new ValidationError(`SHA-256 mismatch for "${source.name}".`)
    }
    return { name: source.name, bytes: size, sha256: digest }
  } finally {
    await file.close()
  }
}

export async function writeProjectFile(path: string, versions: ProjectVersions, sources: EntrySource[]): Promise<void> {
  const entries: Entry[] = []
  for (const source of sources) entries.push(await transferSource(source))
  const manifest = Buffer.from(JSON.stringify({ version: FORMAT_VERSION, ...versions, entries }))
  if (manifest.length > MAX_PACK_BYTES) throw new ValidationError('The project manifest is too large.')
  const prefix = Buffer.alloc(PREFIX_BYTES)
  MAGIC.copy(prefix)
  prefix.writeUInt32LE(manifest.length, MAGIC.length)

  const draft = join(dirname(path), `.blazeproj-export-${randomUUID()}.tmp`)
  const file = await open(draft, 'wx')
  try {
    try {
      await file.writeFile(prefix)
      await file.writeFile(manifest)
      for (const [index, source] of sources.entries()) {
        const entry = await transferSource(source, file)
        if (entry.sha256 !== entries[index]!.sha256) throw new ValidationError(`"${entry.name}" changed during export.`)
      }
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(draft, path)
  } finally {
    await rm(draft, { force: true })
  }
}

export async function readProjectFile<T>(path: string, consume: (reader: ProjectFileReader) => Promise<T>): Promise<T> {
  const file = await openRegular(path)
  try {
    const { size } = await file.stat()
    const prefix = await readExactly(file, PREFIX_BYTES, 0)
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new ValidationError('Invalid Blaze project file signature.')
    const length = prefix.readUInt32LE(MAGIC.length)
    if (length === 0 || length > MAX_PACK_BYTES) throw new ValidationError('Invalid or oversized project manifest.')
    const manifest = checked(manifestSchema, parseJson(await readExactly(file, length, PREFIX_BYTES), 'manifest'), 'Manifest')
    if (manifest.entries[0]?.name !== PROJECT_FILE) throw new ValidationError('project.json must come first.')
    let offset = PREFIX_BYTES + length
    const entries = new Map<string, Entry & { offset: number }>()
    for (const entry of manifest.entries) {
      checkEntry(entry.name, entry.bytes)
      if (entries.has(entry.name)) throw new ValidationError(`Duplicate project entry "${entry.name}".`)
      entries.set(entry.name, { ...entry, offset })
      offset += entry.bytes
      if (offset > size) throw new ValidationError('The project file is truncated.')
    }
    if (offset !== size) throw new ValidationError('Unexpected bytes after the project entries.')
    return await consume(new ProjectFileReader(file, entries))
  } finally {
    await file.close()
  }
}

class ProjectFileReader {
  constructor(private readonly file: FileHandle, readonly entries: ReadonlyMap<string, Entry & { offset: number }>) {}

  async metadata(): Promise<unknown> {
    const entry = this.entries.get(PROJECT_FILE)!
    const bytes = await readExactly(this.file, entry.bytes, entry.offset)
    this.checkHash(entry, sha256(bytes))
    return parseJson(bytes, PROJECT_FILE)
  }

  async extract(name: string, path: string): Promise<void> {
    const entry = this.entries.get(name)!
    const output = await open(path, 'wx')
    try {
      this.checkHash(entry, await transfer(fileBlocks(this.file, entry.bytes, entry.offset), output))
      await output.sync()
    } finally {
      await output.close()
    }
  }

  private checkHash(entry: Entry, digest: string): void {
    if (entry.sha256 !== digest) throw new ValidationError(`SHA-256 mismatch for "${entry.name}".`)
  }
}
