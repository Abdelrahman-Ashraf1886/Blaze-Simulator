import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { EngineSupervisor } from '../../electron/main/engine/supervisor'
import { createLogger } from '../../electron/main/logging/logger'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

it('logs stderr and an unexpected sidecar exit without launching an engine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blaze-engine-log-'))
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  const logger = createLogger(directory)
  const supervisor = new EngineSupervisor({
    binaryPath: 'fake-engine',
    maxRestarts: 0,
    log: (line, level) => logger.write(level ?? 'info', 'engine', line),
  })
  try {
    supervisor.start()
    child.stderr.end('sidecar failure detail\n')
    child.stdout.end()
    child.emit('exit', 1, null)
    expect(supervisor.status.state).toBe('failed')
    const entries = (await logger.readLogs()).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', source: 'engine', message: '[engine] sidecar failure detail' }),
      expect.objectContaining({ level: 'error', source: 'engine', message: '[engine] Engine exited unexpectedly (exit code 1)' }),
    ]))
  } finally {
    await supervisor.stop()
    await rm(directory, { force: true, recursive: true })
  }
})
