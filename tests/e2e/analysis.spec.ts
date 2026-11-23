import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-analysis-'))
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

type Api = {
  components: {
    list(): Promise<{ ok: true; data: { id: string; name: string }[] }>
    setFill(id: string, key: string, spec: unknown): Promise<{ ok: boolean }>
  }
  projects: { list(): Promise<{ ok: true; data: { id: string; name: string }[] }> }
}

/** The quad of the flight test spec: four MN3110 KV470 with P13*4.4 on a Tattu 4S pack, with the values no source states entered. */
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
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await library(page).getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  await page.waitForTimeout(600) // the debounced save reaches the database
}

async function projectId(page: Page, name: string) {
  return page.evaluate(async (n) => {
    const api = (window as unknown as { api: Api }).api
    return (await api.projects.list()).data.find((p) => p.name === n)!.id
  }, name)
}

test('the analysis page shows mass, CoM and T/W for a build, and links to the flight conditions it lacks', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await buildQuad(page, 'Analysis quad')
  const id = await projectId(page, 'Analysis quad')

  // The sidebar entry is enabled; without a project it offers the projects.
  await page.getByTestId('nav-/analysis').click()
  await expect(page.getByRole('heading', { name: 'Engineering Analysis' })).toBeVisible()
  await page.getByRole('link', { name: 'Analysis quad' }).click()
  await expect(page.getByTestId('analysis-page')).toBeVisible()

  // Mass properties: total, CoM with its unit, the inertia tensor, nothing missing.
  await expect(page.getByTestId('analysis-mass-total')).toHaveText(/^\d+\.\d$/)
  expect(Number(await page.getByTestId('analysis-mass-total').innerText())).toBeGreaterThan(300)
  await expect(page.getByTestId('analysis-com-x')).toHaveText(/^-?\d+\.\d$/)
  await expect(page.getByTestId('analysis-com-z')).toBeVisible()
  await expect(page.getByTestId('analysis-com-offset')).toBeVisible()
  await expect(page.getByTestId('analysis-inertia-00')).toBeVisible()
  await expect(page.getByTestId('analysis-mass-missing')).toHaveCount(0)
  await expect(page.getByTestId('analysis-hover-table')).toBeVisible()
  await expect(page.getByTestId('analysis-density-row')).toHaveCount(4)

  // No flight conditions yet: T/W says so and links to the field.
  await expect(page.getByTestId('analysis-thrust')).toHaveAttribute('data-state', 'unknown')
  await expect(page.getByTestId('analysis-altitude-missing')).toBeVisible()
  await expect(page.getByTestId('analysis-condition-item')).toHaveCount(2)
  await page.getByTestId('analysis-altitude-missing').getByRole('button').click()
  await expect(page.getByTestId('flight-test')).toBeVisible()
  await expect(page.getByTestId('flight-altitude')).toBeFocused()

  // Entering the conditions gives the maximum T/W at that air density.
  await commit(page, 'flight-altitude', '0')
  await commit(page, 'flight-cutoff-value', '12')
  await page.waitForTimeout(600)
  await page.evaluate((i) => (location.hash = `#/analysis/${i}`), id)
  await expect(page.getByTestId('analysis-page')).toBeVisible()
  await expect(page.getByTestId('analysis-thrust')).toContainText(/Maximum T\/W \d+\.\d{2}/)
  await expect(page.getByTestId('analysis-air')).toHaveText('1.225')
  await expect(page.getByTestId('analysis-tw')).toHaveText(/^\d+\.\d{2}$/)
  await expect(page.getByTestId('analysis-motor-max-row')).toHaveCount(4)
  await expect(page.getByTestId('analysis-principal-1')).toHaveText(/^\d+\.\d{6}$/)
  await expect(page.getByTestId('analysis-altitude-missing')).toHaveCount(0)
  await expect(page.getByTestId('analysis-conditions-ok')).toBeVisible()
  await page.screenshot({ path: join(__dirname, '../../test-results/analysis-page.png') })

  // Scenarios: a link, no invented result.
  await page.getByTestId('analysis-scenarios-link').click()
  expect(page.url()).toContain('#/scenarios/')
  expect(errors).toEqual([])
})

test('an empty project states what is missing instead of showing numbers', async () => {
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await createProject(page, 'Bare frame')
  const id = await projectId(page, 'Bare frame')
  await page.evaluate((i) => (location.hash = `#/analysis/${i}`), id)
  await expect(page.getByTestId('analysis-page')).toBeVisible()
  await expect(page.getByTestId('analysis-com-none')).toContainText('Not available')
  await expect(page.getByTestId('analysis-balance-none')).toContainText('Not available')
  await expect(page.getByTestId('analysis-mass-missing')).toContainText('Frame')
  await expect(page.getByTestId('analysis-thrust')).toHaveAttribute('data-state', 'unknown')
  await expect(page.getByTestId('analysis-altitude-missing')).toBeVisible()
  await expect(page.getByTestId('analysis-ready-item').first()).toBeVisible()
  // A missing frame mass links to its workshop field.
  await page.getByTestId('analysis-mass-missing').getByRole('button', { name: 'Frame' }).click()
  await expect(page.getByTestId('frame-mass')).toBeFocused()
  expect(errors).toEqual([])
})
