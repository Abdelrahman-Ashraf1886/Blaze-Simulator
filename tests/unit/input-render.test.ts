import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { STANDARD_AXES, type DeviceCalibration } from '../../src/features/input/calibration'
import type { createGamepadService } from '../../src/features/input/gamepads'

const endpoints = { min: -1, trim: 0, max: 1, reverse: false, deadZone: 0 }
const calibration: DeviceCalibration = {
  forward: { ...endpoints, axis: STANDARD_AXES.forward },
  right: { ...endpoints, axis: STANDARD_AXES.right },
  yawRight: { ...endpoints, axis: STANDARD_AXES.yawRight },
  throttle: { ...endpoints, axis: STANDARD_AXES.throttle },
}

let server: ViteDevServer
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-input-render-test'),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
})
afterEach(() => vi.unstubAllGlobals())
afterAll(async () => server?.close())

it('renders the input page without browser globals', async () => {
  const { InputPage } = await server.ssrLoadModule('/src/features/input/InputPage.tsx') as { InputPage: ComponentType }
  const html = renderToStaticMarkup(createElement(InputPage))
  for (const text of ['Input devices', 'Connected devices', 'press a button', 'No input devices detected.', 'Select a device to calibrate it.']) {
    expect(html).toContain(text)
  }
})

async function loadPrefs() {
  const values = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
  vi.stubGlobal('window', { localStorage })
  const prefs = await server.ssrLoadModule('/src/lib/prefs.ts') as {
    readInputCalibration: (id: string) => { status: string; calibration?: DeviceCalibration }
    writeInputCalibration: (id: string, value: DeviceCalibration) => boolean
  }
  return { prefs, values, localStorage }
}

it('round trips calibration per device ID and rejects unreadable, invalid and malformed storage', async () => {
  const { prefs, values } = await loadPrefs()
  const { readInputCalibration: read, writeInputCalibration: write } = prefs
  expect(read('Radio')).toEqual({ status: 'missing' })
  expect(write('Radio', calibration)).toBe(true)
  expect(write('Pad', { ...calibration, forward: { ...calibration.forward, reverse: true } })).toBe(true)
  expect(read('Radio')).toEqual({ status: 'saved', calibration })
  expect(read('Pad').calibration?.forward.reverse).toBe(true)
  const key = [...values.keys()].find((item) => item.endsWith('Radio'))!
  for (const corrupt of ['{', 'null', '{}', JSON.stringify({ ...calibration, forward: { ...calibration.forward, trim: 2 } }),
    JSON.stringify({ ...calibration, throttle: calibration.forward })]) {
    values.set(key, corrupt)
    expect(read('Radio')).toEqual({ status: 'invalid' })
  }
  vi.stubGlobal('window', { get localStorage() { throw new Error('unavailable') } })
  expect(read('Radio')).toEqual({ status: 'unavailable' })
  expect(write('Radio', calibration)).toBe(false)
})

it('gives flight consumers mapped sticks, blur, and disconnect for the selected connection', async () => {
  const { localStorage, prefs } = await loadPrefs()
  const pad = { id: 'Radio', index: 0, connected: true, mapping: 'standard', axes: [1, -1, 1, -1], buttons: [] }
  const otherPad = { ...pad, index: 1 }
  let pads = [pad, otherPad]
  let frame: (() => void) | undefined
  type Listener = (event?: { gamepad: typeof pad }) => void
  const events = new Map<string, Listener>()
  vi.stubGlobal('navigator', { getGamepads: () => pads })
  vi.stubGlobal('window', {
    localStorage,
    requestAnimationFrame: (callback: () => void) => { frame = callback; return 1 },
    cancelAnimationFrame: () => { frame = undefined },
    addEventListener: (event: string, listener: Listener) => events.set(event, listener),
    removeEventListener: (event: string) => events.delete(event),
  })
  const { gamepads, getCalibratedInput, subscribeCalibratedInput, createLiveCalibratedInputReader } = await server.ssrLoadModule('/src/features/input/device-input.ts') as {
    gamepads: ReturnType<typeof createGamepadService>
    getCalibratedInput: (handle: ReturnType<ReturnType<typeof createGamepadService>['getDevices']>[number]) => unknown
    subscribeCalibratedInput: (handle: ReturnType<ReturnType<typeof createGamepadService>['getDevices']>[number], listener: ReturnType<typeof vi.fn>) => () => void
    createLiveCalibratedInputReader: (handle: ReturnType<ReturnType<typeof createGamepadService>['getDevices']>[number]) => () => unknown
  }
  const stopPolling = gamepads.subscribe(() => {})
  frame?.()
  const handle = gamepads.getDevices()[0]!
  expect(getCalibratedInput(handle)).toEqual({ connected: true, sticks: null })
  prefs.writeInputCalibration('Radio', calibration)
  const sticks = { forward: 1, right: 1, yawRight: 1, throttle: 1 }
  expect(getCalibratedInput(handle)).toEqual({ connected: true, sticks })
  const readLive = createLiveCalibratedInputReader(handle)
  expect(readLive()).toEqual({ connected: true, sticks })
  pads = [{ ...pad, axes: [0.5, -0.75, 0.25, 0] }, otherPad]
  expect(readLive()).toEqual({ connected: true, sticks: { forward: 0, right: 0.25, yawRight: 0.5, throttle: 0.75 } })
  pads = [{ ...pad, axes: [] }, otherPad]
  expect(readLive()).toEqual({ connected: true, sticks: null })
  const listener = vi.fn()
  const stop = subscribeCalibratedInput(handle, listener)
  events.get('blur')?.()
  expect(listener).toHaveBeenLastCalledWith('blur', { connected: true, sticks })
  pads = [otherPad]
  events.get('gamepaddisconnected')?.({ gamepad: pad })
  expect(listener).toHaveBeenLastCalledWith('disconnect', { connected: false, sticks: null })
  expect(getCalibratedInput(handle)).toEqual({ connected: false, sticks: null })
  expect(readLive()).toEqual({ connected: false, sticks: null })
  pads = [pad, otherPad]
  expect(readLive()).toEqual({ connected: true, sticks })
  stop()
  stopPolling()
  expect(events.size).toBe(0)
})
