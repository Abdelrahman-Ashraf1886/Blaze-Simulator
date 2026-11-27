import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, platform, release, totalmem } from 'node:os'
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

  // Tracing through the page's DevTools session records the browser, GPU and renderer processes.
  const { config } = createRequire(join(root, 'scripts/profile/'))('./trace-main.cjs') as { config: { included_categories: string[] } }
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Tracing.start', {
    traceConfig: { recordMode: 'recordUntilFull', includedCategories: config.included_categories },
    transferMode: 'ReturnAsStream', streamFormat: 'json',
  })
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
      const complete = new Promise<{ stream?: string; dataLossOccurred?: boolean }>((resolve) =>
        devtools.once('Tracing.tracingComplete', resolve))
      await devtools.send('Tracing.end')
      const { stream, dataLossOccurred } = await complete
      let text = ''
      for (;;) {
        const chunk = await devtools.send('IO.read', { handle: stream ?? '', size: 1 << 20 })
        text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
        if (chunk.eof) break
      }
      await devtools.send('IO.close', { handle: stream ?? '' })
      await writeFile(rawPath, text, 'utf8')
      const parsed = JSON.parse(text) as { traceEvents?: unknown[] } | unknown[]
      const trace = Array.isArray(parsed) ? { traceEvents: parsed } : parsed
      Object.assign(trace, { dataLossOccurred: dataLossOccurred ?? false })
      const timing = capture?.capture
      const matches = capture && timing && matchStickFlips(capture.flips, timing.requests, timing.draws)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({
        ...trace,
        blazeProfile: {
          version: 1,
          metadata: {
            ...metadata, buildCommit: commit, runCount: 1,
            machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), release: release(), ramBytes: totalmem() },
          },
          periodMs, anchors, main, flight: capture ?? null, stickDrawDelaysMs: matches?.drawDelaysMs,
        },
      }), 'utf8')
      console.log(`FLIGHT-TRACE ${path}`)
    }
  }
  // sample() returned or threw before this point.
  return capture!
}
