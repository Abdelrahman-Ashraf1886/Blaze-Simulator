import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, protocol, screen, session, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { thirdPartyNoticesPath } from './notices'
import { ASSET_SCHEME, Channels, type AssetInfo, type GpuPreference, type IpcResult } from '../ipc/contract'
import { createDataOverviewHandler, createDataSafetyHandlers, createDiagnosticsHandlers, createGraphicsHandlers, createHandlers, createRecordingCsvHandler, createRecordingHandlers, createRecordingVerifyHandlers, createTerrainHandlers, flightStartForView, flightStepForView, handlePrintReportPdf, importTerrain } from '../ipc/handlers'
import { createRecordingCsvExporter } from './telemetry/csv'
import { RecordingStore } from './telemetry/store'
import { printCurrentReportPdf } from './telemetry/report-pdf'
import { SessionRecorder } from './telemetry/session-recorder'
import { backfillHullsAsync, importAssetFileAsync, removeAssetFiles, resolveAssetUrl } from './assets/store'
import { shutdownHullWorkers } from './assets/hull-async'
import { safeFileName, savePngSchema } from './screenshot'
import { MAX_PACK_BYTES, PackError, buildPack, importPack } from './components/pack'
import { loadBuiltIns } from './components/seed'
import { z } from 'zod'
import { schemaVersion, type Db } from './db/database'
import {
  backupDirectory, DatabaseCheckError, hasPreservedDatabase, listDatabaseBackups, newestGoodBackup,
  openCheckedDatabase, openDatabaseForRecovery, recoverInterruptedRestore, restoreDatabase,
} from './db/safety'
import { PROJECT_EXTENSION } from './projects/container'
import { recoverInterruptedImports } from './projects/publish'
import { ProjectTransfer } from './projects/transfer'
import engineManifest from '../../simulation-engine/Cargo.toml?raw'
import { ConflictError, createRepositories } from './db/repositories'
import { dropTest } from './engine/drop-test'
import { flightEnd } from './engine/flight-session'
import { scenarioRun } from './engine/scenario-run'
import { stepTest } from './engine/step-test'
import { EngineSupervisor } from './engine/supervisor'
import { createCrashHandlers } from './logging/crashes'
import { createDiagnostics } from './logging/diagnostics'
import { captureConsole, createLogger } from './logging/logger'
import { GPU_PREFERENCE_FILE, gpuSwitchFor, readGpuPreference, writeGpuPreference } from './gpu-preference'

const APP_ID = 'com.blazeuav.app'
/** Fits a 1366×768 laptop at 125 % scaling (1093×566 DIP work area). */
const MIN_SIZE = { width: 880, height: 560 }
const MAX_INITIAL_SIZE = { width: 1680, height: 1050 }
/** Matches --color-bg so the window never flashes white while loading. */
const WINDOW_BACKGROUND = '#131518'

// Test isolation: Playwright points this at a temp directory. Must run before the
// single-instance lock, which is scoped to the userData directory.
if (process.env.BLAZE_UAV_USER_DATA) app.setPath('userData', process.env.BLAZE_UAV_USER_DATA)

const ownsUserData = app.requestSingleInstanceLock()
const logger = createLogger(join(app.getPath('userData'), 'logs'))
if (ownsUserData) {
  captureConsole(logger)
  const crashes = createCrashHandlers(logger, {
    showError: (title, message) => dialog.showErrorBox(title, message),
    offerReload: async (contents, options) => {
      if (contents.isDestroyed()) return false
      const win = BrowserWindow.fromWebContents(contents)
      if (!win || win.isDestroyed()) return false
      return (await dialog.showMessageBox(win, options)).response === 0
    },
  })
  process.on('uncaughtException', crashes.uncaughtException)
  process.on('unhandledRejection', crashes.unhandledRejection)
  app.on('render-process-gone', (_event, contents, details) => void crashes.rendererGone(contents, details))
  app.on('child-process-gone', (_event, details) => crashes.childGone(details))
  logger.write('info', 'main', 'Application starting')
}

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

// Must be registered before `ready`. Fetch-capable so three.js's loader can read
// imported models; the handler serves only files in the asset store.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

let db: Db | null = null
let dbPath = ''
let engine: EngineSupervisor | null = null
let recordingCsv: ReturnType<typeof createRecordingCsvExporter> | undefined
let recorder: SessionRecorder | undefined
let mainWindow: BrowserWindow | null = null
let restartRequested = false

if (!ownsUserData) {
  // Another instance owns this userData directory; it will focus its window.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  const preferencePath = join(app.getPath('userData'), GPU_PREFERENCE_FILE)
  const startupPreference = readGpuPreference(preferencePath)
  const gpuSwitch = gpuSwitchFor(startupPreference)
  if (gpuSwitch) app.commandLine.appendSwitch(gpuSwitch)
  void app.whenReady().then(() => start(preferencePath, startupPreference))
}

function engineBinaryPath(): string {
  // Development/test override, e.g. to exercise the "engine missing" path.
  if (!app.isPackaged && process.env.BLAZE_UAV_ENGINE) return process.env.BLAZE_UAV_ENGINE
  const exe = process.platform === 'win32' ? 'drone-engine.exe' : 'drone-engine'
  if (app.isPackaged) return join(process.resourcesPath, 'engine', exe)
  return join(app.getAppPath(), 'simulation-engine', 'target', 'release', exe)
}

function applyContentSecurityPolicy(): void {
  const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'" // Vite HMR preamble needs inline in dev
  // blob:/data: are needed by three.js for textures embedded in imported models.
  const assets = `${ASSET_SCHEME}: blob: data:`
  const connectSrc = isDev ? `'self' ${assets} ws://localhost:* http://localhost:*` : `'self' ${assets}`
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
}

/** 90 % of the work area of the display under the cursor, clamped, centred. */
function initialBounds() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const minWidth = Math.min(MIN_SIZE.width, workArea.width)
  const minHeight = Math.min(MIN_SIZE.height, workArea.height)
  const width = clamp(Math.round(workArea.width * 0.9), minWidth, Math.min(MAX_INITIAL_SIZE.width, workArea.width))
  const height = clamp(Math.round(workArea.height * 0.9), minHeight, Math.min(MAX_INITIAL_SIZE.height, workArea.height))
  return {
    width,
    height,
    minWidth,
    minHeight,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...initialBounds(),
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    title: 'Blaze UAV',
    autoHideMenuBar: true, // menu stays available on Alt; keeps vertical space for content
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Test hooks (window.__blazeTest) for end-to-end tests only; never set in normal use.
      ...(process.env.BLAZE_UAV_TEST_HOOKS === '1' ? { additionalArguments: ['--blaze-test-hooks'] } : {}),
    },
  })
  win.once('ready-to-show', () => win.show())

  // External links open in the system browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDev || !url.startsWith(process.env.ELECTRON_RENDERER_URL!)) e.preventDefault()
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function showAbout(): void {
  const e = engine?.status
  const engineLine = e?.engineVersion
    ? `Engine ${e.engineVersion} (protocol v${e.protocolVersion})`
    : `Engine not connected (${e?.state ?? 'stopped'})`
  const options = {
    type: 'info' as const,
    title: 'About Blaze UAV',
    message: `Blaze UAV ${app.getVersion()}`,
    detail: [
      engineLine,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      `${process.platform}-${process.arch}`,
      '',
      `Data file: ${dbPath}`,
    ].join('\n'),
    buttons: ['OK'],
  }
  void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit' }] },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'About Blaze UAV', click: showAbout },
          {
            label: 'Third-party notices',
            click: () => {
              const file = thirdPartyNoticesPath(app.isPackaged, process.resourcesPath, app.getAppPath())
              void shell.openPath(file).then((error) => {
                if (error) dialog.showErrorBox('Could not open third-party notices', error)
              }).catch((error: unknown) => {
                dialog.showErrorBox('Could not open third-party notices', String(error))
              })
            },
          },
        ],
      },
    ]),
  )
}

async function start(preferencePath: string, startupPreference: GpuPreference): Promise<void> {
  app.setAppUserModelId(APP_ID)
  nativeTheme.themeSource = 'dark' // dark title bar, menus and native controls on Windows
  applyContentSecurityPolicy()
  buildMenu()

  let preference = startupPreference
  const graphics = createGraphicsHandlers({
    status: () => ({ preference, startupPreference, onBattery: powerMonitor.isOnBatteryPower() }),
    setPreference: (value) => {
      writeGpuPreference(preferencePath, value)
      preference = value
    },
    restart: () => {
      if (restartRequested) return
      restartRequested = true
      app.quit()
    },
  })
  ipcMain.handle(Channels.graphicsStatus, (_event, payload) => graphics.status(payload))
  ipcMain.handle(Channels.graphicsCommand, (_event, payload) => graphics.command(payload))
  const notifyPowerChange = () => mainWindow?.webContents.send(Channels.graphicsStatus, powerMonitor.isOnBatteryPower())
  powerMonitor.on('on-ac', notifyPowerChange)
  powerMonitor.on('on-battery', notifyPowerChange)

  const root = app.getPath('userData')
  dbPath = join(root, 'blaze-uav.db')
  const copies = backupDirectory(dbPath)
  try {
    recoverInterruptedRestore(dbPath)
    try {
      db = await openCheckedDatabase(dbPath)
    } catch (error) {
      if (!(error instanceof DatabaseCheckError)) throw error
      let newest
      try {
        newest = newestGoodBackup(copies)
      } catch (copyError) {
        console.error('[database] could not inspect recovery copies', copyError)
      }
      const restore = newest ? ['Restore newest good copy'] : []
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Database integrity check failed',
        message: 'Blaze UAV found a problem in its database.',
        detail: [
          error.message,
          newest
            ? `Restore replaces the database with the verified copy from ${newest.time} and saves the current file beside it. This covers the database only.`
            : 'No usable database copy was found.',
          'Quit closes Blaze UAV without continuing.',
          'Continue read-only opens whatever data SQLite can still read. Some projects may fail to open, and changes cannot be saved.',
        ].join('\n\n'),
        buttons: ['Quit', ...restore, 'Continue read-only at own risk'],
        defaultId: 0,
        cancelId: 0,
      })
      if (response === 0) {
        app.quit()
        return
      }
      db = newest && response === 1 ? await restoreDatabase(dbPath, newest.id) : openDatabaseForRecovery(dbPath)
    }
  } catch (error) {
    dialog.showErrorBox('Blaze UAV cannot open its database', `${dbPath}\n\n${(error as Error).message}`)
    app.exit(1)
    return
  }

  const recordingsDir = join(root, 'recordings')
  const assetsDir = join(root, 'assets')
  const folders = { root, assets: assetsDir, recordings: recordingsDir }
  const readOnly = db.readonly
  const readOnlyError = { ok: false, error: { code: 'VALIDATION', message: 'Data recovery mode is read-only.' } } as const
  const repos = createRepositories(() => db!, undefined, recordingsDir)
  const recordings = new RecordingStore(recordingsDir, repos.runs)
  if (!readOnly) {
    try {
      recoverInterruptedImports(db, folders)
    } catch (error) {
      console.error('[projects] import recovery failed', error)
    }
    try {
      const orphans = await recordings.recover()
      for (const name of orphans) console.warn('[recordings] recording file has no run row', name)
    } catch (error) {
      console.error('[recordings] startup recovery failed', error)
    }
    try {
      const s = loadBuiltIns(repos)
      if (s.added || s.updated) console.log(`[components] built-ins: ${s.added} added, ${s.updated} updated`)
    } catch (e) {
      console.error('[components] built-in data could not be loaded', e)
    }
    try {
      if (!hasPreservedDatabase(dbPath)) removeAssetFiles(assetsDir, repos.assets.collectGarbage())
    } catch (e) {
      console.error('[assets] cleanup failed', e)
    }
    // On worker threads and not awaited, so startup never waits for it.
    void backfillHullsAsync(assetsDir, repos)
      .then((filled) => {
        if (filled.length) console.log(`[assets] computed the hull of ${filled.length} model(s) imported before 4.4`)
      })
      .catch((e: unknown) => console.error('[assets] hull back-fill failed', e))
  }
  protocol.handle(ASSET_SCHEME, async (request) => {
    const file = resolveAssetUrl(request.url, assetsDir)
    if (!file) return new Response('Not found', { status: 404 })
    return new Response(await readFile(file), {
      headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    })
  })
  ipcMain.handle(Channels.assetsImport, async (event): Promise<IpcResult<AssetInfo | null>> => {
    if (readOnly) return readOnlyError
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import 3D model',
      properties: ['openFile' as const],
      filters: [{ name: 'glTF 2.0 model', extensions: ['glb', 'gltf'] }],
    }
    const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, data: null }
    return importAssetFileAsync(picked.filePaths[0], assetsDir, repos)
  })
  ipcMain.handle(Channels.terrainImport, (event, payload: unknown) => readOnly ? readOnlyError : importTerrain(payload, async () => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import terrain',
      properties: ['openFile' as const],
      filters: [{ name: 'Esri ASCII grid', extensions: ['asc'] }],
    }
    const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    return picked.canceled ? undefined : picked.filePaths[0]
  }, assetsDir, repos))
  ipcMain.handle(Channels.componentsExportPack, async (event, payload: unknown): Promise<IpcResult<{ path: string; count: number } | null>> => {
    const parsed = z.object({ ids: z.array(z.uuid()).min(1, 'Nothing to export').max(5000), name: z.string().max(200) }).safeParse(payload)
    if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: parsed.error.issues[0]!.message } }
    try {
      const components = parsed.data.ids.map((id) => repos.components.get(id))
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: 'Export components',
        defaultPath: join(app.getPath('documents'), `${safeFileName(parsed.data.name)}.json`),
        filters: [{ name: 'Blaze UAV component pack', extensions: ['json'] }],
      }
      const picked = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
      if (picked.canceled || !picked.filePath) return { ok: true, data: null }
      const path = /\.json$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.json`
      await writeFile(path, buildPack(components), 'utf8')
      return { ok: true, data: { path, count: components.length } }
    } catch (e) {
      return { ok: false, error: { code: 'INTERNAL', message: `Could not export: ${(e as Error).message}` } }
    }
  })
  recordingCsv = createRecordingCsvExporter(recordings)
  const exportCsv = createRecordingCsvHandler(recordingCsv)
  ipcMain.handle(Channels.recordingExportCsv, (event, payload: unknown) =>
    exportCsv(payload, async (suggestedName) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: 'Export recording',
        defaultPath: join(app.getPath('documents'), suggestedName),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      }
      const picked = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
      return picked.canceled || !picked.filePath ? null : picked.filePath
    }))

  ipcMain.handle(Channels.componentsImportPack, async (event): Promise<IpcResult<{ imported: number; skipped: number } | null>> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import components',
      properties: ['openFile' as const],
      filters: [{ name: 'Blaze UAV component pack', extensions: ['json'] }],
    }
    const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, data: null }
    try {
      if (statSync(picked.filePaths[0]).size > MAX_PACK_BYTES) throw new PackError('The file is larger than 10 MB.')
      return { ok: true, data: importPack(repos, await readFile(picked.filePaths[0], 'utf8')) }
    } catch (e) {
      if (e instanceof PackError) return { ok: false, error: { code: 'VALIDATION', message: e.message } }
      console.error('[components] import failed', e)
      return { ok: false, error: { code: 'INTERNAL', message: 'The pack could not be read. See application log.' } }
    }
  })
  ipcMain.handle(Channels.viewportSavePng, async (event, payload: unknown): Promise<IpcResult<{ path: string } | null>> => {
    const parsed = savePngSchema.safeParse(payload)
    if (!parsed.success) {
      return { ok: false, error: { code: 'VALIDATION', message: parsed.error.issues.map((i) => i.message).join('; ') } }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Save image of the view',
      defaultPath: join(app.getPath('pictures'), `${safeFileName(parsed.data.name)}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    }
    const picked = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
    if (picked.canceled || !picked.filePath) return { ok: true, data: null }
    const path = /\.png$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.png`
    try {
      await writeFile(path, parsed.data.bytes)
      return { ok: true, data: { path } }
    } catch (e) {
      return { ok: false, error: { code: 'INTERNAL', message: `Could not write the image: ${(e as Error).message}` } }
    }
  })

  const binaryPath = engineBinaryPath()
  engine = new EngineSupervisor({ binaryPath, log: (line, level) => logger.write(level ?? 'info', 'engine', line) })
  const diagnostics = createDiagnostics({
    logger,
    databasePath: dbPath,
    schemaVersion: () => schemaVersion(db!),
    backupDatabase: (path) => db!.backup(path),
    recordingsDirectory: recordingsDir,
    versions: () => ({ app: app.getVersion(), engine: engine!.status.engineVersion, electron: process.versions.electron }),
    os: () => ({ platform: process.platform, arch: process.arch, release: release() }),
    graphicsPreference: () => preference,
    gpuInfo: () => app.getGPUInfo('basic'),
  })
  const diagnosticsHandlers = createDiagnosticsHandlers({
    ...diagnostics,
    openLogFolder: async () => {
      await mkdir(logger.directory, { recursive: true })
      const error = await shell.openPath(logger.directory)
      if (error) throw new Error(error)
    },
    logRendererError: (message) => logger.write('error', 'renderer', message),
  })
  function isMainFrame(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame
  }
  const dataOverview = createDataOverviewHandler({
    async read() {
      // Model and terrain imports share the flat, content-addressed assets folder.
      const files = await readdir(assetsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      let modelBytes = 0
      let terrainBytes = 0
      for (const file of files) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.(glb|gltf|asc)$/.test(file.name)) continue
        const current = await lstat(join(assetsDir, file.name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (!current?.isFile()) continue
        if (file.name.endsWith('.asc')) terrainBytes += current.size
        else modelBytes += current.size
      }
      return { path: root, databaseBytes: (await lstat(dbPath)).size, modelBytes, terrainBytes }
    },
    async open(target) {
      const path = target === 'open-folder'
        ? root
        : thirdPartyNoticesPath(app.isPackaged, process.resourcesPath, app.getAppPath())
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },
  })
  ipcMain.handle(Channels.dataOverview, (event, payload: unknown) =>
    isMainFrame(event) ? dataOverview(payload)
      : { ok: false, error: { code: 'VALIDATION', message: 'Data overview is available from the main window.' } })
  const denied = { ok: false, error: { code: 'VALIDATION', message: 'Diagnostics are available from the main window.' } } as const
  ipcMain.handle(Channels.diagnosticsOpenLogFolder, (event, payload: unknown) =>
    isMainFrame(event) ? diagnosticsHandlers.openLogFolder(payload) : denied)
  ipcMain.handle(Channels.diagnosticsSave, (event, payload: unknown) => {
    const win = mainWindow
    if (!win || !isMainFrame(event)) return denied
    return diagnosticsHandlers.save(payload, async () => {
      const picked = await dialog.showSaveDialog(win, {
        title: 'Save diagnostics',
        defaultPath: join(app.getPath('documents'), 'blaze-uav-diagnostics.zip'),
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      })
      return picked.canceled ? undefined : picked.filePath
    })
  })
  ipcMain.on(Channels.rendererError, (event, payload: unknown) => {
    if (isMainFrame(event)) diagnosticsHandlers.rendererError(payload)
  })
  if (!readOnly) recorder = new SessionRecorder(recordings, (id) => repos.projects.get(id).name, app.getVersion(), () => engine!.status)
  if (!existsSync(binaryPath)) logger.write('error', 'engine', `[engine] binary not found at ${binaryPath}`)

  const projectTransfer = new ProjectTransfer(() => db!, repos, folders, () => {
    // engine-core/src/lib.rs:40 takes its version from the workspace Cargo manifest.
    const engineVersion = engine!.status.engineVersion ?? /^version\s*=\s*"([^"]+)"/m.exec(engineManifest)?.[1]
    if (!engineVersion) throw new Error('The engine version is unavailable.')
    return { appVersion: app.getVersion(), engineVersion }
  })
  const projectFilters = [{ name: 'Blaze UAV project', extensions: [PROJECT_EXTENSION] }]
  let restoring = false
  const dataSafetyHandlers = createDataSafetyHandlers({
    listBackups: () => listDatabaseBackups(copies),
    async restore(id) {
      if (restoring) throw new ConflictError('A database restore is already in progress.')
      restoring = true
      try {
        const restored = await restoreDatabase(dbPath, id, () => {
          if (!readOnly && repos.runs.listOpen().length) throw new ConflictError('Finish recording before restoring a database copy.')
          return db
        }, (reopened) => { db = reopened })
        // The old renderer still has its assembly in memory and saves on unload.
        // Leave its connection closed until the app restarts.
        restored.close()
        restartRequested = true
        setImmediate(() => app.quit())
        return null
      } catch (error) {
        restoring = false
        throw error
      }
    },
    async exportProject({ id, recordings }) {
      const options = {
        title: 'Export project',
        defaultPath: join(app.getPath('documents'), `${safeFileName(repos.projects.get(id).name)}.${PROJECT_EXTENSION}`),
        filters: projectFilters,
      }
      const picked = await (mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options))
      if (picked.canceled || !picked.filePath) return null
      const extension = `.${PROJECT_EXTENSION}`
      const path = picked.filePath.toLowerCase().endsWith(extension) ? picked.filePath : picked.filePath + extension
      await projectTransfer.export(id, recordings, path)
      return { path }
    },
    async importProject() {
      if (readOnly) throw new ConflictError('Data recovery mode is read-only.')
      const options = { title: 'Import project', properties: ['openFile' as const], filters: projectFilters }
      const picked = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options))
      if (picked.canceled || !picked.filePaths[0]) return null
      return projectTransfer.import(picked.filePaths[0])
    },
  })
  const handlers = createHandlers(repos, () => ({
    engine: engine!.status,
    database: { path: dbPath, schemaVersion: schemaVersion(db!) },
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
    },
  }))
  for (const [channel, handler] of Object.entries({ ...handlers, ...dataSafetyHandlers, ...createTerrainHandlers(repos, assetsDir), ...createRecordingHandlers(recordings) })) {
    ipcMain.handle(channel, (_event, payload: unknown) =>
      readOnly && channel === Channels.runsDelete ? readOnlyError : handler(payload))
  }
  for (const [channel, handler] of Object.entries(createRecordingVerifyHandlers(recordings, binaryPath))) {
    ipcMain.handle(channel, (event, payload: unknown) => handler(event.sender, payload))
  }
  ipcMain.handle(Channels.recordingPrintReportPdf, (event, payload: unknown) => handlePrintReportPdf(payload, async () => {
    const win = mainWindow
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Printing is available from the main window.')
    }
    return printCurrentReportPdf(event.sender, async (id) => {
      const run = await recordings.get(id)
      return run.title ?? undefined
    }, async (fileName) => {
      const picked = await dialog.showSaveDialog(win, {
        title: 'Save report as PDF', defaultPath: join(app.getPath('documents'), fileName),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      })
      return picked.canceled ? undefined : picked.filePath
    })
  }))
  // Same validation and storage as the async save; used only while a window unloads.
  ipcMain.on(Channels.assemblySaveSync, (event, payload: unknown) => {
    event.returnValue = db?.open && !readOnly ? handlers[Channels.assemblySave]!(payload) : readOnlyError
  })

  // The sidecar has one loaded vehicle. Keep each load and its consuming command together.
  let vehicleQueue = Promise.resolve()
  function withLoadedVehicle<T>(run: () => Promise<T>): Promise<T> {
    const result = vehicleQueue.then(run)
    vehicleQueue = result.then(() => {}, () => {})
    return result
  }
  ipcMain.handle(Channels.engineDropTest, (_event, payload: unknown) => withLoadedVehicle(() => dropTest(engine!, payload)))
  ipcMain.handle(Channels.engineFlightStart, (_event, payload: unknown) => withLoadedVehicle(() => flightStartForView(engine!, payload, recorder)))
  ipcMain.handle(Channels.engineFlightStep, (_event, payload: unknown) => flightStepForView(engine!, payload, recorder))
  ipcMain.handle(Channels.engineFlightEnd, () => flightEnd(engine!, recorder))
  ipcMain.handle(Channels.engineScenarioRun, (_event, payload: unknown) => withLoadedVehicle(() => scenarioRun(engine!, payload, recorder)))
  ipcMain.handle(Channels.engineStepTest, (_event, payload: unknown) => withLoadedVehicle(() => stepTest(engine!, payload, recorder)))

  engine.on('status', (status) => {
    if ((status.state === 'restarting' || status.state === 'failed') && status.lastError) recorder?.failFlight(status.lastError)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(Channels.engineStatusChanged, status)
  })
  engine.start()

  mainWindow = createWindow()
  // 'closed', not 'close': a cancelled close must not end recording.
  mainWindow.on('closed', () => {
    mainWindow = null
    void recorder?.shutdown('window closed')
  })
}

app.on('window-all-closed', () => app.quit())

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !engine) return
  event.preventDefault()
  quitting = true
  // Never let a stuck engine keep the app alive: give it 3 s, then quit regardless.
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  const closeRecordings = recorder?.shutdown('app quit')
  const closeCsvExports = recordingCsv?.shutdown()
  const shutdown = Promise.allSettled([closeRecordings, closeCsvExports, engine.stop()]).then(() => logger.flush())
  void Promise.race([shutdown, deadline]).finally(() => app.quit())
})

// The database must outlive the windows: closing a window runs its unload handler,
// which saves the last edit synchronously. `will-quit` fires after all windows closed.
app.on('will-quit', () => {
  shutdownHullWorkers()
  if (db?.open) db.close()
  db = null
  if (restartRequested) {
    app.relaunch()
    app.exit()
  }
})
