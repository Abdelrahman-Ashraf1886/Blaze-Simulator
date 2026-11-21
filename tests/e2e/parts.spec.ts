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
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-parts-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

async function openWorkshop(page: Page, name: string) {
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}
const library = (page: Page) => page.getByTestId('part-library')
const rows = (page: Page) => page.getByTestId('part-row')
const row = (page: Page, name: string) => page.locator(`[data-testid=part-row][data-name="${name}"]`)
const inspector = (page: Page) => page.getByTestId('part-inspector')
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')

test('build with the library, tree, inspector and keyboard; everything persists', async () => {
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Parts quad')
  await openWorkshop(page, 'Parts quad')

  // A selected mount is the add target.
  await page.getByTestId('mount-motor-1').click()
  await expect(page.getByTestId('add-target')).toContainText('Motor 1 mount')
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await expect(inspector(page)).toContainText('Motor 1')
  await expect(page.getByLabel('Attached to')).toHaveValue('mount:motor-1')
  // With the motor part selected, the propeller goes on top of it (30 mm motor, 8 mm prop → 19 mm).
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await expect(page.getByLabel('Attached to')).toHaveValue(/^part:/)
  await expect(page.getByTestId('part-pos-z')).toHaveValue('19')

  // Keyboard: duplicate the motor (with its prop), then delete the copy and everything on it.
  await row(page, 'Motor 1').click()
  await page.keyboard.press('Control+d')
  await expect(rows(page)).toHaveCount(4)
  await expect(inspector(page)).toContainText('Motor 2')
  await page.keyboard.press('Delete')
  await expect(rows(page)).toHaveCount(2)
  await page.keyboard.press('Control+z')
  await expect(rows(page)).toHaveCount(4)
  await page.keyboard.press('Control+z')
  await expect(rows(page)).toHaveCount(2)

  // Arrow keys nudge in 5 mm snap steps in the attachment frame.
  await row(page, 'Motor 1').click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('part-pos-x')).toHaveValue('5')
  await expect(page.getByTestId('part-pos-y')).toHaveValue('5')

  // Numeric edits: name, position, rotation, mass; invalid input is refused.
  await page.getByTestId('part-name').fill('Front-right motor')
  await page.getByTestId('part-name').press('Enter')
  await expect(row(page, 'Front-right motor')).toBeVisible()
  await page.getByTestId('part-pos-z').fill('20')
  await page.getByTestId('part-pos-z').press('Enter')
  await page.getByTestId('part-rot-z').fill('45')
  await page.getByTestId('part-rot-z').press('Enter')
  await page.getByTestId('part-mass').fill('-3')
  await page.getByTestId('part-mass').press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Between 0.1 and 1000000 g')
  await page.getByTestId('part-mass').fill('52')
  await page.getByTestId('part-mass').press('Enter')
  await expect(inspector(page)).toContainText('Entered by you.')
  await expect(row(page, 'Front-right motor')).not.toContainText('no mass')

  // Re-attach a new battery to the bottom plate through the inspector.
  await page.keyboard.press('Escape')
  await library(page).getByRole('button', { name: 'Battery' }).click()
  await page.getByLabel('Attached to').selectOption('mount:plate-bottom')
  await expect(page.getByTestId('assembly-tree')).toContainText('Plate bottom')
  await saved(page)
  expect(errors).toEqual([])
  await first.app.close()

  page = (await launch()).page
  await openWorkshop(page, 'Parts quad')
  await expect(rows(page)).toHaveCount(3)
  await row(page, 'Front-right motor').click()
  await expect(page.getByTestId('part-pos-z')).toHaveValue('20')
  await expect(page.getByTestId('part-rot-z')).toHaveValue('45')
  await expect(page.getByTestId('part-mass')).toHaveValue('52')
  await row(page, 'Battery 1').click()
  await expect(page.getByLabel('Attached to')).toHaveValue('mount:plate-bottom')
})

test('mouse: click a part in the viewport to select it, drag the gizmo to move it (snapped)', async () => {
  const { page } = await launch()
  await createProject(page, 'Drag quad')
  await openWorkshop(page, 'Drag quad')
  await library(page).getByRole('button', { name: 'Payload' }).click() // free, centred on the frame
  await page.keyboard.press('Escape')
  await expect(inspector(page)).toHaveCount(0)

  // Top orthographic view: the payload sits at the centre of the viewport.
  await page.getByRole('button', { name: 'Ortho' }).click()
  await page.keyboard.press('1')
  await expect(page.getByTestId('viewport-3d')).toHaveAttribute('data-bounds-in-view', 'true')
  await page.waitForTimeout(800) // camera transition
  const box = (await page.getByTestId('viewport-3d').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  await page.mouse.click(cx, cy)
  await expect(inspector(page)).toContainText('Payload 1')

  // Drag the gizmo's centre handle to the right: in top view that is the aircraft's right, −Y.
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 30, cy, { steps: 5 })
  await page.mouse.move(cx + 60, cy, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Number(await page.getByTestId('part-pos-y').inputValue())).toBeLessThan(0)
  const y = Number(await page.getByTestId('part-pos-y').inputValue())
  expect(Math.abs(y % 5)).toBe(0) // 5 mm snap
  expect(Number(await page.getByTestId('part-pos-x').inputValue())).toBe(0)
  await expect(page.getByRole('button', { name: /Undo move payload 1/i })).toBeEnabled()
})

test('copy a motor with its propeller to every motor mount of a hex in one step', async () => {
  const { page } = await launch()
  const errors = trackErrors(page)
  await createProject(page, 'Copy hex', 'Hex X')
  await openWorkshop(page, 'Copy hex')
  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await row(page, 'Motor 1').click()

  await expect(page.getByTestId('copy-to-mounts')).toHaveText('Copy to 5 more motor mounts')
  await expect(inspector(page)).toContainText('with the 1 part attached to it')
  await page.getByTestId('copy-to-mounts').click()
  await expect(rows(page)).toHaveCount(12)
  await expect(page.getByTestId('copy-to-mounts')).toBeDisabled()
  await expect(page.getByTestId('assembly-tree')).toContainText('Motor 6')
  // The propeller on its own is not on a motor mount, so it has no copy button.
  await row(page, 'Propeller 1').click()
  await expect(page.getByTestId('copy-to-mounts')).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await expect(rows(page)).toHaveCount(2)
  await saved(page)
  expect(errors).toEqual([])
})
