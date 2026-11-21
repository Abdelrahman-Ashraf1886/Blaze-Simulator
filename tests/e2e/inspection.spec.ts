import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-inspect-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const library = (page: Page) => page.getByTestId('part-library')
const inspector = (page: Page) => page.getByTestId('part-inspector')
const viewport = (page: Page) => page.getByTestId('viewport-3d')
const positions = (page: Page) =>
  Promise.all(['x', 'y', 'z'].map((a) => page.getByTestId(`part-pos-${a}`).inputValue()))

test('status strip, dimensions, connection markers, fit to selection and exploded view', async () => {
  const r = await launchApp(userData)
  running.push(r.app)
  const page = r.page
  const errors = trackErrors(page)
  await createProject(page, 'Inspect quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Inspect quad' }).click()
  await expect(viewport(page).locator('canvas')).toBeVisible()

  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await page.keyboard.press('Escape')
  await library(page).getByRole('button', { name: 'Payload' }).click()

  // Status strip: counts, and a click selects the first matching part.
  await expect(page.getByTestId('status-parts')).toHaveText('3 parts')
  await expect(page.getByTestId('status-no-mass')).toHaveText('3 without mass')
  await expect(page.getByTestId('status-unattached')).toHaveText('1 unattached')
  await page.keyboard.press('Escape')
  await page.getByTestId('status-unattached').click()
  await expect(inspector(page)).toContainText('Payload 1')

  // Dimension overlay for the selection (payload placeholder 80 × 60 × 50 mm).
  await expect(page.getByTestId('dim-x')).toHaveText('X 80 mm')
  await expect(page.getByTestId('dim-y')).toHaveText('Y 60 mm')
  await expect(page.getByTestId('dim-z')).toHaveText('Z 50 mm')

  // Connection markers on every mount (4 motors + 2 plates), as guides that never take clicks;
  // the current mount is filled.
  await expect(page.locator('[data-testid^=mount-marker-]')).toHaveCount(6)
  await expect(page.locator('[data-testid^=mount-marker-][data-current]')).toHaveCount(0) // payload is free
  await page.getByLabel('Attached to').selectOption('mount:plate-top')
  await expect(page.getByTestId('mount-marker-plate-top')).toHaveAttribute('data-current', 'true')
  await expect(page.getByTestId('status-unattached')).toHaveCount(0)
  expect(await page.getByTestId('mount-marker-plate-top').evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none')
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('Attached to')).toHaveValue('none')

  // Fit: with a part selected, F frames that part (the whole assembly then no longer fits);
  // with nothing selected, F frames everything again, propeller disc included.
  await page.keyboard.press('f')
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'false')
  await page.keyboard.press('Escape')
  await page.keyboard.press('f')
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true')

  // Exploded view: display only. Saved positions and the save state do not change.
  await page.locator('[data-testid=part-row][data-name="Propeller 1"]').click()
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  const before = await positions(page)
  await page.keyboard.press('x')
  await expect(page.getByRole('button', { name: /Exploded view on/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Exploded view · display only')).toBeVisible()
  await expect(page.locator('[data-testid^=mount-marker-]')).toHaveCount(0)
  await page.getByTestId('explode-spread').fill('100')
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true') // still framed while spread
  await expect(page.getByTestId('dim-z')).toBeVisible() // labels follow the exploded part
  expect(await positions(page)).toEqual(before)
  await page.keyboard.press('x')
  await expect(page.getByText('Exploded view · display only')).toHaveCount(0)
  expect(await positions(page)).toEqual(before)
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  await expect(page.getByRole('button', { name: /^Undo attach/i })).toHaveCount(0) // nothing new to undo
  expect(errors).toEqual([])
})

test('drag a part onto a mount marker to attach it there (one undo step)', async () => {
  const r = await launchApp(userData)
  running.push(r.app)
  const page = r.page
  const errors = trackErrors(page)
  await createProject(page, 'Snap quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Snap quad' }).click()
  await expect(viewport(page).locator('canvas')).toBeVisible()
  await library(page).getByRole('button', { name: 'Payload' }).click() // free, centred, selected

  // Top orthographic view: the payload's gizmo is at the centre of the viewport.
  await page.getByRole('button', { name: 'Ortho' }).click()
  await page.keyboard.press('1')
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true')
  await page.waitForTimeout(800) // camera transition
  const box = (await viewport(page).boundingBox())!
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const marker = page.getByTestId('mount-marker-motor-1')
  const mb = (await marker.boundingBox())!
  const to = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 })
  await expect(marker).not.toHaveAttribute('data-hot') // halfway: nothing to snap to
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await expect(marker).toHaveAttribute('data-hot', 'true')
  await page.mouse.up()

  await expect(page.getByLabel('Attached to')).toHaveValue('mount:motor-1')
  await expect(marker).toHaveAttribute('data-current', 'true')
  await expect(marker).not.toHaveAttribute('data-hot')
  // Rests on the mount: centred, base on the mount surface (half of 50 mm).
  expect(await positions(page)).toEqual(['0', '0', '25'])
  await expect(page.getByRole('button', { name: /Undo attach payload 1 to motor 1 mount/i })).toBeEnabled()
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('Attached to')).toHaveValue('none')
  expect(errors).toEqual([])
})

test('save an image of the view as PNG through the save dialog', async () => {
  const r = await launchApp(userData)
  running.push(r.app)
  const page = r.page
  const errors = trackErrors(page)
  await createProject(page, 'Image quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Image quad' }).click()
  await expect(viewport(page).locator('canvas')).toBeVisible()
  await library(page).getByRole('button', { name: 'Payload' }).click()

  const target = join(userData, 'view') // no extension: main adds .png
  await r.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args.find((a) => a && typeof a === 'object' && 'defaultPath' in (a as object)) as { defaultPath: string }
      ;(globalThis as { __proposed?: string }).__proposed = opts.defaultPath
      return { canceled: false, filePath: p }
    }) as typeof dialog.showSaveDialog
  }, target)
  await page.getByRole('button', { name: 'Save image of the view (PNG)' }).click()
  await expect(page.getByTestId('image-status')).toHaveText('Image saved: view.png')
  const proposed = await r.app.evaluate(() => (globalThis as { __proposed?: string }).__proposed ?? '')
  expect(proposed).toMatch(/Image quad \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.png$/)

  const file = `${target}.png`
  expect(existsSync(file)).toBe(true)
  const png = readFileSync(file)
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // At least 2× the on-screen size of the canvas (IHDR width and height, big-endian).
  const css = (await viewport(page).locator('canvas').boundingBox())!
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  const scale = Math.max(Math.min(dpr, 2), 2)
  expect(png.readUInt32BE(16)).toBeCloseTo(css.width * scale, -1)
  expect(png.readUInt32BE(20)).toBeCloseTo(css.height * scale, -1)
  // The view keeps working afterwards (canvas restored to its own resolution).
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true')
  expect(errors).toEqual([])
})

test('measure tool: two clicks snap to the motor pad centres and read the motor-to-motor diagonal', async () => {
  const r = await launchApp(userData)
  running.push(r.app)
  const page = r.page
  const errors = trackErrors(page)
  await createProject(page, 'Measure quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Measure quad' }).click()
  await expect(viewport(page).locator('canvas')).toBeVisible()
  await page.getByRole('button', { name: 'Ortho' }).click()
  await page.keyboard.press('1')
  await expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true')
  await page.waitForTimeout(800)

  const centre = async (id: string) => {
    const b = (await page.getByTestId(id).boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  // Motor labels sit right above their pads in top view; in measure mode they let clicks through.
  const m1 = await centre('mount-motor-1')
  const m2 = await centre('mount-motor-2')

  await page.keyboard.press('m')
  await expect(page.getByTestId('measure-status')).toHaveText('Measure: click the first point')
  await page.mouse.click(m1.x + 2, m1.y + 2) // a few px off: snapping finds the pad centre
  await expect(page.getByTestId('measure-status')).toHaveText('Measure: click the second point')
  await page.mouse.click(m2.x - 2, m2.y + 1)
  // Quad X starting frame: 450 mm motor-to-motor diagonal, 318.2 mm along X and Y.
  await expect(page.getByTestId('measure-status')).toHaveText('Measure: 450 mm · ΔX 318.2 · ΔY 318.2 · ΔZ 0')
  await expect(page.getByTestId('measure-label')).toHaveText('450 mm')
  // Measuring never selects anything.
  await expect(page.locator('[data-testid^=mount-motor-][aria-pressed=true]')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('measure-status')).toHaveText('Measure: click the first point')
  await expect(page.getByTestId('measure-label')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('measure-status')).toHaveCount(0)
  expect(errors).toEqual([])
})
