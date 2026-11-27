import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopApi } from '../../electron/ipc/contract'

const root = join(__dirname, '../..')
const fixture = (name: string) => join(root, 'tests/fixtures/hostile', name)

test('rejects hostile files chosen from a desktop dialog', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blaze-hostile-'))
  try {
    const app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const pick = async (file: string) => app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, fixture(file))

      await pick('cycle.gltf')
      const model = await page.evaluate(() => (globalThis as { api?: DesktopApi }).api!.assets.import())
      expect(model).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cycle/) } })
      await pick('oversized.asc')
      const terrain = await page.evaluate(() => (globalThis as { api?: DesktopApi }).api!.terrain.import({ verticalUnit: 'm' }))
      expect(terrain).toMatchObject({ ok: false, error: { message: expect.stringMatching(/terrain cells/) } })
      await pick('deep-pack.json')
      const pack = await page.evaluate(() => (globalThis as { api?: DesktopApi }).api!.components.importPack())
      expect(pack).toMatchObject({ ok: false, error: { message: expect.stringMatching(/nested too deeply/) } })
      await expect(page.evaluate(() => (globalThis as { api?: DesktopApi }).api!.system.status())).resolves.toMatchObject({ ok: true })
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('the viewport save refuses to replace an unconfirmed suffixed path', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blaze-hostile-save-'))
  const chosen = join(userData, 'view')
  const existing = chosen + '.png'
  try {
    await writeFile(existing, 'previous export')
    const app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
    })
    try {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, chosen)
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const result = await page.evaluate(() => (globalThis as { api?: DesktopApi }).api!.viewport.savePng({
        name: 'view', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      }))
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/already exists/) } })
      expect(await readFile(existing, 'utf8')).toBe('previous export')
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
