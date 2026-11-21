import { create } from 'zustand'
import type { AssetInfo } from '../../../electron/ipc/contract'
import { getApi, unwrap } from '../../services/api'

/** Renderer state of one model file: loading in the viewport, shown, or failed. */
export type ModelStatus = { state: 'loading' } | { state: 'loaded'; triangles: number } | { state: 'error'; message: string }

interface AssetsState {
  assets: Readonly<Record<string, AssetInfo>>
  status: Readonly<Record<string, ModelStatus>>
  load(): Promise<void>
  add(info: AssetInfo): void
  setStatus(id: string, status: ModelStatus): void
}

export const useAssets = create<AssetsState>()((set) => ({
  assets: {},
  status: {},
  async load() {
    const list = unwrap(await getApi().assets.list())
    set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) })
  },
  add: (info) => set((s) => ({ assets: { ...s.assets, [info.id]: info } })),
  setStatus: (id, status) =>
    set((s) => {
      const cur = s.status[id]
      if (cur && JSON.stringify(cur) === JSON.stringify(status)) return s
      return { status: { ...s.status, [id]: status } }
    }),
}))
