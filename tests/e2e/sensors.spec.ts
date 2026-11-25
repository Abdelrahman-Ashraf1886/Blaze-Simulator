import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApiWithRecordings } from '../../electron/ipc/contract'
import { buildQuad, commit, launchApp, openFlight } from './helpers'

const latestRun = (page: Page) => page.evaluate(async () => {
  const api = (window as unknown as { api: DesktopApiWithRecordings }).api
  const reply = await api.runs.listRecent(1)
  return reply.ok ? reply.data[0] : undefined
})

async function flyTwoSeconds(page: Page, rateLoop: 'true rates' | 'modelled gyro') {
  const prior = (await latestRun(page))?.id
  await expect(page.getByTestId('flight-ready')).toBeVisible()
  await page.getByTestId('flight-start').click()
  await expect(page.getByTestId('flight-status')).toHaveText('Running')
  await expect(page.getByTestId('flight-rate-loop')).toHaveText(`Rate loop: ${rateLoop}`)
  const time = page.getByTestId('flight-debug').getByText('Time', { exact: true }).locator('xpath=following-sibling::dd')
  await expect.poll(async () => Number.parseFloat((await time.textContent()) ?? ''), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await page.getByTestId('flight-stop').click()
  await expect.poll(async () => {
    const run = await latestRun(page)
    return run?.id === prior ? undefined : run
  }).toMatchObject({ open: false, stateHash: expect.any(String) })
  return (await latestRun(page))!.id
}

const channelNames = (page: Page, id: string) => page.evaluate(async (runId) => {
  const api = (window as unknown as { api: DesktopApiWithRecordings }).api
  const summary = await api.recording.summary(runId)
  return summary.ok ? summary.data.header?.channels.map(({ name }) => name) : undefined
}, id)

test('records the catalogue gyro, then flies on it and verifies the saved run', async () => {
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-sensors-'))
  try {
    const { app, page } = await launchApp(userData)
    try {
      const project = 'Sensor quad'
      await buildQuad(page, project, { environment: true })
      // Same add-and-link sequence as phase3-acceptance.spec.ts:55–59,92.
      await page.keyboard.press('Escape')
      await page.getByTestId('part-library').getByRole('button', { name: 'Flight controller', exact: true }).click()
      await page.getByTestId('part-component').selectOption({ label: 'Holybro Pixhawk 6C' })
      await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
      await openFlight(page, project)
      // Existing flight fixture entries from flight-live.spec.ts:40–42.
      await commit(page, 'flight-altitude', '0')
      await commit(page, 'flight-cutoff-value', '12')
      await expect(page.getByLabel('Record runs')).toBeChecked()

      const form = page.getByTestId('flight-sensors')
      await form.locator('summary').click()
      await form.getByLabel('Sensor mode').selectOption('recorded')
      await form.getByLabel('Gyroscope', { exact: true }).selectOption('on')
      await expect(form.getByText('2.8 mdps/√Hz', { exact: false })).toBeVisible()
      await expect(form.getByTestId('flight-sensor-gyro-noiseSigma')).toHaveValue('')
      await form.getByRole('button', { name: 'New seed' }).click()
      const seed = await form.getByTestId('flight-sensor-seed').inputValue()
      expect(seed).toMatch(/^-?\d+$/)
      for (const field of ['vibrationSigma', 'bias', 'randomWalk', 'range', 'delayMs']) {
        await commit(page, `flight-sensor-gyro-${field}`, 'off')
      }

      await form.getByLabel('Accelerometer', { exact: true }).selectOption('on')
      const mountField = form.getByTestId('flight-sensor-accelerometer-mountPositionM')
      await expect(mountField).toHaveValue('')
      const mountButton = form.getByRole('button', { name: /Use flight controller position/ })
      const position = (await mountButton.innerText()).match(/\((.*) m\)/)![1]!
      await mountButton.click()
      await expect(mountField).toHaveValue(position)
      await form.getByLabel('Accelerometer', { exact: true }).selectOption('off')
      await form.getByLabel('GPS', { exact: true }).selectOption('on')
      const gpsDelay = form.getByTestId('flight-sensor-gps-delayMs')
      await expect(gpsDelay).toHaveValue('')
      await form.getByRole('button', { name: /EKF2_GPS_DELAY.*110 ms/ }).click()
      await expect(gpsDelay).toHaveValue('110')
      await form.getByLabel('GPS', { exact: true }).selectOption('off')
      await form.getByLabel('Barometer', { exact: true }).selectOption('off')

      const recorded = await flyTwoSeconds(page, 'true rates')
      expect(await channelNames(page, recorded)).toEqual(expect.arrayContaining(['sensor.gyro.x', 'sensor.gyro.y', 'sensor.gyro.z']))

      await form.getByLabel('Sensor mode').selectOption('flyOnGyro')
      await expect(form.getByTestId('flight-sensor-seed')).toHaveValue(seed)
      await expect(form.getByLabel('IMU_GYRO_CUTOFF', { exact: true })).toHaveValue('')
      await expect(page.getByTestId('flight-start')).toBeDisabled()
      await form.getByRole('button', { name: 'Use PX4 v1.13.3 defaults' }).click()
      await expect(form.getByLabel('IMU_GYRO_CUTOFF', { exact: true })).toHaveValue('40')
      await expect(form.getByLabel('IMU_GYRO_NF0_FRQ', { exact: true })).toHaveValue('0')
      const flown = await flyTwoSeconds(page, 'modelled gyro')
      expect(flown).not.toBe(recorded)
      expect(await channelNames(page, flown)).toEqual(expect.arrayContaining(['sensor.gyroFiltered.x', 'controller.rateSource']))
      const verification = await page.evaluate(async (id) => {
        const api = (window as unknown as { api: DesktopApiWithRecordings }).api
        return api.recording.verify(id, crypto.randomUUID())
      }, flown)
      expect(verification).toMatchObject({ ok: true, data: { status: 'same' } })
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
