import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GPU_PREFERENCE_FILE } from '../../electron/main/gpu-preference'
import { createProject, ignoreRealMouse, launchApp, root } from './helpers'

test('shows the drawing card and persists the graphics preference across a restart', async () => {
  const root = process.cwd()
  const userData = mkdtempSync(join(tmpdir(), 'blazeuav-e2e-graphics-'))
  const launch = () => electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, BLAZE_UAV_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  })
  let running: ElectronApplication | undefined
  try {
    running = await launch()
    const page = await running.firstWindow()
    await ignoreRealMouse(running)
    await page.getByTestId('nav-/settings').click()
    await expect(page.getByRole('heading', { name: 'Graphics' })).toBeVisible()
    await expect(page.getByTestId('drawing-card')).toHaveText(/^(?!Detecting…$|Unavailable$).+/)
    await expect(page.getByRole('radio', { name: 'High performance' })).toBeChecked()
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_high_performance_gpu'))).toBe(true)

    await page.getByRole('radio', { name: 'Power saving' }).click()
    await expect(page.getByRole('radio', { name: 'Power saving' })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Restart now' })).toBeEnabled()
    expect(JSON.parse(readFileSync(join(userData, GPU_PREFERENCE_FILE), 'utf8'))).toEqual({ preference: 'power-saving' })
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_low_power_gpu'))).toBe(false)

    await running.close()
    running = await launch()
    const restarted = await running.firstWindow()
    await ignoreRealMouse(running)
    await restarted.getByTestId('nav-/settings').click()
    await expect(restarted.getByRole('radio', { name: 'Power saving' })).toBeChecked()
    await expect(restarted.getByRole('button', { name: 'Restart now' })).toBeDisabled()
    expect(await running.evaluate(({ app }) => app.commandLine.hasSwitch('force_low_power_gpu'))).toBe(true)
  } finally {
    await running?.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})

test('restores a migration copy from Settings after confirmation and restarts', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-e2e-settings-restore-'))
  try {
    const database = new DatabaseSync(join(userData, 'blaze-uav.db'))
    try {
      // Same v1 upgrade fixture as tests/e2e/data-safety.spec.ts:52–58.
      database.exec(await readFile(join(root, 'database/migrations/0001_initial.sql'), 'utf8'))
      database.exec('PRAGMA user_version = 1')
      const date = new Date().toISOString()
      database.prepare('INSERT INTO projects (id, name, frame_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), 'Before migration', 'quad-x', date, date)
    } finally {
      database.close()
    }

    const { app, page } = await launchApp(userData)
    let closed = false
    try {
      await createProject(page, 'After migration')
      await expect(page.getByTestId('recent-projects')).toContainText('After migration')
      await page.getByTestId('nav-/settings').click()
      const restore = page.getByRole('button', { name: /^Restore schema v1 copy from / })
      await expect(restore).toBeVisible()
      await restore.click()
      const confirmation = page.getByRole('dialog', { name: 'Restore database copy?' })
      await expect(confirmation).toContainText('replace the current database')
      await expect(confirmation).toContainText('Models, terrain and recording files are not in a database copy.')
      await expect(confirmation).toContainText('The app restarts after restore.')
      await confirmation.getByRole('button', { name: 'Cancel' }).click()
      await expect(restore).toBeFocused()
      await restore.press('Enter')

      // Observe the requested relaunch, then reopen under Playwright with the same user data.
      const relaunchMarker = join(userData, 'relaunch-requested')
      await app.evaluate(({ app }, path) => {
        const { writeFileSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs')
        app.relaunch = () => { writeFileSync(path, 'requested', 'utf8') }
      }, relaunchMarker)
      const closing = app.waitForEvent('close').then(() => { closed = true })
      await Promise.all([confirmation.getByRole('button', { name: 'Restore database' }).click(), closing])
      expect(await readFile(relaunchMarker, 'utf8')).toBe('requested')
    } finally {
      if (!closed) await app.close()
    }

    const reopened = await launchApp(userData)
    try {
      await expect(reopened.page.getByTestId('recent-projects')).toContainText('Before migration')
      await expect(reopened.page.getByTestId('recent-projects')).not.toContainText('After migration')
    } finally {
      await reopened.app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('previews diagnostics contents before offering a save', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'blazeuav-e2e-settings-diagnostics-'))
  try {
    const { app, page } = await launchApp(userData)
    try {
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
      })
      await page.getByTestId('nav-/settings').click()
      const save = page.getByRole('button', { name: 'Save diagnostics', exact: true })
      await expect(save).toHaveCount(0)
      await page.getByRole('button', { name: 'Preview diagnostics' }).click()
      const include = page.getByRole('checkbox', { name: 'Include database' })
      await expect(include).not.toBeChecked()
      await expect(page.getByText('system.json', { exact: true })).toBeVisible()
      const databaseEntry = page.getByText('blaze-uav.db', { exact: true })
      await expect(databaseEntry).toHaveCount(0)
      await include.check()
      await expect(databaseEntry).toBeVisible()
      await include.uncheck()
      await expect(databaseEntry).toHaveCount(0)
      await save.click()
      await expect(page.getByText('Diagnostics save canceled.')).toBeVisible()
    } finally {
      await app.close()
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
