import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_SCHEME, Channels, type AssetInfo, type IpcResult } from '../ipc/contract'
import { createHandlers, createRecordingCsvHandler, createRecordingHandlers, createRecordingVerifyHandlers, createTerrainHandlers, flightStartForView, flightStepForView, handlePrintReportPdf, importTerrain } from '../ipc/handlers'
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
import { openDatabase, schemaVersion, type Db } from './db/database'
import { createRepositories } from './db/repositories'
import { dropTest } from './engine/drop-test'
import { flightEnd } from './engine/flight-session'
import { scenarioRun } from './engine/scenario-run'
import { stepTest } from './engine/step-test'
import { EngineSupervisor } from './engine/supervisor'

const APP_ID = 'com.blazeuav.app'
/** Fits a 1366×768 laptop at 125 % scaling (1093×566 DIP work area). */
const MIN_SIZE = { width: 880, height: 560 }
const MAX_INITIAL_SIZE = { width: 1680, height: 1050 }
/** Matches --color-bg so the window never flashes white while loading. */
const WINDOW_BACKGROUND = '#131518'

// Test isolation: Playwright points this at a temp directory. Must run before the
// single-instance lock, which is scoped to the userData directory.
if (process.env.BLAZE_UAV_USER_DATA) app.setPath('userData', process.env.BLAZE_UAV_USER_DATA)

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

if (!app.requestSingleInstanceLock()) {
  // Another instance owns this userData directory; it will focus its window.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void app.whenReady().then(start)
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
      { label: 'Help', submenu: [{ label: 'About Blaze UAV', click: showAbout }] },
    ]),
  )
}

async function start(): Promise<void> {
  app.setAppUserModelId(APP_ID)
  nativeTheme.themeSource = 'dark' // dark title bar, menus and native controls on Windows
  applyContentSecurityPolicy()
  buildMenu()

  dbPath = join(app.getPath('userData'), 'blaze-uav.db')
  try {
    db = openDatabase(dbPath)
  } catch (e) {
    dialog.showErrorBox(
      'Blaze UAV cannot open its database',
      `${dbPath}\n\n${(e as Error).message}\n\nThe file was not modified.`,
    )
    app.exit(1)
    return
  }
  const recordingsDir = join(app.getPath('userData'), 'recordings')
  const repos = createRepositories(db, undefined, recordingsDir)
  const recordings = new RecordingStore(recordingsDir, repos.runs)
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
    console.error('[components] built-in data could not be loaded', e) // the library still works without it
  }

  const assetsDir = join(app.getPath('userData'), 'assets')
  try {
    removeAssetFiles(assetsDir, repos.assets.collectGarbage())
  } catch (e) {
    console.error('[assets] cleanup failed', e) // never blocks startup
  }
  // On worker threads and not awaited, so startup never waits for it.
  void backfillHullsAsync(assetsDir, repos)
    .then((filled) => {
      if (filled.length) console.log(`[assets] computed the hull of ${filled.length} model(s) imported before 4.4`)
    })
    .catch((e: unknown) => console.error('[assets] hull back-fill failed', e)) // those parts keep their bounding box
  protocol.handle(ASSET_SCHEME, async (request) => {
    const file = resolveAssetUrl(request.url, assetsDir)
    if (!file) return new Response('Not found', { status: 404 })
    return new Response(await readFile(file), {
      headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    })
  })
  ipcMain.handle(Channels.assetsImport, async (event): Promise<IpcResult<AssetInfo | null>> => {
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
  ipcMain.handle(Channels.terrainImport, (event, payload: unknown) => importTerrain(payload, async () => {
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
  engine = new EngineSupervisor({ binaryPath, log: (l) => console.log(l) })
  recorder = new SessionRecorder(recordings, (id) => repos.projects.get(id).name, app.getVersion(), () => engine!.status)
  if (!existsSync(binaryPath)) console.error(`[engine] binary not found at ${binaryPath}`)

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
  for (const [channel, handler] of Object.entries({ ...handlers, ...createTerrainHandlers(repos, assetsDir), ...createRecordingHandlers(recordings) })) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload))
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
    event.returnValue = handlers[Channels.assemblySave]!(payload)
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
  void Promise.race([Promise.allSettled([closeRecordings, closeCsvExports, engine.stop()]), deadline]).finally(() => app.quit())
})

// The database must outlive the windows: closing a window runs its unload handler,
// which saves the last edit synchronously. `will-quit` fires after all windows closed.
app.on('will-quit', () => {
  shutdownHullWorkers()
  db?.close()
  db = null
})
