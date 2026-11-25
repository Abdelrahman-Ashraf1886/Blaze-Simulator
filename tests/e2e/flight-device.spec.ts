import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQuad, commit, launchApp, openFlight, savePadCalibration, setPad } from './helpers'

test('flies a calibrated device, pauses on disconnect, resumes, lands, and accepts Return', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'blazeuav-flight-device-'))
  const { app, page } = await launchApp(userData)
  try {
    const name = 'Device flight quad'
    await buildQuad(page, name, { environment: true })
    await openFlight(page, name)
    await page.bringToFront()
    await setPad(page, true)
    const input = page.getByTestId('flight-input-source')
    await input.selectOption({ label: 'DualSense · Index 0 · Needs calibration' })
    await expect(page.getByRole('link', { name: 'Calibrate in Input devices' })).toBeVisible()
    await savePadCalibration(page)
    await page.getByTestId('flight-mode').selectOption('position')
    await expect(input.locator('option:checked')).toHaveText('DualSense · Index 0')
    await commit(page, 'flight-altitude', '0')
    await commit(page, 'flight-cutoff-value', '12')
    await page.getByTestId('flight-start').click()

    const status = page.getByTestId('flight-status')
    const automatic = page.getByTestId('flight-auto-status')
    await expect(status).toHaveText('Running')
    await setPad(page, true, 0) // Cross (gamepad_standard_mappings.h:55)
    await expect(automatic).toContainText('Hold · Finished', { timeout: 30_000 })

    await setPad(page, true, 9) // Options (gamepad_standard_mappings.h:64)
    await expect(status).toContainText('Paused manually')
    const returnButton = page.getByRole('button', { name: 'Return', exact: true })
    await expect(returnButton).toBeDisabled()
    await setPad(page, true, 4) // L1 (playstation.ts:19–23)
    await expect(automatic).toContainText('Hold · Finished')
    await setPad(page, true)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(status).toHaveText('Running')

    await setPad(page, false)
    await expect(status).toHaveText('Paused · Input device disconnected')
    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    await expect(resume).toBeDisabled()
    const time = page.getByTestId('flight-debug').getByText('Time', { exact: true }).locator('xpath=following-sibling::dd')
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const pausedTime = await time.innerText()

    await setPad(page, true)
    await expect(resume).toBeEnabled()
    await expect(time).toHaveText(pausedTime)
    await expect(page.getByTestId('flight-device-sticks')).toContainText('throttle 0')
    await resume.click()
    await expect(status).toHaveText('Running')
    await expect(time).not.toHaveText(pausedTime)
    await setPad(page, true, 1) // Circle (gamepad_standard_mappings.h:56)
    await expect(automatic).toContainText('Land · Finished', { timeout: 30_000 })
    await expect(page.getByRole('list', { name: 'Land detection' })).toContainText('Landed yes')
    await expect(returnButton).toBeEnabled()
    await setPad(page, true, 4) // L1 (playstation.ts:19–23)
    await expect(automatic).toContainText('Return · Finished')
    await expect(page.getByTestId('flight-return-state')).toContainText('Landed')
    await page.getByTestId('flight-stop').click()
    await expect(status).toHaveText('Stopped')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
