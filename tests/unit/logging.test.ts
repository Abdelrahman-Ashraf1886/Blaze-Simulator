import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCrashHandlers } from '../../electron/main/logging/crashes'
import { createLogger } from '../../electron/main/logging/logger'

describe('application log', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'blaze-log-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('keeps a record exactly at the limit and discards the oldest rotated file', async () => {
    const message = 'é'
    const maxBytes = Buffer.byteLength(JSON.stringify({
      time: new Date().toISOString(), level: 'info', source: 'main', message,
    }) + '\n')
    const logger = createLogger(directory, { maxBytes, fileCount: 3 })
    logger.write('info', 'main', message)
    await logger.flush()
    expect(await readdir(directory)).toEqual(['main.log'])
    expect((await readFile(logger.path)).length).toBe(maxBytes)
    for (const next of ['ø', 'á', 'ä']) logger.write('info', 'main', next)
    const combined = (await logger.readLogs()).toString('utf8')
    expect((await readdir(directory)).sort()).toEqual(['main.log', 'main.log.1', 'main.log.2'])
    expect(combined.trimEnd().split('\n').map((line) => JSON.parse(line).message)).toEqual(['ø', 'á', 'ä'])
  })

  it('writes async bursts in call order as single-line JSON', async () => {
    const logger = createLogger(directory)
    const messages = Array.from({ length: 1000 }, (_, index) => `entry ${index}\nnext line`)
    await Promise.all(messages.map(async (message) => { logger.write('warn', 'engine', message) }))
    const entries = (await logger.readLogs()).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(entries.map((entry) => entry.message)).toEqual(messages)
    expect(entries[0]).toMatchObject({ time: expect.any(String), level: 'warn', source: 'engine' })
  })

  it('reports a write failure and retries preparation on the next write', async () => {
    const blocked = join(directory, 'logs')
    const fallback = vi.fn(() => { throw new Error('console unavailable') })
    await writeFile(blocked, '')
    const logger = createLogger(blocked, { fallback })
    logger.write('error', 'main', 'failed')
    await logger.flush()
    expect(fallback).toHaveBeenCalledWith('Could not write application log:', expect.any(Error), expect.stringContaining('failed'))
    await rename(blocked, join(directory, 'previous'))
    logger.write('info', 'main', 'recovered')
    expect((await logger.readLogs()).toString('utf8')).toContain('recovered')
  })
})

describe('crash handlers', () => {
  const setup = () => {
    const logger = { write: vi.fn(), path: 'logs/main.log', flush: vi.fn(async () => {}) }
    const ui = { showError: vi.fn(), offerReload: vi.fn(async () => true) }
    const contents = { isDestroyed: () => false, isCrashed: () => true, reload: vi.fn() }
    const crashes = createCrashHandlers(logger, ui)
    return { crashes, logger, ui, contents, webContents: contents as unknown as WebContents }
  }

  it.each(['uncaughtException', 'unhandledRejection'] as const)('logs %s and shows the log path once', async (event) => {
    const { crashes, logger, ui } = setup()
    crashes[event](new Error('first failure'))
    crashes.uncaughtException(new Error('second failure'))
    crashes.unhandledRejection('third failure')
    expect(ui.showError).not.toHaveBeenCalled()
    await logger.flush()
    expect(logger.write).toHaveBeenCalledTimes(3)
    expect(logger.write).toHaveBeenNthCalledWith(1, 'error', 'main', expect.stringContaining(`${event}: Error: first failure`))
    expect(ui.showError).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.stringContaining(logger.path))
  })

  it('logs a lost renderer and reloads only when accepted', async () => {
    const { crashes, logger, ui, contents, webContents } = setup()
    const details = { reason: 'crashed', exitCode: 1 } as const
    ui.offerReload.mockResolvedValueOnce(false)
    await crashes.rendererGone(webContents, details)
    expect(contents.reload).not.toHaveBeenCalled()
    await crashes.rendererGone(webContents, details)
    expect(logger.write).toHaveBeenCalledWith('error', 'renderer', 'render-process-gone: crashed (exit code 1)')
    expect(ui.offerReload).toHaveBeenCalledWith(webContents, expect.objectContaining({
      buttons: ['Reload', 'Dismiss'], detail: expect.stringContaining(logger.path),
    }))
    expect(contents.reload).toHaveBeenCalledTimes(1)
  })

  it.each(['GPU', 'Utility'])('logs an abnormal %s exit', (type) => {
    const { crashes, logger } = setup()
    crashes.childGone({ type, reason: 'clean-exit', exitCode: 0 })
    crashes.childGone({ type, reason: 'crashed', exitCode: 1 })
    expect(logger.write).toHaveBeenCalledExactlyOnceWith('error', 'main', `child-process-gone: ${type}: crashed (exit code 1)`)
  })
})
