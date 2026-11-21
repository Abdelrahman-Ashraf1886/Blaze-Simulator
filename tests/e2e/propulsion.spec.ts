import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-propulsion-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const library = (page: Page) => page.getByTestId('part-library')
const items = (page: Page) => page.getByTestId('ready-item')
const item = (page: Page, id: string) => page.locator(`[data-testid=ready-item][data-item="${id}"]`)
const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}
/** Screenshots for the DEVLOG go to test-results/ (not committed by the test run). */
const shot = (name: string) => join(__dirname, '../../test-results', `propulsion-${name}.png`)

test('propulsion: fit and validation per pair, Ready-to-fly checklist with links to each field', async () => {
  const first = await launchApp(userData)
  running.push(first.app)
  const page = first.page
  const errors = trackErrors(page)
  await createProject(page, 'Propulsion quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Propulsion quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('propulsion-empty')).toBeVisible()

  // Four MN3110 KV470 with T-Motor P13*4.4, and the Tattu pack.
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

  // One block for the pair, fitted from the five cited rows of T-Motor's table.
  const pair = page.getByTestId('propulsion-pair')
  await expect(pair).toHaveCount(1)
  await expect(pair).toContainText('motors 1, 2, 3, 4')
  await expect(page.getByTestId('pair-source')).toHaveAttribute('data-kind', 'motor-table')
  await expect(page.getByTestId('pair-source')).toContainText('“T-MOTO13*4.4CF” (5 rows)')
  await expect(page.getByTestId('pair-kt')).toHaveText('2.294 × 10⁻⁵')
  await expect(page.getByTestId('pair-kt-error')).toContainText('fit error max 3.6 %')
  await expect(page.getByTestId('validation-row')).toHaveCount(5)
  await expect(page.getByTestId('validation-kind')).toContainText('held out')
  await expect(page.getByTestId('validation-row').first().getByTestId('validation-before').first()).toHaveText('+0.6%')
  await expect(page.getByTestId('pair-other-tables')).toContainText('MN3110 KV700')
  await expect(page.getByTestId('pair-map')).toContainText('100 % → 83.9 %')
  await expect(page.getByTestId('rotor-missing')).toBeVisible()

  // Exactly the values no source states for these parts.
  await expect(items(page)).toHaveCount(5)
  for (const id of ['body-cd', 'ground-friction', 'ground-restitution']) await expect(item(page, id)).toBeVisible()
  await expect(items(page).filter({ hasText: 'Motor rotor inertia' })).toHaveCount(1)
  await expect(items(page).filter({ hasText: 'Battery internal resistance' })).toHaveCount(1)
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await page.getByTestId('ready-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('checklist') })
  await page.getByTestId('validation-table').scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('fit') })

  // The C_d item focuses its field; entering it removes the item, and undo brings it back.
  await item(page, 'body-cd').getByRole('button').click()
  await expect(page.getByTestId('body-cd-x')).toBeFocused()
  // The first value fills the empty axes; one axis can then differ.
  await commit(page, 'body-cd-x', '1.1')
  await expect(page.getByTestId('body-cd-y')).toHaveValue('1.1')
  await expect(page.getByTestId('body-cd-z')).toHaveValue('1.1')
  await commit(page, 'body-cd-z', '1.3')
  await expect(page.getByTestId('body-cd-z')).toHaveValue('1.3')
  await expect(page.getByTestId('body-cd-y')).toHaveValue('1.1')
  await expect(item(page, 'body-cd')).toHaveCount(0)
  await expect(page.getByTestId('drag-areas')).toContainText('cm²')
  // Clearing one axis brings the item back for that axis only.
  await commit(page, 'body-cd-y', '')
  await expect(item(page, 'body-cd')).toContainText('C_d (y)')
  await commit(page, 'body-cd-y', '1.1')
  await expect(items(page)).toHaveCount(4)

  // A component item opens the library on that field, marked.
  await items(page).filter({ hasText: 'Motor rotor inertia' }).getByRole('button').click()
  await expect(page.getByTestId('component-detail')).toContainText('MN3110 KV470')
  await expect(page.getByTestId('spec-rotorInertia')).toHaveAttribute('data-highlight', 'true')
  await expect(page.getByTestId('highlight-note')).toContainText('Duplicate it')
  await page.screenshot({ path: shot('library-field') })
  expect(errors).toEqual([])
})
