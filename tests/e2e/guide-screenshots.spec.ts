import { expect, test, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQuad, commit, launchApp, root, savePadCalibration, setPad } from './helpers'

const width = 1920
const height = 1080
const shots = join(root, 'documentation', 'screenshots', 'guide')
const project = 'Guide quad'

async function capture(page: Page, name: string) {
  const png = await page.screenshot({ animations: 'disabled', scale: 'css' })
  expect(png.readUInt32BE(16)).toBe(width)
  expect(png.readUInt32BE(20)).toBe(height)
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, `${name}.png`), png)
}

async function open(page: Page, route: string, projectScoped = false) {
  await page.getByTestId(`nav-/${route}`).click()
  if (projectScoped) await page.getByRole('link', { name: project, exact: true }).click()
}

test('capture the user guide in the unpackaged app', async () => {
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-guide-'))
  try {
    // helpers.ts:19–24 enables test hooks against the local out/ build.
    const { app, page } = await launchApp(userData, {}, ['--force-device-scale-factor=1'])
    try {
      await page.setViewportSize({ width, height })
      // Build data comes from the existing test fixture (helpers.ts:63–100).
      await buildQuad(page, project, { environment: true })
      await page.waitForFunction(() => {
        const hooks = (window as unknown as { __blazeTest?: { projectObject?: unknown } }).__blazeTest
        return typeof hooks?.projectObject === 'function'
      })
      await capture(page, 'workshop')

      await open(page, 'components')
      await page.getByTestId('component-row').filter({ hasText: 'MN3110 KV470' }).click()
      await expect(page.getByTestId('spec-list')).toBeVisible()
      await capture(page, 'components')

      await open(page, 'electrical', true)
      await expect(page.getByTestId('schematic')).toBeVisible()
      await capture(page, 'electrical')

      await open(page, 'analysis', true)
      await expect(page.getByTestId('analysis-mass')).toBeVisible()
      await capture(page, 'analysis')

      await savePadCalibration(page)
      await setPad(page, true)
      await open(page, 'input')
      await page.getByRole('button', { name: /DualSense/ }).click()
      await expect(page.getByRole('button', { name: 'Save calibration' })).toBeVisible()
      await capture(page, 'input')
      await setPad(page, false)

      await open(page, 'flight', true)
      // Same recording conditions and elapsed time as recording.spec.ts:22–29.
      await commit(page, 'flight-altitude', '0')
      await commit(page, 'flight-cutoff-value', '12')
      await page.getByTestId('flight-mode').selectOption('position')
      await page.getByRole('checkbox', { name: 'Record runs', exact: true }).check()
      await page.getByTestId('flight-start').click()
      await expect(page.getByRole('button', { name: 'Takeoff', exact: true })).toBeEnabled()
      const time = page.getByTestId('flight-debug').locator('dt', { hasText: /^Time$/ }).locator('xpath=following-sibling::dd')
      await expect.poll(async () => Number.parseFloat(await time.innerText())).toBeGreaterThanOrEqual(2)
      await capture(page, 'flight')
      await page.getByTestId('flight-stop').click()
      await page.getByTestId('flight-sensors').locator('summary').click()
      await expect(page.getByLabel('Sensor mode')).toBeVisible()
      await capture(page, 'sensors')

      await open(page, 'scenarios', true)
      await expect(page.getByTestId('scenario-list')).toBeVisible()
      await capture(page, 'scenarios')

      await open(page, 'tuning', true)
      await expect(page.getByRole('button', { name: 'Run step test' })).toBeVisible()
      await capture(page, 'tuning')

      await open(page, 'telemetry')
      await page.getByRole('button', { name: 'Flight Simulator', exact: true }).click()
      await expect(page.getByRole('link', { name: 'Report' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
      await capture(page, 'telemetry')
      await page.getByRole('link', { name: 'Report' }).click()
      await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible()
      await capture(page, 'report')

      await open(page, 'settings')
      await expect(page.getByText('Drawing card', { exact: true })).toBeVisible()
      await expect(page.getByTestId('drawing-card')).not.toHaveText('Detecting…')
      await capture(page, 'settings')
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
