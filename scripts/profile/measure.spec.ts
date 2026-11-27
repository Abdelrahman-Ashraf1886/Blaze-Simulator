import { _electron, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DesktopApiWithRecordings } from '../../electron/ipc/contract'
import { buildQuad, commit, openFlight, root } from '../../tests/e2e/helpers'
import { percentile, summarizeFlightTiming, type TimingCapture } from '../../src/features/flight/flight-timing-stats'
import { MIS_TAKEOFF_ALT_M } from '../../src/features/flight/flight-controls'

const run = promisify(execFile)
const fixtureBudgetMs = 180_000 // tests/e2e/flight-performance.spec.ts:219
const flightSampleMs = 20_000 // tests/e2e/flight-performance.spec.ts:21

async function desktop(app: ElectronApplication) {
  return app.evaluate(async ({ app, BrowserWindow, powerMonitor, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const info = await app.getGPUInfo('basic') as { gpuDevice?: unknown[] }
    return {
      pid: process.pid,
      powerSource: powerMonitor.isOnBatteryPower() ? 'battery' : 'mains',
      display: screen.getDisplayMatching(win.getBounds()),
      window: win.getBounds(),
      gpuAdapters: info.gpuDevice ?? null,
    }
  })
}

async function memory(app: ElectronApplication) {
  const snapshot = await app.evaluate(({ app }) => ({ pid: process.pid, at: Date.now(), processes: app.getAppMetrics() }))
  // Electron does not enumerate the Rust child. Match the OS tree by PID and
  // keep the Electron metrics too, in case a process exits between snapshots.
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    join(root, 'scripts/profile/windows.ps1'), '-RootPid', String(snapshot.pid)], { windowsHide: true })
  const os = JSON.parse(stdout) as {
    at: number
    processes: { pid: number; parentPid: number; name: string; workingSetBytes: number | null; privateBytes: number | null }[]
  }
  return { ...snapshot, os }
}

async function webgl(canvas: ReturnType<Page['locator']>) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const gl = node.getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null,
      vendor: info ? String(gl!.getParameter(info.UNMASKED_VENDOR_WEBGL)) : null,
      drawingBuffer: gl ? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } : null,
      dpr: devicePixelRatio,
    }
  })
}

async function launch(userData: string, entry = root, forceGpu = false) {
  return _electron.launch({
    args: [...(forceGpu ? ['--force_high_performance_gpu'] : []), entry],
    cwd: root,
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '', BLAZE_UAV_TEST_HOOKS: '1' },
    timeout: fixtureBudgetMs,
  })
}

async function withProfile<T>(work: (userData: string) => Promise<T>) {
  const userData = await mkdtemp(join(tmpdir(), 'blaze-profile-'))
  try {
    return await work(userData)
  } finally {
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) // tests/e2e/helpers.ts fixture cleanup convention
  }
}

async function startup(userData: string, cache: string) {
  const app = await launch(userData, join(root, 'scripts/profile/startup-main.cjs'))
  try {
    const observation = await app.evaluate(async ({ app }) => {
      type Startup = { shownEpochMs?: number; engineEpochMs?: number; dashboardEpochMs?: number; firstContentfulPaintMs?: number | null; error?: string }
      const stamps = (globalThis as typeof globalThis & { blazeStartup: Startup }).blazeStartup
      const deadline = performance.now()
      const wait = process.getBuiltinModule('node:timers/promises')!.setTimeout
      for (;;) {
        const proc = app.getAppMetrics().find(({ pid }) => pid === process.pid)
        if (!proc) throw new Error('Electron did not report the browser process creation time')
        if (stamps.error) throw new Error(stamps.error)
        if (stamps.shownEpochMs !== undefined && stamps.engineEpochMs !== undefined && stamps.dashboardEpochMs !== undefined) {
          return {
            processStartEpochMs: proc.creationTime,
            firstWindowShownMs: stamps.shownEpochMs - proc.creationTime,
            engineConnectedMs: stamps.engineEpochMs - proc.creationTime,
            dashboardDrawnByMs: stamps.dashboardEpochMs - proc.creationTime,
            navigationFirstContentfulPaintMs: stamps.firstContentfulPaintMs,
          }
        }
        if (performance.now() - deadline > 60_000) throw new Error(`Startup observations incomplete: ${JSON.stringify(stamps)}`)
        await wait(100) // tests/e2e Playwright expect polling starts at 100 ms
      }
    })
    return { cache, observation, environment: await desktop(app) }
  } finally {
    await app.close()
  }
}

async function orbit(page: Page) {
  const box = await page.getByTestId('viewport-3d').boundingBox()
  if (!box) throw new Error('Workshop canvas is not visible')
  // Same relative orbit as tests/e2e/performance.spec.ts:26–47. Record only
  // real R3F render callbacks (Viewport.tsx:256–265), not idle animation ticks.
  const x = (i: number) => box.x + box.width * (0.3 + 0.4 * Math.sin(i / 120 * Math.PI * 2) ** 2)
  const y = box.y + box.height * 0.75
  await page.mouse.move(x(0), y)
  await page.evaluate(() => {
    const timestamps: number[] = []
    const target = window as unknown as { __blazeRenders?: number; stopProfileOrbit?: () => number[] }
    let count = target.__blazeRenders
    Object.defineProperty(target, '__blazeRenders', {
      configurable: true,
      get: () => count,
      set: (value: number) => { count = value; timestamps.push(performance.now()) },
    })
    target.stopProfileOrbit = () => {
      Object.defineProperty(target, '__blazeRenders', { configurable: true, writable: true, value: count })
      delete target.stopProfileOrbit
      return timestamps
    }
  })
  const start = performance.now()
  await page.mouse.down()
  try {
    for (let i = 0; i <= 120; i++) {
      await page.mouse.move(x(i), y)
      await page.waitForTimeout(16)
    }
  } finally {
    await page.mouse.up()
  }
  const elapsedMs = performance.now() - start
  const timestamps = await page.evaluate(() => {
    const target = window as unknown as { stopProfileOrbit: () => number[] }
    return target.stopProfileOrbit()
  })
  const intervalsMs = timestamps.slice(1).map((time, i) => time - timestamps[i]!)
  return {
    elapsedMs, intervalsMs, frames: timestamps.length, renderedFps: timestamps.length * 1000 / elapsedMs,
    medianMs: percentile(intervalsMs, 0.5), p95Ms: percentile(intervalsMs, 0.95),
  }
}

async function workshop(userData: string, forceGpu: boolean, height: number) {
  const app = await launch(userData, root, forceGpu)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('recent-projects').waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true))
    await page.bringToFront()
    await page.waitForFunction(() => document.hasFocus() && innerWidth === screen.width && innerHeight === screen.height)
    const environment = await desktop(app)
    const { size, scaleFactor } = environment.display
    const physical = { width: Math.round(size.width * scaleFactor), height: Math.round(size.height * scaleFactor) }
    if (physical.height !== height || physical.width * 9 !== physical.height * 16) {
      throw new Error(`Set the display to ${height === 1080 ? '1920×1080' : '3840×2160'}; measured ${physical.width}×${physical.height}`)
    }
    await buildQuad(page, 'Workshop profiling quad', { environment: true })
    const gpu = await webgl(page.getByTestId('viewport-3d').locator('canvas'))
    return { forceGpu, environment: { ...environment, physical, gpu }, metrics: await orbit(page) }
  } finally {
    await app.close()
  }
}

async function flightFrames(page: Page, periodMs: number) {
  const sample = await page.evaluate(async ({ durationMs, periodMs }) => {
    const { flightTiming } = (window as unknown as { __blazeTest: {
      flightTiming: { start(capacity: number): number; stop(): TimingCapture | null }
    } }).__blazeTest
    // The flight gate allows 5% timer tolerance and two boundary callbacks.
    const startMs = flightTiming.start(Math.ceil(durationMs / (periodMs * (1 - 0.05))) + 2)
    const endMs = startMs + durationMs
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs))
    return { startMs, endMs, capture: flightTiming.stop() }
  }, { periodMs, durationMs: flightSampleMs })
  if (!sample.capture) throw new Error('The flight timing hook returned no samples')
  return summarizeFlightTiming(sample.capture, [], sample.startMs, sample.endMs, periodMs)
}

async function takeoff(page: Page) {
  await page.getByTestId('flight-start').click()
  await page.locator('[data-testid="flight-status"]', { hasText: /^Running$/ }).waitFor()
  await page.getByTestId('flight-takeoff-altitude').fill(String(MIS_TAKEOFF_ALT_M))
  await page.getByRole('button', { name: 'Takeoff', exact: true }).click()
  await page.locator('[data-testid="flight-auto-status"]', { hasText: 'Hold · Finished' }).waitFor({ timeout: 30_000 })
}

async function waitUntilSessionEnds(page: Page, timeoutMs: number) {
  return page.getByTestId('flight-status').evaluate((status, timeout) => new Promise<string | null>((resolve) => {
    const finish = (result: string | null) => {
      watcher.disconnect()
      clearTimeout(timer)
      resolve(result)
    }
    const check = () => { if (status.textContent !== 'Running') finish(status.textContent ?? '') }
    const watcher = new MutationObserver(check)
    const timer = setTimeout(() => finish(null), timeout)
    watcher.observe(status, { childList: true, subtree: true, characterData: true })
    check()
  }), timeoutMs)
}

async function soak(userData: string, seconds: number) {
  const app = await launch(userData)
  try {
    const page = await app.firstWindow()
    await page.locator('[data-testid="engine-state"][data-state="connected"]').first().waitFor()
    const atStartup = await memory(app)
    const name = 'Profiling flight'
    await buildQuad(page, name, { environment: true })
    const projectId = await openFlight(page, name)
    await commit(page, 'flight-altitude', '0') // tests/e2e/recording.spec.ts:22–23
    await commit(page, 'flight-cutoff-value', '12')
    await page.getByTestId('flight-mode').selectOption('position')
    await page.getByLabel('Record runs').setChecked(true)
    await page.bringToFront()
    await takeoff(page)
    const start = performance.now()
    const environment = await desktop(app)
    const gpu = await webgl(page.getByTestId('flight-viewport').locator('canvas'))
    const periodMs = 1000 / environment.display.displayFrequency
    if (!Number.isFinite(periodMs) || periodMs <= 0) throw new Error('Display refresh period is unavailable')
    const atFlightStart = await memory(app)
    const startFrames = await flightFrames(page, periodMs)
    const restarts = []
    const lastSampleAt = start + seconds * 1000 - flightSampleMs
    while (performance.now() < lastSampleAt) {
      const reason = await waitUntilSessionEnds(page, lastSampleAt - performance.now())
      if (reason === null) break
      if (!reason.startsWith('Run ended:')) throw new Error(`Flight interrupted: ${reason}`)
      const endedMs = performance.now() - start
      await takeoff(page)
      restarts.push({ endedMs, resumedMs: performance.now() - start, reason })
    }
    const endFrames = await flightFrames(page, periodMs)
    const elapsedMs = performance.now() - start
    const flightStatus = await page.getByTestId('flight-status').innerText()
    if (flightStatus === 'Running') await page.getByTestId('flight-stop').click()
    else if (!flightStatus.startsWith('Run ended:')) throw new Error(`Flight interrupted: ${flightStatus}`)
    // EngineFlightSource.ts:209–224 ends asynchronously. Let the recording
    // close before taking the after-flight snapshot.
    await page.waitForFunction(async ({ projectId, expected }) => {
      const { api } = window as unknown as { api: DesktopApiWithRecordings }
      const result = await api.runs.list(projectId)
      if (!result.ok) throw new Error(result.error.message)
      const flights = result.data.filter(({ kind }) => kind === 'flight')
      return flights.length === expected && flights.every(({ open, incomplete, fileMissing }) => !open && !incomplete && !fileMissing)
    }, { projectId, expected: restarts.length + 1 }, { polling: 1000 }) // FlightPage.tsx:278 uses the same recording status cadence.
    const afterFlight = await memory(app)
    const endEnvironment = await desktop(app)
    const recordingPath = process.env.BLAZE_PROFILE_FIXTURE
    if (recordingPath) {
      const { COPYFILE_EXCL } = process.getBuiltinModule('node:fs')!.constants
      const dir = join(userData, 'recordings')
      const files = (await readdir(dir)).filter((file) => file.endsWith('.blzr'))
      if (files.length !== 1) throw new Error('Fixture export requires one completed flight; use a shorter capture')
      await copyFile(join(dir, files[0]!), recordingPath, COPYFILE_EXCL)
    }
    return { seconds, elapsedMs, flightStatus, restarts, environment: { ...environment, gpu }, endEnvironment, atStartup, atFlightStart, afterFlight, startFrames, endFrames, recordingPath }
  } finally {
    await app.close()
  }
}

test('collect desktop measurements', async () => {
  const { BLAZE_PROFILE_JOB: job, BLAZE_PROFILE_OUT: out, BLAZE_PROFILE_BUILD_COMMIT: buildCommit } = process.env
  const count = Number(process.env.BLAZE_PROFILE_COUNT)
  const size = Number(process.env.BLAZE_PROFILE_SIZE)
  if (!out || !buildCommit || !Number.isSafeInteger(count) || count <= 0) throw new Error('Launch through npm run profile')
  test.setTimeout(fixtureBudgetMs * count * (job === 'memory' ? 1 : 2) + (job === 'memory' ? size * 1000 * count : 0))
  const runs = []
  for (let i = 0; i < count; i++) {
    if (job === 'startup') {
      const pair = await withProfile(async (dir) => ({ cold: await startup(dir, 'new profile'), warm: await startup(dir, 'reused profile') }))
      runs.push(pair)
      console.log(`Startup pair ${i + 1}`, { cold: pair.cold.observation, warm: pair.warm.observation })
    } else if (job === 'workshop') {
      const modes = [await withProfile((dir) => workshop(dir, false, size)), await withProfile((dir) => workshop(dir, true, size))]
      runs.push(modes)
      for (const { forceGpu, environment: { gpu }, metrics } of modes) {
        console.log(`Workshop run ${i + 1}, high-performance request ${forceGpu}`,
          { gpu: gpu.renderer, medianMs: metrics.medianMs, p95Ms: metrics.p95Ms, frames: metrics.frames })
      }
    } else if (job === 'memory') {
      const result = await withProfile((dir) => soak(dir, size))
      runs.push(result)
      console.log(`Memory run ${i + 1}`, {
        elapsedMs: result.elapsedMs, restarts: result.restarts.length,
        startupProcesses: result.atStartup.processes.length, afterFlightProcesses: result.afterFlight.processes.length,
        startFrameMs: result.startFrames.frameIntervalMs, endFrameMs: result.endFrames.frameIntervalMs,
      })
      console.table([
        ...result.atStartup.os.processes.map((proc) => ({ at: 'startup', ...proc })),
        ...result.afterFlight.os.processes.map((proc) => ({ at: 'after flight', ...proc })),
      ])
    } else {
      throw new Error(`Unknown desktop measurement ${job}`)
    }
  }
  const metadata = {
    buildCommit, runCount: count,
    machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), release: release(), ramBytes: totalmem() },
  }
  await writeFile(out, JSON.stringify({ metadata, job, runs }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  console.log(`Wrote ${count} ${job} runs to ${out}`)
})
