import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RecordingEnd, RecordingHeader } from '../../ipc/contract'
import {
  endSchema, FLOAT_BYTES, Frame, frame, FRAME_BYTES, headerSchema,
  MAX_FRAME_PAYLOAD, preamble, ROW_COUNT_BYTES, textFrame,
} from './format'

export interface RecordingOutput {
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface RecordingWriterOptions {
  /** Budget for encoded frames, including the frame currently being written. */
  maxPendingBytes: number
  openFile?: (path: string, flags: 'wx') => Promise<RecordingOutput>
  onSettled: (result: RecordingWriteResult) => void
}

export interface RecordingWriteResult {
  ownsFile: boolean
  bytes: number
  sampleCount: number
  end: RecordingEnd | null
  failure: string | null
}

interface PendingFrame {
  bytes: Buffer
  rows: number
}

/** One sample frame per supplied row batch. Overflow fails the recording instead of stalling the caller. */
export class RecordingWriter {
  private file: RecordingOutput | undefined
  private readonly queue: PendingFrame[] = []
  private pendingBytes = 0
  private bytes = 0
  private sampleCount = 0
  private failure: string | null = null
  private drain: Promise<void> | undefined
  private closing: Promise<RecordingWriteResult> | undefined

  private constructor(
    private readonly columns: number,
    private readonly options: RecordingWriterOptions,
  ) {}

  static async start(path: string, header: RecordingHeader, options: RecordingWriterOptions): Promise<RecordingWriter | null> {
    const writer = new RecordingWriter(header.channels.length, options)
    try {
      if (!Number.isSafeInteger(options.maxPendingBytes) || options.maxPendingBytes <= 0) {
        throw new Error('Invalid recording byte budget')
      }
      const prefix = preamble()
      const start = writer.jsonFrame(Frame.header, headerSchema.parse(header), prefix.length)
      await mkdir(dirname(path), { recursive: true })
      writer.file = await (options.openFile ?? open)(path, 'wx')
      await writer.write(prefix)
      await writer.write(start)
      return writer
    } catch (error) {
      writer.fail(error)
      await writer.closing
      return null
    }
  }

  appendSamples(rows: readonly (readonly (number | null)[])[]): boolean {
    if (this.closing) return false
    if (rows.length === 0) return true
    const length = ROW_COUNT_BYTES + rows.length * this.columns * FLOAT_BYTES
    return this.enqueue(length, rows.length, () => frame(Frame.samples, length, (payload) => {
      payload.writeUInt32LE(rows.length)
      let offset = ROW_COUNT_BYTES
      for (const row of rows) {
        if (row.length !== this.columns) throw new Error('Recording sample has the wrong number of columns')
        for (const value of row) {
          if (value !== null && !Number.isFinite(value)) throw new Error('Recording sample is not finite')
          payload.writeDoubleLE(value ?? NaN, offset)
          offset += FLOAT_BYTES
        }
      }
    }))
  }

  appendRequest(line: string): boolean {
    if (this.closing) return false
    const length = Buffer.byteLength(line, 'utf8')
    return this.enqueue(length, 0, () => textFrame(Frame.request, line, length))
  }

  finish(end: RecordingEnd): Promise<RecordingWriteResult> {
    this.closing ??= this.close({ ...end })
    return this.closing
  }

  abort(end: Omit<RecordingEnd, 'status'>): Promise<RecordingWriteResult> {
    return this.finish({ ...end, status: 'aborted' })
  }

  private checkSize(payload: number, pending: number): void {
    if (payload > MAX_FRAME_PAYLOAD || FRAME_BYTES + payload + pending > this.options.maxPendingBytes) {
      throw new Error('Recording write buffer exceeded its byte budget')
    }
  }

  private jsonFrame(type: number, value: RecordingHeader | RecordingEnd, pending = 0): Buffer {
    const text = JSON.stringify(value)
    const length = Buffer.byteLength(text, 'utf8')
    this.checkSize(length, pending)
    return textFrame(type, text, length)
  }

  private enqueue(length: number, rows: number, encode: () => Buffer): boolean {
    try {
      this.checkSize(length, this.pendingBytes)
      const bytes = encode()
      this.queue.push({ bytes, rows })
      this.pendingBytes += bytes.length
      this.drain ??= Promise.resolve().then(() => this.flush())
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  private async flush(): Promise<void> {
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!
        await this.write(item.bytes)
        this.pendingBytes -= item.bytes.length
        this.sampleCount += item.rows
      }
    } catch (error) {
      this.queue.length = 0
      this.fail(error)
    } finally {
      this.drain = undefined
    }
  }

  private async write(buffer: Buffer): Promise<void> {
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await this.file!.write(buffer, offset, buffer.length - offset)
      if (bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw new Error('Invalid recording write length')
      offset += bytesWritten
      this.bytes += bytesWritten
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error.message : String(error)
    this.closing ??= this.close(null)
  }

  private async close(end: RecordingEnd | null): Promise<RecordingWriteResult> {
    await this.drain
    try {
      if (end && !this.failure) {
        await this.write(this.jsonFrame(Frame.end, endSchema.parse(end)))
        await this.file?.sync()
      }
    } catch (error) {
      this.fail(error)
    } finally {
      try {
        await this.file?.close()
      } catch (error) {
        this.fail(error)
      }
    }
    const result = {
      ownsFile: this.file !== undefined,
      bytes: this.bytes,
      sampleCount: this.sampleCount,
      end: this.failure ? null : end,
      failure: this.failure,
    }
    try {
      this.options.onSettled(result)
    } catch (error) {
      console.error('[recordings] could not update the run after writing', error)
    }
    return result
  }
}
