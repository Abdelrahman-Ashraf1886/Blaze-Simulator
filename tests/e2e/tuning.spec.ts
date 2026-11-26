import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi } from '../../electron/ipc/contract'
import { createProject, launchApp, trackErrors } from './helpers'

const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

// Same ready catalogue build and user entries as flight-live.spec.ts:33–70,102–105.
async function prepareQuad(page: Page, name: string) {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: DesktopApi }).api
    const result = await api.components.list()
    if (!result.ok) throw new Error(result.error.message)
    const byName = (name: string) => result.data.find((c) => c.name === name)!.id
    await api.components.setFill(byName('MN3110 KV470'), 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' })
    await api.components.setFill(byName('MN3110 KV470'), 'referenceDensity', { value: 1.225, unit: 'kg/m³', source: 'user', condition: 'bench air, as stated by the user' })
    await api.components.setFill(byName('Tattu G-Tech 5200mAh 4S 35C'), 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire AC, 1 kHz, 25 °C' })
  })
  await createProject(page, name)
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  const partLibrary = page.getByTestId('part-library')
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await commit(page, 'frame-motorDiagonal', '550')
  for (let n = 1; n <= 4; n++) {
    await page.getByTestId(`mount-motor-${n}`).click()
    await partLibrary.getByRole('button', { name: 'Motor' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470' })
    await partLibrary.getByRole('button', { name: 'Propeller' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  }
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await partLibrary.getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  await commit(page, 'ground-friction', '0.6')
  await commit(page, 'ground-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
  await page.getByTestId('nav-/flight').click()
  await page.getByRole('link', { name, exact: true }).click()
  await commit(page, 'flight-altitude', '0')
  await commit(page, 'flight-cutoff-value', '12')
  await expect(page.getByTestId('flight-ready')).toBeVisible()
}

test('saved project tuning drives a step test and shows metrics and exact signals', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'blazeuav-tuning-'))
  const { app, page } = await launchApp(userData)
  try {
    const errors = trackErrors(page)
    const project = 'Tuning quad'
    await prepareQuad(page, project)
    await page.getByTestId('nav-/tuning').click()
    await page.getByRole('link', { name: project, exact: true }).click()

    const exactSignals = 'The signals are exact (no sensor noise, filtering or delay), so responses look better than on a real vehicle.'
    await expect(page.getByText(exactSignals, { exact: true })).toBeVisible()
    const roll = page.getByLabel('MC_ROLL_P', { exact: true })
    await expect(roll).toBeEnabled()
    const gain = Number(await roll.inputValue()) / 2 // Derived user edit from the PX4 default shown in the tuning panel.
    await roll.fill(String(gain))
    const returnAltitude = page.getByLabel('RTL_RETURN_ALT', { exact: true })
    const returnDefault = Number(await returnAltitude.inputValue())
    await expect(page.getByLabel('RTL_DESCEND_ALT', { exact: true })).toBeEnabled()
    await expect(page.getByLabel('NAV_ACC_RAD', { exact: true })).toBeEnabled()
    await returnAltitude.fill(String(returnDefault / 2))
    await expect(page.getByText('Unsaved gains. Step tests use the last saved gains.')).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('All changes saved')).toBeVisible()

    const run = page.getByRole('button', { name: 'Run step test' })
    await run.click()
    await expect(page.getByText('Enter an amplitude.')).toBeVisible()
    await page.getByLabel('Step', { exact: true }).selectOption('Roll rate')
    // Roll-rate test fixture in engine-core/src/step_test/tests.rs:44–47.
    await page.getByLabel('Amplitude (rad/s)', { exact: true }).fill(String(10 * Math.PI / 180))
    await page.getByLabel('Hold (s)', { exact: true }).fill('1')
    await page.getByLabel('Duration (s, including hold)', { exact: true }).fill('10')
    await page.getByLabel('Decimation (simulation steps per sample)', { exact: true }).fill('1')
    await run.click()
    await expect(page.getByRole('heading', { name: 'Metrics', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Steady-state error', { exact: true })).toBeVisible()
    const signals = page.getByText(exactSignals, { exact: true })
    await expect(signals).toHaveCount(2)
    await expect(signals.nth(0)).toBeVisible()
    await expect(signals.nth(1)).toBeVisible()
    const gains = page.locator('section', { has: page.getByRole('heading', { name: 'Gains used', exact: true }) })
    await expect(gains.locator('dt', { hasText: /^MC_ROLL_P$/ }).locator('xpath=following-sibling::dd')).toHaveText(String(gain))
    await expect(gains.getByText('RTL_RETURN_ALT', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Reset RTL_RETURN_ALT', exact: true }).click()
    await expect(returnAltitude).toHaveValue(String(returnDefault))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('All changes saved')).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
