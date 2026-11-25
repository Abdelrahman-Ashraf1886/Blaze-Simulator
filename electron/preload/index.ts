import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApiWithRecordings, EngineStatus } from '../ipc/contract'

// Channel names are duplicated as literals on purpose: importing the contract
// module at runtime would bundle zod into the sandboxed preload.
const api: DesktopApiWithRecordings = {
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
    totalSize: () => ipcRenderer.invoke('recording:totalSize'),
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
