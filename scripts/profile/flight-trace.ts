import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, hostname, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { matchStickFlips, type StickFlip, type TimingCapture } from '../../src/features/flight/flight-timing-stats'
import { root } from '../../tests/e2e/helpers'

export async function saveFlightTrace<T extends { capture: TimingCapture | null; flips: StickFlip[] }>(
  app: ElectronApplication, page: Page, rawPath: string, path: string,
  metadata: Record<string, unknown>, periodMs: number, sample: () => Promise<T>,
): Promise<T> {
  const commit = process.env.BLAZE_PROFILE_BUILD_COMMIT
  if (!commit) throw new Error('Set BLAZE_PROFILE_BUILD_COMMIT to the commit used to build the app')
  const anchor = async (edge: 'start' | 'end') => {
    const name = `blaze.profile.clock.${edge}`
    const mainBeforeMs = await app.evaluate(() => performance.now())
    const rendererMs = await page.evaluate((mark) => performance.mark(mark).startTime, name)
    const mainAfterMs = await app.evaluate(() => performance.now())
    return { name, rendererMs, mainBeforeMs, mainAfterMs }
  }

  await app.evaluate(async ({ contentTracing }, { file, resolution }) => {
    const load = process.getBuiltinModule('node:module')!.createRequire(file)
    const probe = load(file)
    Object.assign(globalThis, { stopBlazeFlightTrace: await probe.start(contentTracing, resolution) })
  }, { file: join(root, 'scripts/profile/trace-main.cjs'), resolution: Math.ceil(periodMs) })

  let capture: T | undefined
  const anchors: Awaited<ReturnType<typeof anchor>>[] = []
  try {
    anchors.push(await anchor('start'))
    capture = await sample()
  } finally {
    try {
      anchors.push(await anchor('end'))
    } finally {
      const main = await app.evaluate(async (_, file) => {
        const state = globalThis as typeof globalThis & { stopBlazeFlightTrace?: (path: string) => Promise<unknown> }
        const stop = state.stopBlazeFlightTrace!
        delete state.stopBlazeFlightTrace
        return stop(file)
      }, rawPath)
      const trace = JSON.parse(await readFile(rawPath, 'utf8'))
      const timing = capture?.capture
      const matches = capture && timing && matchStickFlips(capture.flips, timing.requests, timing.draws)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({
        ...trace,
        blazeProfile: {
          version: 1,
          metadata: {
            ...metadata, buildCommit: commit, runCount: 1,
            machine: { host: hostname(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), release: release(), ramBytes: totalmem() },
          },
          periodMs, anchors, main, flight: capture ?? null, stickDrawDelaysMs: matches?.drawDelaysMs,
        },
      }), 'utf8')
      console.log(`FLIGHT-TRACE ${path}`)
    }
  }
  return capture
}
