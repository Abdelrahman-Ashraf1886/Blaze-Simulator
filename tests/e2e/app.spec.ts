import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(__dirname, '../..')
/** In Node, the `electron` package resolves to the path of the Electron binary. */
const electronBinary = createRequire(__filename)('electron') as string
let userData: string
/** Apps still open at the end of a test (e.g. after a failed assertion) are closed in afterEach. */
const running: ElectronApplication[] = []

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '', ...extraEnv },
  })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Collects console errors and uncaught exceptions for the lifetime of a page. */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

const engineState = (page: Page) => page.getByTestId('system-status').getByTestId('engine-state')

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-e2e-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

test('engine connects, projects persist across restarts, unbuilt sections are disabled', async () => {
  let { app, page } = await launch()
  let errors = trackErrors(page)

  await expect(engineState(page)).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar').getByTestId('engine-state')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByTestId('system-status')).toContainText('v2') // engine protocol
  await expect(page.getByTestId('recent-projects')).toContainText('No projects yet')

  await page.getByTestId('new-project').click()
  await page.getByLabel('Name').fill('E2E hex')
  // Click the visible option, as a user would; the radio input itself is visually hidden.
  await page.locator('label').filter({ hasText: 'Hex X' }).click()
  await expect(page.getByRole('radio', { name: /Hex X/ })).toBeChecked()
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByTestId('recent-projects').getByTestId('project-row')).toHaveCount(1)
  await expect(page.getByTestId('recent-projects')).toContainText('Hex X')

  // Disabled roadmap sections are not links and do not navigate.
  const analysis = page.getByTestId('nav-/analysis')
  await expect(analysis).toHaveAttribute('aria-disabled', 'true')
  await analysis.click({ force: true }) // force: Playwright treats aria-disabled as not clickable
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(errors).toEqual([])

  await app.close()
  ;({ app, page } = await launch())
  errors = trackErrors(page)
  await expect(page.getByTestId('recent-projects')).toContainText('E2E hex')

  // Projects page: rename then delete.
  await page.getByTestId('nav-/projects').click()
  const row = page.getByTestId('projects-table').getByTestId('project-row')
  await row.hover()
  await page.getByRole('button', { name: 'Rename E2E hex' }).click()
  await page.getByLabel('Project name').fill('E2E hex renamed')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(row).toContainText('E2E hex renamed')
  await row.hover()
  await page.getByRole('button', { name: 'Delete E2E hex renamed' }).click()
  await page.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect(page.getByTestId('projects-table')).toContainText('No projects yet')
  expect(errors).toEqual([])

  await app.close()
})

test('UI recovers when the engine process is killed', async () => {
  const { app, page } = await launch()
  await expect(engineState(page)).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
  if (process.platform === 'win32') execSync('taskkill /F /IM drone-engine.exe', { stdio: 'ignore' })
  else execSync('pkill -f drone-engine', { stdio: 'ignore' })
  await expect(engineState(page)).toHaveAttribute('data-state', 'restarting', { timeout: 5_000 })
  await expect(engineState(page)).toHaveAttribute('data-state', 'connected', { timeout: 10_000 })
  await expect(page.getByTestId('system-status')).toContainText('Restarts')
  await app.close()
})

test('a missing engine binary ends in a visible "Failed" state with the reason', async () => {
  const { app, page } = await launch({ BLAZE_UAV_ENGINE: join(userData, 'missing-engine.exe') })
  // 5 restart attempts with 0.25 / 1 / 3 / 3 / 3 s backoff, then the supervisor gives up.
  await expect(engineState(page)).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(page.getByTestId('system-status')).toContainText('Engine executable not found')
  await expect(page.getByTestId('status-bar').getByTestId('engine-state')).toHaveAttribute('data-state', 'failed')
  // The rest of the app keeps working without the engine.
  await page.getByTestId('nav-/projects').click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await app.close()
})

test('a second launch focuses the running window instead of starting another instance', async () => {
  const { app } = await launch()
  const second = spawn(electronBinary, [root], {
    cwd: root,
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  })
  const exitCode = await new Promise<number | null>((resolve) => second.on('exit', resolve))
  expect(exitCode).toBe(0)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await app.close()
})

test('window starts inside the work area and enforces a laptop-friendly minimum size', async () => {
  const { app } = await launch()
  const info = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    return { bounds: win.getBounds(), min: win.getMinimumSize(), work: screen.getDisplayMatching(win.getBounds()).workArea }
  })
  expect(info.min).toEqual([Math.min(880, info.work.width), Math.min(560, info.work.height)])
  expect(info.bounds.x).toBeGreaterThanOrEqual(info.work.x)
  expect(info.bounds.y).toBeGreaterThanOrEqual(info.work.y)
  expect(info.bounds.x + info.bounds.width).toBeLessThanOrEqual(info.work.x + info.work.width)
  expect(info.bounds.y + info.bounds.height).toBeLessThanOrEqual(info.work.y + info.work.height)
  await app.close()
})

// Window sizes in DIP plus in-app zoom (View → Zoom). Zoom shrinks the CSS viewport:
// 1100 px at 200 % behaves like a 550 px wide window.
const VIEWPORTS = [
  { width: 880, height: 560, zoom: 1, note: 'minimum window' },
  { width: 1093, height: 566, zoom: 1, note: '1366×768 laptop at 125 % scaling' },
  { width: 1280, height: 672, zoom: 1.5, note: '1080p at 150 % plus 150 % zoom' },
  { width: 1100, height: 700, zoom: 2, note: '200 % zoom' },
  { width: 1920, height: 1040, zoom: 1, note: 'full HD' },
  { width: 2560, height: 1400, zoom: 1, note: 'QHD' },
]

test('layout adapts to window size and zoom without horizontal overflow', async () => {
  const { app, page } = await launch()
  // Stress truncation with an unbreakable 80-character name.
  await page.getByTestId('new-project').click()
  await page.getByLabel('Name').fill('W'.repeat(80))
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByTestId('recent-projects').getByTestId('project-row')).toHaveCount(1)

  for (const vp of VIEWPORTS) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(z), vp.zoom)
    await page.setViewportSize({ width: vp.width, height: vp.height })
    for (const route of ['#/', '#/projects', '#/workshop']) {
      await page.evaluate((r) => (location.hash = r), route)
      await expect(page.getByTestId('new-project')).toBeInViewport()
      const m = await page.evaluate(() => {
        const main = document.querySelector('main')!
        return {
          cssWidth: window.innerWidth,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          mainOverflow: main.scrollWidth - main.clientWidth,
          rail: document.querySelector('aside#sidebar')?.getAttribute('data-collapsed') === 'true',
        }
      })
      const where = `${vp.note} (${m.cssWidth} CSS px) ${route}`
      expect(m.pageOverflow, `page overflows at ${where}`).toBeLessThanOrEqual(0)
      expect(m.mainOverflow, `work area overflows at ${where}`).toBeLessThanOrEqual(0)
      expect(m.rail, `sidebar mode at ${where}`).toBe(m.cssWidth < 1180)
    }
  }
  await app.close()
})
