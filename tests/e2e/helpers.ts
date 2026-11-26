import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import type { DEVICE_BUTTONS } from '../../src/features/flight/device-buttons'
import { STANDARD_AXES } from '../../src/features/input/calibration'
import { playStationButtons } from '../../src/features/input/playstation'

export const root = join(__dirname, '../..')

/** Real mouse clicks on a test window pass through to what is below; Playwright's input does not use the mouse. */
export const ignoreRealMouse = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)))

export async function launchApp(
  userData: string,
  extraEnv: Record<string, string> = {},
  /** Chromium switches before the app path, e.g. --force_high_performance_gpu. */
  switches: string[] = [],
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [...switches, root],
    cwd: root,
    // BLAZE_UAV_TEST_HOOKS exposes window.__blazeTest (src/lib/test-hooks.ts); pass '0' to launch without.
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '', BLAZE_UAV_TEST_HOOKS: '1', ...extraEnv },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await ignoreRealMouse(app)
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

const library = (page: Page) => page.getByTestId('part-library')
export const commit = async (page: Page, id: string, value: string) => {
  await page.getByTestId(id).fill(value)
  await page.getByTestId(id).press('Enter')
}

type Api = {
  components: {
    list(): Promise<{ ok: true; data: { id: string; name: string }[] }>
    setFill(id: string, key: string, spec: unknown): Promise<{ ok: boolean }>
  }
  projects: { list(): Promise<{ ok: true; data: { id: string; name: string }[] }> }
}

/**
 * The propulsion spec's quad (four MN3110 KV470 with P13*4.4 on a Tattu 4S pack, 550 mm diagonal, 300 g frame),
 * with the two values no source states for these parts entered as a user would: the rotor inertia and the pack's
 * internal resistance (library gap-fills), plus the body drag. The environment values are entered when asked.
 */
export async function buildQuad(page: Page, name: string, { environment }: { environment: boolean }) {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const all = (await api.components.list()).data
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
    await library(page).getByRole('button', { name: 'Motor' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor MN3110 KV470' })
    await library(page).getByRole('button', { name: 'Propeller' }).click()
    await page.getByTestId('part-component').selectOption({ label: 'T-Motor P13*4.4 CF propeller' })
  }
  await page.getByTestId('viewport-3d').click({ position: { x: 5, y: 5 } }) // deselect: the battery goes on the frame
  await library(page).getByRole('button', { name: 'Battery' }).click()
  await page.getByTestId('part-component').selectOption({ label: 'Tattu Tattu G-Tech 5200mAh 4S 35C' })
  await commit(page, 'frame-mass', '300')
  await commit(page, 'body-cd-x', '1.1')
  if (environment) {
    await commit(page, 'ground-friction', '0.6')
    await commit(page, 'ground-restitution', '0.1')
    await expect(page.getByTestId('environment-ready')).toBeVisible()
  }
  // Let the debounced save reach the database before leaving the workshop.
  await page.waitForTimeout(600)
}

export async function openFlight(page: Page, name: string) {
  const id = await page.evaluate(async (n) => {
    const api = (window as unknown as { api: Api }).api
    return (await api.projects.list()).data.find((p) => p.name === n)!.id
  }, name)
  await page.evaluate((i) => (location.hash = `#/flight/${i}`), id)
  await expect(page.getByTestId('flight-test')).toBeVisible()
  return id
}

const padId = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'

// Same renderer fake as input.spec.ts:8–24, with a distinct ID for this fixture.
export async function setPad(page: Page, present: boolean, pressed?: keyof typeof DEVICE_BUTTONS) {
  await page.evaluate(({ id, present, pressed, buttonCount }) => {
    const previous = navigator.getGamepads()[0]
    const pad = present ? {
      id, index: 0, mapping: 'standard', connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: buttonCount }, (_, index) => ({ value: Number(index === pressed), pressed: index === pressed })),
    } : null
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
    if (Boolean(previous) !== present) {
      const event = new Event(present ? 'gamepadconnected' : 'gamepaddisconnected')
      Object.defineProperty(event, 'gamepad', { value: pad ?? previous })
      window.dispatchEvent(event)
    }
  }, { id: padId, present, pressed, buttonCount: playStationButtons('DualSense').length })
}

export async function savePadCalibration(page: Page) {
  // Test data uses the saved pref shape in prefs.ts:25–42 and the sweep endpoints in input.spec.ts:46–62.
  await page.evaluate(({ id, axes }) => {
    const calibration = Object.fromEntries(Object.entries(axes).map(([stick, axis]) =>
      [stick, { axis, min: -1, trim: 0, max: 1, deadZone: 0, reverse: false }]))
    localStorage.setItem(`input.calibration.${id}`, JSON.stringify(calibration))
  }, { id: padId, axes: STANDARD_AXES })
}
