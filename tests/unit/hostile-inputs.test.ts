import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Channels, MAX_ASSET_BYTES } from '../../electron/ipc/contract'
import { createIpcGuard, ipcPayloadWithinBudget } from '../../electron/ipc/handlers'
import { readBoundedFile, readBoundedFileSync } from '../../electron/main/assets/bounded-file'
import { inspectGltf, MAX_SCENE_WORK } from '../../electron/main/assets/gltf'
import { inspectModel, MAX_INPUT_VERTICES } from '../../electron/main/assets/hull'
import { importPackFile, MAX_PACK_BYTES, parsePack } from '../../electron/main/components/pack'
import { parseEngineReply, watchEngineLines } from '../../electron/main/engine/supervisor'
import { readGpuPreference } from '../../electron/main/gpu-preference'
import { writeConfirmedFile } from '../../electron/main/screenshot'
import { resolveAssetUrl } from '../../electron/main/assets/store'
import { RecordingReader } from '../../electron/main/telemetry/reader'
import { validateRecordedRequest } from '../../electron/main/telemetry/verify'
import { telemetryCsv } from '../../src/domain/telemetry-csv'
import { parseAsciiGrid } from '../../src/domain/terrain'

const hostile = (name: string) => join(import.meta.dirname, '../fixtures/hostile', name)
const read = (name: string) => readFile(hostile(name), 'utf8')

describe('hostile assets and preferences', () => {
  it.each([
    ['cycle.gltf', /cycle/],
    ['repeated-parent.gltf', /repeated parents/],
    ['repeated-root.gltf', /repeated roots/],
  ])('rejects the hierarchy in %s', async (name, message) => {
    const bytes = await readFile(hostile(name))
    expect(() => inspectGltf(bytes, name)).toThrow(message)
  })

  it('charges primitive visits for every instance of a mesh', async () => {
    const model = JSON.parse(await read('repeated-root.gltf'))
    const side = Math.ceil(Math.sqrt(MAX_SCENE_WORK))
    model.nodes = Array.from({ length: side }, () => ({ mesh: 0 }))
    model.scenes[0].nodes = model.nodes.map((_: unknown, index: number) => index)
    model.meshes[0].primitives = Array.from({ length: side }, () => model.meshes[0].primitives[0])
    expect(() => inspectGltf(Buffer.from(JSON.stringify(model)), 'budget.gltf')).toThrow(/traversal budget/)
  })

  it('checks accessor spans and aggregate vertices before building model geometry', async () => {
    const accessor = await readFile(hostile('invalid-accessor.gltf'))
    expect(() => inspectModel(accessor, 'invalid.gltf')).toThrow(/decoded byte budget/)
    const model = JSON.parse(await read('repeated-root.gltf'))
    model.scenes[0].nodes = [0]
    model.meshes[0].primitives.push(model.meshes[0].primitives[0])
    model.accessors[0].count = Math.floor(MAX_INPUT_VERTICES / 2) + 1
    expect(() => inspectModel(Buffer.from(JSON.stringify(model)), 'budget.gltf')).toThrow(/input vertex budget/)
  })

  it('rejects an oversized terrain header before reporting the incomplete body', async () => {
    expect(parseAsciiGrid(await read('oversized.asc'), 'm')).toEqual({ ok: false, reason: 'grid-too-large' })
  })

  it('checks pack nesting and rejects a non-string diagnostic name through validation', async () => {
    const deep = await read('deep-pack.json')
    expect(() => parsePack(deep)).toThrow(/nested too deeply/)
    const invalidName = '{"format":"blaze-uav.components","version":1,"components":[{"name":{"toString":null}}]}'
    expect(() => parsePack(invalidName)).toThrow(/Entry 1/)
  })

  it('checks the pack size from the file handle before parsing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hostile-pack-'))
    const path = join(dir, 'oversized.json')
    try {
      const file = await open(path, 'wx')
      try {
        await file.truncate(MAX_PACK_BYTES + 1)
      } finally {
        await file.close()
      }
      await expect(importPackFile(undefined as never, path)).rejects.toThrow(/byte limit/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not resolve an asset URL to a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hostile-asset-url-'))
    const id = 'a'.repeat(64)
    try {
      await mkdir(join(dir, id + '.glb'))
      expect(resolveAssetUrl('blaze-asset://model/' + id, dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads regular files within their cap and falls back on oversized preferences', async () => {
    const path = hostile('oversized-graphics.json')
    const actual = await readFile(path)
    expect(readBoundedFileSync(path, actual.length)).toEqual(actual)
    await expect(readBoundedFile(path, actual.length - 1)).rejects.toThrow(/byte limit/)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readGpuPreference(path)).toBe('high-performance')
      expect(warning).toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})

describe('recordings and engine pipes', () => {
  it('rejects an oversized declaration before allocating or accepting a truncated tail', async () => {
    await expect(new RecordingReader(hostile('oversized-frame.blzr')).summary()).rejects.toThrow(/frame exceeds its byte limit/)
  })

  it('applies the live Zod schema to recorded flight steps', async () => {
    const line = await read('invalid-replay.ndjson')
    expect(() => validateRecordedRequest(line, 'flight.session.step')).toThrow(/Invalid recorded/)
    expect(validateRecordedRequest(line.replace('101', '100'), 'flight.session.step')).toBe(1)
  })

  it('validates success and error envelopes and safe integer IDs', async () => {
    const line = await read('malformed-reply.ndjson')
    expect(() => parseEngineReply(line)).toThrow()
    expect(() => parseEngineReply('{"id":1,"ok":true}')).toThrow()
    expect(() => parseEngineReply('{"id":9007199254740992,"ok":true,"result":{}}')).toThrow()
    expect(parseEngineReply('{"id":1,"ok":true,"result":{}}')).toEqual({ id: 1, ok: true, result: {} })
  })

  it('caps bytes before a newline or decoding, including across chunks', () => {
    const stream = new PassThrough()
    const accept = vi.fn()
    const fail = vi.fn()
    watchEngineLines(stream, 4, accept, fail)
    const utf8 = Buffer.from('??\n', 'utf8')
    stream.write(utf8.subarray(0, 1))
    stream.write(utf8.subarray(1))
    expect(accept).toHaveBeenCalledWith('??')
    stream.write(Buffer.from('abcd'))
    stream.write(Buffer.from('e'))
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/exceeds 4 bytes/) }))
    expect(accept).toHaveBeenCalledTimes(1)
    stream.end()
  })

  it('prefixes every formula-like channel and preserves normal CSV headers', async () => {
    const names = JSON.parse(await read('formula-headers.json')) as string[]
    const { header } = telemetryCsv(names.map((name) => ({ name, unit: '' })), {
      title: '', projectName: '', startedAt: '', engineVersion: '', finalStateHash: null, incomplete: false,
    })
    expect(header).toBe("'=1+1 [],'+1 [],'-1 [],'@SUM(A1) [],'\t=2 [],\"'\r=3 []\",motor.0.throttle []\r\n")
  })
})

describe('save and IPC boundaries', () => {
  it('never replaces an unconfirmed suffixed path, even if it appears during writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'confirmed-save-'))
    const selected = join(dir, 'selected')
    const collision = selected + '.png'
    try {
      await writeFile(collision, 'existing')
      const write = vi.fn()
      await expect(writeConfirmedFile(selected, '.png', write)).rejects.toThrow(/already exists/)
      expect(write).not.toHaveBeenCalled()
      await rm(collision)
      await expect(writeConfirmedFile(selected, '.png', async (temp) => {
        await writeFile(temp, 'new')
        await writeFile(collision, 'race')
      })).rejects.toThrow(/already exists/)
      expect(await readFile(collision, 'utf8')).toBe('race')
      await expect(writeConfirmedFile(collision, '.png', (temp) => writeFile(temp, 'confirmed'))).resolves.toBe(collision)
      expect(await readFile(collision, 'utf8')).toBe('confirmed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('guards sender, frame, document, payload and engine or verify concurrency', async () => {
    const frame = { url: 'file:///trusted/index.html#/route' }
    const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const guard = createIpcGuard(() => contents, new URL(frame.url))
    const handler = vi.fn(async () => ({ ok: true }))
    const guarded = guard.handle(Channels.graphicsStatus, handler)
    await expect(guarded({ ...event, sender: {} as WebContents })).resolves.toMatchObject({ ok: false })
    await expect(guarded({ ...event, senderFrame: { ...frame } as unknown as typeof event.senderFrame })).resolves.toMatchObject({ ok: false })
    frame.url = 'file:///other/index.html'
    await expect(guarded(event)).resolves.toMatchObject({ ok: false })
    frame.url = 'file:///trusted/index.html#/next'
    await expect(guarded(event, MAX_ASSET_BYTES, true)).resolves.toMatchObject({ ok: false })
    const syncListener = vi.fn()
    const sync = guard.on(Channels.assemblySaveSync, syncListener)
    const untrusted = { ...event, senderFrame: null } as unknown as IpcMainEvent
    sync(untrusted)
    expect(untrusted.returnValue).toMatchObject({ ok: false })
    expect(syncListener).not.toHaveBeenCalled()
    const cyclic: { self?: object } = {}
    cyclic.self = cyclic
    await expect(guarded(event, cyclic)).resolves.toMatchObject({ ok: false })
    expect(ipcPayloadWithinBudget({ bytes: new Uint8Array(16) }, 16)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const engine = guard.handle(Channels.engineFlightStart, () => held)
    const step = guard.handle(Channels.engineFlightStep, handler)
    const verify = guard.handle(Channels.recordingVerify, () => held)
    const active = [engine(event), verify(event)]
    await expect(step(event)).resolves.toMatchObject({ ok: false })
    await expect(verify(event)).resolves.toMatchObject({ ok: false })
    release()
    await Promise.all(active)
    await expect(step(event)).resolves.toEqual({ ok: true })
  })
})
