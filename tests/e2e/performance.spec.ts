/**
 * Phase 2 performance criteria: a 50-part assembly orbits at 60 fps at 1080p on the
 * development machine, frame time is logged at 4K, and an idle viewport renders nothing.
 * Numbers are printed so they can be recorded in the DEVLOG; the hard limits leave
 * headroom so a busy machine does not fail the suite.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, launchApp, root } from './helpers'

let userData: string
let app: ElectronApplication | null = null
test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'blazeuav-perf-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const renders = (page: Page) => page.evaluate(() => (window as unknown as { __blazeRenders?: number }).__blazeRenders ?? 0)

/** Orbits by dragging across the canvas for ~2 s; returns frame statistics. */
async function orbit(page: Page) {
  const box = (await page.getByTestId('viewport-3d').boundingBox())!
  const y = box.y + box.height * 0.75
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __sampling: boolean }
    w.__frames = []
    w.__sampling = true
    const tick = (t: number) => {
      if (!w.__sampling) return
      w.__frames.push(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const r0 = await renders(page)
  const t0 = Date.now()
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  for (let i = 0; i <= 120; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + 0.4 * Math.sin((i / 120) * Math.PI * 2) ** 2), y, { steps: 1 })
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  const seconds = (Date.now() - t0) / 1000
  const r1 = await renders(page)
  const intervals = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __sampling: boolean }
    w.__sampling = false
    return w.__frames.slice(1).map((t, i) => t - w.__frames[i]!)
  })
  intervals.sort((a, b) => a - b)
  const pct = (p: number) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))]!
  return { renderedFps: (r1 - r0) / seconds, medianMs: pct(0.5), p95Ms: pct(0.95), frames: intervals.length }
}

test('50-part assembly: orbit frame rate at 1080p and 4K; idle renders nothing', async () => {
  test.setTimeout(180_000)
  const r = await launchApp(userData)
  app = r.app
  const page = r.page
  await page.setViewportSize({ width: 1920, height: 1080 })
  // Chromium throttles a hidden or covered window to 1 frame per second, which would
  // measure the screen state, not rendering. Measure rendering regardless.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false))
  const visible = await page.evaluate(() => document.visibilityState)
  console.log(`[perf] window ${visible}`)
  await createProject(page, 'Perf quad')
  await page.getByTestId('recent-projects').getByRole('link', { name: 'Perf quad' }).click()
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible()

  // 8 parts: a motor and a propeller on every mount.
  await page.getByTestId('mount-motor-1').click()
  await page.getByTestId('part-library').getByRole('button', { name: 'Motor' }).click()
  await page.getByTestId('part-library').getByRole('button', { name: 'Propeller' }).click()
  await page.locator('[data-testid=part-row][data-name="Motor 1"]').click()
  await page.getByTestId('copy-to-mounts').click()
  // + 1 imported model (Blender export) + 41 boxes = 50.
  await page.keyboard.press('Escape')
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, join(root, 'tests/fixtures/blender/pod.glb'))
  await page.getByTestId('import-model').click()
  await page.getByRole('button', { name: 'Add to assembly' }).click()
  await page.keyboard.press('Escape')
  await page.getByTestId('part-library').getByRole('button', { name: 'Payload' }).click()
  for (let i = 0; i < 40; i++) await page.keyboard.press('Control+d')
  await expect(page.getByTestId('status-parts')).toHaveText('50 parts')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)

  const hd = await orbit(page)
  console.log(`[perf] 1920×1080, 50 parts: ${hd.renderedFps.toFixed(1)} rendered fps, frame median ${hd.medianMs.toFixed(1)} ms, p95 ${hd.p95Ms.toFixed(1)} ms (${hd.frames} frames)`)
  expect(hd.medianMs).toBeLessThanOrEqual(1000 / 50) // 60 fps target; fails only below 50

  // Idle: once the camera has settled, nothing renders.
  await page.waitForTimeout(1500)
  const idle0 = await renders(page)
  await page.waitForTimeout(1000)
  expect(await renders(page)).toBe(idle0)

  await page.setViewportSize({ width: 3840, height: 2160 })
  await page.waitForTimeout(1000)
  const uhd = await orbit(page)
  console.log(`[perf] 3840×2160, 50 parts: ${uhd.renderedFps.toFixed(1)} rendered fps, frame median ${uhd.medianMs.toFixed(1)} ms, p95 ${uhd.p95Ms.toFixed(1)} ms (${uhd.frames} frames)`)
  expect(uhd.renderedFps).toBeGreaterThan(0)
})
