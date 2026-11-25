import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createElement, type ComponentType } from 'react'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DesktopApiWithRecordings, RecordingHeader, RecordingSampleQuery, RecordingSummary } from '../../electron/ipc/contract'
import { parseReportRequests, readReport, type ReportData } from '../../src/features/telemetry/report/report-data'

const load = { id: 1, type: 'vehicle.load', vehicle: { totalMassKg: 2, motors: [{ partId: 'm1' }] }, aero: { areaM2: [1, 2, 3] } }
const config = { airDensityKgM3: 1.2, cutoff: { type: 'voltageV', value: 10 }, gains: { MC_ROLL_P: 7 } }
const header: RecordingHeader = {
  runId: '00000000-0000-4000-8000-000000000000', projectId: '00000000-0000-4000-8000-000000000001',
  projectName: 'Survey fixture', title: 'Crosswind fixture', kind: 'flight', startedAt: '2026-01-01T00:00:00Z',
  appVersion: 'test-app', engineVersion: 'test-engine', protocolVersion: 1, firstSampleStep: 0,
  samplePeriodSteps: 1, stepLengthS: 1, vehicleLoad: JSON.stringify(load),
  startRequest: JSON.stringify({ id: 2, type: 'flight.session.start', ...config, controller: { mode: 'position', thrustModelFactor: 0.4 } }),
  channels: [{ name: 'pack.voltage', label: 'Pack terminal voltage', unit: 'V' }],
}

describe('recorded requests', () => {
  it('keeps FlightLoop settings, the vehicle request and optional recorded sensor and environment fields', () => {
    const extra = {
      sensors: { gyro: { seed: 7 } },
      wind: { mean: { kind: 'constant', speedMps: 2, headingDeg: 0 }, turbulence: { kind: 'dryden', seed: 3 } },
      groundEffect: [0.2],
      environment: { terrain: { heightsM: [2, 3], cellSizeM: 1 }, obstacles: [] },
    }
    const parsed = parseReportRequests({
      ...header, startRequest: JSON.stringify({ ...JSON.parse(header.startRequest), ...extra }),
    })
    expect(parsed).toMatchObject({
      vehicle: load.vehicle, aero: load.aero, controllerMode: 'FlightLoop · position',
      thrustFactor: 0.4, gains: config.gains, config: { ...config, groundEffect: [0.2] },
      turbulence: { seed: 3 }, sensors: extra.sensors, environment: { terrain: { heightsM: { recordedSampleCount: 2 }, cellSizeM: 1 } },
    })
  })

  it('recognizes attitude hold and keeps the recorded gain-based thrust factor', () => {
    const parsed = parseReportRequests({
      ...header, startRequest: JSON.stringify({ type: 'flight.session.start', ...config, gains: { THR_MDL_FAC: 0 } }),
    })
    expect(parsed).toMatchObject({ controllerMode: 'Attitude hold', thrustFactor: 0, gains: { THR_MDL_FAC: 0 } })
  })

  it('recognizes a scenario and uses the matching engine report when recorded', () => {
    const startRequest = JSON.stringify({ id: 2, type: 'scenario.run', scenario: { type: 'builtin', name: 'wind_hold' }, config })
    const report = {
      name: 'wind_hold', passed: false, checks: [], elapsedS: 1, maxAttitudeErrorDeg: 2, finalAltitudeErrorM: null,
      meanThrottle: [0.5], maxThrottle: [0.6], firstThrottle: [0.4], saturatedFraction: 0, chargeUsedMah: 1,
      endReason: 'duration', finalStateHash: '0123456789abcdef',
    }
    expect(parseReportRequests({ ...header, startRequest })).toMatchObject({
      config, controllerMode: 'FlightLoop · scripted commands', scenarioReport: undefined,
    })
    const response = JSON.stringify({ id: 2, ok: true, result: { report } })
    const wrongResponse = JSON.stringify({ id: 3, ok: true, result: { report } })
    expect(parseReportRequests({ ...header, startRequest }, [wrongResponse]).scenarioReport).toBeUndefined()
    expect(parseReportRequests({ ...header, startRequest }, [wrongResponse, response]).scenarioReport).toEqual(report)
  })

  it('recognizes a step test and its measured rate axis', () => {
    const test = { step: { type: 'rate', axis: 'yaw', amplitudeRadps: 1 }, holdS: 1, durationS: 2, decimationSteps: 4 }
    const startRequest = JSON.stringify({ type: 'stepTest.run', config: { ...config, thrustModelFactor: 0.6 }, test })
    expect(parseReportRequests({ ...header, startRequest })).toMatchObject({
      controllerMode: 'FlightLoop · rate step', rateStepAxis: 'z', test, thrustFactor: 0.6, config,
    })
  })
})

const complete: RecordingSummary = {
  header, end: { status: 'completed', reason: 'Stopped', elapsedS: 3, finalStateHash: '0123456789abcdef', engineError: null },
  bytes: 100, sampleCount: 4, requestCount: 0, incomplete: false, integrityError: null,
}

function apiFor(summary: RecordingSummary) {
  const api: DesktopApiWithRecordings['recording'] = {
    summary: vi.fn(async () => ({ ok: true as const, data: summary })),
    readRequests: vi.fn(async () => ({ ok: true as const, data: [] })),
    totalSize: vi.fn(async () => ({ ok: true as const, data: 0 })),
    printReportPdf: vi.fn(async () => ({ ok: true as const, data: null })),
    readSamples: vi.fn(async ({ channels, fromS, toS }: RecordingSampleQuery) => ({
      ok: true as const, data: channels.map((channel) => ({
        channel,
        points: Array.from({ length: (toS ?? 0) - (fromS ?? 0) + 1 }, (_, i) => ({
          timeS: i + (fromS ?? 0), value: channel === 'pack.voltage' ? 10 - (i + (fromS ?? 0)) / summary.sampleCount : 2,
        })),
      })),
    })),
  }
  return api
}

describe('flight report', () => {
  let server: ViteDevServer
  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      cacheDir: resolve(tmpdir(), 'blaze-report-render-test'),
      plugins: [react()],
      optimizeDeps: { noDiscovery: true, include: [] },
      resolve: { alias: { '@': resolve('src') } },
      server: { middlewareMode: true, hmr: false, watch: null },
    })
  })
  afterAll(async () => server?.close())

  async function render(data: ReportData) {
    const module = await server.ssrLoadModule('/src/features/telemetry/report/ReportPage.tsx')
    const Report = module.FlightReport as ComponentType<{ data: ReportData }>
    return renderToStaticMarkup(createElement(Report, { data }))
  }

  async function rendered(summary: RecordingSummary) {
    return render(await readReport(apiFor(summary), header.runId, new AbortController().signal))
  }

  it('server-renders the recorded facts, metric definitions and vector graphs', async () => {
    const html = await rendered(complete)
    for (const value of ['Crosswind fixture', 'Survey fixture', 'Stopped', 'test-app', 'test-engine', '0123456789abcdef',
      'Minimum pack voltage', 'Smallest recorded pack terminal voltage.', 'MC_ROLL_P', '0.4', '<svg', 'requests sent to the engine']) {
      expect(html).toContain(value)
    }
    expect(html).not.toContain('This recording is incomplete')
  })

  it('server-renders incomplete and damaged notices and an absent scenario report', async () => {
    const html = await rendered({ ...complete, header: { ...header, kind: 'scenario' }, end: null, incomplete: true, integrityError: 'Invalid checksum' })
    expect(html).toContain('This recording is incomplete')
    expect(html).toContain('Recording is damaged. Invalid checksum')
    expect(html).toContain('scenario report was not recorded')
  })

  it('renders a damage notice when the reader cannot recover a summary', async () => {
    const api = apiFor(complete)
    vi.mocked(api.summary).mockResolvedValue({ ok: false, error: { code: 'VALIDATION', message: 'Invalid checksum' } })
    const data = await readReport(api, header.runId, new AbortController().signal)
    expect(await render(data)).toContain('Recording is damaged. Invalid checksum')
    expect(api.readSamples).not.toHaveBeenCalled()
  })

  it('server-renders a minimal recording without nonfinite numeric output', async () => {
    const html = await rendered({ ...complete, header: null, end: null, sampleCount: 0, incomplete: true })
    expect(html).toContain('The recording header is unavailable')
    expect(html).toContain('Not available: No recorded end time or samples')
    expect(html).not.toMatch(/NaN|Infinity/)
  })

  it('keeps the energy interval across bounded raw sample windows', async () => {
    const clock = { ...header, channels: [...header.channels, { name: 'pack.current', label: 'Pack current', unit: 'A' }] }
    const api = apiFor({ ...complete, header: clock, sampleCount: 12, end: null })
    const data = await readReport(api, header.runId, new AbortController().signal)
    expect(api.readSamples).toHaveBeenCalledTimes(3)
    expect(api.readSamples).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromS: 0, toS: 9 }))
    expect(api.readSamples).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromS: 10, toS: 11 }))
    expect(api.readSamples).toHaveBeenNthCalledWith(3, expect.objectContaining({ maxPoints: 880 }))
    // Linear power starts at 20 W and ends at (10 - 11/12) * 2 W.
    expect(data.metrics.find(({ id }) => id === 'energy')?.result).toEqual({ value: expect.closeTo(11 * (20 - 11 / 12)) })
  })
})
