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

  // A frame that fits 13-inch props: 550 mm motor diagonal puts neighbouring motors 389 mm
  // apart (> 330 mm prop), and leaves the plate clear for the pack (overlaps are errors, and a
  // part with no free spot is refused).
  await commit(page, 'frame-motorDiagonal', '550')
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

  // Battery R_int: an override on this battery part only (inspector), undoable.
  const rint = () => items(page).filter({ hasText: 'Battery internal resistance' })
  await expect(rint().getByTestId('ready-override')).toContainText('Battery 1')
  await rint().getByTestId('ready-override').getByRole('button', { name: 'Battery 1' }).click()
  const spec = page.getByTestId('part-spec-internalResistance')
  await expect(spec).toHaveAttribute('data-layer', 'missing')
  await spec.getByTestId('override-start').click()
  await page.getByTestId('override-value').fill('12')
  await page.getByTestId('override-condition').fill('4-wire AC, 1 kHz, 25 °C')
  await page.getByTestId('override-save').click()
  await expect(spec).toHaveAttribute('data-layer', 'instance')
  await expect(spec.getByTestId('part-spec-layer')).toHaveText('Override on this part · Measured')
  await expect(spec).toContainText('12 mΩ')
  await expect(rint()).toHaveCount(0)
  await spec.scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('override') })
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } }) // leave the inspector, so Ctrl+Z reaches the editor
  await page.keyboard.press('Control+z')
  await expect(rint()).toHaveCount(1)
  await page.keyboard.press('Control+y')
  await expect(rint()).toHaveCount(0)

  // The rotor inertia item opens the library on that field, ready to fill the gap for every project.
  await items(page).filter({ hasText: 'Motor rotor inertia' }).getByRole('button').first().click()
  await expect(page.getByTestId('component-detail')).toContainText('MN3110 KV470')
  const row = page.getByTestId('spec-rotorInertia')
  await expect(row).toHaveAttribute('data-highlight', 'true')
  await expect(page.getByTestId('highlight-note')).toContainText('every project')
  await page.getByTestId('fill-value').fill('150')
  await page.getByTestId('fill-condition').fill('bifilar pendulum, bell and shaft')
  await page.screenshot({ path: shot('library-field') })
  await page.getByTestId('fill-save').click()
  await expect(row.getByTestId('spec-fill')).toContainText('Gap-fill')
  await expect(row).toContainText('150 g·cm²')
  await expect(row.getByTestId('spec-source')).toHaveText('Measured')
  // Back in the workshop: the item is gone and the rotor inertia is used.
  await page.goBack()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await expect(items(page).filter({ hasText: 'Motor rotor inertia' })).toHaveCount(0)
  await expect(page.getByTestId('rotor-missing')).toHaveCount(0)
  await expect(items(page)).toHaveCount(2) // ground friction and restitution (4.4)
  await page.getByTestId('ready-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('checklist-after') })
  expect(errors).toEqual([])
})
