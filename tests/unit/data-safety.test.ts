import Database from 'better-sqlite3'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDataSafetyHandlers } from '../../electron/ipc/handlers'
import { Channels } from '../../electron/ipc/contract'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import {
  backupDirectory, DatabaseCheckError, listDatabaseBackups, newestGoodBackup,
  openCheckedDatabase, openDatabaseForRecovery, recoverInterruptedRestore, restoreDatabase,
} from '../../electron/main/db/safety'
import { createRepositories } from '../../electron/main/db/repositories'

let dir: string
let path: string
let copies: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaze-db-safety-'))
  path = join(dir, 'blaze-uav.db')
  copies = backupDirectory(path)
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

function writeLegacy(name = 'Before upgrade', version = 1): void {
  const db = new Database(path)
  try {
    for (const migration of MIGRATIONS.slice(0, version)) db.exec(migration)
    db.pragma(`user_version = ${version}`)
    createRepositories(db).projects.create({ name, frameType: 'quad-x' })
  } finally {
    db.close()
  }
}

function inspect(file = path): { version: number; name: string; check: unknown } {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 })
  try {
    return {
      version: schemaVersion(db), name: db.prepare('SELECT name FROM projects').pluck().get() as string,
      check: db.pragma('quick_check', { simple: true }),
    }
  } finally {
    db.close()
  }
}

async function prepareRestore() {
  writeLegacy()
  const active = await openCheckedDatabase(path)
  const name = active.prepare('SELECT id FROM projects').pluck().get() as string
  createRepositories(active).projects.rename({ id: name, name: 'Before restore' })
  const backup = listDatabaseBackups(copies)[0]!
  return { active, backup }
}

describe('database safety', () => {
  it('quick-checks fresh and current databases without keeping an empty or redundant copy', async () => {
    ;(await openCheckedDatabase(path)).close()
    ;(await openCheckedDatabase(path)).close()
    expect(existsSync(copies)).toBe(false)
    writeFileSync(path, 'corrupt')
    await expect(openCheckedDatabase(path)).rejects.toBeInstanceOf(DatabaseCheckError)
  })

  it.each(['backup:copy', 'backup:verify', 'backup:publish', 'migration:apply'] as const)(
    'leaves the previous schema and data readable when %s fails', async (stage) => {
      writeLegacy()
      const before = readFileSync(path)
      let migrations = 0
      await expect(openCheckedDatabase(path, copies, (point) => {
        if (point === stage && (point !== 'migration:apply' || ++migrations === MIGRATIONS.length - 1)) {
          throw new Error('injected startup interruption')
        }
      })).rejects.toThrow('injected startup interruption')
      expect(inspect()).toEqual({ version: 1, name: 'Before upgrade', check: 'ok' })
      expect(readFileSync(path)).toEqual(before)
      expect(listDatabaseBackups(copies)).toHaveLength(stage === 'migration:apply' ? 1 : 0)
    },
  )

  it.each([['ENOSPC', 'disk full'], ['EACCES', 'read-only folder'], ['EBUSY', 'locked destination']])(
    'reports %s (%s) before changing the live database', async (code, message) => {
      writeLegacy()
      await expect(openCheckedDatabase(path, copies, (stage) => {
        if (stage === 'backup:copy') throw Object.assign(new Error(message), { code })
      })).rejects.toThrow(`The upgrade stopped before changing the schema. ${message}`)
      expect(inspect()).toMatchObject({ version: 1, name: 'Before upgrade' })
    },
  )

  it('reports an actual exclusive SQLite lock and opens the original after release', async () => {
    writeLegacy()
    const locker = new Database(path)
    try {
      locker.exec('BEGIN EXCLUSIVE')
      await expect(openCheckedDatabase(path)).rejects.toThrow(/locked/i)
    } finally {
      locker.close()
    }
    expect(inspect()).toEqual({ version: 1, name: 'Before upgrade', check: 'ok' })
    expect(existsSync(copies)).toBe(false)
  })

  it('cannot upgrade when the copies directory is blocked by a file', async () => {
    writeLegacy()
    writeFileSync(copies, 'blocked')
    await expect(openCheckedDatabase(path)).rejects.toThrow('pre-upgrade copy')
    expect(inspect()).toMatchObject({ version: 1, name: 'Before upgrade' })
  })

  it('copies committed WAL data and rotates only after publishing a verified copy', async () => {
    mkdirSync(copies)
    const history = ['2020-01-01', '2020-01-02', '2020-01-03'].map((date) => `blaze-uav-v1-${date}T00-00-00.000Z.db`)
    for (const name of history) writeFileSync(join(copies, name), 'existing copy')
    writeLegacy()
    const writer = new Database(path)
    try {
      writer.pragma('journal_mode = WAL')
      writer.prepare('UPDATE projects SET name = ?').run('Committed in WAL')
      await expect(openCheckedDatabase(path, copies, (stage) => {
        if (stage === 'backup:verify') throw new Error('cannot verify')
      })).rejects.toThrow('cannot verify')
      expect(readdirSync(copies).sort()).toEqual(history)
      const migrated = await openCheckedDatabase(path)
      migrated.close()
    } finally {
      writer.close()
    }
    const backups = listDatabaseBackups(copies)
    expect(backups.map((copy) => copy.id).slice(1)).toEqual(history.slice(1).reverse())
    expect(backups[0]).toMatchObject({ version: 1, bytes: expect.any(Number) })
    expect(inspect(join(copies, backups[0]!.id))).toEqual({ version: 1, name: 'Committed in WAL', check: 'ok' })
    expect(inspect()).toEqual({ version: MIGRATIONS.length, name: 'Committed in WAL', check: 'ok' })
  })

  it.each(['restore:copy', 'restore:verify', 'restore:close', 'restore:preserve',
    'restore:sidecars', 'restore:replace', 'restore:open'] as const)(
    'opens the original data after a %s failure', async (stage) => {
      const prepared = await prepareRestore()
      let active = prepared.active
      try {
        await expect(restoreDatabase(path, prepared.backup.id, () => active, (db) => { active = db }, (point) => {
          if (point === stage) throw new Error('injected restore interruption')
        })).rejects.toThrow('injected restore interruption')
        expect(active.open).toBe(true)
        expect(inspect()).toEqual({ version: MIGRATIONS.length, name: 'Before restore', check: 'ok' })
        expect(readdirSync(dir).filter((name) => name.includes('restore'))).toEqual([])
      } finally {
        active.close()
      }
    },
  )

  it('restores and migrates an older copy and keeps the displaced database', async () => {
    const { active, backup } = await prepareRestore()
    const restored = await restoreDatabase(path, backup.id, () => active)
    try {
      expect(active.open).toBe(false)
      expect(inspect()).toEqual({ version: MIGRATIONS.length, name: 'Before upgrade', check: 'ok' })
      const previous = readdirSync(dir).find((name) => name.startsWith('blaze-uav.before-restore-'))!
      expect(inspect(join(dir, previous))).toEqual({ version: MIGRATIONS.length, name: 'Before restore', check: 'ok' })
    } finally {
      restored.close()
    }
  })

  it('refuses newer copies and chooses the newest eligible verified copy for a damaged database', async () => {
    const { active, backup } = await prepareRestore()
    active.close()
    const version = MIGRATIONS.length + 1
    const newer = `blaze-uav-v${version}-9999-01-01T00-00-00.000Z.db`
    const other = openDatabase(join(copies, newer))
    other.pragma(`user_version = ${version}`)
    other.close()
    await expect(restoreDatabase(path, newer)).rejects.toThrow('newer than this app')
    await expect(restoreDatabase(path, '../blaze-uav.db')).rejects.toThrow('missing')
    expect(inspect().name).toBe('Before restore')
    expect(newestGoodBackup(copies)).toEqual(backup)
    const recovery = openDatabaseForRecovery(path)
    expect(() => recovery.prepare('DELETE FROM projects').run()).toThrow(/readonly/)
    recovery.close()
    writeFileSync(path, 'damaged database')
    await expect(openCheckedDatabase(path)).rejects.toBeInstanceOf(DatabaseCheckError)
    ;(await restoreDatabase(path, backup.id)).close()
    expect(inspect().name).toBe('Before upgrade')
  })

  it('recovers an interrupted restore with the original file and its WAL sidecars', () => {
    writeLegacy()
    const time = '2020-01-01T00-00-00.000Z'
    const preserved = join(dir, `blaze-uav.before-restore-${time}.db`)
    const staged = join(dir, `.blaze-uav.restore-${time}.db`)
    writeFileSync(staged, 'staged')
    writeFileSync(join(dir, '.blaze-uav.restore-pending'), time)
    linkSync(path, preserved)
    writeFileSync(path + '-wal', 'parked')
    renameSync(path + '-wal', preserved + '-wal')
    recoverInterruptedRestore(path)
    expect(readFileSync(path + '-wal', 'utf8')).toBe('parked')
    rmSync(path + '-wal')
    expect(inspect().name).toBe('Before upgrade')
    expect(readdirSync(dir)).toEqual(['blaze-uav.db'])
  })

  it('validates IPC payloads before invoking copy and project operations', async () => {
    const handlers = createDataSafetyHandlers({
      listBackups: () => [], restore: async () => null, exportProject: async () => null, importProject: async () => null,
    })
    expect(await handlers[Channels.databaseListBackups](undefined)).toEqual({ ok: true, data: [] })
    expect(await handlers[Channels.databaseRestore]({ id: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(await handlers[Channels.projectsExport]({ id: 'bad' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(await handlers[Channels.projectsImport]({ path })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  })
})
