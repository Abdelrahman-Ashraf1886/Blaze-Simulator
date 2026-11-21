import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-mass-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

test('mass properties: frame mass, a battery moved 40 mm shifts the CoM and the hover shares; undo; marker; persists', async () => {
  const first = await launchApp(userData)
  running.push(first.app)
  let page = first.page
  const errors = trackErrors(page)
  await createProject(page, 'Mass quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Mass quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()

  // Nothing has a mass yet: the frame is listed and there is no CoM.
  await expect(page.getByTestId('mass-missing')).toContainText('Frame')
  await expect(page.getByTestId('com-none')).toBeVisible()
  await expect(page.getByTestId('com-marker')).toHaveCount(0)

  // Frame 300 g: CoM on the frame axis, at half the frame thickness.
  await commit(page, 'frame-mass', '300')
  await expect(page.getByTestId('mass-total')).toHaveText('300.0')
  await expect(page.getByTestId('mass-missing')).toHaveCount(0)
  const thicknessMm = Number(await page.getByTestId('frame-armThickness').inputValue())
  const diagonalMm = Number(await page.getByTestId('frame-motorDiagonal').inputValue())
  await expect(page.getByTestId('com-x')).toHaveText('0.0')
  await expect(page.getByTestId('com-y')).toHaveText('0.0')
  await expect(page.getByTestId('com-z')).toHaveText((thicknessMm / 2).toFixed(1))
  await expect(page.getByTestId('com-marker')).toBeVisible()
  for (let i = 1; i <= 4; i++) await expect(page.getByTestId(`hover-share-${i}`)).toHaveText('100.0 %')

  // A 500 g battery without a library link: incomplete until its mass is entered.
  await page.getByTestId('part-library').getByRole('button', { name: 'Battery' }).click()
  await expect(page.getByTestId('mass-missing')).toContainText('Battery 1')
  await commit(page, 'part-mass', '500')
  await expect(page.getByTestId('mass-total')).toHaveText('800.0')
  await expect(page.getByTestId('com-x')).toHaveText('0.0')

  // Battery 40 mm forward: CoM x = 0.5 kg × 40 mm / 0.8 kg = 25.0 mm.
  await commit(page, 'part-pos-x', '40')
  await expect(page.getByTestId('com-x')).toHaveText('25.0')
  await expect(page.getByTestId('com-offset')).toHaveText('25.0')
  // Hover shares on a quad X with motors at ±a (a = diagonal/2 · cos 45°): front 1 + d/a, rear 1 − d/a.
  const a = (diagonalMm / 2) * Math.SQRT1_2
  await expect(page.getByTestId('hover-share-1')).toHaveText(`${((1 + 25 / a) * 100).toFixed(1)} %`)
  await expect(page.getByTestId('hover-share-2')).toHaveText(`${((1 - 25 / a) * 100).toFixed(1)} %`)
  // Above the default 10 % margin: a hover-balance warning naming the front motors.
  const balance = page.locator('[data-testid=finding][data-rule=hover-balance]')
  await expect(balance).toHaveAttribute('data-severity', 'warning')
  await expect(balance).toContainText('Motor 1')
  // Raising the margin clears it.
  await commit(page, 'balance-tolerance', '50')
  await expect(balance).toHaveCount(0)
  await commit(page, 'balance-tolerance', '10')
  await expect(balance).toHaveCount(1)

  // Undo the move: the CoM returns to the axis.
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('com-x')).toHaveText('0.0')
  await expect(balance).toHaveCount(0)

  // The marker can be hidden with C and shown again.
  await page.keyboard.press('c')
  await expect(page.getByTestId('com-marker')).toHaveCount(0)
  await page.keyboard.press('c')
  await expect(page.getByTestId('com-marker')).toBeVisible()
  expect(errors).toEqual([])
  await first.app.close()

  // The frame mass is saved with the project.
  const second = await launchApp(userData)
  running.push(second.app)
  page = second.page
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Mass quad' }).click()
  await expect(page.getByTestId('frame-mass')).toHaveValue('300')
  await expect(page.getByTestId('mass-total')).toHaveText('800.0')
})
