import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, EngineStatus } from '../ipc/contract'

// Channel names are duplicated as literals on purpose: importing the contract
// module at runtime would bundle zod into the sandboxed preload.
const api: DesktopApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    rename: (input) => ipcRenderer.invoke('projects:rename', input),
    delete: (id) => ipcRenderer.invoke('projects:delete', { id }),
  },
  runs: { listRecent: (limit) => ipcRenderer.invoke('runs:listRecent', { limit }) },
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
    exportPack: (ids, name) => ipcRenderer.invoke('components:exportPack', { ids, name }),
    importPack: () => ipcRenderer.invoke('components:importPack'),
  },
  viewport: { savePng: (input) => ipcRenderer.invoke('viewport:savePng', input) },
  assets: {
    list: () => ipcRenderer.invoke('assets:list'),
    import: () => ipcRenderer.invoke('assets:import'),
  },
  engine: { dropTest: (input) => ipcRenderer.invoke('engine:dropTest', input) },
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
