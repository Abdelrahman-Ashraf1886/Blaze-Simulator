import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

export type ZipEntry = { name: string; data: Buffer | string }

// ZIP32, stored entries with UTF-8 names and streaming data descriptors.
const UINT32_MAX = 0xffff_ffff
const UINT16_MAX = 0xffff
const DESCRIPTOR_AND_UTF8 = 0x0808
const ZIP_VERSION = 20
const DOS_DATE_MIN = 0x21 // January 1, 1980

function zip32(value: number): number {
  if (value >= UINT32_MAX) throw new Error('Diagnostics exceeds the ZIP32 size limit')
  return value
}

async function* archive(entries: readonly ZipEntry[]) {
  if (entries.length >= UINT16_MAX) throw new Error('Too many diagnostics entries')
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const start = offset
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(ZIP_VERSION, 4)
    header.writeUInt16LE(DESCRIPTOR_AND_UTF8, 6)
    header.writeUInt16LE(DOS_DATE_MIN, 12)
    header.writeUInt16LE(name.length, 26)
    yield header
    yield name

    let size = 0
    let checksum = 0
    const chunks = typeof entry.data === 'string' ? createReadStream(entry.data) : [entry.data]
    for await (const chunk of chunks) {
      size = zip32(size + chunk.length)
      checksum = crc32(chunk, checksum)
      yield chunk
    }

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50)
    descriptor.writeUInt32LE(checksum, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    offset = zip32(offset + header.length + name.length + size + descriptor.length)
    yield descriptor

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(ZIP_VERSION, 4)
    central.writeUInt16LE(ZIP_VERSION, 6)
    central.writeUInt16LE(DESCRIPTOR_AND_UTF8, 8)
    central.writeUInt16LE(DOS_DATE_MIN, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(start, 42)
    directory.push(central, name)
  }

  let length = 0
  for (const block of directory) {
    length += block.length
    yield block
  }
  const end = Buffer.alloc(22)
  zip32(offset + length + end.length)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(length, 12)
  end.writeUInt32LE(offset, 16)
  yield end
}

export async function writeZip(path: string, entries: readonly ZipEntry[]): Promise<void> {
  await pipeline(archive(entries), createWriteStream(path, { flags: 'wx' }))
}
