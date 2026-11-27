import { _electron as electron, expect, test } from '@playwright/test'

// Creates a 0.1.0 data folder with one project for the Sandbox upgrade test (Phase 8, 8.8).
// BLAZE_OLD_APP: the 0.1.0 win-unpacked executable. BLAZE_OLD_USERDATA: an empty folder to fill.
// 0.1.0 still honoured BLAZE_UAV_USER_DATA in packaged builds (gated from 0.8.0 on).
test('fill a 0.1.0 data folder with a project', async () => {
  const executablePath = process.env.BLAZE_OLD_APP
  const userData = process.env.BLAZE_OLD_USERDATA
  test.skip(!executablePath || !userData, 'Set BLAZE_OLD_APP and BLAZE_OLD_USERDATA')
  const app = await electron.launch({ executablePath, env: { ...process.env, BLAZE_UAV_USER_DATA: userData! } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const created = await page.evaluate(async () => {
      const api = (window as unknown as { api: { projects: { create(i: unknown): Promise<{ ok: boolean }>; list(): Promise<{ ok: boolean; data: { name: string }[] }> } } }).api
      await api.projects.create({ name: 'Upgrade test quad', frameType: 'quad-x' })
      return api.projects.list()
    })
    expect(created.ok).toBe(true)
    expect(created.data.map(({ name }) => name)).toContain('Upgrade test quad')
  } finally {
    await app.close()
  }
})
