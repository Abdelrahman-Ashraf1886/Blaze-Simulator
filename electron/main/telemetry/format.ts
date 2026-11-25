/**
 * Blaze recording v1 (documentation/plans/phase-7-telemetry.md:45,47-50).
 * userData/recordings/<run UUID>.blzr starts with ASCII BLZR and a uint32
 * version. All integers and IEEE 754 doubles are little-endian.
 *
 * Every frame is u8 type, u32 payload length, u32 CRC-32 of those first five
 * bytes, u32 CRC-32 of the payload, then the payload. CRC-32 is IEEE
 * (ISO-HDLC). Type 0 is the UTF-8 JSON RecordingHeader and comes first.
 * Type 1 is u32 row count then float64 columns in header order for each row.
 * Float64 preserves JS/engine doubles and signed zero without float32
 * rounding. NaN represents missing; Infinity is outside the format.
 * Type 2 is one UTF-8 request line, including its original newline if any.
 * Replay uses the header's verbatim load and start text before these lines.
 * Type 3 is UTF-8 JSON RecordingEnd and terminates the file.
 *
 * Sample i is at (firstSampleStep + i * samplePeriodSteps) * stepLengthS.
 * A partial frame is ignored. Before a whole header exists, the summary has
 * no header. A whole frame with a mismatched CRC is an integrity error.
 */
import { crc32 } from 'node:zlib'
import { z } from 'zod'
import type { RecordingEnd, RecordingHeader } from '../../ipc/contract'

export const RECORDING_EXTENSION = '.blzr'
export const MAGIC = Buffer.from('BLZR', 'ascii')
export const VERSION = 1
export const PREAMBLE_BYTES = MAGIC.length + 4
export const FRAME_BYTES = 13
export const ROW_COUNT_BYTES = 4
export const FLOAT_BYTES = Float64Array.BYTES_PER_ELEMENT
export const MAX_FRAME_PAYLOAD = 0xffffffff
export const Frame = { header: 0, samples: 1, request: 2, end: 3 } as const

export const runIdSchema = z.uuid()

export function recordingFileName(id: string): string {
  return runIdSchema.parse(id) + RECORDING_EXTENSION
}

export const headerSchema: z.ZodType<RecordingHeader> = z.object({
  runId: runIdSchema,
  projectId: z.uuid(),
  projectName: z.string(),
  kind: z.enum(['flight', 'scenario', 'step-test']),
  title: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  appVersion: z.string(),
  engineVersion: z.string(),
  protocolVersion: z.int().nonnegative(),
  samplePeriodSteps: z.int().positive(),
  stepLengthS: z.number().positive(),
  firstSampleStep: z.int().nonnegative(),
  channels: z.array(z.object({ name: z.string().min(1), unit: z.string(), label: z.string() })).nonempty(),
  vehicleLoad: z.string(),
  startRequest: z.string(),
}).refine(({ channels }) => new Set(channels.map(({ name }) => name)).size === channels.length, 'Duplicate recording channel')

export const endSchema: z.ZodType<RecordingEnd> = z.object({
  status: z.enum(['completed', 'aborted', 'failed']),
  reason: z.string(),
  elapsedS: z.number().nonnegative(),
  finalStateHash: z.string().nullable(),
  engineError: z.string().nullable(),
})

export class RecordingFormatError extends Error {}

export function preamble(): Buffer {
  const bytes = Buffer.alloc(PREAMBLE_BYTES)
  MAGIC.copy(bytes)
  bytes.writeUInt32LE(VERSION, MAGIC.length)
  return bytes
}

export function frame(type: number, length: number, fill: (payload: Buffer) => void): Buffer {
  const bytes = Buffer.allocUnsafe(FRAME_BYTES + length)
  const payload = bytes.subarray(FRAME_BYTES)
  fill(payload)
  bytes.writeUInt8(type)
  bytes.writeUInt32LE(length, 1)
  bytes.writeUInt32LE(crc32(bytes.subarray(0, 5)), 5)
  bytes.writeUInt32LE(crc32(payload), 9)
  return bytes
}

export function textFrame(type: number, text: string, length: number): Buffer {
  return frame(type, length, (payload) => { payload.write(text, 'utf8') })
}

export function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, name: string): T {
  try {
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)))
  } catch {
    throw new RecordingFormatError(`Invalid recording ${name}`)
  }
}
