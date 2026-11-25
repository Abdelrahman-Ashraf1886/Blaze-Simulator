import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi } from '../../electron/ipc/contract'
import { toSI } from '../../src/domain/units'
import { MIS_TAKEOFF_ALT_M } from '../../src/features/flight/flight-controls'
import { percentile, summarizeFlightTiming, type TimingCapture } from '../../src/features/flight/flight-timing-stats'
import { STANDARD_AXES } from '../../src/features/input/calibration'
import { buildQuad, commit, launchApp, openFlight, savePadCalibration, setPad } from './helpers'

test.use({ trace: 'off' })
test.skip(process.env.BLAZE_FLIGHT_PERF !== '1', 'Set BLAZE_FLIGHT_PERF=1 to measure the built application')

// Milestone 6.0b limits and sample counts.
const durationMs = 20_000
const flipCount = 60
const flipSeed = 42 // tests/unit/collisions.test.ts:84–85
const tolerance = 0.05
const stickBudgetMs = 67
const warmupMs = 1000 // Same warm-up duration as the climb interval in flight-live.spec.ts.
const terrainSize = 512
// environment.spec.ts:16,29,33–34,38–50, and tests/unit/wind.test.ts:64–67.
const terrainCellM = 2
const terrainNoData = -9999
const wind = {
  kind: 'wind',
  fromDeg: 90,
  mean: { kind: 'constant', speedMps: 3.5 },
  gust: { kind: 'discrete', amplitudeMps: 4, lengthM: 20, startS: 3 },
  turbulence: { kind: 'dryden', seed: 0 },
} as const
// P13*4.4 fixture diameter (database/seed/components.v1.json:2288–2295).
const propDiameterM = toSI(13, 'in')
const cases = [
  { name: 'ground', judged: true, takeoffM: null },
  { name: 'free-hover', judged: true, takeoffM: MIS_TAKEOFF_ALT_M },
  { name: 'heavy-near-ground', judged: false, takeoffM: propDiameterM / 2 },
] as const

async function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, powerMonitor, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const primary = screen.getPrimaryDisplay()
    const bounds = win.getBounds()
    return {
      visible: win.isVisible() && !win.isMinimized(),
      focused: win.isFocused(),
      normalSize: !win.isMaximized() && !win.isFullScreen(),
      bounds,
      displayId: screen.getDisplayMatching(bounds).id,
      primaryId: primary.id,
      displayHz: primary.displayFrequency,
      power: powerMonitor.isOnBatteryPower() ? 'battery' : 'mains',
    }
  })
}

/** Asks for focus and waits for it; validateWindow reports the setup as invalid if the system refuses. */
async function focusWindow(app: ElectronApplication) {
  await expect.poll(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
    const { visible, focused } = await windowState(app)
    return visible && focused
  }, { timeout: 10_000 }).toBe(true).catch(() => {})
}

function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

function validateWindow(win: Awaited<ReturnType<typeof windowState>>) {
  requireValid(win.visible && win.focused && win.normalSize, 'Window must be visible, focused and at normal size')
  requireValid(win.displayId === win.primaryId, 'Window must be on the primary display')
  requireValid(Number.isFinite(win.displayHz) && win.displayHz > 0, 'Primary display frequency is unavailable')
}

async function idleCadence(page: Page, samples: number, periodMs: number) {
  return page.evaluate(({ count, timeoutMs }) => new Promise<{ intervals: number[]; active: boolean }>((resolve) => {
    const intervals: number[] = []
    let previous: number | undefined
    let frame: number
    const finish = (active: boolean) => {
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
      resolve({ intervals, active })
    }
    const sample = (timestamp: number) => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return finish(false)
      if (previous !== undefined) intervals.push(timestamp - previous)
      previous = timestamp
      if (intervals.length === count) return finish(true)
      frame = requestAnimationFrame(sample)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    frame = requestAnimationFrame(sample)
  }), { count: samples, timeoutMs: 2 * (samples + 1) * periodMs })
}

async function importTerrain(app: ElectronApplication, page: Page, userData: string) {
  // Flat at the fixture's zero elevation. Centre the sample extent around the vehicle origin.
  const corner = -terrainSize * terrainCellM / 2
  const file = join(userData, 'flight-perf-flat.asc')
  const row = Array<string>(terrainSize).fill('0').join(' ')
  writeFileSync(file, [
    `ncols ${terrainSize}`, `nrows ${terrainSize}`, `xllcorner ${corner}`, `yllcorner ${corner}`,
    `cellsize ${terrainCellM}`, `NODATA_VALUE ${terrainNoData}`, ...Array<string>(terrainSize).fill(row),
  ].join('\n') + '\n', 'utf8')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, file)
  await page.getByLabel('The .asc file’s elevations are in metres').check()
  await page.getByTestId('import-terrain').click()
  await page.getByTestId('terrain-grid').selectOption({ label: 'flight-perf-flat.asc' })
  await commit(page, 'terrain-friction', '0.4')
  await commit(page, 'terrain-restitution', '0.2')
  const id = await page.evaluate(() => location.hash.split('/').at(-1)!)
  await expect.poll(() => page.evaluate((projectId) =>
    (window as unknown as { api: DesktopApi }).api.assembly.load(projectId), id)).toMatchObject({
    ok: true, data: { environment: { terrain: { friction: 0.4, restitution: 0.2 } } },
  })
}

async function setupWeather(page: Page, id: string) {
  await page.getByTestId('wind-setting').selectOption(wind.kind)
  await commit(page, 'wind-from', String(wind.fromDeg))
  await page.getByTestId('wind-mean').selectOption(wind.mean.kind)
  await commit(page, 'wind-speed', String(wind.mean.speedMps))
  await page.getByTestId('wind-gust').selectOption(wind.gust.kind)
  await commit(page, 'wind-gust-amplitude', String(wind.gust.amplitudeMps))
  await commit(page, 'wind-gust-length', String(wind.gust.lengthM))
  await commit(page, 'wind-gust-start', String(wind.gust.startS))
  await page.getByTestId('wind-turbulence').selectOption(wind.turbulence.kind)
  await commit(page, 'wind-turbulence-seed', String(wind.turbulence.seed))
  await page.getByTestId('ground-effect').selectOption('true')
  await expect.poll(() => page.evaluate((projectId) =>
    (window as unknown as { api: DesktopApi }).api.assembly.load(projectId), id)).toMatchObject({
    ok: true, data: { flight: { wind, groundEffect: true } },
  })
}

function flipSchedule() {
  // Same fixed seed and LCG as tests/unit/collisions.test.ts:84–85, with exact 32-bit multiplication.
  let seed = flipSeed
  const slotMs = durationMs / flipCount
  return Array.from({ length: flipCount }, (_, index) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & (2 ** 31 - 1)
    // Leave a latency budget on each side of a slot so changes are separated even at its edges.
    return index * slotMs + stickBudgetMs + seed / 2 ** 31 * (slotMs - 2 * stickBudgetMs)
  })
}

async function sampleFlight(page: Page, displayHz: number) {
  const tailMs = 2 * stickBudgetMs
  // One request and one draw at most per refresh, plus 5% timer tolerance and two boundary callbacks.
  const capacity = Math.ceil((durationMs + tailMs) * displayHz / (1000 * (1 - tolerance))) + 2
  return page.evaluate(async ({ capacity, durationMs, tailMs, offsets, axis }) => {
    const timing = (window as unknown as { __blazeTest?: {
      flightTiming?: { start(limit: number): number; stop(): TimingCapture | null }
    } }).__blazeTest?.flightTiming
    const axes = navigator.getGamepads()[0]?.axes as number[] | undefined
    if (!timing || !axes) throw new Error('Flight timing hook or calibrated fake pad is missing')
    const visibleAndFocused = () => document.visibilityState === 'visible' && document.hasFocus()
    let active = visibleAndFocused()
    const checkFocus = () => { active &&= visibleAndFocused() }
    const onBlur = () => { active = false }
    document.addEventListener('visibilitychange', checkFocus)
    window.addEventListener('blur', onBlur)
    const flips: { atMs: number; yawRight: number }[] = []
    const startMs = timing.start(capacity)
    const endMs = startMs + durationMs
    const waitUntil = (time: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, time - performance.now())))
    // Chromium runs timers at nearly one point of each frame. Finish the last two 60 Hz frames with message
    // tasks, so a change lands wherever its scheduled time falls within a frame.
    const channel = new MessageChannel()
    const exactly = async (time: number) => {
      await waitUntil(time - 2000 / 60)
      await new Promise<void>((resolve) => {
        channel.port1.onmessage = () => { if (performance.now() >= time) resolve(); else channel.port2.postMessage(0) }
        channel.port2.postMessage(0)
      })
    }
    let lastFrameMs = performance.now()
    let sampling = true
    const onAnimation = (t: number) => { lastFrameMs = t; if (sampling) requestAnimationFrame(onAnimation) }
    requestAnimationFrame(onAnimation)
    const flipPhaseMs: number[] = []
    let capture: TimingCapture | null
    try {
      for (const offset of offsets) {
        await exactly(startMs + offset)
        if (performance.now() >= endMs) break
        // Half of the calibrated [-1, 1] travel. Yaw exercises the input path without commanding translation.
        const yawRight = flips.length % 2 === 0 ? 1 / 2 : -1 / 2
        axes[axis] = yawRight
        flips.push({ atMs: performance.now(), yawRight })
        flipPhaseMs.push(performance.now() - lastFrameMs)
      }
      await waitUntil(endMs + tailMs)
    } finally {
      sampling = false
      channel.port1.close()
      document.removeEventListener('visibilitychange', checkFocus)
      window.removeEventListener('blur', onBlur)
      capture = timing.stop()
    }
    return { capture, flips, flipPhaseMs, startMs, endMs, active: active && visibleAndFocused(), capacity }
  }, { capacity, durationMs, tailMs, offsets: flipSchedule(), axis: STANDARD_AXES.yawRight })
}

for (const scenario of cases) {
  test(scenario.name, async () => {
    test.setTimeout(180_000) // Same fixture budget as flight-device.spec.ts.
    const userData = mkdtempSync(join(tmpdir(), 'blazeuav-flight-perf-'))
    let app: ElectronApplication | undefined
    let status = 'invalid'
    let detail: string | undefined
    const report: Record<string, unknown> = {
      case: scenario.name, judged: scenario.judged, durationMs, cpu: cpus()[0]?.model,
      stickTestInputs: { flipCount, flipSeed },
    }
    try {
      const launched = await launchApp(userData)
      const page = launched.page
      app = launched.app
      await page.bringToFront()
      // The window is shown after the page has loaded; wait for it before judging the setup.
      await focusWindow(app)
      const initial = await windowState(app)
      report.window = initial
      validateWindow(initial)
      const periodMs = 1000 / initial.displayHz
      const limits = { frameMedianMs: periodMs * (1 + tolerance), frameP95Ms: 2 * periodMs * (1 + tolerance), stickP95Ms: stickBudgetMs }
      report.periodMs = periodMs
      report.limits = limits
      const idle = await idleCadence(page, Math.ceil(initial.displayHz), periodMs)
      const idleMedianMs = percentile(idle.intervals, 0.5)
      const idleP95Ms = percentile(idle.intervals, 0.95)
      report.idle = { medianMs: idleMedianMs, p95Ms: idleP95Ms, samples: idle.intervals.length }
      requireValid(idle.active && idleMedianMs !== null && idleP95Ms !== null &&
        idleMedianMs >= periodMs * (1 - tolerance) && idleP95Ms <= limits.frameMedianMs,
        'Idle requestAnimationFrame cadence does not match the primary display frequency')

      await buildQuad(page, scenario.name, { environment: true })
      if (!scenario.judged) {
        report.environmentTestInputs = { terrainSize, terrainCellM, terrainNoData, wind, groundEffect: true, takeoffM: scenario.takeoffM }
        await importTerrain(app, page, userData)
      }
      const id = await openFlight(page, scenario.name)
      if (!scenario.judged) await setupWeather(page, id)
      const canvas = page.getByTestId('flight-viewport').locator('canvas')
      report.gpu = await canvas.evaluate((node: HTMLCanvasElement) => {
        const gl = node.getContext('webgl2')
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return info ? gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) as string | undefined : undefined
      })
      requireValid(report.gpu && report.cpu, 'WebGL renderer or CPU name is unavailable')

      await setPad(page, true)
      await savePadCalibration(page)
      await page.getByTestId('flight-mode').selectOption('position')
      await page.getByTestId('flight-input-source').selectOption({ label: 'DualSense · Index 0' })
      await commit(page, 'flight-altitude', '0') // Sea-level ambient altitude, flight-device.spec.ts.
      await commit(page, 'flight-cutoff-value', '12') // Same battery cut-off as flight-device.spec.ts.
      if (scenario.takeoffM === null) {
        // Raw standard Y is inverted by src/domain/input-mapping.ts:55–56.
        await page.evaluate((axis) => { (navigator.getGamepads()[0]!.axes as number[])[axis] = 1 }, STANDARD_AXES.throttle)
      }
      await focusWindow(app)
      await page.getByTestId('flight-start').click()
      await expect(page.getByTestId('flight-status')).toHaveText('Running')
      await expect(page.getByTestId('flight-mode-actual')).toHaveText('Position')
      const originZ = async () => {
        const xyz = await page.getByTestId('flight-debug').getByText('Origin (world)', { exact: true })
          .locator('xpath=following-sibling::dd').innerText()
        return Number.parseFloat(xyz.split('/')[2] ?? '') // the readout ends with its unit
      }
      const groundZ = await originZ()
      requireValid(Number.isFinite(groundZ), 'Starting altitude readout is unavailable')
      if (scenario.takeoffM !== null) {
        await page.getByTestId('flight-takeoff-altitude').fill(String(scenario.takeoffM))
        await page.getByRole('button', { name: 'Takeoff', exact: true }).click()
        await expect(page.getByTestId('flight-auto-status')).toContainText('Hold · Finished', { timeout: 30_000 })
        await page.getByRole('button', { name: 'Manual', exact: true }).click()
      }
      await page.waitForTimeout(warmupMs)
      const before = await windowState(app)
      report.before = before
      validateWindow(before)
      requireValid(before.displayHz === initial.displayHz && before.primaryId === initial.primaryId,
        'Primary display changed after the idle cadence check')
      const { capture, flips, flipPhaseMs, startMs, endMs, active, capacity } = await sampleFlight(page, before.displayHz)
      const after = await windowState(app)
      report.after = after
      report.capacityPerStream = capacity
      requireValid(capture, 'Timing recorder returned no capture')
      const summary = summarizeFlightTiming(capture, flips, startMs, endMs, periodMs)
      report.metrics = summary
      // Where in a frame the changes landed; spread over a whole period when the schedule is honoured.
      report.flipPhaseMs = { p05: percentile(flipPhaseMs, 0.05), median: percentile(flipPhaseMs, 0.5), p95: percentile(flipPhaseMs, 0.95) }
      report.unsentFlips = flipCount - flips.length
      validateWindow(after)
      requireValid(active && after.displayHz === before.displayHz && after.primaryId === before.primaryId &&
        after.bounds.width === before.bounds.width && after.bounds.height === before.bounds.height,
      'Window focus, visibility, size or display changed during sampling')
      requireValid(!capture.overflow.requests && !capture.overflow.draws, 'Timing recorder overflowed')
      requireValid(summary.draws >= 2 && summary.requests > 0 && flips.length >= flipCount && flips.every(({ atMs }) => atMs < endMs),
        'Insufficient draws, requests or stick changes in the measurement window')
      const measured = capture.draws.filter(({ drawnMs }) => drawnMs >= startMs && drawnMs < endMs)
      const clearances = measured.map(({ altitudeM }) => altitudeM - groundZ)
      const lowest = Math.min(...clearances)
      const highest = Math.max(...clearances)
      report.clearanceAboveStartM = { min: lowest, max: highest }
      requireValid(measured.every(({ mode }) => mode === 'position'), 'Engine left Position mode during sampling')
      requireValid(measured.every(({ touching }) => touching === (scenario.takeoffM === null)),
        'Physical contact did not match the flight case')
      // The heavy case drifts in its wind and gust; its height range is in the report.
      requireValid(scenario.takeoffM === null || lowest > 0, 'The hover touched the ground height')
      await expect(page.getByTestId('flight-status')).toHaveText('Running')

      const within = (value: number | null, limit: number) => value !== null && value <= limit
      const failures = [
        !within(summary.frameIntervalMs.median, limits.frameMedianMs) && 'frame interval median',
        !within(summary.frameIntervalMs.p95, limits.frameP95Ms) && 'frame interval p95',
        !within(summary.stickToDrawMs.p95, limits.stickP95Ms) && 'stick-to-draw p95',
      ].filter(Boolean)
      report.exceededLimits = failures
      status = !scenario.judged ? 'reported' : failures.length ? 'limit-failure' : 'pass'
      if (status === 'limit-failure') detail = `LIMIT ${failures.join(', ')}`
    } catch (error) {
      detail = `INVALID ${error instanceof Error ? error.message : String(error)}`
    } finally {
      console.log(`FLIGHT-PERF ${JSON.stringify({ ...report, status, detail })}`)
      try {
        await app?.close()
      } finally {
        rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      }
    }
    if (detail) throw new Error(detail)
  })
}
