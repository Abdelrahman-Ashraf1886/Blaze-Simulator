import { create } from 'zustand'
import type { DesktopApi, EngineStatus, SimulationRun, SystemStatus } from '../../electron/ipc/contract'
import { getApi, unwrap } from '../services/api'

interface SystemState {
  status: SystemStatus | null
  /** Latest engine status, from either a snapshot or a push (highest revision wins). */
  engine: EngineStatus | null
  runs: SimulationRun[]
  error: string | null
  refresh(): Promise<void>
  applyEngineStatus(engine: EngineStatus): void
  /** Subscribes to engine pushes; returns an unsubscribe function. */
  subscribe(): () => void
}

export function createSystemStore(api: () => DesktopApi = getApi) {
  return create<SystemState>((set, get) => ({
    status: null,
    engine: null,
    runs: [],
    error: null,
    async refresh() {
      try {
        const [status, runs] = await Promise.all([api().system.status(), api().runs.listRecent(10)])
        const snapshot = unwrap(status)
        set({ status: snapshot, runs: unwrap(runs), error: null })
        get().applyEngineStatus(snapshot.engine)
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },
    applyEngineStatus(engine) {
      const current = get().engine
      if (!current || engine.revision >= current.revision) set({ engine })
    },
    subscribe() {
      return api().system.onEngineStatus((s) => get().applyEngineStatus(s))
    },
  }))
}

export const useSystem = createSystemStore()
