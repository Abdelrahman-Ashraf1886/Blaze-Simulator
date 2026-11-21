import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'

export const root = join(__dirname, '../..')

export async function launchApp(
  userData: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    // BLAZE_UAV_TEST_HOOKS exposes window.__blazeTest (src/lib/test-hooks.ts); pass '0' to launch without.
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '', BLAZE_UAV_TEST_HOOKS: '1', ...extraEnv },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Collects console errors and uncaught exceptions for the lifetime of a page. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

export async function createProject(page: Page, name: string, frame: 'Quad X' | 'Hex X' | 'Octo X' = 'Quad X') {
  await page.getByTestId('new-project').click()
  await page.getByLabel('Name').fill(name)
  await page.locator('label').filter({ hasText: frame }).click()
  await page.getByRole('button', { name: 'Create project' }).click()
}

export const setZoom = (app: ElectronApplication, zoom: number) =>
  app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(z), zoom)
