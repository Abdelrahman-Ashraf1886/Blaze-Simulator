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
    await expect(page.getByTestId('wind-turbulence')).toHaveValue('off')
    await page.getByTestId('wind-turbulence').selectOption('dryden')
    await expect(page.getByTestId('wind-turbulence-seed')).toHaveValue('')
    const limits = page.getByTestId('wind-turbulence-limits')
    await expect(limits).toBeVisible()
    await expect(limits).toContainText('does not model hovering flight')
    await expect(limits).toContainText('stops changing at zero airspeed')
    await commit(page, 'wind-turbulence-seed', '0')
    await page.getByTestId('ground-effect').selectOption('true')
    await expect.poll(() => page.evaluate((projectId) =>
      (window as unknown as { api: DesktopApi }).api.assembly.load(projectId), id)).toMatchObject({
      ok: true,
      data: {
        flight: { wind: { fromDeg: 90, mean: { kind: 'constant', speedMps: 3.5 }, gust: { kind: 'none' },
          turbulence: { kind: 'dryden', seed: 0 } }, groundEffect: true },
        environment: { terrain: { friction: 0.4, restitution: 0.2 } },
      },
    })
    await page.reload()
    await expect(page.getByTestId('wind-from')).toHaveValue('90')
    await expect(page.getByTestId('wind-speed')).toHaveValue('3.5')
    await expect(page.getByTestId('wind-turbulence')).toHaveValue('dryden')
    await expect(page.getByTestId('wind-turbulence-seed')).toHaveValue('0')
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

// Same catalogue build and user entries as flight-live.spec.ts:38–67.
async function buildWindQuad(page: Page, name: string) {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: DesktopApi }).api
    const listed = await api.components.list()
    if (!listed.ok) throw new Error(listed.error.message)
    const all = listed.data
    const byName = (n: string) => all.find((c) => c.name === n)!
    await api.components.setFill(byName('MN3110 KV470').id, 'rotorInertia', { value: 150, unit: 'g·cm²', source: 'measured', condition: 'bifilar pendulum, bell and shaft' })
    // The air density of T-Motor's bench table: no source states it, so it is the user's entry for that data.
    await api.components.setFill(byName('MN3110 KV470').id, 'referenceDensity', { value: 1.225, unit: 'kg/m³', source: 'user', condition: 'bench air, as stated by the user' })
    await api.components.setFill(byName('Tattu G-Tech 5200mAh 4S 35C').id, 'internalResistance', { value: 12, unit: 'mΩ', source: 'measured', condition: '4-wire AC, 1 kHz, 25 °C' })
  })
  await createProject(page, name)
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
  await commit(page, 'frame-motorDiagonal', '550')
  for (let n = 1; n <= 4; n++) {
    await page.getByTestId(`mount-motor-${n}`).click()
    await page.getByTestId('part-library').getByRole('button', { name: 'Motor' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470' })
    await page.getByTestId('part-library').getByRole('button', { name: 'Propeller' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  }
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } }) // deselect: the battery goes on the frame
  await page.getByTestId('part-library').getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  await commit(page, 'ground-friction', '0.6')
  await commit(page, 'ground-restitution', '0.1')
  await expect(page.getByTestId('environment-ready')).toBeVisible()
}

test('live flight shows the engine’s nonzero wind speed beside the arrow', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'blaze-wind-flight-'))
  const { app, page } = await launchApp(userData)
  try {
    await buildWindQuad(page, 'Wind quad')
    const id = await page.evaluate(() => location.hash.split('/').at(-1)!)
    await expect.poll(() => page.evaluate(async (projectId) => {
      const loaded = await (window as unknown as { api: DesktopApi }).api.assembly.load(projectId)
      return loaded.ok ? loaded.data?.environment?.ground.restitution : null
    }, id)).toBe(0.1)
    await page.evaluate((projectId) => { location.hash = `#/flight/${projectId}` }, id)
    await commit(page, 'flight-altitude', '0')
    await commit(page, 'flight-cutoff-value', '12')
    await page.getByTestId('wind-setting').selectOption('wind')
    await commit(page, 'wind-from', '90')
    await page.getByTestId('wind-mean').selectOption('constant')
    await commit(page, 'wind-speed', '3.5')
    await page.getByTestId('wind-gust').selectOption('none')
    await expect(page.getByTestId('flight-environment-summary')).toContainText('Ground plane · Wind on · Ground effect off')
    await expect(page.getByTestId('flight-wind-speed')).toHaveCount(0)
    await page.getByTestId('flight-start').click()
    await expect(page.getByTestId('flight-wind-speed')).toHaveText('Wind 3.50 m/s')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
