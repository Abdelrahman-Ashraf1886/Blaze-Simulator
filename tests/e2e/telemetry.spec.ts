import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DesktopApi, RecordingHeader } from '../../electron/ipc/contract'
import { recordingFileName } from '../../electron/main/telemetry/format'
import { RecordingWriter } from '../../electron/main/telemetry/writer'
import { telemetryChannels } from '../../src/domain/telemetry-channels'
import { ignoreRealMouse } from './helpers'

const root = join(__dirname, '../..')

test('opens a saved recording, adds a channel, and zooms the graph', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-telemetry-e2e-'))
  try {
    const app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await ignoreRealMouse(app)
      const project = await page.evaluate(() => (window as unknown as { api: DesktopApi }).api.projects.create({ name: 'Telemetry fixture', frameType: 'quad-x' }))
      if (!project.ok) throw new Error(project.error.message)

      // Build a real recording with the store test's sample clock (recording-store.test.ts:35–39).
      const channels = telemetryChannels(0, 'flightLoop')
        .filter(({ name }) => name === 'pack.voltage' || name === 'pack.current')
        .map(({ name, label, unit }) => ({ name, label, unit }))
      const header: RecordingHeader = {
        runId: randomUUID(), projectId: project.data.id, projectName: project.data.name, startedAt: project.data.createdAt,
        title: 'Battery recording fixture', kind: 'scenario', appVersion: 'test-app', engineVersion: 'test-engine',
        protocolVersion: 1, firstSampleStep: 4, samplePeriodSteps: 4, stepLengthS: 0.001, channels,
        vehicleLoad: '{}', startRequest: '{}',
      }
      const fileName = recordingFileName(header.runId)
      const writer = await RecordingWriter.start(join(userData, 'recordings', fileName), header,
        { maxPendingBytes: 4096, onSettled: () => {} })
      if (!writer) throw new Error('Could not create the fixture recording')
      const rows = [[14, 1], [13, 2], [12, 3], [11, 4]]
      const elapsedS = (header.firstSampleStep + (rows.length - 1) * header.samplePeriodSteps) * header.stepLengthS
      writer.appendSamples(rows)
      const saved = await writer.finish({ status: 'completed', reason: 'Finished', elapsedS, finalStateHash: null, engineError: null })
      expect(saved.failure).toBeNull()

      // The app has already migrated its own isolated DB (index.ts:188–201).
      const db = new DatabaseSync(join(userData, 'blaze-uav.db'))
      try {
        db.prepare(`INSERT INTO simulation_runs
          (id, project_id, started_at, duration_s, status, kind, title, file_name, bytes, sample_count, engine_version, incomplete, recording_open)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, 0, 0)`)
          .run(header.runId, header.projectId, header.startedAt, elapsedS, header.kind, header.title,
            fileName, saved.bytes, saved.sampleCount, header.engineVersion)
      } finally {
        db.close()
      }

      await page.getByTestId('nav-/telemetry').click()
      await page.getByRole('button', { name: header.title }).click()
      await expect(page.getByRole('region', { name: 'Selected run' })).toContainText('test-engine')
      await page.getByRole('button', { name: 'Add graph' }).click()
      const graph = page.getByRole('article', { name: 'Graph 3' })
      await graph.getByText('Edit channels').click()
      await graph.getByRole('searchbox', { name: 'Search channels' }).fill('voltage')
      await graph.getByLabel('Channel', { exact: true }).selectOption('pack.voltage')
      await graph.getByRole('button', { name: 'Add channel' }).click()
      const plot = graph.getByRole('group', { name: 'Graph 3' })
      await plot.focus()
      await expect(async () => {
        await plot.press('ArrowRight')
        await expect(graph.locator('dd').first()).toContainText(' s', { timeout: 250 })
      }).toPass()
      const overlay = graph.locator('.u-over')
      await expect(overlay).toBeVisible()
      await overlay.scrollIntoViewIfNeeded()
      const box = (await overlay.boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width / 4, y)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 3 / 4, y, { steps: 4 })
      await page.mouse.up()
      await expect(graph.getByLabel('Visible time range')).toBeVisible()
      await graph.getByRole('button', { name: 'Reset zoom' }).click()
      await expect(graph.getByLabel('Visible time range')).toHaveCount(0)
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
