import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-library-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const rows = (page: Page) => page.getByTestId('component-row')
const BUILT_INS = (JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: unknown[] }).components.length
const detail = (page: Page) => page.getByTestId('component-detail')
const field = (page: Page, key: string) => page.getByTestId(`field-${key}`)
const answerSave = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, path)
const answerOpen = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)

test('create a cited component, edit, duplicate, export, delete, import it back identical; bad packs are refused', async () => {
  const first = await launch()
  const { app } = first
  let page = first.page
  const errors = trackErrors(page)

  await page.getByTestId('nav-/components').click()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()

  // Built-in parts are there, read-only, with every value cited.
  await expect(rows(page)).toHaveCount(BUILT_INS)
  await page.locator('[data-testid=component-row][data-name="Pixhawk 6C"]').click()
  await expect(detail(page).getByRole('button', { name: 'Edit' })).toBeDisabled()
  await expect(detail(page).getByRole('button', { name: 'Delete' })).toBeDisabled()
  await expect(detail(page)).toContainText('Built-in')
  await expect(page.getByTestId('spec-pwmOutputs')).toContainText('16')
  await expect(page.getByTestId('spec-pwmOutputs').getByRole('link')).toHaveAttribute('href', 'https://docs.holybro.com/autopilot/pixhawk-6c/technical-specification')
  await expect(page.getByTestId('spec-ports')).toContainText('Telem1 (UART)')
  // Our own parts only, from here on.
  const search = page.getByPlaceholder('Search name, manufacturer, notes')
  await search.fill('Example Motors')

  // Create a motor. A manufacturer value without a source is refused by main.
  await page.getByTestId('new-component').click()
  await page.locator('#component-name').fill('Test 2306 1750KV')
  await page.locator('#component-manufacturer').fill('Example Motors')
  await page.locator('#spec-kv').fill('1750')
  await field(page, 'kv').getByLabel('Kv source').selectOption('manufacturer')
  await expect(field(page, 'kv').getByLabel('Read on')).not.toHaveValue('') // today, filled in
  await page.locator('#spec-mass').fill('31.5')
  await page.getByRole('button', { name: 'Add to library' }).click()
  await expect(page.getByTestId('editor-errors')).toContainText('Mass: choose where this value comes from')
  await field(page, 'mass').getByLabel('Mass source').selectOption('measured')
  await field(page, 'mass').getByLabel('Condition').fill('with 10 cm leads')
  await page.getByRole('button', { name: 'Add to library' }).click()
  await expect(page.getByTestId('editor-errors')).toContainText('Kv: A manufacturer value needs its source (URL or document title)')
  await field(page, 'kv').getByLabel('Source URL').fill('https://example.com/2306-datasheet.pdf')
  await field(page, 'kv').getByLabel('Page, table or section').fill('p. 2')
  await page.getByRole('button', { name: 'Add to library' }).click()
  await expect(page.getByTestId('component-editor')).toHaveCount(0)

  // Detail: every value with its source.
  await expect(detail(page)).toContainText('Test 2306 1750KV')
  const kv = page.getByTestId('spec-kv')
  await expect(kv).toContainText('1750 rpm/V')
  await expect(kv.getByTestId('spec-source')).toHaveText('Manufacturer')
  await expect(kv.getByRole('link')).toContainText('example.com · p. 2 · read 20')
  await expect(kv.getByRole('link')).toHaveAttribute('href', 'https://example.com/2306-datasheet.pdf')
  await expect(page.getByTestId('spec-mass')).toContainText('31.5 g')
  await expect(page.getByTestId('spec-mass')).toContainText('with 10 cm leads')
  await expect(page.getByTestId('spec-mass').getByTestId('spec-source')).toHaveText('Measured')
  await expect(page.getByTestId('spec-maxCurrent')).toContainText('not specified')
  await expect(rows(page).first()).toContainText('Example Motors')

  // Edit, then duplicate.
  await detail(page).getByRole('button', { name: 'Edit' }).click()
  await page.locator('#spec-mass').fill('32')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByTestId('spec-mass')).toContainText('32 g')
  await detail(page).getByRole('button', { name: 'Duplicate' }).click()
  await expect(detail(page)).toContainText('Test 2306 1750KV (copy)')
  await expect(rows(page)).toHaveCount(2)
  const before = await page.getByTestId('spec-list').innerText()

  // Search and category filter.
  await search.fill('copy')
  await expect(rows(page)).toHaveCount(1)
  await search.fill('Example Motors')
  await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: /^Battery/ }).click()
  await expect(page.getByText('Nothing matches this search.')).toBeVisible()
  await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: /^All/ }).click()

  // Export the two shown, delete them.
  const pack = join(userData, 'motors')
  await answerSave(app, pack)
  await page.getByRole('button', { name: /Export shown/ }).click()
  await expect(page.getByTestId('library-note')).toHaveText('Exported 2 components to motors.json')
  expect(existsSync(`${pack}.json`)).toBe(true)
  expect(JSON.parse(readFileSync(`${pack}.json`, 'utf8'))).toMatchObject({ format: 'blaze-uav.components', version: 1 })
  for (let i = 0; i < 2; i++) {
    await rows(page).first().click()
    await detail(page).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  }
  await expect(rows(page)).toHaveCount(0)

  // A malformed pack changes nothing and says why.
  const bad = join(userData, 'bad.json')
  writeFileSync(bad, JSON.stringify({ format: 'blaze-uav.components', version: 1, components: [{ category: 'motor', name: 'X', manufacturer: null, notes: null, specs: { kv: { value: 1, unit: 'A', source: 'user' } } }] }))
  await answerOpen(app, bad)
  await page.getByTestId('import-pack').click()
  await expect(page.getByTestId('library-note')).toContainText('Nothing was imported. 1 problem:')
  await expect(page.getByTestId('library-note')).toContainText('Entry 1 (X): Kv: Unit must be one of rpm/V')
  writeFileSync(bad, 'not json at all')
  await page.getByTestId('import-pack').click()
  await expect(page.getByTestId('library-note')).toHaveText('The file is not valid JSON.')
  await expect(rows(page)).toHaveCount(0)

  // Import the real pack: identical values and sources.
  await answerOpen(app, `${pack}.json`)
  await page.getByTestId('import-pack').click()
  await expect(page.getByTestId('library-note')).toHaveText('Imported 2')
  await page.locator('[data-testid=component-row][data-name="Test 2306 1750KV (copy)"]').click()
  expect(await page.getByTestId('spec-list').innerText()).toBe(before)
  await expect(detail(page)).toContainText('Imported')
  expect(errors).toEqual([])
  await app.close()

  // Persists across a restart (built-ins are not added twice).
  page = (await launch()).page
  await page.getByTestId('nav-/components').click()
  await expect(rows(page)).toHaveCount(BUILT_INS + 2)
})
