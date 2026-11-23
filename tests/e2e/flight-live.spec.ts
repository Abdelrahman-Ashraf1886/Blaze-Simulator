import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-flight-live-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const library = (page: Page) => page.getByTestId('part-library')
const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}
/** Screenshots for the DEVLOG go to test-results/ (not committed by the test run). */
const shot = (name: string) => join(__dirname, '../../test-results', `flight-live-${name}.png`)

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

/** A world-vector readout of the debug panel as numbers, e.g. "Origin (world)" → [x, y, z]. */
const readout = async (page: Page, label: string) => {
  const text = await page.getByTestId('flight-debug').locator('dt', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }).locator('xpath=following-sibling::dd').innerText()
  return text.split('/').map((s) => Number.parseFloat(s))
}

test('live flight: a ready build starts, W climbs, release holds a vertical speed near 0', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await buildQuad(page, 'Live quad', { environment: true })
  await openFlight(page, 'Live quad')

  // Everything the build needs is stated or entered; the flight conditions (altitude, cut-off) are the user's.
  await expect(page.getByTestId('flight-blocker')).toHaveCount(3)
  await expect(page.getByTestId('flight-blocker').first()).toHaveAttribute('data-item', 'flight-altitude')
  await expect(page.getByTestId('flight-blocker').nth(1)).toHaveAttribute('data-item', 'flight-reference-density')
  await expect(page.getByTestId('flight-blocker').nth(2)).toHaveAttribute('data-item', 'flight-cutoff')
  await expect(page.getByTestId('flight-start')).toBeDisabled()
  await expect(page.getByText('Demo data')).toHaveCount(0)
  await commit(page, 'flight-altitude', '0')
  await expect(page.getByTestId('flight-blocker')).toHaveCount(2)
  // The propeller data's air density is the user's entry (APC states 1.225 kg/m³ for its files).
  await commit(page, 'flight-reference-density', '1.225')
  await expect(page.getByTestId('flight-blocker')).toHaveCount(1)
  await commit(page, 'flight-cutoff-value', '12')
  await expect(page.getByTestId('flight-ready')).toBeVisible()
  await expect(page.getByTestId('flight-blockers')).toHaveCount(0)
  await expect(page.getByTestId('flight-start')).toBeEnabled()

  await page.getByTestId('flight-start').click()
  await expect(page.getByTestId('flight-status')).toHaveText('Running')
  await expect(page.getByTestId('flight-error')).toHaveCount(0)
  // The live engine drives the readouts (time advances with real time); no demo labels while live.
  await expect.poll(async () => (await readout(page, 'Time'))[0]!, { timeout: 10_000 }).toBeGreaterThan(0.3)
  await expect(page.getByTestId('flight-debug')).not.toContainText('Demo telemetry')
  const z0 = (await readout(page, 'Origin (world)'))[2]!

  // Hold W for about a second: climb at up to 2 m/s. A loaded machine slows the simulation (it never
  // catches up), so wait for the climb rather than for a wall-clock second.
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(1000)
  await expect.poll(async () => (await readout(page, 'Origin (world)'))[2]!, { timeout: 20_000, intervals: [250] }).toBeGreaterThan(z0 + 0.1)
  const climbing = (await readout(page, 'Linear (world)'))[2]!
  await page.screenshot({ path: shot('climb') })
  expect(climbing).toBeGreaterThan(0.2)

  // Release: the controller holds a vertical speed of 0 (it does not hold an altitude).
  await page.keyboard.up('KeyW')
  await expect.poll(async () => Math.abs((await readout(page, 'Linear (world)'))[2]!), { timeout: 10_000, intervals: [250] }).toBeLessThan(0.3)
  await page.screenshot({ path: shot('released') })
  await expect(page.getByTestId('flight-status')).toHaveText('Running')

  await page.getByTestId('flight-stop').click()
  await expect(page.getByTestId('flight-status')).toHaveText('Stopped')

  // A charge cut-off ends the run, and the end reason is shown (the keys are cleared, the source stops).
  await page.getByTestId('flight-cutoff-type').selectOption('chargeMah')
  await expect(page.getByTestId('flight-start')).toBeDisabled() // the new type's value is not entered yet
  await commit(page, 'flight-cutoff-value', '1')
  await expect(page.getByTestId('flight-start')).toBeEnabled()
  await page.getByTestId('flight-start').click()
  await expect(page.getByTestId('flight-status')).toHaveText(/^Run ended: Charge cut-off at \d+\.\d{3} s$/, { timeout: 30_000 })
  await expect(page.getByTestId('flight-debug')).toContainText('Charge cut-off')
  await expect(page.getByTestId('flight-start')).toBeEnabled()
  expect(errors).toEqual([])
})

test('live flight: a build missing a cut-off or an environment value shows the checklist and cannot start', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await buildQuad(page, 'Unready quad', { environment: false })
  await openFlight(page, 'Unready quad')

  const items = page.getByTestId('flight-blocker')
  const item = (id: string) => page.locator(`[data-testid=flight-blocker][data-item="${id}"]`)
  await expect(page.getByTestId('flight-blockers')).toBeVisible()
  for (const id of ['ground-friction', 'ground-restitution', 'flight-altitude', 'flight-reference-density', 'flight-cutoff']) await expect(item(id)).toBeVisible()
  await expect(items).toHaveCount(5)
  await expect(page.getByTestId('flight-ready')).toHaveCount(0)
  await expect(page.getByTestId('flight-start')).toBeDisabled()
  await page.screenshot({ path: shot('checklist') })

  // Entering the conditions leaves the environment values: still no start.
  await commit(page, 'flight-altitude', '0')
  await commit(page, 'flight-reference-density', '1.225')
  await commit(page, 'flight-cutoff-value', '12')
  await expect(items).toHaveCount(2)
  await expect(page.getByTestId('flight-start')).toBeDisabled()
  await page.getByTestId('flight-start').click({ force: true })
  await expect(page.getByTestId('flight-status')).toHaveText('Stopped')

  // An item links to its field: the workshop's ground friction.
  await item('ground-friction').getByRole('button').click()
  await expect(page.getByTestId('ground-friction')).toBeFocused()
  expect(page.url()).toContain('#/workshop/')
  await commit(page, 'ground-friction', '0.6')
  await commit(page, 'ground-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
  await page.waitForTimeout(600)
  await openFlight(page, 'Unready quad')
  await expect(page.getByTestId('flight-ready')).toBeVisible()
  await expect(page.getByTestId('flight-start')).toBeEnabled()
  expect(errors).toEqual([])
})
