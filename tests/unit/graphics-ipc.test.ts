import { expect, it, vi } from 'vitest'
import { GPU_PREFERENCES, type GraphicsStatus } from '../../electron/ipc/contract'
import { createGraphicsHandlers } from '../../electron/ipc/handlers'

it('accepts an empty status request and validates every graphics command', () => {
  const status: GraphicsStatus = { preference: 'system', startupPreference: 'high-performance', onBattery: true }
  const setPreference = vi.fn()
  const restart = vi.fn()
  const graphics = createGraphicsHandlers({ status: () => status, setPreference, restart })
  const validation = { ok: false, error: { code: 'VALIDATION' } }

  expect(graphics.status(undefined)).toEqual({ ok: true, data: status })
  expect(graphics.status({})).toMatchObject(validation)
  for (const payload of [
    undefined,
    { action: 'set' },
    { action: 'set', preference: 'unsupported' },
    { action: 'set', preference: 'system', restart: true },
    { action: 'restart', preference: 'system' },
    { action: 'quit' },
  ]) {
    expect(graphics.command(payload)).toMatchObject(validation)
  }
  expect(setPreference).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()

  for (const preference of GPU_PREFERENCES) {
    expect(graphics.command({ action: 'set', preference })).toEqual({ ok: true, data: null })
  }
  expect(setPreference.mock.calls).toEqual(GPU_PREFERENCES.map((preference) => [preference]))
  expect(graphics.command({ action: 'restart' })).toEqual({ ok: true, data: null })
  expect(restart).toHaveBeenCalledOnce()
})
