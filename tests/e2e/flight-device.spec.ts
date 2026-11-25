import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DEVICE_BUTTONS } from '../../src/features/flight/device-buttons'
import { STANDARD_AXES } from '../../src/features/input/calibration'
import { playStationButtons } from '../../src/features/input/playstation'
import { createProject, launchApp } from './helpers'

const library = (page: Page) => page.getByTestId('part-library')
const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

// Reuse the ready-quad fixture values and setup from flight-live.spec.ts:25–80.
type Api = {
  components: {
    list(): Promise<{ ok: true; data: { id: string; name: string }[] }>
    setFill(id: string, key: string, spec: unknown): Promise<{ ok: boolean }>
  }
  projects: { list(): Promise<{ ok: true; data: { id: string; name: string }[] }> }
}

/**
 * The propulsion spec's quad (four MN3110 KV470 with P13*4.4 on a Tattu 4S pack, 550 mm diagonal, 300 g frame),
 * with the two values no source states for these parts entered as a user would: the rotor inertia and the pack's
 * internal resistance (library gap-fills), plus the body drag. The environment values are entered when asked.
 */
async function buildQuad(page: Page, name: string, { environment }: { environment: boolean }) {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const all = (await api.components.list()).data
    const byName = (n: string) => all.find((c) => c.name === n)!
    await api.components.setFill(byName('MN3110 KV470').id, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' })
    // The air density of T-Motor's bench table: no source states it, so it is the user's entry for that data.
    await api.components.setFill(byName('MN3110 KV470').id, 'referenceDensity', { value: 1.225, unit: 'kg/m³', source: 'user', condition: 'bench air, as stated by the user' })
    await api.components.setFill(byName('Tattu G-Tech 5200mAh 4S 35C').id, 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire AC, 1 kHz, 25 °C' })
  })
  await createProject(page, name)
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await commit(page, 'frame-motorDiagonal', '550')
  for (let n = 1; n <= 4; n++) {
    await page.getByTestId(`mount-motor-${n}`).click()
    await library(page).getByRole('button', { name: 'Motor' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470' })
    await library(page).getByRole('button', { name: 'Propeller' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  }
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } }) // deselect: the battery goes on the frame
  await library(page).getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  if (environment) {
    await commit(page, 'ground-friction', '0.6')
    await commit(page, 'ground-restitution', '0.1')
    await expect(page.getByTestId('environment-ready')).toBeVisible()
  }
  // Let the debounced save reach the database before leaving the workshop.
  await page.waitForTimeout(600)
}

async function openFlight(page: Page, name: string) {
  const id = await page.evaluate(async (n) => {
    const api = (window as unknown as { api: Api }).api
    return (await api.projects.list()).data.find((p) => p.name === n)!.id
  }, name)
  await page.evaluate((i) => (location.hash = `#/flight/${i}`), id)
  await expect(page.getByTestId('flight-test')).toBeVisible()
}

const padId = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'

// Same renderer fake as input.spec.ts:8–24, with a distinct ID for this fixture.
async function setPad(page: Page, present: boolean, pressed?: keyof typeof DEVICE_BUTTONS) {
  await page.evaluate(({ id, present, pressed, buttonCount }) => {
    const previous = navigator.getGamepads()[0]
    const pad = present ? {
      id, index: 0, mapping: 'standard', connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: buttonCount }, (_, index) => ({ value: Number(index === pressed), pressed: index === pressed })),
    } : null
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
    if (Boolean(previous) !== present) {
      const event = new Event(present ? 'gamepadconnected' : 'gamepaddisconnected')
      Object.defineProperty(event, 'gamepad', { value: pad ?? previous })
      window.dispatchEvent(event)
    }
  }, { id: padId, present, pressed, buttonCount: playStationButtons('DualSense').length })
}

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
    // Test data uses the saved pref shape in prefs.ts:25–42 and the sweep endpoints in input.spec.ts:46–62.
    await page.evaluate(({ id, axes }) => {
      const calibration = Object.fromEntries(Object.entries(axes).map(([stick, axis]) =>
        [stick, { axis, min: -1, trim: 0, max: 1, deadZone: 0, reverse: false }]))
      localStorage.setItem(`input.calibration.${id}`, JSON.stringify(calibration))
    }, { id: padId, axes: STANDARD_AXES })
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
