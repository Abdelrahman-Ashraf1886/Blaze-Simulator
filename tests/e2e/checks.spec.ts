import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentInput, IpcResult } from '../../electron/ipc/contract'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-checks-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const library = (page: Page) => page.getByTestId('part-library')
const findings = (page: Page) => page.getByTestId('finding')

/** Test-only components, entered as the user would (source "user"); not real products. */
const TEST_ESC: ComponentInput = {
  category: 'esc',
  name: 'Test ESC 4S',
  manufacturer: 'Test',
  notes: null,
  specs: {
    format: { value: 'single', source: 'user' },
    cellsMin: { value: 2, source: 'user' },
    cellsMax: { value: 4, source: 'user' },
    continuousCurrent: { value: 30, unit: 'A', source: 'user' },
  },
}
const TEST_6S: ComponentInput = {
  category: 'battery',
  name: 'Test 6S pack',
  manufacturer: 'Test',
  notes: null,
  specs: { series: { value: 6, source: 'user' }, capacity: { value: 1300, unit: 'mAh', source: 'user' }, cRateContinuous: { value: 100, unit: 'C', source: 'user' } },
}

test('a 6S battery with a 4S-rated ESC is an error that points at both; fixing the battery clears it', async () => {
  const { app, page } = await launchApp(userData)
  running.push(app)
  const errors = trackErrors(page)
  await page.evaluate(async (inputs) => {
    const api = (window as unknown as { api: { components: { create(i: unknown): Promise<IpcResult<unknown>> } } }).api
    for (const i of inputs) {
      const r = await api.components.create(i)
      if (!r.ok) throw new Error(r.error.message)
    }
  }, [TEST_ESC, TEST_6S])
  await createProject(page, 'Checks quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Checks quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('checks-ok')).toHaveText('Add parts to check them.')
  // These parts are stacked at shared spots (a real overlap, reported by the 4.4 interference
  // check); this test is about other rules, so a 50 mm overlap tolerance keeps those findings out.
  // Interference itself is tested in collisions.spec.ts.
  await page.getByTestId('interference-tolerance').fill('50')
  await page.getByTestId('interference-tolerance').press('Enter')

  await library(page).getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Test Test 6S pack' })
  await page.keyboard.press('Escape')
  await library(page).getByRole('button', { name: 'ESC' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Test Test ESC 4S' })

  const cells = page.locator('[data-testid=finding][data-rule=battery-cells]')
  await expect(cells).toHaveAttribute('data-severity', 'error')
  await expect(cells).toHaveText('Battery 1 (Test 6S pack) is 6S, but ESC 1 (Test ESC 4S) is rated for at most 4S (Test ESC 4S: 4).')
  await expect(page.getByTestId('status-checks')).toHaveText('1 error')
  // Clicking the finding selects the parts involved (the battery first).
  await cells.click()
  await expect(page.getByTestId('part-inspector')).toContainText('Battery 1')

  // The Markdown report is copied to the clipboard.
  await page.getByTestId('copy-report').click()
  await expect(page.getByRole('status').filter({ hasText: 'Report copied' })).toBeVisible()
  const md = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(md).toContain('# Compatibility report: Checks quad')
  expect(md).toContain('- Battery 1 (Test 6S pack) is 6S, but ESC 1 (Test ESC 4S) is rated for at most 4S')

  // Fix: swap in a 4S battery from the library. No errors remain.
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await expect(cells).toHaveCount(0)
  await expect(page.getByTestId('status-checks')).toHaveCount(0)
  await expect(findings(page).and(page.locator('[data-severity=error]'))).toHaveCount(0)
  expect(errors).toEqual([])
})

test('propeller clearance: 13-inch props on a 450 mm quad overlap; 10-inch props do not', async () => {
  const { app, page } = await launchApp(userData)
  running.push(app)
  await createProject(page, 'Clearance quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Clearance quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV700' })
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  await page.locator('[data-testid=part-row][data-name="Motor 1"]').click()
  await page.getByTestId('copy-to-mounts').click()

  // Adjacent motors are 318 mm apart; two 330 mm discs overlap by 12 mm (four neighbouring pairs).
  const overlaps = page.locator('[data-testid=finding][data-rule=prop-clearance]')
  await expect(overlaps).toHaveCount(4)
  await expect(overlaps.first()).toContainText('overlap by 12 mm')
  await expect(page.getByTestId('status-checks')).toContainText('4 errors')

  // Swap every propeller to 10-inch props: the overlaps go away.
  for (let n = 1; n <= 4; n++) {
    await page.locator(`[data-testid=part-row][data-name="Propeller ${n}"]`).click()
    await page.getByTestId('part-component').selectOption({ label: 'APC Propellers 10x4.5MR' })
  }
  await expect(overlaps).toHaveCount(0)
  // The APC bore (1/4 in) on the 4 mm shaft remains a warning, not an error.
  await expect(page.locator('[data-testid=finding][data-rule=prop-bore]').first()).toHaveAttribute('data-severity', 'warning')
})
