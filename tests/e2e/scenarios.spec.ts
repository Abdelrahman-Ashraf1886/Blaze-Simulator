import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-scenarios-'))
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
const shot = (name: string) => join(__dirname, '../../test-results', `scenarios-${name}.png`)

type Api = {
  components: {
    list(): Promise<{ ok: true; data: { id: string; name: string }[] }>
    setFill(id: string, key: string, spec: unknown): Promise<{ ok: boolean }>
  }
  projects: { list(): Promise<{ ok: true; data: { id: string; name: string }[] }> }
}

/**
 * The flight test's quad (four MN3110 KV470 with P13*4.4 on a Tattu 4S pack, 550 mm diagonal, 300 g frame), with
 * the two values no source states for these parts entered as a user would (the rotor inertia, the pack's internal
 * resistance), the air density the motor's bench data was taken at, the body drag and the ground's values.
 * The flight conditions (altitude, cut-off) are entered later.
 */
async function buildQuad(page: Page, name: string) {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const all = (await api.components.list()).data
    const byName = (n: string) => all.find((c) => c.name === n)!
    await api.components.setFill(byName('MN3110 KV470').id, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' })
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
  await commit(page, 'ground-friction', '0.6')
  await commit(page, 'ground-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
  // Let the debounced save reach the database before leaving the workshop.
  await page.waitForTimeout(600)
}

async function open(page: Page, name: string, route: 'scenarios' | 'flight') {
  const id = await page.evaluate(async (n) => {
    const api = (window as unknown as { api: Api }).api
    return (await api.projects.list()).data.find((p) => p.name === n)!.id
  }, name)
  await page.evaluate(([r, i]) => (location.hash = `#/${r}/${i}`), [route, id])
  await expect(page.getByTestId(route === 'scenarios' ? 'scenarios-page' : 'flight-test')).toBeVisible()
}

test('scenarios: the checklist gates the page; a ready build runs balanced hover and it passes', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await buildQuad(page, 'Scenario quad')
  await open(page, 'Scenario quad', 'scenarios')

  // The page lists the five built-ins; the build is complete but the flight conditions are the user's entries.
  await expect(page.getByTestId('scenario-list').locator('> li')).toHaveCount(5)
  const item = (id: string) => page.locator(`[data-testid=scenarios-blocker][data-item="${id}"]`)
  await expect(page.getByTestId('scenarios-blockers')).toBeVisible()
  await expect(page.getByTestId('scenarios-blocker')).toHaveCount(2)
  await expect(item('flight-altitude')).toBeVisible()
  await expect(item('flight-cutoff')).toBeVisible()
  await expect(page.getByTestId('scenarios-ready')).toHaveCount(0)
  await expect(page.getByTestId('scenario-run-balanced_hover')).toBeDisabled()
  await expect(page.getByTestId('scenario-run-all')).toBeDisabled()
  await page.screenshot({ path: shot('checklist') })

  // An item links to its field, on the flight page where the conditions are entered.
  await item('flight-altitude').getByRole('button').click()
  await expect(page.getByTestId('flight-test')).toBeVisible()
  await expect(page.getByTestId('flight-altitude')).toBeFocused()
  await commit(page, 'flight-altitude', '0')

  // A cut-off is still missing: the checklist shows exactly that, and nothing runs.
  await open(page, 'Scenario quad', 'scenarios')
  await expect(page.getByTestId('scenarios-blocker')).toHaveCount(1)
  await expect(item('flight-cutoff')).toBeVisible()
  await expect(page.getByTestId('scenario-run-balanced_hover')).toBeDisabled()
  await page.getByTestId('scenario-run-balanced_hover').click({ force: true })
  await expect(page.getByTestId('scenario-result-balanced_hover')).toHaveCount(0)
  await item('flight-cutoff').getByRole('button').click()
  await expect(page.getByTestId('flight-cutoff-value')).toBeFocused()
  await commit(page, 'flight-cutoff-value', '12')

  await open(page, 'Scenario quad', 'scenarios')
  await expect(page.getByTestId('scenarios-ready')).toBeVisible()
  await expect(page.getByTestId('scenarios-blockers')).toHaveCount(0)
  await expect(page.getByTestId('scenarios-conditions')).toContainText('1.225 kg/m³')
  await expect(page.getByTestId('scenarios-conditions')).toContainText('12 V')
  await expect(page.getByTestId('scenario-run-balanced_hover')).toBeEnabled()

  // Balanced hover: no entry needed; the engine flies it and every check passes.
  await page.getByTestId('scenario-run-balanced_hover').click()
  await expect(page.getByTestId('scenario-verdict-balanced_hover')).toHaveAttribute('data-passed', 'true', { timeout: 60_000 })
  await expect(page.getByTestId('scenario-verdict-balanced_hover')).toHaveText('Pass')
  const checks = page.getByTestId('scenario-check-balanced_hover')
  expect(await checks.count()).toBeGreaterThanOrEqual(3)
  for (const row of await checks.all()) {
    await expect(row).toHaveAttribute('data-passed', 'true')
    await expect(row.locator('td').nth(1)).not.toContainText('none')
  }
  await expect(page.getByTestId('scenario-summary-balanced_hover')).toContainText('Time flown')
  await expect(page.getByTestId('scenario-summary-balanced_hover')).toContainText('20 s')
  await expect(page.getByTestId('scenario-summary-balanced_hover')).toContainText('Flew the full duration')
  await page.screenshot({ path: shot('balanced-hover') })

  // A scenario with a parameter says what it needs, and runs once it is entered.
  await expect(page.getByTestId('scenario-run-payload')).toBeDisabled()
  await expect(page.getByTestId('scenario-need-payload')).toContainText('payload mass')
  await commit(page, 'scenario-payload-mass', '200')
  await expect(page.getByTestId('scenario-need-payload')).toHaveCount(0)
  await page.getByTestId('scenario-run-payload').click()
  await expect(page.getByTestId('scenario-verdict-payload')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('scenario-changes-payload')).toContainText('Added 200 g')
  await expect(page.getByTestId('scenario-error-payload')).toHaveCount(0)

  // Run all: every scenario that has what it needs runs, one after the other; the one still missing its entry does not.
  await page.getByTestId('scenario-run-all').click()
  await expect(page.getByTestId('scenario-run-all')).toBeEnabled({ timeout: 120_000 })
  for (const name of ['balanced_hover', 'payload', 'overweight_payload', 'com_offset_beyond_authority']) {
    await expect(page.getByTestId(`scenario-result-${name}`)).toBeVisible()
  }
  await expect(page.getByTestId('scenario-result-com_offset')).toHaveCount(0)
  await expect(page.getByTestId('scenario-need-com_offset')).toContainText('offset')
  for (const name of ['balanced_hover', 'payload']) await expect(page.getByTestId(`scenario-verdict-${name}`)).toHaveText('Pass')
  // The two that pass by failing the way the engine predicts say so.
  for (const name of ['overweight_payload', 'com_offset_beyond_authority']) {
    await expect(page.getByTestId(`scenario-verdict-${name}`)).toHaveText('Pass: the predicted failure happened')
    await expect(page.getByTestId(`scenario-verdict-${name}`)).toHaveAttribute('data-passed', 'true')
  }
  await expect(page.getByTestId('scenario-summary-com_offset_beyond_authority')).toContainText('5 s')
  await commit(page, 'scenario-com-offset', '5')
  await page.getByTestId('scenario-run-com_offset').click()
  await expect(page.getByTestId('scenario-verdict-com_offset')).toHaveAttribute('data-passed', 'true', { timeout: 60_000 })
  await expect(page.getByTestId('scenario-changes-com_offset')).toContainText('Moved part')
  expect(await page.getByTestId('scenario-check-com_offset').count()).toBeGreaterThanOrEqual(5)
  await page.screenshot({ path: shot('all'), fullPage: true })

  expect(errors).toEqual([])
})
