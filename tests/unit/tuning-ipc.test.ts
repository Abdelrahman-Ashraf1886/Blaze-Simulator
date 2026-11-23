import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, type DesktopApi, type IpcResult, type TuningSettings } from '../../electron/ipc/contract'
import { createHandlers } from '../../electron/ipc/handlers'
import { openDatabase, type Db } from '../../electron/main/db/database'
import { createRepositories, TuningValidationError } from '../../electron/main/db/repositories'
import { CONTROLLER_PARAMS, controllerParam, effectiveParams } from '../../src/domain/controller-params'

let db: Db
let repos: ReturnType<typeof createRepositories>
let handlers: ReturnType<typeof createHandlers>
let id: string

beforeEach(() => {
  db = openDatabase(':memory:')
  repos = createRepositories(db)
  handlers = createHandlers(repos, () => { throw new Error('System status is unused') })
  id = repos.projects.create({ name: 'Tuning test', frameType: 'quad-x' }).id
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

const call = (channel: string, payload: unknown) => handlers[channel]!(payload) as IpcResult<TuningSettings>
const rows = () => db.prepare('SELECT project_id, param_name, value FROM controller_tuning').all()
// A simulated user edit, derived from the cited default; this is not a new PX4 value.
const overrides = () => ({ MC_ROLL_P: controllerParam('MC_ROLL_P')!.default / 2 })

describe('tuning IPC', () => {
  it('exposes the tuning methods in preload and sends their payloads through the handlers', async () => {
    const invoke = vi.fn(async (channel: string, payload: unknown) => call(channel, payload))
    const expose = vi.fn()
    vi.doMock('electron', () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }))
    try {
      await import('../../electron/preload/index')
      const api = expose.mock.calls[0]![1] as DesktopApi
      expect(expose.mock.calls[0]![0]).toBe('api')
      expect(await api.tuning.set({ id, overrides: overrides() })).toMatchObject({ ok: true, data: { overrides: overrides() } })
      expect(await api.tuning.get(id)).toMatchObject({ ok: true, data: { overrides: overrides() } })
      expect(await api.tuning.reset(id)).toMatchObject({ ok: true, data: { overrides: {} } })
      expect(invoke.mock.calls).toEqual([
        [Channels.tuningSet, { id, overrides: overrides() }],
        [Channels.tuningGet, { id }],
        [Channels.tuningReset, { id }],
      ])
    } finally {
      vi.doUnmock('electron')
    }
  })

  it('returns the cited table and defaults, then round-trips only the supplied overrides', () => {
    expect(call(Channels.tuningGet, { id })).toEqual({
      ok: true, data: { table: CONTROLLER_PARAMS, overrides: {}, effective: effectiveParams() },
    })
    const input = overrides()
    const expected = { ok: true, data: { table: CONTROLLER_PARAMS, overrides: input, effective: effectiveParams(input) } }
    expect(call(Channels.tuningSet, { id, overrides: input })).toEqual(expected)
    expect(call(Channels.tuningGet, { id })).toEqual(expected)
    expect(rows()).toEqual([{ project_id: id, param_name: 'MC_ROLL_P', value: input.MC_ROLL_P }])
    expect(call(Channels.tuningSet, { id, overrides: {} })).toMatchObject({ ok: true, data: { overrides: {}, effective: effectiveParams() } })
    expect(rows()).toEqual([])
    const other = repos.projects.create({ name: 'Other', frameType: 'quad-x' })
    expect(call(Channels.tuningGet, { id: other.id })).toMatchObject({ ok: true, data: { overrides: {} } })
  })

  it('reports every invalid parameter and refuses the entire write at the boundary', () => {
    const set = vi.spyOn(repos.tuning, 'set')
    const result = call(Channels.tuningSet, { id, overrides: {
      ...overrides(),
      NOT_A_PARAM: 1,
      MC_PITCH_P: 'bad',
      MPC_TILTMAX_AIR: controllerParam('MPC_TILTMAX_AIR')!.min! - 1,
    } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected invalid tuning')
    expect(result.error.code).toBe('VALIDATION')
    expect(result.error.errors?.map((e) => e.name).sort()).toEqual(['MC_PITCH_P', 'MPC_TILTMAX_AIR', 'NOT_A_PARAM'])
    expect(set).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })

  it.each([null, [], 'bad', { MC_ROLL_P: NaN }, { MC_ROLL_P: Infinity }, { MC_AIRMODE: 0.5 }])(
    'refuses malformed or non-finite overrides %j without changing saved values', (invalid) => {
      call(Channels.tuningSet, { id, overrides: overrides() })
      const before = rows()
      expect(call(Channels.tuningSet, { id, overrides: invalid })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
      expect(rows()).toEqual(before)
    },
  )

  it('refuses inconsistent effective thrust limits and returns their parameter names', () => {
    const result = call(Channels.tuningSet, { id, overrides: { MPC_THR_MIN: controllerParam('MPC_THR_MAX')!.default } })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION', errors: [
      { name: 'MPC_THR_MIN', related: ['MPC_THR_HOVER', 'MPC_THR_MAX'] },
    ] } })
    expect(rows()).toEqual([])
  })

  it('preserves structured repository validation errors', () => {
    const errors = [{ name: 'MC_ROLL_P', message: 'MC_ROLL_P refused' }]
    vi.spyOn(repos.tuning, 'set').mockImplementation(() => { throw new TuningValidationError(errors) })
    expect(call(Channels.tuningSet, { id, overrides: overrides() })).toMatchObject({ ok: false, error: { code: 'VALIDATION', errors } })
    expect(rows()).toEqual([])
  })

  it('resets to PX4 defaults, clearing only the requested project', () => {
    const other = repos.projects.create({ name: 'Other', frameType: 'quad-x' })
    call(Channels.tuningSet, { id, overrides: overrides() })
    call(Channels.tuningSet, { id: other.id, overrides: overrides() })
    const expected = { ok: true, data: { table: CONTROLLER_PARAMS, overrides: {}, effective: effectiveParams() } }
    expect(call(Channels.tuningReset, { id })).toEqual(expected)
    expect(call(Channels.tuningGet, { id })).toEqual(expected)
    expect(rows()).toHaveLength(1)
    expect(repos.tuning.get(other.id)).toEqual(overrides())
  })

  it.each([Channels.tuningGet, Channels.tuningSet, Channels.tuningReset])('handles unknown projects and invalid ids on %s', (channel) => {
    expect(call(channel, { id: '00000000-0000-4000-8000-000000000000', overrides: {} })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(call(channel, { id: 'invalid', overrides: {} })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(rows()).toEqual([])
  })
})
