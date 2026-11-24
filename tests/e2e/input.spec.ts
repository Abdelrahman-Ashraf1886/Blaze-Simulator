import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STANDARD_AXES, STICKS, stickNames } from '../../src/features/input/calibration'
import { launchApp } from './helpers'

async function setPad(page: Page, axes: number[] | null) {
  await page.evaluate((values) => {
    const previous = navigator.getGamepads()[0]
    const pad = values === null ? null : {
      id: 'Calibration test pad', index: 0, mapping: 'standard', connected: true,
      axes: values, buttons: [{ value: 1, pressed: true }],
    }
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
    const event = pad && !previous
      ? new Event('gamepadconnected')
      : previous && !pad ? new Event('gamepaddisconnected') : null
    if (event) {
      Object.defineProperty(event, 'gamepad', { value: pad ?? previous })
      window.dispatchEvent(event)
    }
  }, axes)
}

test('calibrates a renderer gamepad, persists it, and cancels a sweep on disconnect', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'blaze-input-'))
  const { app, page } = await launchApp(userData)
  try {
    await setPad(page, null)
    await page.getByTestId('nav-/input').click()
    await expect(page.getByText('No input devices detected.')).toBeVisible()
    await expect(page.getByText(/press a button on it/)).toBeVisible()
    await setPad(page, [0, 0, 0, 0])
    const device = page.getByRole('button', { name: /Calibration test pad/ })
    await device.click()
    await expect(page.getByText('standard', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Buttons', { exact: true }).getByText('1.000', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Save calibration' }).click()
    const forward = page.getByRole('group', { name: 'Forward', exact: true })
    await expect(forward.getByText('Choose an available axis.')).toBeVisible()
    await page.getByRole('button', { name: 'Use standard gamepad preset' }).click()
    await expect(forward.getByLabel('Axis', { exact: true })).toHaveValue(String(STANDARD_AXES.forward))

    const rawAxes = page.getByLabel('Axes', { exact: true })
    for (const stick of stickNames) {
      const group = page.getByRole('group', { name: STICKS[stick], exact: true })
      await group.getByRole('button', { name: 'Start sweep' }).click()
      for (const endpoint of [-1, 1]) {
        const axes = [0, 0, 0, 0]
        axes[STANDARD_AXES[stick]] = endpoint
        await setPad(page, axes)
        await expect(rawAxes.getByText(endpoint.toFixed(3), { exact: true })).toBeVisible()
      }
      await group.getByRole('button', { name: 'Finish sweep' }).click()
      await setPad(page, [0, 0, 0, 0])
      await expect(rawAxes.getByText('0.000', { exact: true })).toHaveCount(4)
      if (stick === 'throttle') {
        await group.getByLabel('Does throttle self-centre?').selectOption('midpoint')
      } else {
        await group.getByRole('button', { name: 'Capture centre' }).click()
      }
    }
    await setPad(page, [1, -1, 1, -1])
    await expect(page.getByText('Live preview 1.000', { exact: true })).toHaveCount(4)
    await forward.getByLabel('Reverse').check()
    await expect(forward.getByText('Live preview -1.000', { exact: true })).toBeVisible()
    await forward.getByLabel('Dead zone (optional)').fill('1')
    await expect(forward.getByText(/Use a dead zone smaller/)).toBeVisible()
    await forward.getByLabel('Dead zone (optional)').fill('0')
    await page.getByRole('button', { name: 'Save calibration' }).click()
    await expect(page.getByText('Calibration saved.')).toBeVisible()

    await forward.getByRole('button', { name: 'Start sweep' }).click()
    await setPad(page, null)
    await expect(page.getByText(/Device disconnected. Unsaved calibration was discarded/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save calibration' })).toHaveCount(0)
    await setPad(page, [0, 0, 0, -1])
    await device.click()
    await expect(forward.getByLabel('Reverse')).toBeChecked()
    await expect(forward.getByText('Live preview -1.000', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
