import { create } from 'zustand'
import type { Component, ComponentInput, DesktopApi } from '../../electron/ipc/contract'
import { getApi, unwrap } from '../services/api'

interface ComponentsState {
  components: Component[]
  loading: boolean
  error: string | null
  load(): Promise<void>
  create(input: ComponentInput): Promise<Component>
  update(id: string, baseRevision: number, input: ComponentInput): Promise<Component>
  remove(id: string): Promise<void>
  duplicate(id: string): Promise<Component>
  /** Null when the user cancels the save dialog. */
  exportPack(ids: string[], name: string): Promise<{ path: string; count: number } | null>
  /** Null when the user cancels; reloads the list after an import. */
  importPack(): Promise<{ imported: number; skipped: number } | null>
}

const byCategoryAndName = (a: Component, b: Component) =>
  a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export function createComponentsStore(api: () => DesktopApi = getApi) {
  return create<ComponentsState>((set, get) => {
    const put = (c: Component) =>
      set({ components: [...get().components.filter((x) => x.id !== c.id), c].sort(byCategoryAndName) })
    return {
      components: [],
      loading: false,
      error: null,
      async load() {
        set({ loading: true, error: null })
        try {
          set({ components: unwrap(await api().components.list()), loading: false })
        } catch (e) {
          set({ error: (e as Error).message, loading: false })
        }
      },
      async create(input) {
        const c = unwrap(await api().components.create(input))
        put(c)
        return c
      },
      async update(id, baseRevision, input) {
        const c = unwrap(await api().components.update(id, baseRevision, input))
        put(c)
        return c
      },
      async remove(id) {
        unwrap(await api().components.delete(id))
        set({ components: get().components.filter((c) => c.id !== id) })
      },
      async duplicate(id) {
        const c = unwrap(await api().components.duplicate(id))
        put(c)
        return c
      },
      async exportPack(ids, name) {
        return unwrap(await api().components.exportPack(ids, name))
      },
      async importPack() {
        const r = unwrap(await api().components.importPack())
        if (r) await get().load()
        return r
      },
    }
  })
}

export const useComponents = createComponentsStore()
