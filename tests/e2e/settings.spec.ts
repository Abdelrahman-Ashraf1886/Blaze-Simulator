import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GPU_PREFERENCE_FILE } from '../../electron/main/gpu-preference'
import { ignoreRealMouse } from './helpers'

test('shows the drawing card and persists the graphics preference across a restart', async () => {
  const root = process.cwd()
  const userData = mkdtempSync(join(tmpdir(), 'blazeuav-e2e-graphics-'))
  const launch = () => electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  })
  let running: ElectronApplication | undefined
  try {
    running = await launch()
    const page = await running.firstWindow()
    await ignoreRealMouse(running)
    await page.getByTestId('nav-/settings').click()
    await expect(page.getByRole('heading', { name: 'Graphics' })).toBeVisible()
    await expect(page.getByTestId('drawing-card')).toHaveText(/^(?!Detecting…$|Unavailable$).+/)
    await expect(page.getByRole('radio', { name: 'High performance' })).toBeChecked()
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_high_performance_gpu'))).toBe(true)

    await page.getByRole('radio', { name: 'Power saving' }).click()
    await expect(page.getByRole('radio', { name: 'Power saving' })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Restart now' })).toBeEnabled()
    expect(JSON.parse(readFileSync(join(userData, GPU_PREFERENCE_FILE), 'utf8'))).toEqual({ preference: 'power-saving' })
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_low_power_gpu'))).toBe(false)

    await running.close()
    running = await launch()
    const restarted = await running.firstWindow()
    await ignoreRealMouse(running)
    await restarted.getByTestId('nav-/settings').click()
    await expect(restarted.getByRole('radio', { name: 'Power saving' })).toBeChecked()
    await expect(restarted.getByRole('button', { name: 'Restart now' })).toBeDisabled()
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_low_power_gpu'))).toBe(true)
  } finally {
    await running?.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
