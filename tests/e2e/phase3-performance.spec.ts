/**
 * Phase 3 performance (milestone 3.8): a library of 200 components and an assembly
 * with 100 wires.
 *
 * Interaction timings are measured inside the page: the action is dispatched there
 * (so Playwright's own actionability waits are not counted) and the time is taken at
 * the first animation frame in which the DOM shows the result. Pan and zoom are real
 * mouse input; their figure is the interval between animation frames while moving.
 * Numbers are printed for the DEVLOG. The limits leave headroom for a busy machine:
 * 250 ms for an interaction (well inside the 1 s that keeps a user's flow), 3 s to
 * open a page with everything on it, and 33 ms median per frame (30 fps) when panning.
 * Selecting a part in the workshop has a 500 ms limit: about 0.1–0.2 s of it is the
 * workshop's own selection (inspector and 3D view), measured here for comparison.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentInput } from '../../electron/ipc/contract'
import { createProject, launchApp, trackErrors } from './helpers'

let userData: string
let app: ElectronApplication | null = null
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-perf3-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const LIBRARY_SIZE = 200
const BUILT_INS = (JSON.parse(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8')) as { components: unknown[] }).components.length
const INTERACTION_MS = 250
const PAGE_MS = 3000
const FRAME_MS = 1000 / 30

/** Test-only library entries, entered as a user would (source "user"); not real products. */
function userComponents(n: number): ComponentInput[] {
  return Array.from({ length: n }, (_, i): ComponentInput => {
    const name = `Perf ${String(i + 1).padStart(3, '0')}`
    switch (i % 3) {
      case 0:
        return { category: 'motor', name: `${name} motor`, manufacturer: 'Perf Test', notes: null, specs: { kv: { value: 700 + i, unit: 'rpm/V', source: 'user' }, mass: { value: 80, unit: 'g', source: 'user' } } }
      case 1:
        return { category: 'battery', name: `${name} battery`, manufacturer: 'Perf Test', notes: null, specs: { series: { value: 4, source: 'user' }, capacity: { value: 1000 + i, unit: 'mAh', source: 'user' } } }
      default:
        return { category: 'esc', name: `${name} ESC`, manufacturer: 'Perf Test', notes: null, specs: { format: { value: 'single', source: 'user' }, continuousCurrent: { value: 30, unit: 'A', source: 'user' } } }
    }
  })
}

/**
 * Octo X with 40 ESC/motor pairs (8 on the mounts, 32 loose), a power module, a
 * Pixhawk 6C, a GPS and a radio: auto-wire gives 1 + 40 + 1 + 40 + 16 + 2 = 100 wires.
 * Not a sensible drone; it is sized to load the wiring, checks and calculations.
 */
async function buildLargeAssembly(page: Page, projectName: string) {
  await page.evaluate(async (name) => {
    type R<T> = { ok: true; data: T } | { ok: false; error: { message: string } }
    const api = (window as unknown as { api: Record<string, Record<string, (...a: unknown[]) => Promise<R<unknown>>>> }).api
    const unwrap = async <T,>(p: Promise<R<unknown>>) => {
      const r = await p
      if (!r.ok) throw new Error(r.error.message)
      return r.data as T
    }
    const project = (await unwrap<{ id: string; name: string }[]>(api.projects!.list!())).find((p) => p.name === name)!
    const library = await unwrap<{ id: string; name: string }[]>(api.components!.list!())
    const c = (n: string) => library.find((x) => x.name === n)!.id
    const asm = await unwrap<{ revision: number; frame: unknown; motors: unknown }>(api.assembly!.load!(project.id))
    const part = (partName: string, kind: string, componentId: string, mountId: string | null, i = 0) => ({
      id: crypto.randomUUID(),
      name: partName,
      kind,
      shape: { type: 'box', size: [0.03, 0.03, 0.02] },
      parentId: null,
      mountId,
      position: mountId ? [0, 0, 0.02] : [0.05 * (i % 10), 0.05 * Math.floor(i / 10), 0.06],
      rotation: [0, 0, 0, 1],
      mass: null,
      componentId,
    })
    const parts = [
      part('Battery 1', 'battery', c('Tattu G-Tech 5200mAh 4S 35C'), 'plate-bottom'),
      part('Power module', 'payload', c('PM02 V3'), null, 90),
      part('Flight controller 1', 'flight-controller', c('Pixhawk 6C'), 'plate-top'),
      ...Array.from({ length: 40 }, (_, i) => part(`ESC ${i + 1}`, 'esc', c('Tekko32 F4 45A ESC (AM32)'), null, i)),
      ...Array.from({ length: 40 }, (_, i) => part(`Motor ${i + 1}`, 'motor', c('MN3110 KV700'), i < 8 ? `motor-${i + 1}` : null, 40 + i)),
      part('GPS', 'payload', c('M10 GPS'), null, 91),
      part('Radio', 'payload', c('SiK Telemetry Radio V3 100mW'), null, 92),
    ]
    await unwrap(api.assembly!.save!({ projectId: project.id, baseRevision: asm.revision, frame: asm.frame, motors: asm.motors, parts }))
  }, projectName)
}

/**
 * Runs `act` in the page, then checks `done` on every animation frame; returns the
 * milliseconds from the action to the start of the frame that paints the result.
 * One script evaluated over the debugging protocol (the app's CSP forbids eval, so
 * Playwright's waitForFunction with a string cannot be used).
 */
async function timed(page: Page, label: string, act: string, done: string): Promise<number> {
  const script = `(async () => {
    const done = () => { try { return !!(${done}) } catch { return false } }
    const t0 = performance.now()
    ${act}
    return await new Promise((resolve, reject) => {
      const tick = () => {
        if (done()) requestAnimationFrame(() => resolve(performance.now() - t0))
        else if (performance.now() - t0 > 20000) reject(new Error('timed out: ' + ${JSON.stringify(label)}))
        else requestAnimationFrame(tick)
      }
      tick()
    })
  })()`
  const ms = (await page.evaluate(script)) as number
  console.log(`[perf3] ${label}: ${ms.toFixed(0)} ms`)
  return ms
}

/** Sets a React-controlled input's value as typing would. */
const typeInto = (selector: string, value: string) =>
  `{ const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) }`
const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`
const count = (selector: string) => `document.querySelectorAll(${JSON.stringify(selector)}).length`

/** Frame intervals while `move` runs; returns the median and 95th percentile in ms. */
async function frames(page: Page, label: string, move: () => Promise<void>) {
  await page.evaluate(() => {
    // A new run token, so a sampling loop left from an earlier call stops instead of doubling the samples.
    const w = window as unknown as { __frames: number[]; __run: number }
    const run = (w.__run = (w.__run ?? 0) + 1)
    w.__frames = []
    const tick = (t: number) => {
      if (w.__run !== run) return
      w.__frames.push(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await move()
  const intervals = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __run: number }
    w.__run++
    return w.__frames.slice(1).map((t, i) => t - w.__frames[i]!)
  })
  intervals.sort((a, b) => a - b)
  const pct = (p: number) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))]!
  const r = { medianMs: pct(0.5), p95Ms: pct(0.95), frames: intervals.length }
  console.log(`[perf3] ${label}: frame median ${r.medianMs.toFixed(1)} ms, p95 ${r.p95Ms.toFixed(1)} ms (${r.frames} frames)`)
  return r
}

test('200 library components and a 100-wire assembly: library, Electrical Designer and checks stay responsive', async () => {
  test.setTimeout(240_000)
  const r = await launchApp(userData)
  app = r.app
  const page = r.page
  const errors = trackErrors(page)
  await page.setViewportSize({ width: 1920, height: 1080 })
  // A hidden or covered window is throttled to 1 frame per second; measure the app, not the screen state.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false))
  console.log(`[perf3] window ${await page.evaluate(() => document.visibilityState)}`)

  const generated = userComponents(LIBRARY_SIZE - BUILT_INS)
  /** Rows a search should show: only the generated names contain "perf". */
  const matching = (q: string) => generated.filter((c) => c.name.toLowerCase().includes(q)).length
  await page.evaluate(async (inputs) => {
    const api = (window as unknown as { api: { components: { create(i: unknown): Promise<{ ok: boolean; error?: { message: string } }> } } }).api
    for (const i of inputs) {
      const res = await api.components.create(i)
      if (!res.ok) throw new Error(res.error!.message)
    }
  }, generated)

  // ---- Components page ----
  const rows = '[data-testid=component-row]'
  const loadMs = await timed(page, `Components page, ${LIBRARY_SIZE} rows`, click('[data-testid="nav-/components"]'), `${count(rows)} === ${LIBRARY_SIZE}`)
  expect(loadMs).toBeLessThan(PAGE_MS)
  const search = 'input[placeholder="Search name, manufacturer, notes"]'
  const library: Record<string, number> = {}
  library.search = await timed(page, `search "perf 1" (${matching('perf 1')} rows)`, typeInto(search, 'perf 1'), `${count(rows)} === ${matching('perf 1')}`)
  library.searchNarrow = await timed(page, 'search "perf 123" (1 row)', typeInto(search, 'perf 123'), `${count(rows)} === ${matching('perf 123')}`)
  library.clear = await timed(page, `clear search (${LIBRARY_SIZE} rows)`, typeInto(search, ''), `${count(rows)} === ${LIBRARY_SIZE}`)
  const batteryFilter = '[role=group][aria-label=Category] button:nth-child(4)'
  const batteries = await page.locator(batteryFilter).innerText()
  expect(batteries).toMatch(/^Battery/)
  library.filter = await timed(page, 'filter by category (Battery)', click(batteryFilter), `document.querySelector(${JSON.stringify(batteryFilter)}).getAttribute('aria-pressed') === 'true' && ${count(rows)} < ${LIBRARY_SIZE}`)
  library.all = await timed(page, 'filter: All', click('[role=group][aria-label=Category] button:nth-child(1)'), `${count(rows)} === ${LIBRARY_SIZE}`)
  library.select = await timed(page, 'select a component (detail)', click(`${rows}[data-name="Pixhawk 6C"]`), `!!document.querySelector('[data-testid=spec-ports]')`)
  for (const [k, ms] of Object.entries(library)) expect(ms, k).toBeLessThan(INTERACTION_MS)

  // ---- Electrical Designer ----
  await page.getByTestId('nav-/').click()
  await createProject(page, 'Perf wiring', 'Octo X')
  await buildLargeAssembly(page, 'Perf wiring')
  await page.getByTestId('nav-/electrical').click()
  const projectId = await page.evaluate(async () => {
    const api = (window as unknown as { api: { projects: { list(): Promise<{ ok: true; data: { id: string; name: string }[] }> } } }).api
    return (await api.projects.list()).data.find((p) => p.name === 'Perf wiring')!.id
  })
  await expect(page.getByTestId('electrical-chooser').getByRole('link', { name: 'Perf wiring' })).toBeVisible()
  const nodes = '[data-testid=schematic-node]'
  const openMs = await timed(page, 'open Electrical Designer (85 boxes)', click(`[data-testid=electrical-chooser] a[href$="${projectId}"]`), `${count(nodes)} === 85`)
  expect(openMs).toBeLessThan(PAGE_MS)
  const wireRows = '[data-testid=wire-row]'
  const autoMs = await timed(page, 'auto-wire (100 wires)', click('[data-testid=auto-wire]'), `${count(wireRows)} === 100 && ${count('.react-flow__edge')} === 100`)
  expect(autoMs).toBeLessThan(PAGE_MS)
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
  await page.waitForTimeout(500)

  const designer: Record<string, number> = {}
  designer.selectWireList = await timed(page, 'select a wire (wire list)', `document.querySelectorAll(${JSON.stringify(wireRows)})[50].click()`, `!!document.querySelector('[data-testid=wire-inspector]') && document.querySelectorAll(${JSON.stringify(wireRows)})[50].getAttribute('aria-pressed') === 'true'`)
  const edgeId = await page.locator('.react-flow__edge').nth(20).getAttribute('data-id')
  expect(edgeId).toBeTruthy()
  designer.selectWireCanvas = await timed(
    page,
    'select a wire (schematic)',
    click(`.react-flow__edge[data-id="${edgeId}"]`),
    `document.querySelector('.react-flow__edge[data-id="${edgeId}"]').classList.contains('selected') && !!document.querySelector('[data-testid=wire-inspector]')`,
  )
  designer.selectPart = await timed(page, 'select a part (schematic box)', click(`${nodes}[data-name="Flight controller 1"]`), `!!document.querySelector('[data-testid=part-ports]')`)
  designer.calcOpen = await timed(page, 'open the Calculations drawer', click('[data-testid=toggle-calculations]'), `!!document.querySelector('[data-testid=calc-battery-current]')`)
  await expect(page.getByTestId('calc-battery-current')).toHaveText('840.0 A') // 40 × 21 A
  designer.calcTemp = await timed(
    page,
    'recalculate at 60 °C',
    `{ const s = document.querySelector('[data-testid=load-temp]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '60'); s.dispatchEvent(new Event('change', { bubbles: true })) }`,
    `document.querySelector('[data-testid=load-temp]').value === '60'`,
  )
  // An edit the checks must react to: the GPS cable moved onto Telem1, where the radio is.
  await page.locator(wireRows).filter({ hasText: 'GPS · UART → Flight controller 1 · GPS1' }).click()
  designer.editChecks = await timed(
    page,
    'move a cable → port-conflict in the checks',
    `{ const s = document.querySelector('[data-testid=wire-to-port]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'Telem1'); s.dispatchEvent(new Event('change', { bubbles: true })) }`,
    `!!document.querySelector('[data-testid=electrical-checks] [data-rule=port-conflict]')`,
  )
  designer.undoChecks = await timed(
    page,
    'undo → conflict cleared',
    `document.querySelector('button[aria-label^="Undo "]').click()`,
    `!document.querySelector('[data-testid=electrical-checks] [data-rule=port-conflict]')`,
  )
  for (const [k, ms] of Object.entries(designer)) expect(ms, k).toBeLessThan(INTERACTION_MS)

  // Pan and zoom with the drawer closed (the canvas at full height).
  await page.getByTestId('toggle-calculations').click()
  const pane = (await page.locator('.react-flow__pane').boundingBox())!
  const cx = pane.x + pane.width / 2
  const cy = pane.y + pane.height / 2
  const pan = await frames(page, 'pan the schematic', async () => {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let i = 0; i <= 90; i++) {
      await page.mouse.move(cx + 300 * Math.sin((i / 90) * Math.PI * 2), cy + 150 * Math.sin((i / 45) * Math.PI), { steps: 1 })
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
  })
  const zoom = await frames(page, 'zoom the schematic (wheel)', async () => {
    await page.mouse.move(cx, cy)
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, i < 30 ? -60 : 60)
      await page.waitForTimeout(16)
    }
  })
  expect(pan.medianMs).toBeLessThanOrEqual(FRAME_MS)
  expect(zoom.medianMs).toBeLessThanOrEqual(FRAME_MS)

  // ---- Workshop checks panel, same assembly ----
  // The checks panel and the 3D view are timed apart: the view builds 85 detailed part
  // models, which is the workshop's cost (Phase 2), not the checks'.
  const findings = '[data-testid=checks] [data-testid=finding]'
  const checksMs = await timed(page, 'open the workshop: checks listed (85 parts, 100 wires)', click(`a[href$="/workshop/${projectId}"]`), `${count(findings)} > 0`)
  expect(checksMs).toBeLessThan(PAGE_MS)
  const canvasMs = await timed(page, '… then the 3D view', '', `!!document.querySelector('[data-testid=viewport-3d] canvas')`)
  expect(canvasMs).toBeLessThan(10_000) // logged; GPU start-up varies widely between runs
  await page.waitForTimeout(1500)
  console.log(`[perf3] workshop checks: ${await page.locator(findings).count()} findings`)
  const checksSelect = await timed(page, 'click a finding (selects its parts)', `document.querySelector(${JSON.stringify(`${findings}:not([disabled])`)}).click()`, `!!document.querySelector('[data-testid=part-inspector]')`)
  const firstPart = await page.getByTestId('part-inspector').getByTestId('part-name').inputValue()
  console.log(`[perf3] the finding selected ${firstPart}`)
  // The same selection from the assembly tree: what selecting a part costs in the workshop without the checks.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('part-inspector')).toHaveCount(0)
  const treeSelect = await timed(page, 'select a part in the assembly tree (for comparison)', click(`[data-testid=part-row][data-name="${firstPart}"]`), `!!document.querySelector('[data-testid=part-inspector]')`)
  // Selecting the battery costs the workshop about 0.2 s either way (inspector and 3D view, Phase 2 code);
  // the bound is looser than for the designer for that reason and is a follow-up, not a checks cost.
  expect(treeSelect).toBeLessThan(2 * INTERACTION_MS)
  expect(checksSelect).toBeLessThan(2 * INTERACTION_MS)
  expect(errors).toEqual([])
})
