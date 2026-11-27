import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { DesktopApiWithRecordings } from '../../electron/ipc/contract'
import { MIS_TAKEOFF_ALT_M } from '../../src/features/flight/flight-controls'
import { summarizeFlightTiming, type TimingCapture } from '../../src/features/flight/flight-timing-stats'
import { buildQuad, commit, launchApp, openFlight, root } from '../e2e/helpers'

const run = promisify(execFile)
const defaultSeconds = 60 * 60 // documentation/plans/phase-8-quality.md:104
const setupBudgetMs = 180_000 // scripts/profile/measure.spec.ts:13
const maxSampleMs = 20_000 // scripts/profile/measure.spec.ts:14
const pollingMs = 1000 // src/features/flight/FlightPage.tsx:278–280

interface ProcessMemory {
  pid: number
  parentPid: number
  name: string
  workingSetBytes: number | null
  privateBytes: number | null
}

async function memory(app: ElectronApplication) {
  // The OS tree includes the engine child (scripts/profile/measure.spec.ts:30–40).
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    join(root, 'scripts/profile/windows.ps1'), '-RootPid', String(app.process().pid)], { windowsHide: true })
  return JSON.parse(stdout) as { at: number; processes: ProcessMemory[] }
}

function growth(start: ProcessMemory[], end: ProcessMemory[]) {
  const pids = new Set([...start, ...end].map(({ pid }) => pid))
  const difference = (before: number | null | undefined, after: number | null | undefined) =>
    before == null || after == null ? null : after - before
  const total = (processes: ProcessMemory[], key: 'privateBytes' | 'workingSetBytes') =>
    processes.some((entry) => entry[key] === null) ? null : processes.reduce((bytes, entry) => bytes + entry[key]!, 0)
  return {
    totalWorkingSetBytes: difference(total(start, 'workingSetBytes'), total(end, 'workingSetBytes')),
    totalPrivateBytes: difference(total(start, 'privateBytes'), total(end, 'privateBytes')),
    processes: [...pids].map((pid) => {
      const before = start.find((entry) => entry.pid === pid)
      const after = end.find((entry) => entry.pid === pid)
      return {
        pid, name: (after ?? before)!.name,
        lifecycle: !before ? 'started' : !after ? 'exited' : 'present at both samples',
        workingSetBytes: difference(before?.workingSetBytes, after?.workingSetBytes),
        privateBytes: difference(before?.privateBytes, after?.privateBytes),
      }
    }),
  }
}

async function frames(page: Page, durationMs: number, periodMs: number) {
  // Measure the app's flight draws using the same probe as scripts/profile/measure.spec.ts:173–185.
  const sample = await page.evaluate(async ({ durationMs, periodMs }) => {
    const { flightTiming } = (window as unknown as { __blazeTest: {
      flightTiming: { start(capacity: number): number; stop(): TimingCapture | null }
    } }).__blazeTest
    const startMs = flightTiming.start(Math.ceil(durationMs / (periodMs * (1 - 0.05))) + 2)
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs))
    return { startMs, capture: flightTiming.stop() }
  }, { durationMs, periodMs })
  if (!sample.capture) throw new Error('No flight timing capture')
  return summarizeFlightTiming(sample.capture, [], sample.startMs, sample.startMs + durationMs, periodMs)
}

async function measure<T>(work: Promise<T>) {
  try {
    return { value: await work }
  } catch (error) {
    return { error: String(error) }
  }
}

async function takeoff(page: Page) {
  // Ready-to-hold workflow from scripts/profile/measure.spec.ts:188–193.
  await page.getByTestId('flight-start').click()
  await expect(page.getByTestId('flight-status')).toHaveText('Running')
  await page.getByTestId('flight-takeoff-altitude').fill(String(MIS_TAKEOFF_ALT_M))
  await page.getByRole('button', { name: 'Takeoff', exact: true }).click()
  await expect(page.getByTestId('flight-auto-status')).toContainText('Hold · Finished', { timeout: 30_000 })
}

test('reports memory and frame-time growth during a recorded flight with live graphs', async () => {
  const seconds = Number(process.env.BLAZE_SOAK_SECONDS ?? defaultSeconds)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('BLAZE_SOAK_SECONDS must be a positive integer')
  const durationMs = seconds * 1000
  test.setTimeout(durationMs + setupBudgetMs)
  const profile = await mkdtemp(join(tmpdir(), 'blaze-soak-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(profile)
    app = launched.app
    const { page } = launched
    let rendererCrashed = false
    page.on('crash', () => { rendererCrashed = true })
    await expect(page.getByTestId('status-bar').getByTestId('engine-state')).toHaveAttribute('data-state', 'connected')
    const project = 'Soak flight'
    await buildQuad(page, project, { environment: true })
    const projectId = await openFlight(page, project)
    await commit(page, 'flight-altitude', '0')
    await commit(page, 'flight-cutoff-value', '12') // tests/e2e/recording.spec.ts:22–23
    await page.getByTestId('flight-mode').selectOption('position')
    await page.getByRole('checkbox', { name: 'Record runs' }).setChecked(true)
    await page.getByRole('button', { name: 'Show live graphs' }).click()
    await expect(page.getByRole('button', { name: 'Hide live graphs' })).toBeVisible()
    await page.bringToFront()
    await takeoff(page)
    const started = performance.now()
    const periodMs = await app.evaluate(({ screen }) => 1000 / screen.getPrimaryDisplay().displayFrequency)
    const sampleMs = Math.min(maxSampleMs, durationMs / 2)
    const firstMemory = measure(memory(app))
    const firstFrames = measure(frames(page, sampleMs, periodMs))
    const cutoffs: { atMs: number; reason: string }[] = []
    const deadline = started + durationMs
    const finalSampleAt = deadline - sampleMs
    let lastFrames: typeof firstFrames | undefined
    const status = page.getByTestId('flight-status')
    while (performance.now() < deadline) {
      if (!lastFrames && performance.now() >= finalSampleAt) lastFrames = measure(frames(page, sampleMs, periodMs))
      if (rendererCrashed || page.isClosed()) throw new Error('Flight renderer crashed or closed')
      const reason = await status.innerText()
      if (/^Run ended: (Voltage|Charge) cut-off/.test(reason)) {
        cutoffs.push({ atMs: performance.now() - started, reason })
        await takeoff(page)
      } else if (reason !== 'Running') {
        const engineError = await page.getByTestId('flight-error').allTextContents()
        throw new Error(`Flight stopped: ${[reason, ...engineError].join(' ')}`)
      }
      const next = lastFrames ? deadline : finalSampleAt
      await delay(Math.max(0, Math.min(pollingMs, next - performance.now())))
    }
    if (rendererCrashed || page.isClosed()) throw new Error('Flight renderer crashed or closed')
    const lastMemory = measure(memory(app))
    const elapsedMs = performance.now() - started
    const [memoryStart, memoryEnd, framesStart, framesEnd] = await Promise.all([
      firstMemory, lastMemory, firstFrames, lastFrames ?? measure(frames(page, sampleMs, periodMs)),
    ])
    if (await page.getByTestId('flight-stop').isEnabled()) await page.getByTestId('flight-stop').click()
    const completed = await page.waitForFunction(async ({ projectId, expectedRuns }) => {
      const { api } = window as unknown as { api: DesktopApiWithRecordings }
      const result = await api.runs.list(projectId)
      if (!result.ok) throw new Error(result.error.message)
      const flights = result.data.filter(({ kind }) => kind === 'flight')
      const failed = flights.find(({ open, incomplete, fileMissing }) => !open && (incomplete || fileMissing))
      if (failed) throw new Error(`Recording failed: ${failed.endReason ?? failed.id}`)
      return flights.length === expectedRuns && flights.every(({ open }) => !open) ? flights.map(({ id }) => id) : false
    }, { projectId, expectedRuns: cutoffs.length + 1 }, { polling: pollingMs })
    const ids = await completed.jsonValue()
    await completed.dispose()
    if (!ids) throw new Error('Recording completion did not return run IDs')
    const recordings = await page.evaluate(async (ids) => {
      const { api } = window as unknown as { api: DesktopApiWithRecordings }
      return Promise.all(ids.map(async (id) => {
        const result = await api.recording.summary(id)
        if (!result.ok) throw new Error(result.error.message)
        const { bytes, sampleCount, incomplete, integrityError, end } = result.data
        if (incomplete || integrityError || !end || sampleCount === 0) {
          throw new Error(`Recording failed: ${id} ${integrityError ?? ''}`)
        }
        return { id, bytes, sampleCount }
      }))
    }, ids)
    const startP95 = framesStart.value?.frameIntervalMs.p95
    const endP95 = framesEnd.value?.frameIntervalMs.p95
    const report = {
      seconds, elapsedMs, sampleMs, cutoffs, recordings,
      memory: {
        start: memoryStart, end: memoryEnd,
        growth: memoryStart.value && memoryEnd.value ? growth(memoryStart.value.processes, memoryEnd.value.processes) : null,
      },
      frames: {
        start: framesStart, end: framesEnd,
        p95GrowthMs: startP95 == null || endP95 == null ? null : endP95 - startP95,
      },
    }
    const path = test.info().outputPath('soak.json')
    await writeFile(path, JSON.stringify(report, null, 2) + '\r\n', 'utf8')
    console.log(`Soak report ${path}`)
    console.log(JSON.stringify({
      recordings, cutoffs: cutoffs.length, memoryGrowth: report.memory.growth, p95StartMs: startP95,
      p95EndMs: endP95, p95GrowthMs: report.frames.p95GrowthMs,
    }))
  } finally {
    await app?.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
