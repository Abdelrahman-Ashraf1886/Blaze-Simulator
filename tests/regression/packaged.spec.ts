import { expect, test, type Page } from '@playwright/test'
import { commit, createProject } from '../e2e/helpers'
import { withPackagedApp } from './packaged'

async function fillCatalogueValue(page: Page, name: string, key: string, value: string, unit: string, source: string, condition: string) {
  await page.locator('[data-testid="component-row"]').filter({ hasText: name }).click()
  const field = page.getByTestId(`spec-${key}`)
  await field.getByTestId('fill-enter').click()
  await field.getByTestId('fill-value').fill(value)
  const units = field.getByTestId('fill-unit')
  if (await units.count()) await units.selectOption(unit)
  await field.getByTestId('fill-source').selectOption(source)
  await field.getByTestId('fill-condition').fill(condition)
  await field.getByTestId('fill-save').click()
  await expect(field.getByTestId('spec-fill')).toBeVisible()
}

// Stock quad and cited measurement entries from tests/e2e/helpers.ts:63–98.
async function buildInWorkshop(page: Page, project: string) {
  await page.getByTestId('nav-/components').click()
  await fillCatalogueValue(page, 'MN3110 KV470', 'rotorInertia', '150', 'g·cm²', 'measured', 'bifilar pendulum, bell and shaft')
  await fillCatalogueValue(page, 'MN3110 KV470', 'referenceDensity', '1.225', 'kg/m³', 'user', 'bench air, as stated by the user')
  await fillCatalogueValue(page, 'Tattu G-Tech 5200mAh 4S 35C', 'internalResistance', '12', 'mΩ', 'measured', '4-wire AC, 1 kHz, 25 °C')
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await createProject(page, project)
  await page.getByTestId('recent-projects').getByRole('link', { name: project }).click()
  const viewport = page.getByTestId('viewport-3d')
  await expect(viewport.locator('canvas')).toBeVisible()
  await commit(page, 'frame-motorDiagonal', '550')
  const parts = page.getByTestId('part-library')
  for (let motor = 1; motor <= 4; motor++) {
    await page.getByTestId(`mount-motor-${motor}`).click()
    await parts.getByRole('button', { name: 'Motor' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470' })
    await parts.getByRole('button', { name: 'Propeller' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  }
  await viewport.click({ position: { x: 5, y: 5 } })
  await parts.getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  await commit(page, 'ground-friction', '0.6')
  await commit(page, 'ground-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
}

test('packaged startup, projects and settings use an isolated profile', async () => {
  await withPackagedApp(async (page, profile) => {
    await expect(page.getByTestId('recent-projects')).toContainText('No projects yet')
    await createProject(page, 'Packaged project', 'Hex X')
    await page.getByTestId('nav-/projects').click()
    const row = page.getByTestId('projects-table').getByTestId('project-row')
    await expect(row).toContainText('Packaged project')
    await expect(row).toContainText('Hex X')
    await page.getByTestId('nav-/settings').click()
    await expect(page.getByRole('heading', { name: 'Graphics' })).toBeVisible()
    await expect(page.locator('dt', { hasText: /^Data folder$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(profile)
  })
})

test('packaged workshop, flight, telemetry and report work through the UI', async () => {
  await withPackagedApp(async (page) => {
    const project = 'Packaged quad'
    await buildInWorkshop(page, project)
    await page.getByTestId('nav-/flight').click()
    await page.getByRole('link', { name: project, exact: true }).click()
    // tests/e2e/recording.spec.ts:21–28
    await commit(page, 'flight-altitude', '0')
    await commit(page, 'flight-cutoff-value', '12')
    await page.getByRole('checkbox', { name: 'Record runs' }).setChecked(true)
    await page.getByTestId('flight-start').click()
    const time = page.getByTestId('flight-debug').locator('dt', { hasText: /^Time$/ }).locator('xpath=following-sibling::dd')
    await expect.poll(async () => Number.parseFloat(await time.innerText())).toBeGreaterThanOrEqual(2)
    await page.getByTestId('flight-stop').click()
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
    const run = page.getByTestId('simulation-history').getByTestId('simulation-run').filter({ hasText: project })
    await expect(run.getByRole('cell').last()).toHaveText(/^[1-9][\d,]* B$/)
    await page.getByTestId('nav-/telemetry').click()
    await page.getByRole('button', { name: 'Flight Simulator', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Add graph' })).toBeVisible()
    await page.getByRole('link', { name: 'Report', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Flight Simulator', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /PDF/ })).toBeEnabled()
  })
})
