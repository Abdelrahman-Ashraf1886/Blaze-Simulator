import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DesktopApi, RecordingHeader } from '../../electron/ipc/contract'
import { recordingFileName } from '../../electron/main/telemetry/format'
import { RecordingWriter } from '../../electron/main/telemetry/writer'
import { telemetryChannels } from '../../src/domain/telemetry-channels'

const root = join(__dirname, '../..')

test('opens a fixture report and saves the active page as PDF', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-report-e2e-'))
  try {
    const app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const project = await page.evaluate(() => (window as unknown as { api: DesktopApi }).api.projects.create({
        name: 'Report fixture', frameType: 'quad-x',
      }))
      if (!project.ok) throw new Error(project.error.message)
      // Same file layout and sample clock as e2e/telemetry.spec.ts:29–58.
      const channels = telemetryChannels(0, 'flightLoop')
        .filter(({ name }) => name === 'pack.voltage').map(({ name, label, unit }) => ({ name, label, unit }))
      const header: RecordingHeader = {
        runId: randomUUID(), projectId: project.data.id, projectName: project.data.name, startedAt: project.data.createdAt,
        title: 'Battery report fixture', kind: 'scenario', appVersion: 'test-app', engineVersion: 'test-engine',
        protocolVersion: 1, firstSampleStep: 4, samplePeriodSteps: 4, stepLengthS: 0.001, channels,
        vehicleLoad: JSON.stringify({ type: 'vehicle.load', vehicle: {} }),
        startRequest: JSON.stringify({ type: 'scenario.run', scenario: { type: 'builtin', name: 'balanced_hover' }, config: {} }),
      }
      const fileName = recordingFileName(header.runId)
      const writer = await RecordingWriter.start(join(userData, 'recordings', fileName), header,
        { maxPendingBytes: 4096, onSettled: () => {} })
      if (!writer) throw new Error('Could not create the fixture recording')
      const rows = [[14], [13], [12], [11]]
      const elapsedS = (header.firstSampleStep + (rows.length - 1) * header.samplePeriodSteps) * header.stepLengthS
      writer.appendSamples(rows)
      const saved = await writer.finish({ status: 'completed', reason: 'Finished', elapsedS, finalStateHash: null, engineError: null })
      expect(saved.failure).toBeNull()

      const db = new DatabaseSync(join(userData, 'blaze-uav.db'))
      try {
        db.prepare(
          'INSERT INTO simulation_runs ' +
          '(id, project_id, started_at, duration_s, status, kind, title, file_name, bytes, sample_count, engine_version, incomplete, recording_open) ' +
          "VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, 0, 0)",
        ).run(header.runId, header.projectId, header.startedAt, elapsedS, header.kind, header.title,
          fileName, saved.bytes, saved.sampleCount, header.engineVersion)
      } finally {
        db.close()
      }

      const destination = join(userData, 'flight-report.pdf')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, destination)
      await page.evaluate((id) => { window.location.hash = '/telemetry/report/' + id }, header.runId)
      await expect(page.getByRole('heading', { name: header.title })).toBeVisible()
      const metrics = page.getByRole('region', { name: 'Metrics' })
      await expect(metrics.getByText('Minimum pack voltage', { exact: true })).toBeVisible()
      await expect(metrics.getByText('11 V', { exact: true })).toBeVisible()
      await expect(metrics.getByText('Smallest recorded pack terminal voltage.')).toBeVisible()
      await page.getByRole('button', { name: 'Save as PDF' }).click()
      await expect(page.getByText('PDF saved.', { exact: true })).toBeVisible()
      expect((await readFile(destination)).subarray(0, 4).toString()).toBe('%PDF')
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
