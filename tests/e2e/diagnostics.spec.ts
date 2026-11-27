import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi } from '../../electron/ipc/contract'
import { launchApp } from './helpers'

test('logs renderer and main errors and offers to reload a lost renderer', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blaze-e2e-crashes-'))
  const logPath = join(userData, 'logs', 'main.log')
  const readLog = () => readFile(logPath, 'utf8').catch(() => '')
  let running: ElectronApplication | undefined
  try {
    const { app, page } = await launchApp(userData)
    running = app
    await app.evaluate(({ dialog }, path) => {
      dialog.showErrorBox = (_title, detail) => console.log('Observed crash dialog', detail.includes(path))
      dialog.showMessageBox = async () => {
        console.log('Observed renderer reload dialog')
        return { response: 0, checkboxChecked: false }
      }
      setTimeout(() => { throw new Error('diagnostics-main-exception') }, 0)
    }, logPath)
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('diagnostics-window-error') }, 0)
    })
    await expect.poll(readLog).toContain('diagnostics-window-error')
    await expect.poll(async () => {
      await page.evaluate(() => { void Promise.reject(new Error('diagnostics-window-rejection')) })
      return readLog()
    }).toContain('unhandledrejection: Error: diagnostics-window-rejection')
    await expect.poll(readLog).toContain('uncaughtException: Error: diagnostics-main-exception')
    await expect.poll(readLog).toContain('Observed crash dialog true')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
    await expect.poll(readLog).toContain('render-process-gone: crashed')
    await expect.poll(readLog).toContain('Observed renderer reload dialog')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      return !contents.isCrashed() && !contents.isLoading()
    })).toBe(true)
  } finally {
    await running?.close()
    await rm(userData, { recursive: true, force: true })
  }
})

test('previews diagnostics and saves a local ZIP through the preload API', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blaze-e2e-diagnostics-'))
  let running: ElectronApplication | undefined
  try {
    const { app, page } = await launchApp(userData)
    running = app
    const path = join(userData, 'diagnostics.zip')
    await app.evaluate(({ dialog, shell }, paths) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.zip })
      shell.openPath = async (target) => target === paths.logs ? '' : 'Unexpected log folder'
    }, { zip: path, logs: join(userData, 'logs') })
    expect(await page.evaluate(() => {
      const api = (window as unknown as { api: DesktopApi }).api
      return api.diagnostics.openLogFolder()
    })).toEqual({ ok: true, data: null })
    const preview = await page.evaluate(() => {
      const api = (window as unknown as { api: DesktopApi }).api
      return api.diagnostics.save({ action: 'preview', includeDatabase: false })
    })
    expect(preview).toEqual({ ok: true, data: { entries: [
      { name: 'logs/main.log', description: expect.stringContaining('user file paths') },
      { name: 'system.json', description: expect.any(String) },
      { name: 'recordings.json', description: expect.any(String) },
    ] } })
    const saved = await page.evaluate(() => {
      const api = (window as unknown as { api: DesktopApi }).api
      return api.diagnostics.save({ action: 'save', includeDatabase: false })
    })
    expect(saved).toEqual({ ok: true, data: { path } })
    const zip = await readFile(path)
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
  } finally {
    await running?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
