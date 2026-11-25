import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, stat, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApiWithRecordings } from '../../electron/ipc/contract'
import { buildQuad, commit, launchApp, openFlight } from './helpers'

const seconds = (text: string | null) => Number.parseFloat(text ?? '')

async function prepareFlight(page: Page, project: string) {
  await buildQuad(page, project, { environment: true })
  await openFlight(page, project)
  // Same user-entered conditions as flight-live.spec.ts:40–42.
  await commit(page, 'flight-altitude', '0')
  await commit(page, 'flight-cutoff-value', '12')
  await expect(page.getByTestId('flight-ready')).toBeVisible()
}

test('shows a live trace, then replays, scrubs and verifies a three-second recording', async () => {
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-replay-'))
  try {
    const { app, page } = await launchApp(userData)
    try {
      await prepareFlight(page, 'Replay quad')
      await expect(page.getByLabel('Record runs')).toBeChecked()
      await expect(page.getByRole('region', { name: 'Live telemetry' })).toHaveCount(0)
      await page.getByTestId('flight-start').click()
      await expect(page.getByTestId('flight-status')).toHaveText('Running')
      await page.getByRole('button', { name: 'Show live graphs' }).click()
      const live = page.getByRole('region', { name: 'Live telemetry' })
      const altitude = live.getByRole('group', { name: 'Altitude' })
      await altitude.focus()
      await expect(async () => {
        await altitude.press('ArrowRight')
        const value = live.getByText('Body origin Z (m)').locator('xpath=ancestor::dt/following-sibling::dd')
        expect(Number.isFinite(seconds(await value.textContent()))).toBe(true)
      }).toPass()

      const flightTime = page.getByTestId('flight-debug').getByText('Time', { exact: true }).locator('xpath=following-sibling::dd')
      await expect.poll(async () => seconds(await flightTime.textContent())).toBeGreaterThanOrEqual(3)
      await page.getByTestId('flight-stop').click()
      const lastRun = () => page.evaluate(async () => {
        const api = (window as unknown as { api: DesktopApiWithRecordings }).api
        const runs = await api.runs.listRecent(1)
        return runs.ok ? runs.data[0] : undefined
      })
      await expect.poll(lastRun).toMatchObject({ open: false, stateHash: expect.any(String) })
      const fileName = (await lastRun())?.fileName
      expect(fileName).toBeTruthy()

      await page.getByTestId('nav-/telemetry').click()
      await page.getByRole('button', { name: 'Flight Simulator', exact: true }).click()
      const replay = page.getByRole('region', { name: 'Recording replay' })
      const time = replay.getByLabel('Replay time')
      await expect(replay.getByTestId('flight-viewport').locator('canvas')).toBeVisible()
      await replay.getByRole('button', { name: 'Play', exact: true }).click()
      await expect.poll(async () => seconds(await time.textContent())).toBeGreaterThan(0)
      await replay.getByRole('button', { name: 'Pause', exact: true }).click()
      await replay.getByRole('slider', { name: 'Replay position' }).fill('1')
      await expect(time).toHaveText('1.000 s')
      const graph = page.getByRole('article', { name: 'Graph 1' })
      await expect(graph.locator('dd').first()).toHaveText('1 s')
      await graph.getByRole('group', { name: 'Graph 1' }).press('ArrowRight')
      await expect.poll(async () => seconds(await time.textContent())).toBeGreaterThan(1)
      await replay.getByRole('button', { name: 'Next sample' }).click()
      await page.getByRole('button', { name: 'Verify', exact: true }).click()
      await expect(page.getByRole('status', { name: 'Verification result' })).toContainText('Same')

      await page.getByRole('button', { name: 'Back to runs' }).click()
      const recording = join(userData, 'recordings', fileName!)
      await truncate(recording, (await stat(recording)).size - 1)
      await page.getByRole('button', { name: 'Flight Simulator', exact: true }).click()
      await expect(page.getByText('This recording is incomplete. Available samples are shown.')).toBeVisible()
      await expect(replay.getByTestId('flight-viewport').locator('canvas')).toBeVisible()
      await page.getByRole('button', { name: 'Verify', exact: true }).click()
      await expect(page.getByRole('status', { name: 'Verification result' })).toContainText('Cannot verify')
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
