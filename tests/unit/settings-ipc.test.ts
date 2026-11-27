import { expect, it, vi } from 'vitest'
import { createDataOverviewHandler } from '../../electron/ipc/handlers'

it('reads disk usage and allows only the two fixed open targets', async () => {
  const overview = { path: 'userData', databaseBytes: 512, modelBytes: 64, terrainBytes: 128 }
  const read = vi.fn(async () => overview)
  const open = vi.fn(async () => {})
  const handle = createDataOverviewHandler({ read, open })

  expect(await handle('read')).toEqual({ ok: true, data: overview })
  expect(await handle('open-folder')).toEqual({ ok: true, data: null })
  expect(await handle('open-notices')).toEqual({ ok: true, data: null })
  for (const payload of [undefined, 'C:\\arbitrary.txt', { action: 'open-folder', path: 'arbitrary.txt' }]) {
    expect(await handle(payload)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  }
  expect(read).toHaveBeenCalledTimes(1)
  expect(open.mock.calls).toEqual([['open-folder'], ['open-notices']])
})

it('returns a readable error if the shell cannot open a target', async () => {
  const handle = createDataOverviewHandler({
    read: async () => { throw new Error('The data folder is inaccessible.') },
    open: async () => { throw new Error('No application is associated with this file.') },
  })
  expect(await handle('open-notices')).toMatchObject({
    ok: false, error: { message: 'No application is associated with this file.' },
  })
  expect(await handle('read')).toMatchObject({
    ok: false, error: { message: 'The data folder is inaccessible.' },
  })
})
