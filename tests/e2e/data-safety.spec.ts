import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DesktopApi } from '../../electron/ipc/contract'
import { createProject, launchApp, root } from './helpers'

test('exports and imports a project through the Projects page and native file pickers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blaze-safety-e2e-'))
  try {
    const path = join(dir, 'portable.blazeproj')
    const sourceDir = join(dir, 'source')
    const targetDir = join(dir, 'target')
    await Promise.all([mkdir(sourceDir), mkdir(targetDir)])
    const source = await launchApp(sourceDir)
    try {
      await createProject(source.page, 'Portable quad')
      await source.page.getByTestId('nav-/projects').click()
      await source.app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, path)
      await source.page.getByTestId('project-row').hover()
      await source.page.getByRole('button', { name: 'Export Portable quad' }).click()
      await expect(source.page.getByRole('checkbox', { name: 'Include recordings' })).not.toBeChecked()
      await source.page.getByRole('button', { name: 'Export project', exact: true }).click()
      await expect.poll(async () => (await stat(path).catch(() => null))?.size ?? 0).toBeGreaterThan(0)
    } finally {
      await source.app.close()
    }

    const target = await launchApp(targetDir)
    try {
      await target.app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
      }, path)
      await target.page.getByTestId('nav-/projects').click()
      await target.page.getByRole('button', { name: 'Import project' }).click()
      await expect(target.page.getByTestId('project-row')).toContainText('Portable quad')
    } finally {
      await target.app.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startup creates a verified pre-upgrade copy and the restore IPC preserves the displaced database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blaze-safety-upgrade-e2e-'))
  try {
    const db = new DatabaseSync(join(dir, 'blaze-uav.db'))
    const date = new Date().toISOString()
    try {
      db.exec(await readFile(join(root, 'database/migrations/0001_initial.sql'), 'utf8'))
      db.exec('PRAGMA user_version = 1')
      db.prepare('INSERT INTO projects (id, name, frame_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), 'Before upgrade', 'quad-x', date, date)
    } finally {
      db.close()
    }

    const { app, page } = await launchApp(dir)
    let restored = false
    try {
      await expect(page.getByTestId('recent-projects')).toContainText('Before upgrade')
      const result = await page.evaluate(() =>
        (window as typeof window & { api: DesktopApi }).api.database.listBackups())
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
      expect(result.data).toHaveLength(1)
      const copy = result.data[0]!
      expect(copy).toMatchObject({ version: 1, time: expect.any(String), bytes: expect.any(Number) })
      const backup = new DatabaseSync(join(dir, 'backups', copy.id), { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' })
        expect(backup.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
        expect(backup.prepare('SELECT name FROM projects').get()).toMatchObject({ name: 'Before upgrade' })
      } finally {
        backup.close()
      }

      await createProject(page, 'After upgrade')
      await expect(page.getByTestId('recent-projects')).toContainText('After upgrade')
      // Reopen under Playwright in the same folder once the original process quits.
      await app.evaluate(({ app }) => { app.relaunch = () => {} })
      const closing = app.waitForEvent('close')
      const restore = await page.evaluate((id) =>
        (window as typeof window & { api: DesktopApi }).api.database.restore(id), copy.id)
      expect(restore).toEqual({ ok: true, data: null })
      await closing
      restored = true
    } finally {
      if (!restored) await app.close()
    }

    const reopened = await launchApp(dir)
    try {
      await expect(reopened.page.getByTestId('recent-projects')).toContainText('Before upgrade')
      await expect(reopened.page.getByTestId('recent-projects')).not.toContainText('After upgrade')
      const saved = (await readdir(dir)).find((name) => name.startsWith('blaze-uav.before-restore-') && name.endsWith('.db'))!
      const previous = new DatabaseSync(join(dir, saved), { readOnly: true })
      try {
        expect(previous.prepare('SELECT name FROM projects WHERE name = ?').get('After upgrade')).toMatchObject({ name: 'After upgrade' })
      } finally {
        previous.close()
      }
    } finally {
      await reopened.app.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
