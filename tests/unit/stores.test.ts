import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi, EngineStatus, Project, SystemStatus } from '../../electron/ipc/contract'
import { createProjectsStore } from '../../src/stores/projects'
import { createSystemStore } from '../../src/stores/system'

const project = (id: string, name: string): Project => ({
  id,
  name,
  frameType: 'quad-x',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

function fakeApi(overrides: Partial<DesktopApi['projects']> = {}): DesktopApi {
  return {
    projects: {
      list: vi.fn(async () => ({ ok: true as const, data: [project('a', 'A')] })),
      create: vi.fn(async (i) => ({ ok: true as const, data: project('b', i.name) })),
      rename: vi.fn(async (i) => ({ ok: true as const, data: project(i.id, i.name) })),
      delete: vi.fn(async () => ({ ok: true as const, data: null })),
      ...overrides,
    },
    runs: { listRecent: vi.fn(async () => ({ ok: true as const, data: [] })) },
    assembly: {
      load: vi.fn(),
      save: vi.fn(),
      saveSync: vi.fn(),
    },
    assets: { list: vi.fn(), import: vi.fn() },
    viewport: { savePng: vi.fn() },
    components: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), duplicate: vi.fn(), setFill: vi.fn(), exportPack: vi.fn(), importPack: vi.fn() },
    system: {
      status: vi.fn(async () => ({
        ok: true as const,
        data: { engine: { state: 'starting', revision: 1 } } as SystemStatus,
      })),
      onEngineStatus: vi.fn(() => () => {}),
    },
  }
}

describe('projects store', () => {
  it('loads, creates (prepends), renames (moves to top) and removes', async () => {
    const api = fakeApi()
    const store = createProjectsStore(() => api)
    await store.getState().load()
    expect(store.getState().projects.map((p) => p.id)).toEqual(['a'])

    await store.getState().create({ name: 'B', frameType: 'hex-x' })
    expect(store.getState().projects.map((p) => p.id)).toEqual(['b', 'a'])

    await store.getState().rename('a', 'A2')
    expect(store.getState().projects.map((p) => p.name)).toEqual(['A2', 'B'])

    await store.getState().remove('b')
    expect(store.getState().projects.map((p) => p.id)).toEqual(['a'])
  })

  it('surfaces IPC errors without corrupting state', async () => {
    const api = fakeApi({
      create: vi.fn(async () => ({ ok: false as const, error: { code: 'VALIDATION' as const, message: 'Name is required' } })),
      list: vi.fn(async () => ({ ok: false as const, error: { code: 'INTERNAL' as const, message: 'boom' } })),
    })
    const store = createProjectsStore(() => api)
    await store.getState().load()
    expect(store.getState().error).toBe('boom')
    await expect(store.getState().create({ name: '', frameType: 'quad-x' })).rejects.toThrow('Name is required')
    expect(store.getState().projects).toEqual([])
  })
})

const engineAt = (state: EngineStatus['state'], revision: number) => ({ state, revision }) as EngineStatus

describe('system store', () => {
  it('applies pushed engine status after refresh', async () => {
    const store = createSystemStore(() => fakeApi())
    await store.getState().refresh()
    expect(store.getState().engine?.state).toBe('starting')
    store.getState().applyEngineStatus(engineAt('connected', 2))
    expect(store.getState().engine?.state).toBe('connected')
  })

  it('never lets an older snapshot overwrite a newer push', async () => {
    const api = fakeApi()
    // The snapshot was taken at revision 3, but a push at revision 5 arrived first.
    api.system.status = vi.fn(async () => ({
      ok: true as const,
      data: { engine: engineAt('restarting', 3) } as SystemStatus,
    }))
    const store = createSystemStore(() => api)
    store.getState().applyEngineStatus(engineAt('failed', 5))
    await store.getState().refresh()
    expect(store.getState().engine).toMatchObject({ state: 'failed', revision: 5 })
  })
})
