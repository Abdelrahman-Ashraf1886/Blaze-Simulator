import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApiWithRecordings } from '../../electron/ipc/contract'
import { buildQuad, commit, launchApp, openFlight } from './helpers'

const project = 'Phase 7 acceptance quad'
const title = 'Flight Simulator'

const runRow = (page: Page) => page.getByRole('row').filter({
  has: page.getByRole('cell', { name: project, exact: true }),
})

async function openRun(page: Page) {
  await page.getByTestId('nav-/telemetry').click()
  await runRow(page).getByRole('button', { name: title, exact: true }).click()
  const replay = page.getByRole('region', { name: 'Recording replay' })
  await expect(replay.getByTestId('flight-viewport').locator('canvas')).toBeVisible()
  return replay
}

async function verify(page: Page) {
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Verification result' })).toContainText('Same')
}

test('12: records, replays, exports and verifies a flight across restart, then deletes it', async () => {
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-phase7-'))
  try {
    const { app, page } = await launchApp(userData)
    let recording: string
    try {
      await buildQuad(page, project, { environment: true })
      await openFlight(page, project)
      // Same setup and flight duration as replay.spec.ts:10–16,40–42.
      await commit(page, 'flight-altitude', '0')
      await commit(page, 'flight-cutoff-value', '12')
      await expect(page.getByTestId('flight-ready')).toBeVisible()
      await expect(page.getByLabel('Record runs')).toBeChecked()
      await page.getByTestId('flight-start').click()
      await expect(page.getByTestId('flight-status')).toHaveText('Running')
      const flightTime = page.getByTestId('flight-debug').getByText('Time', { exact: true })
        .locator('xpath=following-sibling::dd')
      await expect.poll(async () => Number.parseFloat(await flightTime.textContent() ?? '')).toBeGreaterThanOrEqual(3)
      await page.getByTestId('flight-stop').click()

      const lastRun = () => page.evaluate(async () => {
        const api = (window as unknown as { api: DesktopApiWithRecordings }).api
        const result = await api.runs.listRecent(1)
        if (!result.ok) throw new Error(result.error.message)
        return result.data[0]
      })
      await expect.poll(lastRun).toMatchObject({ open: false, stateHash: expect.any(String), fileName: expect.any(String) })
      const run = await lastRun()
      if (!run?.fileName) throw new Error('The stopped flight has no recording file')
      recording = join(userData, 'recordings', run.fileName)
      expect((await stat(recording)).isFile()).toBe(true)

      const replay = await openRun(page)
      const time = replay.getByLabel('Replay time')
      await replay.getByRole('button', { name: 'Play', exact: true }).click()
      await expect.poll(async () => Number.parseFloat(await time.textContent() ?? '')).toBeGreaterThan(0)
      await replay.getByRole('slider', { name: 'Replay position' }).fill('1')
      await expect(time).toHaveText('1.000 s')
      await verify(page)

      const csv = test.info().outputPath('run.csv')
      const pdf = test.info().outputPath('report.pdf')
      await app.evaluate(({ dialog }, paths) => {
        dialog.showSaveDialog = (async (_win: unknown, options: { filters: { extensions: string[] }[] }) =>
          ({ canceled: false, filePath: options.filters[0]!.extensions[0] === 'pdf' ? paths.pdf : paths.csv })) as never
      }, { csv, pdf })

      await page.getByRole('checkbox', { name: 'Mode names instead of codes' }).check()
      await page.getByRole('button', { name: 'Export CSV' }).click()
      await expect(page.getByText('CSV saved.')).toBeVisible()
      const rows = (await readFile(csv, 'utf8')).trimEnd().split('\r\n')
      expect(rows[0]).toMatch(/^time \[s\],/)
      // Three seconds at 250 Hz and the initial row, as in replay.spec.ts:79–82.
      expect(rows.length - 1).toBeGreaterThanOrEqual(751)

      await page.getByRole('link', { name: 'Report' }).click()
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
      await page.getByRole('button', { name: 'Save as PDF' }).click()
      await expect(page.getByText('PDF saved.', { exact: true })).toBeVisible()
      expect((await readFile(pdf)).subarray(0, 4).toString()).toBe('%PDF')
    } finally {
      await app.close()
    }

    const restarted = await launchApp(userData)
    try {
      await openRun(restarted.page)
      await verify(restarted.page)
      await restarted.page.getByRole('button', { name: 'Back to runs' }).click()
      await runRow(restarted.page).getByRole('button', { name: 'Delete Flight Simulator' }).click()
      await restarted.page.getByRole('dialog').getByRole('button', { name: 'Delete run' }).click()
      await expect(runRow(restarted.page)).toHaveCount(0)
      await expect(stat(recording)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await restarted.app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
