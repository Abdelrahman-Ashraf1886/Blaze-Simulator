import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-kinds-'))
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

test('new kinds, a dragged part dropped on a mount, an entered inertia, and the resize mode', async () => {
  const first = await launchApp(userData)
  running.push(first.app)
  let page = first.page
  const errors = trackErrors(page)
  await createProject(page, 'Kinds quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Kinds quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()

  // Landing gear with nothing selected goes under the bottom plate.
  await library(page).getByRole('button', { name: 'Landing gear' }).click()
  await expect(page.getByLabel('Attached to')).toHaveValue('mount:plate-bottom')

  // Drag a GPS from the library onto the motor 2 mount marker (markers show while a part is selected or dragged).
  const marker = page.getByTestId('mount-marker-motor-2')
  await expect(marker).toBeVisible()
  const box = (await marker.boundingBox())!
  const drop = (await page.getByTestId('viewport-drop').boundingBox())!
  await library(page)
    .getByRole('button', { name: 'GPS' })
    .dragTo(page.getByTestId('viewport-drop'), {
      targetPosition: { x: box.x + box.width / 2 - drop.x, y: box.y + box.height / 2 - drop.y },
    })
  await expect(page.locator('[data-testid=part-row][data-name="GPS 1"]')).toBeVisible()
  await expect(page.getByLabel('Attached to')).toHaveValue('mount:motor-2')

  // A camera: its inertia is derived from mass and size until the user enters their own.
  await page.keyboard.press('Escape')
  await library(page).getByRole('button', { name: 'Camera' }).click()
  await expect(page.getByTestId('inertia-derived')).toContainText('Needs a mass first.')
  await commit(page, 'part-mass', '60')
  // 60 g box 40 × 30 × 30 mm: Ixx = m(b² + c²)/12 = 0.06 × (0.0009 + 0.0009)/12 = 9e-6 kg·m² = 0.009 g·m²
  await expect(page.getByTestId('inertia-derived-ixx')).toHaveText('0.009')
  await page.getByTestId('inertia-enter').click()
  await expect(page.getByTestId('inertia-ixx')).toHaveValue('0.009')
  // Izz larger than Ixx + Iyy is impossible and is refused with the reason.
  await commit(page, 'inertia-izz', '1')
  await expect(page.getByRole('alert')).toContainText('sum of the other two')
  await page.getByTestId('inertia-izz').press('Escape')
  await commit(page, 'com-offset-x', '5')
  await expect(page.getByTestId('com-offset-x')).toHaveValue('5')
  // Back to the derived value is one click, and undo returns the entered one.
  await page.getByTestId('inertia-derive').click()
  await expect(page.getByTestId('inertia-derived')).toBeVisible()
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await page.locator('[data-testid=part-row][data-name="Camera 1"]').click()
  await expect(page.getByTestId('com-offset-x')).toHaveValue('5')

  // R switches the gizmo to resize.
  await page.keyboard.press('r')
  await expect(page.getByRole('button', { name: /Resize selected part/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('w')
  expect(errors).toEqual([])
  await first.app.close()

  // Kinds and the entered inertia are saved.
  const second = await launchApp(userData)
  running.push(second.app)
  page = second.page
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Kinds quad' }).click()
  for (const name of ['Landing gear 1', 'GPS 1', 'Camera 1']) await expect(page.locator(`[data-testid=part-row][data-name="${name}"]`)).toBeVisible()
  await page.locator('[data-testid=part-row][data-name="Camera 1"]').click()
  await expect(page.getByTestId('com-offset-x')).toHaveValue('5')
})
