import Database from 'better-sqlite3'
import {
  constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseBackup } from '../../ipc/contract'
import { MIGRATIONS, migrate, schemaVersion, type Db } from './database'
import { ValidationError } from './repositories'

const KEEP_BACKUPS = 3 // documentation/plans/phase-8-quality.md, D5
const TIME = String.raw`\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z`
const backupName = new RegExp(`^blaze-uav-v(\\d+)-(${TIME})\\.db$`)
const restoreTime = new RegExp(`^${TIME}$`)
const sidecars = ['-wal', '-shm', '-journal']

type SafetyStage = 'backup:copy' | 'backup:verify' | 'backup:publish' | 'migration:apply'
  | 'restore:copy' | 'restore:verify' | 'restore:close' | 'restore:preserve'
  | 'restore:sidecars' | 'restore:replace' | 'restore:open'
type Fault = (stage: SafetyStage) => void

export class DatabaseCheckError extends Error {}
export class DatabaseUpgradeError extends Error {}

function fileTime(date: Date): string {
  // Windows file names cannot contain the ':' separators in ISO times.
  return date.toISOString().replaceAll(':', '-')
}

function findFreeTime(pathFor: (time: string) => string): string {
  let millis = Date.now()
  while (existsSync(pathFor(fileTime(new Date(millis))))) millis++
  return fileTime(new Date(millis))
}

function checkVersion(version: number): void {
  if (version > MIGRATIONS.length) {
    throw new ValidationError(`Database schema v${version} is newer than this app supports (v${MIGRATIONS.length}).`)
  }
}

function checkDatabase(db: Db): number {
  try {
    const findings = db.pragma('quick_check') as { quick_check: string }[]
    if (findings.length !== 1 || findings[0]?.quick_check !== 'ok') {
      throw new DatabaseCheckError(findings.map((row) => row.quick_check).join('\n'))
    }
    return schemaVersion(db)
  } catch (error) {
    if (error instanceof DatabaseCheckError) throw error
    throw new DatabaseCheckError((error as Error).message, { cause: error })
  }
}

function inspect(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return checkDatabase(db)
  } finally {
    db.close()
  }
}

function syncFile(path: string): void {
  const file = openSync(path, 'r+')
  try {
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
}

export function backupDirectory(path: string): string {
  return join(dirname(path), 'backups')
}

export function listDatabaseBackups(directory: string): DatabaseBackup[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const match = backupName.exec(entry.name)
    if (!entry.isFile() || !match) return []
    const time = match[2]!.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3')
    const version = Number(match[1])
    if (!Number.isSafeInteger(version) || Number.isNaN(Date.parse(time))) return []
    return [{ id: entry.name, version, time, bytes: lstatSync(join(directory, entry.name)).size }]
  }).sort((a, b) => b.time.localeCompare(a.time) || b.version - a.version)
}

function verifiedBackup(directory: string, backup: DatabaseBackup): string {
  const path = join(directory, backup.id)
  if (!lstatSync(path).isFile() || sidecars.some((suffix) => existsSync(path + suffix))) {
    throw new ValidationError('The selected copy must be a standalone database file.')
  }
  checkVersion(backup.version)
  const version = inspect(path)
  checkVersion(version)
  if (version !== backup.version) throw new ValidationError('The database version does not match the copy name.')
  return path
}

export function newestGoodBackup(directory: string): DatabaseBackup | undefined {
  return listDatabaseBackups(directory).find((backup) => {
    try {
      verifiedBackup(directory, backup)
      return true
    } catch {
      return false
    }
  })
}

async function copyBeforeMigration(db: Db, directory: string, version: number, fault?: Fault): Promise<void> {
  const temporary = join(directory, `.backup-${randomUUID()}.db`)
  try {
    mkdirSync(directory, { recursive: true })
    fault?.('backup:copy')
    await db.backup(temporary)
    fault?.('backup:verify')
    const snapshot = new Database(temporary, { fileMustExist: true })
    try {
      snapshot.pragma('journal_mode = DELETE')
    } finally {
      snapshot.close()
    }
    if (inspect(temporary) !== version) throw new Error('The copy has a different schema version.')
    syncFile(temporary)
    const pathFor = (time: string) => join(directory, `blaze-uav-v${version}-${time}.db`)
    fault?.('backup:publish')
    renameSync(temporary, pathFor(findFreeTime(pathFor)))
  } catch (error) {
    throw new DatabaseUpgradeError(`Could not create and verify the pre-upgrade copy in ${directory}. The upgrade stopped before changing the schema. ${(error as Error).message}`, { cause: error })
  } finally {
    try {
      if (existsSync(temporary)) rmSync(temporary)
    } catch (error) {
      console.warn('[database] could not remove the unfinished copy', error)
    }
  }
  try {
    for (const backup of listDatabaseBackups(directory).slice(KEEP_BACKUPS)) {
      rmSync(join(directory, backup.id))
    }
  } catch (error) {
    console.warn('[database] could not rotate pre-upgrade copies', error)
  }
}

export async function openCheckedDatabase(path: string, directory = backupDirectory(path), fault?: Fault): Promise<Db> {
  const existing = existsSync(path)
  let checkedVersion: number | undefined
  if (existing) {
    const source = new Database(path, { fileMustExist: true, readonly: true })
    try {
      checkedVersion = checkDatabase(source)
      checkVersion(checkedVersion)
      if (checkedVersion < MIGRATIONS.length) await copyBeforeMigration(source, directory, checkedVersion, fault)
    } finally {
      source.close()
    }
  }
  const db = new Database(path, { fileMustExist: existing })
  try {
    const version = checkedVersion ?? checkDatabase(db)
    if (version !== schemaVersion(db)) throw new Error('The database version changed at startup. Reopen the app to retry.')
    db.pragma('foreign_keys = ON')
    migrate(db, () => fault?.('migration:apply'))
    db.pragma('journal_mode = WAL')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function openDatabaseForRecovery(path: string): Db {
  return new Database(path, { readonly: true, fileMustExist: true })
}

function restorePaths(path: string, time: string) {
  const stem = basename(path, '.db')
  const directory = dirname(path)
  return {
    staged: join(directory, `.${stem}.restore-${time}.db`),
    original: join(directory, `${stem}.before-restore-${time}.db`),
    journal: join(directory, `.${stem}.restore-pending`),
  }
}

export function hasPreservedDatabase(path: string): boolean {
  const prefix = basename(path, '.db') + '.before-restore-'
  return readdirSync(dirname(path)).some((name) =>
    name.startsWith(prefix) && name.endsWith('.db') && restoreTime.test(name.slice(prefix.length, -3)))
}

/** The staged file's presence identifies an interrupted swap. A completed rename leaves
 * the verified replacement at the live path and the old database under its saved name. */
export function recoverInterruptedRestore(path: string): void {
  const { journal } = restorePaths(path, '')
  if (!existsSync(journal)) return
  const time = readFileSync(journal, 'utf8')
  if (!restoreTime.test(time)) throw new Error('The database restore journal is invalid.')
  const { staged, original } = restorePaths(path, time)
  if (existsSync(staged)) {
    if (existsSync(original)) {
      const saved = lstatSync(original, { bigint: true })
      const live = existsSync(path) ? lstatSync(path, { bigint: true }) : undefined
      if (live?.dev === saved.dev && live.ino === saved.ino) rmSync(original)
      else renameSync(original, path)
    }
    for (const suffix of sidecars) {
      if (existsSync(original + suffix)) renameSync(original + suffix, path + suffix)
    }
    for (const suffix of sidecars) rmSync(staged + suffix, { force: true })
    rmSync(staged)
  }
  rmSync(journal)
}

/** Stage and upgrade the chosen copy before closing the live connection. The swap and
 * reopen are synchronous, so other handlers cannot use the connection during that window. */
export async function restoreDatabase(
  path: string,
  id: string,
  current?: () => Db | null,
  reconnect?: (db: Db) => void,
  fault?: Fault,
): Promise<Db> {
  if (!existsSync(path)) throw new ValidationError('The current database file is missing.')
  const directory = backupDirectory(path)
  const backup = listDatabaseBackups(directory).find((entry) => entry.id === id)
  if (!backup) throw new ValidationError('The selected database copy is missing.')
  const source = verifiedBackup(directory, backup)
  const time = findFreeTime((value) => {
    const { staged, original } = restorePaths(path, value)
    return existsSync(original) ? original : staged
  })
  const { staged, original, journal } = restorePaths(path, time)
  let swapped = false
  let journaled = false
  let previous: Db | null = null
  let replacement: Db | undefined
  try {
    const journalDraft = staged + '.pending'
    try {
      writeFileSync(journalDraft, time, { flag: 'wx', flush: true })
      renameSync(journalDraft, journal)
      journaled = true
    } finally {
      rmSync(journalDraft, { force: true })
    }
    fault?.('restore:copy')
    copyFileSync(source, staged, constants.COPYFILE_EXCL)
    fault?.('restore:verify')
    if (inspect(staged) !== backup.version) throw new ValidationError('The staged database does not match the copy version.')
    const candidate = await openCheckedDatabase(staged, directory, fault)
    try {
      checkDatabase(candidate)
      candidate.pragma('journal_mode = DELETE')
    } finally {
      candidate.close()
    }
    syncFile(staged)

    fault?.('restore:close')
    previous = current?.() ?? null
    if (previous && !previous.readonly) {
      const checkpoint = previous.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
      if (checkpoint[0]?.busy) throw new Error('The database is locked by another connection.')
    }
    previous?.close()
    fault?.('restore:preserve')
    if (existsSync(path)) linkSync(path, original)
    fault?.('restore:sidecars')
    for (const suffix of sidecars) {
      if (existsSync(path + suffix)) renameSync(path + suffix, original + suffix)
    }
    fault?.('restore:replace')
    renameSync(staged, path)
    swapped = true
    fault?.('restore:open')
    replacement = new Database(path, { fileMustExist: true })
    replacement.pragma('foreign_keys = ON')
    replacement.pragma('journal_mode = WAL')
    rmSync(journal)
    return replacement
  } catch (error) {
    try {
      replacement?.close()
      // Recreate the staged link so crash recovery also recognizes an in-progress rollback.
      if (swapped) linkSync(path, staged)
      if (journaled) recoverInterruptedRestore(path)
      if (previous && !previous.open) {
        const reopened = new Database(path, { fileMustExist: true, readonly: previous.readonly })
        reopened.pragma('foreign_keys = ON')
        if (reconnect) reconnect(reopened)
        else reopened.close()
      }
    } catch (rollback) {
      throw new Error(`Restore failed: ${(error as Error).message}. Recovery could not finish: ${(rollback as Error).message}. The saved database path is ${original}.`, { cause: rollback })
    }
    throw error
  } finally {
    if (!journaled) rmSync(staged, { force: true })
  }
}
