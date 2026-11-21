import { create } from 'zustand'
import type { AssemblyDocument, DesktopApi, IpcResult, SaveAssemblyResult } from '../../../electron/ipc/contract'
import { getApi } from '../../services/api'

/**
 * Editor state for one project's assembly.
 *
 * - Every edit goes through `edit(label, recipe)`, which records the previous
 *   document for undo. Snapshots are cheap: documents are small plain objects
 *   and recipes return new objects (structural sharing), never mutate.
 * - Saving is debounced and never overlaps: at most one save is in flight, and
 *   edits made meanwhile are saved right after it with the new base revision.
 * - A save based on a stale revision is rejected by main (`CONFLICT`); the editor
 *   then stops saving and asks for a reload instead of overwriting.
 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

interface HistoryEntry {
  doc: AssemblyDocument
  label: string
}

export interface AssemblyState {
  projectId: string | null
  doc: AssemblyDocument | null
  /** Revision of the last successful save (or load). */
  revision: number
  loading: boolean
  saveState: SaveState
  error: string | null
  past: HistoryEntry[]
  future: HistoryEntry[]
  load(projectId: string): Promise<void>
  edit(label: string, recipe: (doc: AssemblyDocument) => AssemblyDocument): void
  undo(): void
  redo(): void
  /** Saves pending edits now. */
  flush(): Promise<void>
  /** Saves pending edits synchronously; only for window unload. */
  flushSync(): void
}

export interface AssemblyStoreOptions {
  debounceMs?: number
  historyLimit?: number
}

export function createAssemblyStore(api: () => DesktopApi = getApi, opts: AssemblyStoreOptions = {}) {
  const debounceMs = opts.debounceMs ?? 500
  const historyLimit = opts.historyLimit ?? 200
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let dirty = false

  return create<AssemblyState>((set, get) => {
    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    const applyResult = (res: IpcResult<SaveAssemblyResult>) => {
      if (res.ok) {
        set({ revision: res.data.revision, saveState: dirty ? 'dirty' : 'saved', error: null })
      } else if (res.error.code === 'CONFLICT') {
        dirty = false
        clearTimer()
        set({ saveState: 'conflict', error: res.error.message })
      } else {
        dirty = true // keep the edit; the next edit or flush retries
        set({ saveState: 'error', error: res.error.message })
      }
    }

    const payload = (baseRevision: number) => {
      const { projectId, doc } = get()
      // The whole document: any field added to it (wiring, schematic…) is saved too.
      return { ...doc!, projectId: projectId!, baseRevision }
    }

    const save = async (): Promise<void> => {
      clearTimer()
      while (inFlight) await inFlight
      const { projectId, doc, saveState } = get()
      if (!dirty || !projectId || !doc || saveState === 'conflict') return
      dirty = false
      set({ saveState: 'saving' })
      inFlight = api()
        .assembly.save(payload(get().revision))
        .then(applyResult, (e: unknown) => {
          dirty = true
          set({ saveState: 'error', error: (e as Error).message })
        })
        .finally(() => {
          inFlight = null
        })
      await inFlight
      if (dirty && get().saveState !== 'error') schedule()
    }

    const schedule = () => {
      clearTimer()
      timer = setTimeout(() => void save(), debounceMs)
    }

    const commit = (doc: AssemblyDocument, past: HistoryEntry[], future: HistoryEntry[]) => {
      if (get().saveState === 'conflict') return
      dirty = true
      set({ doc, past, future, saveState: 'dirty' })
      schedule()
    }

    return {
      projectId: null,
      doc: null,
      revision: 0,
      loading: false,
      saveState: 'idle',
      error: null,
      past: [],
      future: [],

      async load(projectId) {
        clearTimer()
        dirty = false
        set({ projectId, doc: null, loading: true, error: null, past: [], future: [], saveState: 'idle' })
        try {
          const res = await api().assembly.load(projectId)
          if (get().projectId !== projectId) return // another project was opened meanwhile
          if (res.ok) {
            const { revision, frame, motors, parts, wires, schematic } = res.data
            // Optional fields only when present, so documents without them stay identical.
            const doc: AssemblyDocument = { frame, motors, parts, ...(wires ? { wires } : {}), ...(schematic ? { schematic } : {}) }
            set({ doc, revision, loading: false })
          } else {
            set({ loading: false, saveState: 'error', error: res.error.message })
          }
        } catch (e) {
          set({ loading: false, saveState: 'error', error: (e as Error).message })
        }
      },

      edit(label, recipe) {
        const { doc, past } = get()
        if (!doc) return
        const next = recipe(doc)
        if (next === doc) return
        commit(next, [...past, { doc, label }].slice(-historyLimit), [])
      },

      undo() {
        const { doc, past, future } = get()
        const entry = past.at(-1)
        if (!doc || !entry) return
        commit(entry.doc, past.slice(0, -1), [{ doc, label: entry.label }, ...future])
      },

      redo() {
        const { doc, past, future } = get()
        const entry = future[0]
        if (!doc || !entry) return
        commit(entry.doc, [...past, { doc, label: entry.label }], future.slice(1))
      },

      flush: save,

      flushSync() {
        const { projectId, doc, saveState } = get()
        if (!dirty || !projectId || !doc || saveState === 'conflict') return
        clearTimer()
        dirty = false
        // Main handles messages in order, so an async save still in flight is applied
        // first and will have advanced the stored revision by one.
        const base = get().revision + (inFlight ? 1 : 0)
        applyResult(api().assembly.saveSync(payload(base)))
      },
    }
  })
}

export const useAssembly = createAssemblyStore()
