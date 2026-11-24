import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi } from '../../electron/ipc/contract'
import { createProject, launchApp } from './helpers'

async function commit(page: Page, field: string, value: string) {
  await page.getByTestId(field).fill(value)
  await page.getByTestId(field).press('Enter')
}

test('wind, ground effect and an imported ASCII terrain survive reload', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'blaze-environment-'))
  const path = join(userData, 'test-slope.asc')
  writeFileSync(path, 'ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 2\n1 3\n0 2\n', 'utf8')
  const { app, page } = await launchApp(userData)
  try {
    await createProject(page, 'Terrain quad')
    await page.getByTestId('recent-projects').getByRole('link', { name: 'Terrain quad' }).click()
    await expect(page.getByTestId('environment-panel')).toBeVisible()
    const id = await page.evaluate(() => location.hash.split('/').at(-1)!)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    }, path)
    await page.getByLabel('The .asc file’s elevations are in metres').check()
    await page.getByTestId('import-terrain').click()
    await expect(page.getByTestId('terrain-import-error')).toContainText('omits NODATA_VALUE')
    await page.getByLabel('File’s NODATA sentinel').fill('-9999')
    await page.getByTestId('import-terrain').click()
    await page.getByTestId('terrain-grid').selectOption({ label: 'test-slope.asc' })
    await expect(page.getByTestId('terrain-details')).toContainText('Elevation 0 to 3 m')
    await commit(page, 'terrain-friction', '0.4')
    await commit(page, 'terrain-restitution', '0.2')

    await page.evaluate((projectId) => { location.hash = `#/flight/${projectId}` }, id)
    await page.getByTestId('wind-setting').selectOption('wind')
    await commit(page, 'wind-from', '90')
    await page.getByTestId('wind-mean').selectOption('constant')
    await commit(page, 'wind-speed', '3.5')
    await page.getByTestId('wind-gust').selectOption('none')
    await page.getByTestId('ground-effect').selectOption('true')
    await expect.poll(() => page.evaluate((projectId) =>
      (window as unknown as { api: DesktopApi }).api.assembly.load(projectId), id)).toMatchObject({
      ok: true,
      data: {
        flight: { wind: { fromDeg: 90, mean: { kind: 'constant', speedMps: 3.5 }, gust: { kind: 'none' } }, groundEffect: true },
        environment: { terrain: { friction: 0.4, restitution: 0.2 } },
      },
    })
    await page.reload()
    await expect(page.getByTestId('wind-from')).toHaveValue('90')
    await expect(page.getByTestId('wind-speed')).toHaveValue('3.5')
    await expect(page.getByTestId('ground-effect')).toHaveValue('true')
    await page.evaluate((projectId) => { location.hash = `#/workshop/${projectId}` }, id)
    await expect(page.getByTestId('terrain-grid').locator('option:checked')).toHaveText('test-slope.asc')
    await expect(page.getByTestId('terrain-friction')).toHaveValue('0.4')
    await expect(page.getByTestId('terrain-restitution')).toHaveValue('0.2')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
