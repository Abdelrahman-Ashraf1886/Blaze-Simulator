/**
 * Phase 3 acceptance (documentation/plans/phase-3-components.md), end to end and
 * across a restart:
 *   1. build a hex from library components (in the workshop, as a user would);
 *   2. auto-wire it;
 *   3. see zero errors;
 *   4. swap in a battery outside the ESC's rating and get the error;
 *   5. fix it and get zero errors again.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentInput, IpcResult } from '../../electron/ipc/contract'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-accept3-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

/** Test-only pack above the ESC's 6S maximum, entered as a user would (source "user"); not a real product. */
const TEST_8S: ComponentInput = {
  category: 'battery',
  name: 'Test 8S pack',
  manufacturer: 'Test',
  notes: null,
  specs: { series: { value: 8, source: 'user' }, capacity: { value: 5000, unit: 'mAh', source: 'user' }, cRateContinuous: { value: 40, unit: 'C', source: 'user' } },
}

const NAME = 'Acceptance hex 3'
const library = (page: Page) => page.getByTestId('part-library')
const rows = (page: Page) => page.getByTestId('part-row')
const row = (page: Page, name: string) => page.locator(`[data-testid=part-row][data-name="${name}"]`)
const link = (page: Page, label: string) => page.getByTestId('part-component').selectOption({ label })
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
const errorsIn = (scope: ReturnType<Page['getByTestId']>) => scope.locator('[data-testid=finding][data-severity=error]')

async function openWorkshop(page: Page) {
  await page.getByTestId('nav-/workshop').click()
  await page.getByRole('link', { name: NAME }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}

/** Adds a part of `kind` from the library (nothing selected, so it is not stacked on another part) and links it. */
async function add(page: Page, kind: string, label: string) {
  await page.keyboard.press('Escape')
  await library(page).getByRole('button', { name: kind, exact: true }).click()
  await link(page, label)
}

test('hex from library parts: auto-wire, zero errors; an 8S battery on 6S ESCs is an error; fixing it clears it; all of it survives a restart', async () => {
  test.setTimeout(180_000)
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await page.evaluate(async (input) => {
    const api = (window as unknown as { api: { components: { create(i: unknown): Promise<IpcResult<unknown>> } } }).api
    const r = await api.components.create(input)
    if (!r.ok) throw new Error(r.error.message)
  }, TEST_8S)
  await createProject(page, NAME, 'Hex X')
  await openWorkshop(page)
  // These parts are stacked at shared spots (a real overlap, reported by the 4.4 interference
  // check); this test is about other rules, so a 50 mm overlap tolerance keeps those findings out.
  // Interference itself is tested in collisions.spec.ts.
  await page.getByTestId('interference-tolerance').fill('50')
  await page.getByTestId('interference-tolerance').press('Enter')

  // 1. Build: a linked motor and propeller on every mount, then the electrical parts.
  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor', exact: true }).click()
  await link(page, 'T-Motor MN3110 KV700')
  await library(page).getByRole('button', { name: 'Propeller', exact: true }).click()
  await link(page, 'APC Propellers 10x4.5MR')
  await row(page, 'Motor 1').click()
  await page.getByTestId('copy-to-mounts').click()
  await expect(rows(page)).toHaveCount(12)
  await add(page, 'Battery', 'Tattu Tattu G-Tech 5200mAh 4S 35C')
  await add(page, 'ESC', 'Holybro Tekko32 F4 45A ESC (AM32)')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+d') // linked copies: ESC 2…6
  await expect(rows(page)).toHaveCount(19)
  await add(page, 'Flight controller', 'Holybro Pixhawk 6C')
  await add(page, 'Payload', 'Holybro PM02 V3')
  await add(page, 'Payload', 'Holybro M10 GPS')
  await add(page, 'Payload', 'Holybro SiK Telemetry Radio V3 100mW')
  await expect(rows(page)).toHaveCount(23)
  await expect(row(page, 'ESC 6')).toHaveCount(1)
  await saved(page)

  // 2. Auto-wire in the Electrical Designer: 1 battery→PM, 6 PM→ESC, 6 ESC→motor, 6 PWM→ESC, sense, GPS, radio.
  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: NAME }).click()
  await expect(page.getByTestId('schematic-node')).toHaveCount(17) // propellers have no ports
  await page.getByTestId('auto-wire').click()
  await expect(page.getByTestId('wire-row')).toHaveCount(22)
  await expect(page.getByTestId('autowire-notes')).toHaveCount(0)

  // 3. Zero errors, in the designer and in the workshop (warnings such as the APC bore adapter may remain).
  await expect(page.getByTestId('electrical-checks')).toBeVisible()
  await expect(errorsIn(page.getByTestId('electrical-checks'))).toHaveCount(0)
  await saved(page)
  await page.getByTestId('electrical').getByRole('link', { name: 'Workshop' }).click()
  await expect(page.getByTestId('checks').locator('[data-testid=finding]').first()).toBeVisible()
  await expect(errorsIn(page.getByTestId('checks'))).toHaveCount(0)
  await expect(page.getByTestId('status-checks')).not.toContainText('error')

  // 4. An 8S pack on ESCs and motors rated for at most 6S: an error naming the battery and the ESCs.
  await row(page, 'Battery 1').click()
  await link(page, 'Test Test 8S pack')
  const cells = (p: Page) => p.getByTestId('checks').locator('[data-testid=finding][data-rule=battery-cells][data-severity=error]')
  await expect(cells(page)).toHaveCount(2) // the ESCs and the motors
  await expect(cells(page).filter({ hasText: '6 × Tekko32 F4 45A ESC (AM32)' })).toHaveText(
    'Battery 1 (Test 8S pack) is 8S, but 6 × Tekko32 F4 45A ESC (AM32) is rated for at most 6S (Tekko32 F4 45A ESC (AM32): 6 (2-6s LIPO input)).',
  )
  await expect(page.getByTestId('status-checks')).toContainText('2 errors')
  await saved(page)

  // The error persists across a restart, wiring and all.
  expect(errors).toEqual([])
  await first.app.close()
  page = (await launch()).page
  const errors2 = trackErrors(page)
  await openWorkshop(page)
  await expect(rows(page)).toHaveCount(23)
  await expect(page.getByTestId('status-checks')).toContainText('2 errors')

  // 5. Fix: the 4S Tattu again. Zero errors, in both views, and still after another restart.
  await row(page, 'Battery 1').click()
  await link(page, 'Tattu Tattu G-Tech 5200mAh 4S 35C')
  await expect(cells(page)).toHaveCount(0)
  await expect(errorsIn(page.getByTestId('checks'))).toHaveCount(0)
  await saved(page)
  expect(errors2).toEqual([])
  await running.at(-1)!.close()

  page = (await launch()).page
  const errors3 = trackErrors(page)
  await openWorkshop(page)
  await expect(rows(page)).toHaveCount(23)
  await expect(page.getByTestId('checks').locator('[data-testid=finding]').first()).toBeVisible()
  await expect(errorsIn(page.getByTestId('checks'))).toHaveCount(0)
  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: NAME }).click()
  await expect(page.getByTestId('wire-row')).toHaveCount(22)
  await expect(errorsIn(page.getByTestId('electrical-checks'))).toHaveCount(0)
  expect(errors3).toEqual([])
})
