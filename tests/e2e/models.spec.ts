import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boxGlb, externalBufferGltf } from '../fixtures/gltf'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
let files: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-models-'))
  files = mkdtempSync(join(tmpdir(), 'blazeuav-model-files-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  for (const d of [userData, files]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

/** The native file dialog cannot be driven by Playwright; answer it from the main process instead. */
const answerFileDialog = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)

async function openWorkshop(page: Page, name: string) {
  await page.getByTestId('recent-projects').getByRole('link', { name }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()
}
const inspector = (page: Page) => page.getByTestId('part-inspector')

test('import a GLB: choose units and up axis, it shows at the right size, undoes, and survives a restart', async () => {
  // 100 × 20 × 50 in the file's X, Y (up), Z, in millimetres.
  const model = join(files, 'Camera pod.glb')
  writeFileSync(model, boxGlb({ size: [100, 20, 50] }))

  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Model quad')
  await openWorkshop(page, 'Model quad')

  await answerFileDialog(first.app, model)
  await page.getByTestId('import-model').click()
  const options = page.getByTestId('import-options')
  await expect(options).toBeVisible()
  // glTF says metres; read as metres the box is 100 m long, which the dialog flags.
  await expect(page.getByTestId('import-size')).toHaveText('100000 × 50000 × 20000 mm')
  await expect(page.getByTestId('import-warning')).toContainText('Check the units')
  await options.getByRole('button', { name: 'Millimetres' }).click()
  // Y-up file → Z-up world: the file's 20 mm (Y) becomes the height.
  await expect(page.getByTestId('import-size')).toHaveText('100 × 50 × 20 mm')
  await expect(page.getByTestId('import-warning')).toHaveCount(0)
  await options.getByRole('button', { name: '+Z (CAD)' }).click()
  await expect(page.getByTestId('import-size')).toHaveText('100 × 20 × 50 mm')
  await options.getByRole('button', { name: '+Y (glTF)' }).click()
  await page.getByRole('button', { name: 'Add to assembly' }).click()

  await expect(inspector(page)).toContainText('Camera pod')
  await expect(page.getByTestId('part-size')).toHaveText('100 × 50 × 20 mm')
  await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'loaded')
  await expect(page.getByTestId('model-status')).toHaveText('Shown · 12 triangles')
  // Resting on the frame: centre at frame top (4 mm arm thickness) + half the 20 mm height.
  await expect(page.getByTestId('part-pos-z')).toHaveValue('14')

  // The import is one undoable edit.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('part-row')).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await expect(page.getByTestId('part-row')).toHaveCount(1)

  // Changing units afterwards is an edit too.
  await page.locator('[data-testid=part-row][data-name="Camera pod"]').click()
  await page.getByLabel('Units in file').selectOption('in')
  await expect(page.getByTestId('part-size')).toHaveText('2540 × 1270 × 508 mm')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('part-size')).toHaveText('100 × 50 × 20 mm')

  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launch()
  const errors2 = trackErrors(second.page)
  page = second.page
  await openWorkshop(page, 'Model quad')
  await page.locator('[data-testid=part-row][data-name="Camera pod"]').click()
  await expect(page.getByTestId('part-size')).toHaveText('100 × 50 × 20 mm')
  await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'loaded')
  expect(errors2).toEqual([])
})

test('files that are not self-contained glTF are refused with a clear message', async () => {
  const external = join(files, 'linked.gltf')
  writeFileSync(external, externalBufferGltf('textures/../../secret.bin'))
  const fake = join(files, 'renamed.glb')
  writeFileSync(fake, 'just some text')

  const { app, page } = await launch()
  await createProject(page, 'Bad files')
  await openWorkshop(page, 'Bad files')

  await answerFileDialog(app, external)
  await page.getByTestId('import-model').click()
  await expect(page.getByTestId('import-error')).toContainText('references an external file or URL')
  await answerFileDialog(app, fake)
  await page.getByTestId('import-model').click()
  await expect(page.getByTestId('import-error')).toContainText('not a GLB file')
  await expect(page.getByTestId('import-options')).toHaveCount(0)
  await expect(page.getByTestId('part-row')).toHaveCount(0)
})
