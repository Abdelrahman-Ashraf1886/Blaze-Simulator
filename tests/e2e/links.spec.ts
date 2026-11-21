import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-links-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const library = (page: Page) => page.getByTestId('part-library')
const inspector = (page: Page) => page.getByTestId('part-inspector')
const row = (page: Page, name: string) => page.locator(`[data-testid=part-row][data-name="${name}"]`)
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')

async function openWorkshop(page: Page, name: string) {
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}

test('link a motor to a library component: datasheet size and mass with their source; unlink and undo restore; persists', async () => {
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Link quad')
  await openWorkshop(page, 'Link quad')

  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await expect(page.getByTestId('part-size')).toHaveText('28 × 28 × 30 mm') // placeholder shape
  await expect(page.getByTestId('status-no-mass')).toHaveText('1 without mass')

  // Only motors are offered for a motor part.
  const picker = page.getByTestId('part-component')
  await expect(picker.locator('optgroup')).toHaveCount(1)
  await expect(picker.locator('optgroup')).toHaveAttribute('label', 'Motor')
  await picker.selectOption({ label: 'T-Motor MN3110 KV700' })

  // Size and mass now come from T-Motor's page, with the source shown.
  await expect(page.getByTestId('part-size')).toHaveText('37.7 × 37.7 × 28.5 mm')
  await expect(page.getByTestId('linked-bodyDiameter')).toContainText('37.7 mm')
  await expect(page.getByTestId('part-mass-linked')).toHaveText('99 g')
  const massSource = page.getByTestId('linked-mass').getByTestId('linked-source')
  await expect(massSource).toHaveText('Manufacturer')
  await expect(page.getByTestId('linked-mass').getByRole('link')).toHaveAttribute('href', 'https://store.tmotor.com/product/mn3110-motor-navigator-type.html')
  await expect(page.getByTestId('linked-mass')).toContainText('Your own value (not set)')
  await expect(page.getByTestId('status-no-mass')).toHaveCount(0)
  await expect(row(page, 'Motor 1')).not.toContainText('no mass')

  // A propeller added on the linked motor rests on its stated 28.5 mm height: 14.25 + 4 = 18.25 mm.
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await expect(page.getByTestId('part-pos-z')).toHaveValue('18.3')

  // Unlink: the part's own placeholder shape and (unset) mass come back; undo re-links.
  await row(page, 'Motor 1').click()
  await picker.selectOption('')
  await expect(page.getByTestId('part-size')).toHaveText('28 × 28 × 30 mm')
  await expect(page.getByTestId('part-mass')).toHaveValue('')
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } }) // leave the select, so Ctrl+Z reaches the editor
  await row(page, 'Motor 1').click()
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('part-size')).toHaveText('37.7 × 37.7 × 28.5 mm')
  await expect(picker).toHaveValue(/[0-9a-f-]{36}/)
  await saved(page)
  expect(errors).toEqual([])
  await first.app.close()

  // After a restart the link is still there.
  const second = await launch()
  page = second.page
  await openWorkshop(page, 'Link quad')
  await row(page, 'Motor 1').click()
  await expect(inspector(page)).toContainText('99 g')
  await expect(page.getByTestId('part-size')).toHaveText('37.7 × 37.7 × 28.5 mm')
})

test('a component used by a part cannot be deleted from the library', async () => {
  const { page } = await launch()
  await createProject(page, 'In-use quad')
  // Make an own copy of a built-in motor and link a part to it.
  await page.getByTestId('nav-/components').click()
  await page.locator('[data-testid=component-row][data-name="MN3110 KV470"]').click()
  await page.getByTestId('component-detail').getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.getByTestId('component-detail')).toContainText('MN3110 KV470 (copy)')

  await page.getByTestId('nav-/workshop').click()
  await page.getByRole('link', { name: 'In-use quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470 (copy)' })
  await saved(page)

  await page.getByTestId('nav-/components').click()
  await page.locator('[data-testid=component-row][data-name="MN3110 KV470 (copy)"]').click()
  await page.getByTestId('component-detail').getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('library-note')).toHaveText('Used by 1 part in "In-use quad". Unlink it in the workshop first.')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-testid=component-row][data-name="MN3110 KV470 (copy)"]')).toHaveCount(1)
})
