import { open } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { MAX_PACK_BYTES } from '../components/pack'
import { ValidationError } from '../db/repositories'
import {
  endSchema, FLOAT_BYTES, Frame, FRAME_BYTES, headerSchema, PREAMBLE_BYTES, preamble, ROW_COUNT_BYTES, textFrame,
} from '../telemetry/format'
import { checked, fileBlocks, parseJson, readExactly } from './container'

export async function validateRecording(path: string, run: {
  id: string; projectId: string; incomplete: boolean; sampleCount: number
}) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (!(await readExactly(file, PREAMBLE_BYTES, 0)).equals(preamble())) {
      throw new ValidationError('Invalid recording signature or version.')
    }
    let offset = PREAMBLE_BYTES
    let header
    let headerEnd = offset
    let samples = 0
    let ended = false
    while (offset < size) {
      if (run.incomplete && size - offset < FRAME_BYTES) break
      const prefix = await readExactly(file, FRAME_BYTES, offset)
      const type = prefix.readUInt8()
      const length = prefix.readUInt32LE(1)
      offset += FRAME_BYTES
      if (crc32(prefix.subarray(0, 5)) !== prefix.readUInt32LE(5)) {
        throw new ValidationError('Invalid recording frame header checksum.')
      }
      if (length > size - offset && run.incomplete) break
      if (ended || (!header && type !== Frame.header) || length > size - offset) {
        throw new ValidationError('Unexpected or truncated recording frame.')
      }
      let checksum = 0
      for await (const block of fileBlocks(file, length, offset)) checksum = crc32(block, checksum)
      if (checksum !== prefix.readUInt32LE(9)) throw new ValidationError('Recording frame checksum mismatch.')
      if (type === Frame.header || type === Frame.end || type === Frame.request) {
        if (length > MAX_PACK_BYTES) throw new ValidationError('Recording JSON frame is too large.')
        const value = parseJson(await readExactly(file, length, offset), 'recording frame')
        if (type === Frame.header) {
          if (header) throw new ValidationError('Duplicate recording header.')
          header = checked(headerSchema, value, 'Recording header')
          if (header.runId !== run.id || header.projectId !== run.projectId) {
            throw new ValidationError('Recording header does not match its run.')
          }
          headerEnd = offset + length
        } else if (type === Frame.end) {
          checked(endSchema, value, 'Recording end')
          ended = true
          if (offset + length !== size) throw new ValidationError('Unexpected bytes after the recording end.')
        } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ValidationError('Invalid recording request.')
        }
      } else if (type === Frame.samples && header && length >= ROW_COUNT_BYTES) {
        const rows = (await readExactly(file, ROW_COUNT_BYTES, offset)).readUInt32LE()
        if (!rows || length !== ROW_COUNT_BYTES + rows * header.channels.length * FLOAT_BYTES) {
          throw new ValidationError('Invalid recording sample frame.')
        }
        samples += rows
      } else {
        throw new ValidationError('Unknown recording frame.')
      }
      offset += length
    }
    if (!header || (!ended && !run.incomplete) || samples !== run.sampleCount) {
      throw new ValidationError('Recording data does not match its stored run.')
    }
    return { header, headerEnd, size }
  } finally {
    await file.close()
  }
}

export async function reidentifyRecording(
  source: string, target: string, info: Awaited<ReturnType<typeof validateRecording>>, runId: string, projectId: string,
): Promise<number> {
  const input = await open(source, 'r')
  try {
    const output = await open(target, 'wx')
    try {
      const json = JSON.stringify({ ...info.header, runId, projectId })
      const frame = textFrame(Frame.header, json, Buffer.byteLength(json))
      await output.writeFile(preamble())
      await output.writeFile(frame)
      for await (const block of fileBlocks(input, info.size - info.headerEnd, info.headerEnd)) await output.writeFile(block)
      await output.sync()
      return PREAMBLE_BYTES + frame.length + info.size - info.headerEnd
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}
