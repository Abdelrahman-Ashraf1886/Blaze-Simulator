import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApiWithRecordings, EngineStatus, RecordingVerifyProgress } from '../ipc/contract'

// Channel names are duplicated as literals on purpose: importing the contract
// module at runtime would bundle zod into the sandboxed preload.
let lastRendererError = -Infinity
const api: DesktopApiWithRecordings = {
  diagnostics: {
    openLogFolder: () => ipcRenderer.invoke('diagnostics:openLogFolder'),
    save: (input) => ipcRenderer.invoke('diagnostics:save', input),
    reportRendererError: (message) => {
      const now = performance.now()
      // Match the main process limit to avoid sending an IPC for every repeated error.
      if (now - lastRendererError < 1000 || typeof message !== 'string' || !message) return
      lastRendererError = now
      ipcRenderer.send('diagnostics:rendererError', message)
    },
  },
  graphics: {
    status: () => ipcRenderer.invoke('graphics:status'),
    command: (input) => ipcRenderer.invoke('graphics:command', input),
    onPowerChange: (listener) => {
      const receive = (_event: unknown, onBattery: boolean) => listener(onBattery)
      ipcRenderer.on('graphics:status', receive)
      return () => ipcRenderer.removeListener('graphics:status', receive)
    },
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    rename: (input) => ipcRenderer.invoke('projects:rename', input),
    delete: (id) => ipcRenderer.invoke('projects:delete', { id }),
  },
  runs: {
    listRecent: (limit) => ipcRenderer.invoke('runs:listRecent', { limit }),
    list: (id) => ipcRenderer.invoke('runs:list', { id }),
    get: (id) => ipcRenderer.invoke('runs:get', { id }),
    delete: (id) => ipcRenderer.invoke('runs:delete', { id }),
  },
  recording: {
    summary: (id) => ipcRenderer.invoke('recording:summary', { id }),
    readSamples: (query) => ipcRenderer.invoke('recording:readSamples', query),
    readRequests: (id) => ipcRenderer.invoke('recording:readRequests', { id }),
    verify: (id, requestId) => ipcRenderer.invoke('recording:verify', { id, requestId }),
    cancelVerify: (requestId) => ipcRenderer.invoke('recording:verifyCancel', { requestId }),
    onVerifyProgress: (listener) => {
      const receive = (_event: unknown, progress: RecordingVerifyProgress) => listener(progress)
      ipcRenderer.on('recording:verifyProgress', receive)
      return () => ipcRenderer.removeListener('recording:verifyProgress', receive)
    },
    totalSize: () => ipcRenderer.invoke('recording:totalSize'),
    printReportPdf: () => ipcRenderer.invoke('recording:printReportPdf'),
    exportCsv: (query) => ipcRenderer.invoke('recording:exportCsv', query),
  },
  tuning: {
    get: (projectId) => ipcRenderer.invoke('tuning:get', { id: projectId }),
    set: (input) => ipcRenderer.invoke('tuning:set', input),
    reset: (projectId) => ipcRenderer.invoke('tuning:reset', { id: projectId }),
  },
  assembly: {
    load: (projectId) => ipcRenderer.invoke('assembly:load', { id: projectId }),
    save: (input) => ipcRenderer.invoke('assembly:save', input),
    saveSync: (input) => ipcRenderer.sendSync('assembly:saveSync', input),
  },
  components: {
    list: (category) => ipcRenderer.invoke('components:list', { category }),
    get: (id) => ipcRenderer.invoke('components:get', { id }),
    create: (input) => ipcRenderer.invoke('components:create', input),
    update: (id, baseRevision, input) => ipcRenderer.invoke('components:update', { id, baseRevision, input }),
    delete: (id) => ipcRenderer.invoke('components:delete', { id }),
    duplicate: (id) => ipcRenderer.invoke('components:duplicate', { id }),
    setFill: (id, key, spec) => ipcRenderer.invoke('components:setFill', { id, key, spec }),
    exportPack: (ids, name) => ipcRenderer.invoke('components:exportPack', { ids, name }),
    importPack: () => ipcRenderer.invoke('components:importPack'),
  },
  viewport: { savePng: (input) => ipcRenderer.invoke('viewport:savePng', input) },
  assets: {
    list: () => ipcRenderer.invoke('assets:list'),
    import: () => ipcRenderer.invoke('assets:import'),
  },
  terrain: {
    import: (input) => ipcRenderer.invoke('terrain:import', input),
    read: (id) => ipcRenderer.invoke('terrain:read', id),
    list: () => ipcRenderer.invoke('terrain:list'),
  },
  engine: {
    dropTest: (input) => ipcRenderer.invoke('engine:dropTest', input),
    flightStart: (input) => ipcRenderer.invoke('engine:flightStart', input),
    flightStep: (input) => ipcRenderer.invoke('engine:flightStep', input),
    flightEnd: () => ipcRenderer.invoke('engine:flightEnd'),
    scenarioRun: (input) => ipcRenderer.invoke('engine:scenarioRun', input),
    stepTest: (input) => ipcRenderer.invoke('engine:stepTest', input),
  },
  // Main adds this argument only when started for end-to-end tests (BLAZE_UAV_TEST_HOOKS=1).
  testHooks: process.argv.includes('--blaze-test-hooks'),
  system: {
    status: () => ipcRenderer.invoke('system:status'),
    onEngineStatus: (listener) => {
      const handler = (_e: unknown, status: EngineStatus) => listener(status)
      ipcRenderer.on('engine:statusChanged', handler)
      return () => ipcRenderer.removeListener('engine:statusChanged', handler)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

if (process.isMainFrame) {
  // Rejection events are dispatched in the world where the rejected promise lives.
  contextBridge.executeInMainWorld({
    func: () => {
      const page = globalThis as unknown as {
        api: DesktopApiWithRecordings
        addEventListener(type: 'error', listener: (event: {
          error: unknown; message: string; filename: string; lineno: number; colno: number
        }) => void): void
        addEventListener(type: 'unhandledrejection', listener: (event: { reason: unknown }) => void): void
      }
      const report = page.api.diagnostics.reportRendererError
      page.addEventListener('error', ({ error, message, filename, lineno, colno }) => {
        report(error instanceof Error ? error.stack ?? error.message : `${message} (${filename}:${lineno}:${colno})`)
      })
      page.addEventListener('unhandledrejection', ({ reason }) => {
        let message: string
        try {
          message = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
        } catch {
          message = '[Could not format rejection reason]'
        }
        report(`unhandledrejection: ${message}`)
      })
    },
  })
}
