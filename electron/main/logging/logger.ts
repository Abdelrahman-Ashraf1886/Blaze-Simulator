import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { formatWithOptions } from 'node:util'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogSource = 'main' | 'engine' | 'renderer'

// Milestone 8.2 calls for size-based rotation. Keep five 2 MiB files including the active log.
const MAX_BYTES = 2 * 1024 * 1024
const FILE_COUNT = 5

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function formatLog(...args: unknown[]): string {
  try {
    return formatWithOptions({ customInspect: false }, ...args)
  } catch {
    return '[Could not format log message]'
  }
}

export function createLogger(directory: string, {
  maxBytes = MAX_BYTES, fileCount = FILE_COUNT, fallback = console.error.bind(console),
} = {}) {
  const path = join(directory, 'main.log')
  const file = (index: number) => index === 0 ? path : `${path}.${index}`
  let bytes: number | undefined
  let pending = Promise.resolve()

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work)
    pending = result.then(() => {}, () => {})
    return result
  }

  async function rotate() {
    await rm(file(fileCount - 1), { force: true })
    for (let index = fileCount - 1; index > 0; index--) {
      try {
        await rename(file(index - 1), file(index))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }

  return {
    directory,
    path,
    write(level: LogLevel, source: LogSource, message: string): void {
      const record = { time: new Date().toISOString(), level, source, message }
      let line = JSON.stringify(record) + '\n'
      if (Buffer.byteLength(line) > maxBytes) {
        record.message = ''
        const overhead = Buffer.byteLength(JSON.stringify(record) + '…\n')
        // A UTF-16 code unit needs at most six bytes after JSON escaping.
        record.message = message.slice(0, Math.max(0, Math.floor((maxBytes - overhead) / 6))) + '…'
        line = JSON.stringify(record) + '\n'
      }
      void enqueue(async () => {
        try {
          const length = Buffer.byteLength(line)
          if (length > maxBytes) throw new Error('Log entry exceeds the file limit')
          if (bytes === undefined) {
            await mkdir(directory, { recursive: true })
            bytes = await stat(path).then((s) => s.size, (error: unknown) => {
              if (isMissing(error)) return 0
              throw error
            })
          }
          if (bytes + length > maxBytes) {
            await rotate()
            bytes = 0
          }
          await appendFile(path, line, 'utf8')
          bytes += length
        } catch (error) {
          bytes = undefined
          try {
            fallback('Could not write application log:', error, line.trimEnd())
          } catch {
            // Console output can also fail during shutdown.
          }
        }
      })
    },
    flush: () => pending,
    readLogs: () => enqueue(async () => {
      const logs: Buffer[] = []
      for (let index = fileCount - 1; index >= 0; index--) {
        try {
          logs.push(await readFile(file(index)))
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      return Buffer.concat(logs)
    }),
  }
}

export type Logger = ReturnType<typeof createLogger>

export function captureConsole(logger: Logger): void {
  const methods = { log: 'info', warn: 'warn', error: 'error' } as const
  for (const method of Object.keys(methods) as (keyof typeof methods)[]) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      logger.write(methods[method], 'main', formatLog(...args))
      original(...args)
    }
  }
}
