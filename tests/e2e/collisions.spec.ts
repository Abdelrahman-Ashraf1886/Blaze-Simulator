import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, root, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-collisions-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

/** Screenshots for the DEVLOG (documentation/screenshots), refreshed by every run. */
const shots = join(root, 'documentation', 'screenshots')

test('interference: two batteries overlapping are an error and highlighted; allow, tolerance, debug view; settings persist', async () => {
  mkdirSync(shots, { recursive: true })
  const first = await launchApp(userData)
  running.push(first.app)
  let page = first.page
  const errors = trackErrors(page)
  await createProject(page, 'Collision quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Collision quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  const view = page.getByTestId('collision-view')
  const interference = page.locator('[data-testid=finding][data-rule=interference][data-severity=error]')

  // One battery on the frame: mounted contact only, no finding.
  const library = page.getByTestId('part-library')
  await library.getByRole('button', { name: 'Battery' }).click()
  await expect(interference).toHaveCount(0)
  await expect(view).toHaveAttribute('data-highlighted', '')

  // A second, free battery (nothing selected, so not attached to the first) 40 mm to the side
  // of the first: batteries are 45 mm wide → 5 mm overlap.
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await library.getByRole('button', { name: 'Battery' }).click()
  await expect(page.getByTestId('part-pos-y')).toBeVisible()
  await commit(page, 'part-pos-y', '40')
  await expect(interference).toHaveCount(1)
  await expect(interference).toContainText('Battery 1 and Battery 2 overlap by 5 mm (your tolerance: 0.5 mm)')
  // Both are highlighted in the viewport.
  await expect(view).toHaveAttribute('data-highlighted', /^[^,]+,[^,]+$/)
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('f')
  await page.waitForTimeout(800)
  await page.getByTestId('viewport-3d').screenshot({ path: join(shots, '4.4-interference-highlight.png') })

  // Allowing the pair clears the error and the highlight, and lists the pair; undo brings it back.
  await page.getByTestId('allow-overlap').click()
  await expect(interference).toHaveCount(0)
  await expect(view).toHaveAttribute('data-highlighted', '')
  await expect(page.getByTestId('allowed-pair')).toContainText('Battery 1 · Battery 2')
  await expect(page.getByTestId('allowed-pair')).toContainText('5 mm')
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(interference).toHaveCount(1)
  await expect(page.getByTestId('allowed-none')).toBeVisible()

  // Tolerance edge: 5.01 mm accepts the 5 mm overlap, 4.99 mm does not.
  await commit(page, 'interference-tolerance', '5.01')
  await expect(interference).toHaveCount(0)
  await commit(page, 'interference-tolerance', '4.99')
  await expect(interference).toHaveCount(1)
  await commit(page, 'interference-tolerance', '0.5')

  // Debug view (B): every collision shape: the frame's plate and 4 arms, and both batteries.
  await expect(view).toHaveAttribute('data-shapes', '0')
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('b')
  await expect(view).toHaveAttribute('data-shapes', '7')
  await page.waitForTimeout(500)
  await page.getByTestId('viewport-3d').screenshot({ path: join(shots, '4.4-collision-debug-view.png') })
  await page.keyboard.press('b')
  await expect(view).toHaveAttribute('data-shapes', '0')

  // Allow the pair and set a tolerance, then restart: both are saved with the project.
  await page.getByTestId('allow-overlap').click()
  await commit(page, 'interference-tolerance', '1.5')
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launchApp(userData)
  running.push(second.app)
  page = second.page
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Collision quad' }).click()
  await expect(page.getByTestId('interference-tolerance')).toHaveValue('1.5')
  await expect(page.getByTestId('allowed-pair')).toContainText('Battery 1 · Battery 2')
  await expect(page.locator('[data-testid=finding][data-rule=interference]')).toHaveCount(0)
})
