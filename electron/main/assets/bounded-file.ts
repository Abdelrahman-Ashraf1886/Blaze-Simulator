import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'

const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

export class BoundedFileError extends Error {}

function readBuffer(stat: Stats, limit: number): Buffer {
  if (!stat.isFile()) throw new BoundedFileError('The path is not a regular file.')
  if (stat.size > limit) throw new BoundedFileError('The file exceeds the byte limit.')
  // One extra byte detects growth without trusting a fresh path lookup.
  return Buffer.allocUnsafeSlow(stat.size + 1)
}

function checkedBytes(buffer: Buffer, count: number): Buffer {
  if (count !== buffer.length - 1) throw new BoundedFileError('The file changed while it was being read.')
  return buffer.subarray(0, count)
}

export function readBoundedFileSync(path: string, limit: number): Buffer {
  const fd = openSync(path, readFlags)
  try {
    const buffer = readBuffer(fstatSync(fd), limit)
    let count = 0
    while (count < buffer.length) {
      const bytes = readSync(fd, buffer, count, buffer.length - count, count)
      if (!bytes) break
      count += bytes
    }
    return checkedBytes(buffer, count)
  } finally {
    closeSync(fd)
  }
}

export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, readFlags)
  try {
    const buffer = readBuffer(await file.stat(), limit)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    return checkedBytes(buffer, count)
  } finally {
    await file.close()
  }
}
