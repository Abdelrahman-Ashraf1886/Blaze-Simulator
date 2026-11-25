import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { channelDefinition, describeChannel, groupAxes, isTelemetryLayout, STARTER_LAYOUTS, starterLayout, type PlotChannel, type TelemetryLayout } from '../../src/features/telemetry/layout'
import { alignSamples, pointAt, recordingRange, sampleQuery, valueLabel } from '../../src/features/telemetry/samples'
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
