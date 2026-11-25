import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQuad, commit, launchApp, openFlight } from './helpers'

function recordedFlight(page: Page, project: string) {
  return page.getByTestId('simulation-history').getByTestId('simulation-run').filter({ hasText: project })
}

test('a stopped flight is listed on the dashboard and survives restart', async () => {
  // Build and flight settings from flight-live.spec.ts:27-47.
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'blazeuav-recording-'))
  const project = 'Recorded quad'
  let app: ElectronApplication | undefined
  try {
    const first = await launchApp(userData)
    app = first.app
    await buildQuad(first.page, project, { environment: true })
    await openFlight(first.page, project)
    await commit(first.page, 'flight-altitude', '0')
    await commit(first.page, 'flight-cutoff-value', '12')
    await expect(first.page.getByRole('checkbox', { name: 'Record runs' })).toBeChecked()
    await first.page.getByTestId('flight-start').click()
    const time = first.page.getByTestId('flight-debug').locator('dt', { hasText: /^Time$/ }).locator('xpath=following-sibling::dd')
    await expect.poll(async () => Number.parseFloat(await time.innerText())).toBeGreaterThanOrEqual(2)
    await first.page.getByTestId('flight-stop').click()
    await first.page.getByRole('link', { name: 'Dashboard', exact: true }).click()

    const row = recordedFlight(first.page, project)
    await expect(row).toContainText('Flight Simulator')
    await expect(row).toContainText('completed')
    await expect(row.getByRole('cell').last()).toHaveText(/^[1-9][\d,]* B$/)
    const saved = await row.innerText()

    await app.close()
    app = undefined
    const second = await launchApp(userData)
    app = second.app
    await expect(recordedFlight(second.page, project)).toHaveText(saved, { useInnerText: true })
  } finally {
    await app?.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
