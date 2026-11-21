/**
 * Phase 2 acceptance scenarios (documentation/plans/phase-2-workshop.md).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Assembly, IpcResult } from '../../electron/ipc/contract'
import { createProject, launchApp, root, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-accept-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const BLENDER_POD = join(root, 'tests/fixtures/blender/pod.glb')
const library = (page: Page) => page.getByTestId('part-library')
const rows = (page: Page) => page.getByTestId('part-row')
const row = (page: Page, name: string) => page.locator(`[data-testid=part-row][data-name="${name}"]`)
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
const answerFileDialog = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)

async function openWorkshop(page: Page, name: string) {
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}

/** The assembly as stored in the database (what a restart will load). */
async function stored(page: Page): Promise<Pick<Assembly, 'frame' | 'motors' | 'parts'>> {
  const id = decodeURIComponent(page.url().split('/workshop/')[1]!)
  const r = await page.evaluate(
    (pid) => (window as unknown as { api: { assembly: { load(id: string): Promise<IpcResult<Assembly>> } } }).api.assembly.load(pid),
    id,
  )
  if (!r.ok) throw new Error(r.error.message)
  return { frame: r.data.frame, motors: r.data.motors, parts: r.data.parts }
}

async function importPod(app: ElectronApplication, page: Page) {
  await answerFileDialog(app, BLENDER_POD)
  await page.getByTestId('import-model').click()
  await expect(page.getByTestId('import-size')).toHaveText('100 × 60 × 50 mm') // Blender: metres, +Y up
  await page.getByRole('button', { name: 'Add to assembly' }).click()
}

test('hex X: 6 motors and 6 propellers on the mounts, spins set, Blender GLB payload; identical after restart', async () => {
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Acceptance hex', 'Hex X')
  await openWorkshop(page, 'Acceptance hex')

  await page.getByTestId('mount-motor-1').click()
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await row(page, 'Motor 1').click()
  await page.getByTestId('copy-to-mounts').click()
  await expect(rows(page)).toHaveCount(12)
  for (let n = 1; n <= 6; n++) {
    await expect(page.getByTestId('assembly-tree')).toContainText(`Motor ${n} ·`) // one group per mount
  }

  // Reverse the spin of motors 1 and 2.
  for (const n of [1, 2]) {
    const label = page.getByTestId(`mount-motor-${n}`)
    const before = await label.getAttribute('data-spin')
    await label.click()
    await page.getByRole('group', { name: 'Spin direction' }).getByRole('button', { name: before === 'cw' ? 'CCW' : 'CW', exact: true }).click()
    await expect(label).not.toHaveAttribute('data-spin', before!)
  }

  // Blender GLB payload under the bottom plate.
  await page.keyboard.press('Escape')
  await importPod(first.app, page)
  await page.getByLabel('Attached to').selectOption('mount:plate-bottom')
  await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'loaded')
  await expect(page.getByTestId('part-size')).toHaveText('100 × 60 × 50 mm')
  await expect(rows(page)).toHaveCount(13)
  await saved(page)
  const before = await stored(page)
  const spins = await page.locator('[data-testid^=mount-motor-]').evaluateAll((els) => els.map((e) => e.getAttribute('data-spin')))
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launch()
  const errors2 = trackErrors(second.page)
  page = second.page
  await openWorkshop(page, 'Acceptance hex')
  await expect(rows(page)).toHaveCount(13)
  expect(await stored(page)).toEqual(before) // every transform, attachment, spin and shape
  expect(await page.locator('[data-testid^=mount-motor-]').evaluateAll((els) => els.map((e) => e.getAttribute('data-spin')))).toEqual(spins)
  await row(page, 'pod').click()
  await expect(page.getByLabel('Attached to')).toHaveValue('mount:plate-bottom')
  await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'loaded')
  await expect(page.getByTestId('viewport-3d')).toHaveAttribute('data-bounds-in-view', 'true')
  expect(errors2).toEqual([])
})

test('undo and redo restore every edit kind, back to the empty assembly and forward again', async () => {
  const { app, page } = await launch()
  const errors = trackErrors(page)
  await createProject(page, 'Undo quad')
  await openWorkshop(page, 'Undo quad')
  await saved(page).catch(() => {}) // a brand-new assembly may not have saved anything yet
  const initial = await stored(page)

  const commit = async (id: string, value: string) => {
    await page.getByTestId(id).fill(value)
    await page.getByTestId(id).press('Enter')
  }
  // Frame, motor spin and tilt.
  await commit('frame-motorDiagonal', '500')
  await page.getByTestId('mount-motor-3').click()
  await page.getByRole('group', { name: 'Spin direction' }).getByRole('button', { name: 'CCW', exact: true }).click()
  await commit('motor-tilt', '10')
  // Add (on a mount, on a part), move, rotate, resize, rename, mass.
  await library(page).getByRole('button', { name: 'Motor' }).click()
  await library(page).getByRole('button', { name: 'Propeller' }).click()
  await row(page, 'Motor 1').click()
  await page.keyboard.press('ArrowUp') // nudge
  await commit('part-rot-z', '30')
  await commit('part-diameter', '32')
  await commit('part-mass', '48')
  await page.getByTestId('part-name').fill('Front-left motor')
  await page.getByTestId('part-name').press('Enter')
  // Copy to the other mounts, duplicate, attach, detach, delete.
  await page.getByTestId('copy-to-mounts').click()
  await row(page, 'Front-left motor').click()
  await page.keyboard.press('Control+d')
  await page.getByLabel('Attached to').selectOption('mount:plate-top')
  await page.getByLabel('Attached to').selectOption('none')
  await page.keyboard.press('Delete')
  // Import a model and change its units.
  await importPod(app, page)
  await page.getByLabel('Units in file').selectOption('mm')
  await saved(page)
  const final = await stored(page)
  expect(final.parts.length).toBeGreaterThan(8)

  // Undo everything (focus out of fields so Ctrl+Z reaches the editor).
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } })
  const undo = page.getByRole('button', { name: /^Undo / })
  let steps = 0
  while ((await undo.count()) > 0 && steps < 60) {
    await page.keyboard.press('Control+z')
    steps++
  }
  await expect(page.getByRole('button', { name: 'Nothing to undo' })).toBeVisible()
  expect(steps).toBeGreaterThanOrEqual(17)
  await saved(page)
  expect(await stored(page)).toEqual(initial)

  for (let i = 0; i < steps; i++) await page.keyboard.press('Control+y')
  await expect(page.getByRole('button', { name: 'Nothing to redo' })).toBeVisible()
  await saved(page)
  expect(await stored(page)).toEqual(final)
  expect(errors).toEqual([])
})
