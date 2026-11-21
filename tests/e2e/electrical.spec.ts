import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
const running: ElectronApplication[] = []
async function launch() {
  const r = await launchApp(userData)
  running.push(r.app)
  return r
}
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-electrical-'))
})
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close().catch(() => {})))
  rmSync(userData, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  })
})

/**
 * Builds a hex through the app's own API (the workshop flows are covered elsewhere):
 * Tattu 4S, PM02 V3, Pixhawk 6C, six Tekko32 45A ESCs, six MN3110 KV700 on the motor
 * mounts, an M10 GPS and a SiK radio, all linked to built-in components.
 */
async function buildHex(page: Page, projectName: string) {
  await page.evaluate(async (name) => {
    type R<T> = { ok: true; data: T } | { ok: false; error: { message: string } }
    const api = (
      window as unknown as {
        api: Record<string, Record<string, (...a: unknown[]) => Promise<R<unknown>>>>
      }
    ).api
    const unwrap = async <T>(p: Promise<R<unknown>>) => {
      const r = await p
      if (!r.ok) throw new Error(r.error.message)
      return r.data as T
    }
    const projects = await unwrap<{ id: string; name: string }[]>(api.projects!.list!())
    const project = projects.find((p) => p.name === name)!
    const library = await unwrap<{ id: string; name: string }[]>(api.components!.list!())
    const c = (n: string) => library.find((x) => x.name === n)!.id
    const asm = await unwrap<{
      revision: number
      frame: unknown
      motors: unknown
    }>(api.assembly!.load!(project.id))
    const part = (name: string, kind: string, componentId: string, mountId: string | null = null) => ({
      id: crypto.randomUUID(),
      name,
      kind,
      shape: { type: 'box', size: [0.03, 0.03, 0.02] },
      parentId: null,
      mountId,
      position: [0, 0, 0.02],
      rotation: [0, 0, 0, 1],
      mass: null,
      componentId,
    })
    const parts = [
      part('Battery 1', 'battery', c('Tattu G-Tech 5200mAh 4S 35C'), 'plate-bottom'),
      part('Power module', 'payload', c('PM02 V3')),
      part('Flight controller 1', 'flight-controller', c('Pixhawk 6C'), 'plate-top'),
      ...Array.from({ length: 6 }, (_, i) => part(`ESC ${i + 1}`, 'esc', c('Tekko32 F4 45A ESC (AM32)'))),
      ...Array.from({ length: 6 }, (_, i) => part(`Motor ${i + 1}`, 'motor', c('MN3110 KV700'), `motor-${i + 1}`)),
      part('GPS', 'payload', c('M10 GPS')),
      part('Radio', 'payload', c('SiK Telemetry Radio V3 100mW')),
    ]
    await unwrap(
      api.assembly!.save!({
        projectId: project.id,
        baseRevision: asm.revision,
        frame: asm.frame,
        motors: asm.motors,
        parts,
        // The parts share positions (a real overlap, reported by the 4.4 interference check); this
        // file tests wiring, so a 50 mm overlap tolerance keeps those findings out (collisions.spec.ts).
        interference: { toleranceM: 0.05, allowedPairs: [] },
      }),
    )
  }, projectName)
}

const wireRows = (page: Page) => page.getByTestId('wire-row')
const checks = (page: Page) => page.getByTestId('electrical-checks')

test('auto-wire a hex, then move the GPS onto the telemetry port: a port conflict; undo restores; wiring persists', async () => {
  const first = await launch()
  const errors = trackErrors(first.page)
  let page = first.page
  await createProject(page, 'Wired hex', 'Hex X')
  await buildHex(page, 'Wired hex')

  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: 'Wired hex' }).click()
  await expect(page.getByTestId('schematic-node')).toHaveCount(17)
  await expect(page.getByTestId('schematic-node').filter({ hasText: 'Flight controller 1' })).toContainText('Telem1')
  await expect(wireRows(page)).toHaveCount(0)

  await page.getByTestId('auto-wire').click()
  // 1 battery→PM, 6 PM→ESC, 6 ESC→motor, 6 PWM→ESC, PM sense, GPS, radio.
  await expect(wireRows(page)).toHaveCount(22)
  await expect(page.getByTestId('autowire-notes')).toHaveCount(0)
  await expect(checks(page)).toContainText('No errors or warnings.')
  await expect(wireRows(page).filter({ hasText: 'ESC 3 · Motor → Motor 3 · Phases' })).toHaveCount(1)
  await expect(
    wireRows(page).filter({
      hasText: 'Flight controller 1 · PWM 3 → ESC 3 · Signal',
    }),
  ).toHaveCount(1)
  await expect(
    wireRows(page).filter({
      hasText: 'Power module · Sense (analog) → Flight controller 1 · Power1',
    }),
  ).toHaveCount(1)

  // Move the GPS cable from GPS1 to Telem1, where the radio already is.
  await wireRows(page).filter({ hasText: 'GPS · UART → Flight controller 1 · GPS1' }).click()
  await page.getByTestId('wire-to-port').selectOption('Telem1')
  const conflict = checks(page).locator('[data-testid=finding][data-rule=port-conflict]')
  await expect(conflict).toHaveAttribute('data-severity', 'error')
  await expect(conflict).toHaveText('Telem1 on Flight controller 1 has 2 cables (GPS, Radio); it takes one.')
  // Clicking the finding shows the flight controller's ports and what is on each.
  await conflict.click()
  await expect(page.getByTestId('part-ports')).toContainText('Telem1')

  // The workshop sees the same problem.
  await page.getByTestId('schematic').click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('Control+z')
  await expect(conflict).toHaveCount(0)
  await expect(checks(page)).toContainText('No errors or warnings.')

  // Wire properties are stored with the wire.
  await wireRows(page).filter({ hasText: 'Battery 1 · Power out → Power module · Power in' }).click()
  await page.getByTestId('wire-gauge').fill('12')
  await page.getByTestId('wire-gauge').press('Enter')
  await page.getByTestId('wire-length').fill('150')
  await page.getByTestId('wire-length').press('Enter')
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  expect(errors).toEqual([])
  await first.app.close()

  page = (await launch()).page
  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: 'Wired hex' }).click()
  await expect(wireRows(page)).toHaveCount(22)
  await wireRows(page).filter({ hasText: 'Battery 1 · Power out → Power module · Power in' }).click()
  await expect(page.getByTestId('wire-gauge')).toHaveValue('12')
  await expect(page.getByTestId('wire-length')).toHaveValue('150')
})

test('a second auto-wire asks before replacing the wiring', async () => {
  const { page } = await launch()
  await createProject(page, 'Rewire quad')
  await buildHex(page, 'Rewire quad')
  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: 'Rewire quad' }).click()
  await page.getByTestId('auto-wire').click()
  await expect(wireRows(page)).toHaveCount(22)
  // Delete one wire, then auto-wire again: confirm, and the harness is complete again.
  await wireRows(page).first().click()
  await page.getByRole('button', { name: 'Delete wire' }).click()
  await expect(wireRows(page)).toHaveCount(21)
  await expect(checks(page).locator('[data-testid=finding]')).not.toHaveCount(0) // something is now unwired
  await page.getByTestId('auto-wire').click()
  await expect(page.getByRole('dialog')).toContainText('Auto-wire replaces all 21 wires')
  await page.getByRole('button', { name: 'Replace wiring' }).click()
  await expect(wireRows(page)).toHaveCount(22)
})

test('calculations: a hex at maximum current overloads the PM02; cable drops follow gauge and length', async () => {
  const { page } = await launch()
  const errors = trackErrors(page)
  await createProject(page, 'Calc hex', 'Hex X')
  await buildHex(page, 'Calc hex')
  await page.getByTestId('nav-/electrical').click()
  await page.getByTestId('electrical-chooser').getByRole('link', { name: 'Calc hex' }).click()
  await page.getByTestId('toggle-calculations').click()
  await expect(page.getByTestId('calc-problem')).toContainText('No battery is wired')

  await page.getByTestId('auto-wire').click()
  const calc = page.getByTestId('calculations')
  // 6 × MN3110 at 21 A (stated, 180 s) = 126 A; Tattu states 14.8 V nominal but no internal resistance.
  await expect(page.getByTestId('calc-battery-current')).toHaveText('126.0 A')
  await expect(page.getByTestId('calc-voc')).toHaveText('14.80 V')
  await expect(page.getByTestId('calc-terminal')).toHaveAttribute('data-missing', 'true')
  await expect(page.getByTestId('calc-missing')).toContainText('internal resistance not specified')
  // PM02: 126 A through a 60 A continuous rating.
  await expect(page.getByTestId('calc-rating').filter({ hasText: 'Power module' })).toHaveAttribute('data-within', 'false')
  await expect(page.getByTestId('calc-rating').filter({ hasText: 'Battery 1' })).toHaveAttribute('data-within', 'true')
  await expect(page.getByTestId('calc-cable')).toHaveCount(7)

  // Battery → PM: 12 AWG, 150 mm → R = 1.5632 mΩ; 126 A → ΔV = 197.0 mV.
  await page.getByTestId('calc-cable').filter({ hasText: 'Battery 1 → Power module' }).click()
  await page.getByTestId('wire-gauge').fill('12')
  await page.getByTestId('wire-gauge').press('Enter')
  await page.getByTestId('wire-length').fill('150')
  await page.getByTestId('wire-length').press('Enter')
  const main = page.getByTestId('calc-cable').filter({ hasText: 'Battery 1 → Power module' })
  await expect(main.getByTestId('calc-cable-drop')).toHaveText('197.0 mV')
  // At 60 °C: × (1 + 0.00393 × 40) = 1.1572 → 227.9 mV.
  await page.getByTestId('load-temp').selectOption('60')
  await expect(main.getByTestId('calc-cable-drop')).toHaveText('227.9 mV')

  // An entered 8 A per motor: 48 A, within the PM02's 60 A.
  await page.getByTestId('load-mode').selectOption('fixed')
  await page.getByTestId('load-current').fill('8')
  await expect(page.getByTestId('calc-battery-current')).toHaveText('48.0 A')
  await expect(page.getByTestId('calc-rating').filter({ hasText: 'Power module' })).toHaveAttribute('data-within', 'true')
  await expect(calc.getByTestId('calc-method')).toContainText('IEC 60028')
  expect(errors).toEqual([])
})
