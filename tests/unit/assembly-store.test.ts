import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssemblyDocument,
  DesktopApi,
  IpcResult,
  SaveAssemblyInput,
  SaveAssemblyResult,
} from '../../electron/ipc/contract'
import { createAssemblyStore } from '../../src/features/workshop/assembly-store'
import { EMPTY_CONDITIONS } from '../../src/features/flight/readiness'
import { parseFrameValue, toMm } from '../../src/features/workshop/frame-values'

const FRAME = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.12 }

/** In-memory stand-in for the main process: enforces revisions like the repository. */
function fakeBackend() {
  let revision = 0
  const saves: SaveAssemblyInput[] = []
  const handle = (input: SaveAssemblyInput): IpcResult<SaveAssemblyResult> => {
    saves.push(input)
    if (input.baseRevision !== revision) return { ok: false, error: { code: 'CONFLICT', message: 'stale' } }
    revision += 1
    return { ok: true, data: { revision, updatedAt: 'now' } }
  }
  const api = {
    assembly: {
      load: vi.fn(async (projectId: string) => ({
        ok: true as const,
        data: { projectId, revision, updatedAt: 'now', frame: FRAME, motors: {}, parts: [] },
      })),
      save: vi.fn(async (input: SaveAssemblyInput) => handle(input)),
      saveSync: vi.fn((input: SaveAssemblyInput) => handle(input)),
    },
  } as unknown as DesktopApi
  return { api, saves, bump: () => (revision += 1) }
}

const setDiagonal = (v: number) => (d: AssemblyDocument) => ({ ...d, frame: { ...d.frame, motorDiagonal: v } })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('assembly store', () => {
  it('undoes and redoes a sensor conditions edit, using the same document history', async () => {
    const { api, saves } = fakeBackend()
    const store = createAssemblyStore(() => api)
    await store.getState().load('p')
    store.getState().edit('Set sensors', (doc) => ({ ...doc, flight: { ...EMPTY_CONDITIONS, sensors: { mode: 'recorded', gyro: {} } } }))
    expect(store.getState().past.at(-1)?.label).toBe('Set sensors')
    store.getState().undo()
    expect(store.getState().doc).not.toHaveProperty('flight')
    store.getState().redo()
    await store.getState().flush()
    expect(saves.at(-1)?.flight?.sensors).toEqual({ mode: 'recorded', gyro: {} })
  })

  it('records undo history with labels and supports redo', async () => {
    const { api } = fakeBackend()
    const store = createAssemblyStore(() => api)
    await store.getState().load('p')
    store.getState().edit('Change diagonal', setDiagonal(0.5))
    store.getState().edit('Change diagonal', setDiagonal(0.6))
    expect(store.getState().past.map((h) => h.label)).toEqual(['Change diagonal', 'Change diagonal'])

    store.getState().undo()
    expect(store.getState().doc?.frame.motorDiagonal).toBe(0.5)
    store.getState().undo()
    expect(store.getState().doc?.frame.motorDiagonal).toBe(0.45)
    store.getState().undo() // nothing left: no-op
    expect(store.getState().doc?.frame.motorDiagonal).toBe(0.45)
    store.getState().redo()
    expect(store.getState().doc?.frame.motorDiagonal).toBe(0.5)

    store.getState().edit('Change diagonal', setDiagonal(0.7)) // a new edit clears redo
    expect(store.getState().future).toEqual([])
  })

  it('ignores no-op edits and caps history', async () => {
    const { api } = fakeBackend()
    const store = createAssemblyStore(() => api, { historyLimit: 3 })
    await store.getState().load('p')
    store.getState().edit('Nothing', (d) => d)
    expect(store.getState().past).toHaveLength(0)
    for (let i = 1; i <= 5; i++) store.getState().edit(`Edit ${i}`, setDiagonal(0.4 + i / 100))
    expect(store.getState().past.map((h) => h.label)).toEqual(['Edit 3', 'Edit 4', 'Edit 5'])
  })

  it('debounces rapid edits into one save with the latest document', async () => {
    const { api, saves } = fakeBackend()
    const store = createAssemblyStore(() => api, { debounceMs: 500 })
    await store.getState().load('p')
    store.getState().edit('a', setDiagonal(0.5))
    store.getState().edit('b', setDiagonal(0.55))
    expect(store.getState().saveState).toBe('dirty')
    await vi.advanceTimersByTimeAsync(499)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ projectId: 'p', baseRevision: 0, frame: { motorDiagonal: 0.55 } })
    expect(store.getState()).toMatchObject({ saveState: 'saved', revision: 1 })
  })

  it('saves edits made during an in-flight save right after it, on the new revision', async () => {
    const { api, saves } = fakeBackend()
    const store = createAssemblyStore(() => api, { debounceMs: 10 })
    await store.getState().load('p')
    store.getState().edit('a', setDiagonal(0.5))
    const first = store.getState().flush()
    store.getState().edit('b', setDiagonal(0.6))
    await first
    await vi.advanceTimersByTimeAsync(20)
    expect(saves.map((s) => [s.baseRevision, s.frame.motorDiagonal])).toEqual([
      [0, 0.5],
      [1, 0.6],
    ])
    expect(store.getState()).toMatchObject({ saveState: 'saved', revision: 2 })
  })

  it('stops saving on a conflict instead of overwriting', async () => {
    const { api, saves, bump } = fakeBackend()
    const store = createAssemblyStore(() => api, { debounceMs: 10 })
    await store.getState().load('p')
    bump() // someone else saved
    store.getState().edit('a', setDiagonal(0.5))
    await vi.advanceTimersByTimeAsync(20)
    expect(store.getState().saveState).toBe('conflict')
    store.getState().edit('b', setDiagonal(0.6)) // edits are refused until reload
    await vi.advanceTimersByTimeAsync(20)
    expect(saves).toHaveLength(1)
    expect(store.getState().doc?.frame.motorDiagonal).toBe(0.5)
  })

  it('flushSync writes pending edits immediately', async () => {
    const { api } = fakeBackend()
    const store = createAssemblyStore(() => api, { debounceMs: 10_000 })
    await store.getState().load('p')
    store.getState().edit('a', setDiagonal(0.5))
    store.getState().flushSync()
    expect(api.assembly.saveSync).toHaveBeenCalledOnce()
    expect(store.getState()).toMatchObject({ saveState: 'saved', revision: 1 })
  })
})

describe('frame value parsing (mm in the UI, metres stored)', () => {
  it('converts, rounds to 0.1 mm and accepts a comma decimal', () => {
    expect(parseFrameValue('motorDiagonal', '500', FRAME)).toEqual({ ok: true, metres: 0.5 })
    expect(parseFrameValue('armWidth', '18,25', FRAME)).toEqual({ ok: true, metres: 0.0183 })
    expect(toMm(0.0183)).toBe('18.3')
    expect(toMm(0.45)).toBe('450')
  })

  it('explains out-of-range and inconsistent values', () => {
    expect(parseFrameValue('motorDiagonal', 'abc', FRAME)).toEqual({ ok: false, message: 'Enter a number in millimetres' })
    expect(parseFrameValue('motorDiagonal', '20', FRAME)).toEqual({ ok: false, message: 'Between 50 and 3000 mm' })
    expect(parseFrameValue('plateSize', '460', FRAME)).toMatchObject({ ok: false, message: /smaller than the motor/ })
    expect(parseFrameValue('motorDiagonal', '100', FRAME)).toMatchObject({ ok: false, message: /larger than the centre plate/ })
  })
})
