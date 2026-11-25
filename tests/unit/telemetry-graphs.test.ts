import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { channelDefinition, describeChannel, groupAxes, isTelemetryLayout, STARTER_LAYOUTS, starterLayout, type PlotChannel, type TelemetryLayout } from '../../src/features/telemetry/layout'
import { alignSamples, comparisonOffset, intersectRanges, livePointIndex, pointAt, recordingRange, sampleQuery, sampleValue, shiftedRange, valueLabel } from '../../src/features/telemetry/samples'
import { createLiveBuffer } from '../../src/features/telemetry/live-buffer'
import { createLiveTelemetry, LIVE_GRAPH_INTERVAL_MS } from '../../src/features/telemetry/use-live-telemetry'
import { replayIndexAt, replayTimeAt, replayWindowAt } from '../../src/features/flight/replay-frame'
import type { RecordingHeader } from '../../electron/ipc/contract'
import { telemetryChannels } from '../../src/domain/telemetry-channels'

let server: ViteDevServer
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), 'blaze-telemetry-render-test'),
    plugins: [react(), {
      name: 'uplot-ssr-stub',
      resolveId: (id) => id === 'uplot' ? '\0telemetry-uplot' : undefined,
      load: (id) => id === '\0telemetry-uplot' ? 'export default class UPlot {}' : undefined,
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
})
afterAll(async () => server?.close())

const pack = telemetryChannels(0, 'flightLoop').filter(({ group }) => group === 'battery').map(describeChannel)
const volts = pack[0]!
const amps = pack[1]!

afterEach(() => vi.unstubAllGlobals())

function readThenAlign(
  ring: readonly Float64Array[], head: number, length: number,
  channels: readonly string[], names: readonly string[], fromS: number,
) {
  const clock = channels.indexOf('time')
  const times = ring[clock]!
  // The former live-buffer read, followed by the unchanged saved-graph alignment.
  return alignSamples(names.filter((name) => channels.includes(name)).map((channel) => {
    const column = channels.indexOf(channel)
    const values = ring[column]!
    const points = []
    for (let i = 0; i < length; i++) {
      const slot = (head + i) % times.length
      const timeS = times[slot]!
      if (timeS >= fromS) points.push({ timeS, value: sampleValue(values[slot]) })
    }
    return { channel, points }
  }))
}

describe('live graph data', () => {
  it.each([1, 2, 4])('matches read and align through wrap at capacity %i', (capacity) => {
    const channels = ['b', 'time', 'a']
    const names = ['a', 'b', 'time']
    const duration = capacity
    const live = createLiveBuffer(duration, capacity)
    const read = live.createReader(names)
    const ring = channels.map(() => new Float64Array(capacity))
    live.begin(channels)
    expect(read().map((column) => Array.from(column))).toEqual([[], [], [], []])
    for (let time = 0; time <= 2 * capacity; time++) {
      const row = [time * 2, time, time <= capacity ? null : time * 3]
      row.forEach((value, column) => { ring[column]![time % capacity] = value ?? NaN })
      live.append([row, [0, time, 0], [0, time - 1, 0], [0, time + 1]])
      const length = Math.min(time + 1, capacity)
      const head = (time + 1 - length) % capacity
      expect(read().map((column) => Array.from(column))).toEqual(readThenAlign(ring, head, length, channels, names, 0))
    }

    const snapshot = read()
    expect(snapshot[1]).toBeInstanceOf(Float64Array)
    expect(snapshot[3]).toBe(snapshot[0])
    const [clock, a, b] = snapshot
    const later = (2 * capacity) + duration + 1
    live.append([[1, later, NaN]])
    expect(read().map((column) => Array.from(column))).toEqual([[later], [null], [1], [later]])
    live.begin(channels)
    live.append([[8, 0, 4]])
    expect(read().map((column) => Array.from(column))).toEqual([[0], [4], [8], [0]])
    expect(read()).toBe(snapshot)
    expect(read()[0].buffer).toBe(clock.buffer)
    expect((read()[1] as Float64Array).buffer).toBe((a as Float64Array).buffer)
    expect((read()[2] as Float64Array).buffer).toBe((b as Float64Array).buffer)
    live.reset()
    expect(read().map((column) => Array.from(column))).toEqual([[], [], [], []])
  })

  it('uses the same cursor lookup as the saved path, including gaps and ties', () => {
    const times = Float64Array.of(2, 4, 8)
    const values = [8, null, 4]
    const points = Array.from(times, (timeS, index) => ({ timeS, value: values[index]! }))
    for (const stepped of [true, false]) {
      for (const time of [1, 2, 3, 4, 6, 7, 8, 9]) {
        expect(sampleValue(values[livePointIndex(times, time, stepped)])).toBe(pointAt(points, time, stepped))
      }
    }
  })

  it('reports one live read before and after for 2501 rows and six series', () => {
    // LiveGraphs.tsx:5–13 supplies the window, row rate, and six body-rate series.
    const duration = 10
    const rate = 250
    const capacity = rate * duration + 1
    const names = telemetryChannels(0, 'attitudeHold').map(({ name }) => name)
      .filter((name) => /^(state\.bodyRates|setpoint\.rates)\./.test(name))
    const channels = ['time', ...names]
    const rows = Array.from({ length: capacity + 1 }, (_, i) => [i / rate, ...names.map((_, j) => i + j)])
    const ring = channels.map((_, column) => Float64Array.from(
      { length: capacity }, (_, slot) => rows[slot || capacity]![column]!,
    ))
    const live = createLiveBuffer(duration, capacity)
    const read = live.createReader(names)
    live.begin(channels)
    live.append(rows)
    expect(read()[0]).toHaveLength(capacity)
    expect(names).toHaveLength(6)
    readThenAlign(ring, 1, capacity, channels, names, 0)
    let start = performance.now()
    const beforeData = readThenAlign(ring, 1, capacity, channels, names, 0)
    const before = performance.now() - start
    start = performance.now()
    const afterData = read()
    const after = performance.now() - start
    console.log(`Live graph read (2501 × 6), read + align before: ${before.toFixed(3)} ms, typed read after: ${after.toFixed(3)} ms`)
    expect(beforeData).toHaveLength(afterData.length)
  })
})

function fakeDrawClock() {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  let frame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle))
  return {
    get frame() { return frame },
    get queuedFrames() { return frames.size },
    runFrame() {
      // Drive a synthetic display with several frames between eligible redraws.
      vi.advanceTimersByTime(LIVE_GRAPH_INTERVAL_MS / 5 - 1)
      frame++
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(performance.now())
    },
    finishFrame: () => vi.advanceTimersByTime(1),
  }
}

describe('live graph scheduling', () => {
  afterEach(() => vi.useRealTimers())

  it('caps each plot, staggers plots, and drains the final samples after the producer stops', () => {
    const clock = fakeDrawClock()
    const live = createLiveTelemetry(10, 4)
    const draws: { plot: number; frame: number; time: number; latest?: number }[] = []
    const subscriptions = [0, 1, 2].map((plot) => {
      const read = live.source.createReader(['a'])
      const subscription = live.source.subscribe(() => {
        draws.push({ plot, frame: clock.frame, time: performance.now(), latest: read()[0].at(-1) })
      })
      subscription.setVisible(true)
      return subscription
    })
    live.begin(['time', 'a'])
    for (let row = 0; row < 20; row++) {
      live.append([[row, row]])
      const count = draws.length
      clock.runFrame()
      expect(draws).toHaveLength(count)
      clock.finishFrame()
    }
    for (let frame = 0; frame < 10; frame++) {
      clock.runFrame()
      clock.finishFrame()
    }
    expect(new Set(draws.map(({ frame }) => frame)).size).toBe(draws.length)
    expect(clock.queuedFrames).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    for (let plot = 0; plot < subscriptions.length; plot++) {
      const ownDraws = draws.filter((item) => item.plot === plot)
      expect(ownDraws.length).toBeGreaterThan(1)
      expect(ownDraws.at(-1)?.latest).toBe(19)
      for (let i = 1; i < ownDraws.length; i++) {
        expect(ownDraws[i]!.time - ownDraws[i - 1]!.time).toBeGreaterThanOrEqual(LIVE_GRAPH_INTERVAL_MS)
      }
      subscriptions[plot]!.unsubscribe()
    }
  })

  it.each(['frame', 'after-frame', 'cooldown'] as const)('cancels pending %s work on unsubscribe', (stage) => {
    const clock = fakeDrawClock()
    const live = createLiveTelemetry(10, 4)
    const draw = vi.fn()
    const subscription = live.source.subscribe(draw)
    subscription.setVisible(true)
    if (stage !== 'frame') clock.runFrame()
    if (stage === 'cooldown') {
      clock.finishFrame()
      live.begin(['time', 'a'])
    }
    subscription.unsubscribe()
    expect(clock.queuedFrames).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    live.append([[1, 1]])
    clock.runFrame()
    clock.finishFrame()
    expect(draw).toHaveBeenCalledTimes(stage === 'cooldown' ? 1 : 0)
  })

  it('draws only visible subscriptions and picks up the latest data when shown', () => {
    const clock = fakeDrawClock()
    const live = createLiveTelemetry(10, 4)
    const read = live.source.createReader(['a'])
    const draw = vi.fn(() => read()[0].at(-1))
    const subscription = live.source.subscribe(draw)
    subscription.setVisible(true)
    subscription.setVisible(false)
    live.begin(['time', 'a'])
    live.append([[1, 7]])
    expect(clock.queuedFrames).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    subscription.setVisible(true)
    clock.runFrame()
    clock.finishFrame()
    expect(draw).toHaveReturnedWith(1)
    subscription.unsubscribe()
  })
})

describe('telemetry layouts', () => {
  it('groups y axes in first use order by unit', () => {
    const secondVoltage = { ...volts, name: 'second.voltage' }
    expect([...groupAxes([volts, amps, secondVoltage])]).toEqual([
      ['V', [volts, secondVoltage]], ['A', [amps]],
    ])
  })

  it('validates all starters and populates the motors present in the run', () => {
    const available = telemetryChannels(2, 'flightLoop').map(describeChannel)
    STARTER_LAYOUTS.forEach((_, index) => expect(isTelemetryLayout(starterLayout(index, available))).toBe(true))
    expect(starterLayout(2, available).graphs[0]?.channels).toEqual(['motor.0.throttle', 'motor.1.throttle'])
    expect(channelDefinition('motor.31.groundEffectStatus')?.kind).toBe('enum')
  })

  it('rejects malformed layouts, repeated ids/channels and three known units', () => {
    const graph = { id: 'supply', channels: [volts.name, amps.name] }
    expect(isTelemetryLayout({ graphs: [graph] })).toBe(true)
    expect(isTelemetryLayout({ graphs: [{ ...graph, channels: [volts.name, 'future.signal'] }] })).toBe(true)
    expect(isTelemetryLayout({ graphs: [graph, graph] })).toBe(false)
    expect(isTelemetryLayout({ graphs: [{ ...graph, channels: pack.map(({ name }) => name) }] })).toBe(false)
    expect(isTelemetryLayout({ graphs: [{ ...graph, channels: [volts.name, volts.name] }] })).toBe(false)
    expect(isTelemetryLayout({ graphs: [{ ...graph, channels: [null] }] })).toBe(false)
    expect(isTelemetryLayout({ graphs: 'broken' })).toBe(false)
  })

  it('round-trips a view preference and handles bad JSON and invalid layouts', async () => {
    const { readTelemetryLayout, writeTelemetryLayout } = await server.ssrLoadModule('/src/lib/prefs.ts') as {
      readTelemetryLayout: () => TelemetryLayout | undefined
      writeTelemetryLayout: (layout: TelemetryLayout) => void
    }
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) } })
    expect(readTelemetryLayout()).toBeUndefined()
    const layout = starterLayout(0, [])
    writeTelemetryLayout(layout)
    expect(readTelemetryLayout()).toEqual(layout)
    const [key] = storage.keys()
    storage.set(key!, '{')
    expect(readTelemetryLayout()).toBeUndefined()
    storage.set(key!, '{"graphs":true}')
    expect(readTelemetryLayout()).toBeUndefined()
  })
})

describe('telemetry samples', () => {
  it('separates gaps from timestamps belonging to another decimated series', () => {
    const points = [{ timeS: 0, value: 4 }, { timeS: 2, value: null }, { timeS: 3, value: NaN }, { timeS: 4, value: 8 }]
    expect(alignSamples([{ channel: 'a', points }, { channel: 'b', points: [{ timeS: 1, value: 9 }] }]))
      .toEqual([[0, 1, 2, 3, 4], [4, undefined, null, null, 8], [undefined, 9, undefined, undefined, undefined]])
    expect(pointAt(points, 1.5, false)).toBeNull()
    expect(pointAt(points, 1.5, true)).toBe(4)
    expect(pointAt(points, 2.5, true)).toBeNull()
    expect(pointAt(points, 5, false)).toBeNull()
  })

  it('formats engine enum codes and flags', () => {
    expect(valueLabel(describeChannel(channelDefinition('controller.mode')!), 4)).toBe('position')
    expect(valueLabel(describeChannel(channelDefinition('state.groundContact')!), 0)).toBe('False')
    expect(valueLabel(describeChannel(channelDefinition('state.groundContact')!), 1)).toBe('True')
  })

  it('derives range from the sample clock and uses whole CSS pixels for the budget', () => {
    const header = { firstSampleStep: 4, samplePeriodSteps: 4, stepLengthS: 0.001 } as RecordingHeader
    expect(recordingRange(header, 0)).toBeUndefined()
    expect(recordingRange(header, 2)).toEqual({ fromS: 0.004, toS: 0.008 })
    expect(sampleQuery('run', ['a', 'a'], 420.9)).toEqual({ id: 'run', channels: ['a'], maxPoints: 420 })
    expect(sampleQuery('run', ['a', 'b'], 420, { fromS: 1, toS: 2 }))
      .toEqual({ id: 'run', channels: ['a', 'b'], maxPoints: 420, fromS: 1, toS: 2 })
    expect(sampleQuery('run', ['a'], 0)).toBeUndefined()
    expect(sampleQuery('run', [], 20)).toBeUndefined()
    expect(sampleQuery('run', ['a'], 20, { fromS: 3, toS: 2 })).toBeUndefined()
    expect(sampleQuery('run', ['a'], 20, { fromS: 1, toS: Infinity })).toBeUndefined()
  })

  it('holds the previous replay sample and maps exact edges across bounded windows', () => {
    const header = { firstSampleStep: 4, samplePeriodSteps: 4, stepLengthS: 0.001 } as RecordingHeader
    expect(replayIndexAt(header, 501, 0)).toBe(0)
    expect(replayIndexAt(header, 501, 1.003)).toBe(249)
    expect(replayIndexAt(header, 501, replayTimeAt(header, 250))).toBe(250)
    expect(replayIndexAt(header, 501, 3)).toBe(500)
    expect(replayWindowAt(header, 501, 249)).toEqual({ first: 0, fromS: 0.004, toS: 1 })
    expect(replayWindowAt(header, 501, 250)).toEqual({ first: 250, fromS: 1.004, toS: 2 })
    expect(replayWindowAt(header, 501, 500)).toEqual({ first: 500, fromS: 2.004, toS: 2.004 })
  })

  it('aligns starts and selected moments and maps a negative visible range back to the comparison file', () => {
    const primary = { fromS: 0, toS: 3 }
    const comparison = { fromS: 0.5, toS: 4.5 }
    expect(shiftedRange(comparison, comparisonOffset(primary, comparison))).toEqual({ fromS: 0, toS: 4 })
    const offset = comparisonOffset(primary, comparison, { primaryS: 1, comparisonS: 3 })
    expect(shiftedRange(comparison, offset)).toEqual({ fromS: -1.5, toS: 2.5 })
    expect(intersectRanges(shiftedRange({ fromS: -2, toS: 1 }, -offset), comparison)).toEqual({ fromS: 0.5, toS: 3 })
  })
})

it('SSR renders the page, keyboard-reachable graph, and grouped picker with missing channels', async () => {
  const [page, graphModule, pickerModule] = await Promise.all([
    server.ssrLoadModule('/src/features/telemetry/TelemetryPage.tsx'),
    server.ssrLoadModule('/src/features/telemetry/TelemetryGraph.tsx'),
    server.ssrLoadModule('/src/features/telemetry/ChannelPicker.tsx'),
  ])
  const TelemetryPage = page.default as ComponentType
  const { createGraphCursor, TelemetryGraph } = graphModule as {
    createGraphCursor: () => unknown
    TelemetryGraph: ComponentType<{ title: string; channels: PlotChannel[]; cursor: unknown; onZoom: () => void }>
  }
  const ChannelPicker = pickerModule.ChannelPicker as ComponentType<{
    available: PlotChannel[]; selected: string[]; onChange: () => void
  }>
  expect(renderToStaticMarkup(createElement(TelemetryPage))).toContain('Total on disk')
  const graph = renderToStaticMarkup(createElement(TelemetryGraph, {
    title: 'Supply', channels: pack.slice(0, 2), cursor: createGraphCursor(), onZoom: vi.fn(),
  }))
  expect(graph).toContain('tabindex="0"')
  expect(graph).toContain('Reset zoom')
  expect(graph).toContain('Pack terminal voltage (V)')
  const picker = renderToStaticMarkup(createElement(ChannelPicker, {
    available: pack, selected: [volts.name, 'future.signal'], onChange: vi.fn(),
  }))
  expect(picker).toContain('<optgroup label="Battery">')
  expect(picker).toContain('Pack current (A)')
  expect(picker).toContain('future.signal (not in this run)')
})
