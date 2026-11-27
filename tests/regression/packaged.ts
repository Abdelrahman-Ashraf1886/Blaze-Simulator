import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { root } from '../e2e/helpers'

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const executable = join(root, 'release', version, 'win-unpacked', 'Blaze UAV.exe')

export async function withPackagedApp(work: (page: Page, profile: string) => Promise<void>) {
  if (!existsSync(executable)) throw new Error(`Packaged app missing: ${executable}. Run npm run release.`)
  const profile = await mkdtemp(join(tmpdir(), 'blaze-packaged-'))
  // The release disables the Node inspector (scripts/release/fuses.mjs:4–10).
  // Attach to Chromium only. Electron uses this switch for its app data too.
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], {
    cwd: dirname(executable), stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
  })
  let context: BrowserContext | undefined
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: child.stderr })
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for packaged Chromium DevTools')), 30_000)
      const cleanup = () => {
        clearTimeout(timeout)
        lines.removeAllListeners('line')
      }
      lines.on('line', (line) => {
        const match = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)$/.exec(line)
        if (match) {
          cleanup()
          resolve(match[1]!)
        }
      })
      child.once('error', (error) => { cleanup(); reject(error) })
      child.once('exit', (code) => { cleanup(); reject(new Error(`Packaged app exited before DevTools attached (${code})`)) })
    })
    const browser = await chromium.connectOverCDP(endpoint)
    context = browser.contexts()[0]
    if (!context) throw new Error('Packaged app has no Chromium context')
    const page = context.pages()[0] ?? await context.waitForEvent('page')
    await expect(page.getByTestId('status-bar').getByTestId('engine-state')).toHaveAttribute('data-state', 'connected')
    expect(existsSync(join(profile, 'blaze-uav.db')), 'database is inside the isolated profile').toBe(true)
    await work(page, profile)
  } finally {
    // Closing the app window runs its regular shutdown path (electron/main/index.ts:671–688).
    await Promise.all((context?.pages() ?? []).map((page) => page.close({ runBeforeUnload: true })))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Packaged app did not close. Profile kept at ${profile}`)), 10_000)
        }),
      ])
      // Only files under the profile created above are eligible for cleanup.
      await rm(profile, { recursive: true, force: true })
    } finally {
      clearTimeout(timer)
    }
  }
}
