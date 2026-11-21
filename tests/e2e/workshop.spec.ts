import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, setZoom, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []

async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-ws-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const viewport = (page: Page) => page.getByTestId('viewport-3d')
const framed = (page: Page) => expect(viewport(page)).toHaveAttribute('data-bounds-in-view', 'true')

async function openWorkshop(page: Page, name: string) {
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('workshop')).toBeVisible()
  await expect(viewport(page).locator('canvas')).toBeVisible()
}

test('three.js loads only with the workshop; views and projections keep the build area framed', async () => {
  const { page } = await launch()
  const errors = trackErrors(page)
  await createProject(page, 'Survey hex', 'Hex X')
  expect(await page.evaluate(() => (globalThis as { __THREE__?: string }).__THREE__ ?? null)).toBeNull()

  await openWorkshop(page, 'Survey hex')
  expect(await page.evaluate(() => (globalThis as { __THREE__?: string }).__THREE__ ?? null)).not.toBeNull()
  await expect(page.getByTestId('project-panel')).toContainText('Hex X')
  await framed(page)

  const status = page.getByTestId('view-status')
  for (const [key, label] of [['1', 'Top'], ['2', 'Front'], ['3', 'Right'], ['4', 'Iso']] as const) {
    await page.keyboard.press(key)
    await expect(status).toContainText(`${label} view`)
    await framed(page)
  }
  await page.keyboard.press('p')
  await expect(viewport(page)).toHaveAttribute('data-projection', 'orthographic')
  await framed(page)
  await page.getByRole('button', { name: 'Persp' }).click()
  await expect(viewport(page)).toHaveAttribute('data-projection', 'perspective')
  await framed(page)
  expect(errors).toEqual([])
})

const SIZES = [
  { width: 880, height: 560, zoom: 1 },
  { width: 1280, height: 672, zoom: 1.5 },
  { width: 1100, height: 700, zoom: 2 },
  { width: 1920, height: 1080, zoom: 1 },
  { width: 3840, height: 2160, zoom: 1 },
]

test('viewport canvas tracks its container across sizes, zoom and panel collapse', async () => {
  const { app, page } = await launch()
  await createProject(page, 'Sizing quad')
  await openWorkshop(page, 'Sizing quad')

  const measure = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid=viewport-3d]')!
      const canvas = el.querySelector('canvas')!
      const box = el.getBoundingClientRect()
      return {
        container: [Math.round(box.width), Math.round(box.height)],
        canvas: [canvas.clientWidth, canvas.clientHeight],
        mainOverflow: document.querySelector('main')!.scrollWidth - document.querySelector('main')!.clientWidth,
      }
    })

  for (const s of SIZES) {
    await setZoom(app, s.zoom)
    await page.setViewportSize({ width: s.width, height: s.height })
    await expect.poll(async () => {
      const m = await measure()
      return m.canvas[0] === m.container[0] && m.canvas[1] === m.container[1]
    }, { message: `canvas size at ${s.width}×${s.height} @${s.zoom}` }).toBe(true)
    expect((await measure()).mainOverflow, `overflow at ${s.width}×${s.height} @${s.zoom}`).toBeLessThanOrEqual(0)
    await framed(page)
  }

  await setZoom(app, 1)
  await page.setViewportSize({ width: 1366, height: 768 })
  // The 200 % zoom step may have squeezed a side panel shut; the toolbar must say so.
  for (const side of ['project', 'view']) {
    const show = page.getByRole('button', { name: `Show ${side} panel` })
    if (await show.isVisible()) await show.click()
    await expect(page.getByRole('button', { name: `Hide ${side} panel` })).toBeVisible()
  }
  await expect.poll(async () => (await measure()).canvas[0]).toBeLessThan(1366 - 212 - 400)
  const before = (await measure()).container[0]!
  await page.getByRole('button', { name: 'Hide project panel' }).click()
  await page.getByRole('button', { name: 'Hide view panel' }).click()
  await expect.poll(async () => (await measure()).canvas[0]).toBeGreaterThan(before + 300)
  const after = await measure()
  expect(after.canvas).toEqual(after.container)
  await framed(page)
})

test('panel layout and view settings persist across restarts', async () => {
  const first = await launch()
  const app = first.app
  let page = first.page
  await createProject(page, 'Layout octo', 'Octo X')
  await openWorkshop(page, 'Layout octo')
  await page.getByRole('button', { name: 'Hide view panel' }).click()
  await page.getByRole('button', { name: 'Ortho' }).click()
  await expect(page.getByRole('button', { name: 'Show view panel' })).toBeVisible()
  await page.waitForTimeout(300) // layout save is debounced
  await app.close()

  page = (await launch()).page
  await openWorkshop(page, 'Layout octo')
  await expect(page.getByRole('button', { name: 'Show view panel' })).toBeVisible()
  await expect(viewport(page)).toHaveAttribute('data-projection', 'orthographic')
  await framed(page)
})

const field = (page: Page, key: string) => page.getByTestId(`frame-${key}`)
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')

test('frame dimensions save, undo/redo, reject invalid input and persist across restarts', async () => {
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Editable quad')
  await openWorkshop(page, 'Editable quad')
  await expect(field(page, 'motorDiagonal')).toHaveValue('450') // starting value for a quad

  await field(page, 'motorDiagonal').fill('500')
  await field(page, 'motorDiagonal').press('Enter')
  await saved(page)
  await expect(page.getByRole('button', { name: /Undo change motor-to-motor diagonal/ })).toBeEnabled()

  await page.keyboard.press('Control+z')
  await expect(field(page, 'motorDiagonal')).toHaveValue('450')
  await page.keyboard.press('Control+y')
  await expect(field(page, 'motorDiagonal')).toHaveValue('500')
  await saved(page)

  // Invalid input is explained and never saved.
  await field(page, 'plateSize').fill('700')
  await field(page, 'plateSize').press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Between 20 and 600 mm')
  await field(page, 'plateSize').fill('520')
  await field(page, 'plateSize').press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Must be smaller than the motor-to-motor diagonal')
  await field(page, 'plateSize').press('Escape')
  await expect(field(page, 'plateSize')).toHaveValue('120')
  expect(errors).toEqual([])
  await first.app.close()

  page = (await launch()).page
  await openWorkshop(page, 'Editable quad')
  await expect(field(page, 'motorDiagonal')).toHaveValue('500')
  await expect(field(page, 'plateSize')).toHaveValue('120')
})

test('an edit made right before closing the app is not lost', async () => {
  const first = await launch()
  await createProject(first.page, 'Quick close hex', 'Hex X')
  await openWorkshop(first.page, 'Quick close hex')
  await field(first.page, 'armWidth').fill('25')
  await field(first.page, 'armWidth').press('Enter')
  // Close immediately: well inside the 500 ms save debounce.
  await first.app.close()

  const { page } = await launch()
  await openWorkshop(page, 'Quick close hex')
  await expect(field(page, 'armWidth')).toHaveValue('25')
})


test.describe('parametric frame and motor mounts', () => {
  test('each layout shows its motors with PX4 numbering and default spin', async () => {
    const { page } = await launch()
    const errors = trackErrors(page)
    for (const [name, frame, spins] of [
      ['Mount quad', 'Quad X', ['ccw', 'ccw', 'cw', 'cw']],
      ['Mount hex', 'Hex X', ['cw', 'ccw', 'cw', 'ccw', 'ccw', 'cw']],
      ['Mount octo', 'Octo X', ['cw', 'cw', 'ccw', 'ccw', 'ccw', 'ccw', 'cw', 'cw']],
    ] as const) {
      await page.getByRole('link', { name: 'Dashboard' }).click()
      await createProject(page, name, frame)
      await openWorkshop(page, name)
      const labels = page.locator('[data-testid^=mount-motor-]')
      await expect(labels).toHaveCount(spins.length)
      for (const [i, spin] of spins.entries()) {
        const label = page.getByTestId(`mount-motor-${i + 1}`)
        await expect(label).toBeVisible()
        await expect(label).toHaveAttribute('data-spin', spin)
      }
      await framed(page)
    }
    expect(errors).toEqual([])
  })

  test('motor spin and tilt edit, undo, reset and persist; geometry follows the diagonal', async () => {
    const first = await launch()
    let page = first.page
    await createProject(page, 'Tuned quad')
    await openWorkshop(page, 'Tuned quad')
    const inspector = page.getByTestId('motor-inspector')

    await page.getByTestId('mount-motor-1').click()
    await expect(inspector).toContainText('Front right')
    // 450 mm diagonal: motor 1 at 225 mm × (cos 45°, −sin 45°) = (159.1, −159.1) mm.
    await expect(inspector).toContainText('159.1, -159.1')

    await inspector.getByRole('button', { name: 'CW', exact: true }).click()
    await expect(page.getByTestId('mount-motor-1')).toHaveAttribute('data-spin', 'cw')
    await page.keyboard.press('Control+z')
    await expect(page.getByTestId('mount-motor-1')).toHaveAttribute('data-spin', 'ccw')
    await page.keyboard.press('Control+y')
    await expect(page.getByTestId('mount-motor-1')).toHaveAttribute('data-spin', 'cw')

    await page.getByTestId('motor-tilt').fill('45')
    await page.getByTestId('motor-tilt').press('Enter')
    await expect(page.getByRole('alert')).toHaveText('Between −30° and 30°')
    await page.getByTestId('motor-tilt').fill('12.5')
    await page.getByTestId('motor-tilt').press('Enter')
    await expect(page.getByTestId('motor-row-1')).toContainText('CW · 12.5°')

    // Geometry follows the frame: a 600 mm diagonal moves motor 1 to 212.1 mm on each axis.
    await field(page, 'motorDiagonal').fill('600')
    await field(page, 'motorDiagonal').press('Enter')
    await expect(inspector).toContainText('212.1, -212.1')
    await framed(page)
    await saved(page)
    await first.app.close()

    page = (await launch()).page
    await openWorkshop(page, 'Tuned quad')
    await expect(page.getByTestId('motor-row-1')).toContainText('CW · 12.5°')
    await page.getByTestId('motor-row-1').click()
    await page.getByRole('button', { name: 'Reset to PX4 default' }).click()
    await expect(page.getByTestId('mount-motor-1')).toHaveAttribute('data-spin', 'ccw')
    await expect(page.getByTestId('motor-row-1')).not.toContainText('°')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('motor-inspector')).toHaveCount(0)
  })
})
