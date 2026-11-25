import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ComponentType } from 'react'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DesktopApiWithRecordings, RecordingHeader, RecordingSampleQuery, RecordingSummary } from '../../electron/ipc/contract'
import { parseReportRequests, readReport, type ReportData } from '../../src/features/telemetry/report/report-data'

const motors = [1, 2, 3, 4].map((number) => ({
  partId: 'm' + number, position: [0.12, 0, 0], thrustAxis: [0, 0, 1], spin: number % 2 ? 'cw' : 'ccw',
}))
const propulsion = {
  version: 1,
  motors: motors.map(({ partId }) => ({
    partId, kvRadPerSV: 80 * Math.PI / 3, resistanceOhm: 0.12, noLoadCurrentA: 1,
    thrustCoefNs2: 0.000012345678, torqueCoefNms2: 0.000001, inertiaKgM2: 0.00002,
    referenceDensityKgM3: 1.2, throttleMap: [[0.5, 0.493]],
  })),
  battery: { openCircuitVoltageV: 16.8, internalResistanceOhm: 0.09, capacityC: 7200 },
}
const load = {
  id: 1, type: 'vehicle.load', vehicle: { totalMassKg: 2, motors }, propulsion,
  aero: { cdBody: [0.7, 0.8, 0.9], areaM2: [0.01, 0.02, 0.03] },
}
const config = { airDensityKgM3: 1.2, cutoff: { type: 'voltageV', value: 12 }, gains: { MC_ROLL_P: 7 } }
const environment = { ground: { friction: 0.5, restitution: 0.1 }, obstacles: [] }
const header: RecordingHeader = {
  runId: '00000000-0000-4000-8000-000000000000', projectId: '00000000-0000-4000-8000-000000000001',
  projectName: 'Survey fixture', title: 'Crosswind fixture', kind: 'flight', startedAt: '2026-01-01T00:00:00Z',
  appVersion: 'test-app', engineVersion: 'test-engine', protocolVersion: 1, firstSampleStep: 0,
  samplePeriodSteps: 1, stepLengthS: 1, vehicleLoad: JSON.stringify(load),
  startRequest: JSON.stringify({ id: 2, type: 'flight.session.start', ...config, environment, controller: { mode: 'position', thrustModelFactor: 0.4 } }),
  channels: [
    { name: 'pack.voltage', label: 'Pack terminal voltage', unit: 'V' },
    { name: 'pack.current', label: 'Pack current', unit: 'A' },
    ...motors.map((_, index) => ({ name: 'motor.' + index + '.command', label: 'Motor ' + (index + 1), unit: '1' as const })),
  ],
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
      turbulence: { seed: 3 }, sensors: extra.sensors, environment: extra.environment,
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
    readRequests: vi.fn(async () => ({ ok: true as const, data: { lines: [], integrityError: null } })),
    totalSize: vi.fn(async () => ({ ok: true as const, data: 0 })),
    printReportPdf: vi.fn(async () => ({ ok: true as const, data: null })),
    readSamples: vi.fn(async ({ channels, fromS, toS }: RecordingSampleQuery) => ({
      ok: true as const, data: { integrityError: null, series: channels.map((channel) => ({
        channel,
        points: Array.from({ length: (toS ?? 0) - (fromS ?? 0) + 1 }, (_, i) => ({
          timeS: i + (fromS ?? 0), value: channel === 'pack.voltage' ? 10 - (i + (fromS ?? 0)) / summary.sampleCount
            : channel.startsWith('motor.') ? 0.5 : 2,
        })),
      })) },
    })),
    exportCsv: vi.fn(async () => ({ ok: true as const, data: null })),
    verify: vi.fn(async () => ({ ok: true as const, data: { status: 'cancelled' as const } })),
    cancelVerify: vi.fn(async () => ({ ok: true as const, data: null })),
    onVerifyProgress: vi.fn(() => () => {}),
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

  it('renders print summaries, one motor metrics table and vector graphs for a normal flight', async () => {
    const html = await rendered(complete)
    const printed = html.replace(/<details class="report-screen-only">.*?<\/details>/gs, '')
    const css = readFileSync(resolve('src/features/telemetry/report/report.css'), 'utf8')
    expect(css.split('@media print')[1]).toMatch(/\.report-screen-only\s*\{\s*display: none;/)
    expect(printed).not.toMatch(/<pre|&quot;(partId|throttleMap)&quot;|Thrust axis/)
    expect(html).toContain('<details class="report-screen-only"><summary>Values as sent to the engine</summary>')
    expect(html).toContain('&quot;thrustCoefNs2&quot;:0.000012345678')
    for (const value of ['Crosswind fixture', 'Survey fixture', 'Stopped', 'test-app', 'test-engine', '0123456789abcdef',
      'Minimum pack voltage', 'Smallest recorded pack terminal voltage.', 'MC_ROLL_P', '0.4', '<svg', 'requests sent to the engine',
      'Motors 1-4', '800', '120', '50 % → 49.3 %', '1.23457e-5', '2000 mAh (7200 C)', '12 V per pack (voltage)',
      'Ground friction', 'Terrain size', 'Time at 0 (s)', 'Time at 1 (s)',
      'The controller uses exact simulated state.']) {
      expect(printed).toContain(value)
    }
    for (const group of ['Flight', 'Tracking', 'Motors', 'Power', 'Air', 'Landing']) {
      expect(printed).toContain('<h3>' + group + '</h3>')
    }
    expect(printed.match(/<caption>Motor commands<\/caption>/g)).toHaveLength(1)
    expect(printed.match(/No paired body-rate setpoint and measurement/g)).toHaveLength(1)
    for (const label of ['Wind', 'Ground effect', 'Sensors']) {
      expect(printed).toContain('>' + label + '</dt><dd><span>None</span>')
    }
    expect(printed).not.toContain('vibration is omitted')
    expect(html).not.toContain('This recording is incomplete')
  })

  it('shows the recorded wind, terrain, gyro feedback and vibration limits', async () => {
    const imu = { noiseSigma: 0.00001, vibrationSigma: null, bias: [0, 0, 0], randomWalk: 0.00003, delaySteps: 2, range: 3 }
    const startRequest = JSON.stringify({
      ...JSON.parse(header.startRequest), cutoff: { type: 'chargeMah', value: 1500 },
      environment: { terrain: { rows: 2, columns: 3, cellSizeM: 4, cornerM: [0, 0],
        heightsM: [0, 0, 0, 0, 0, 0], friction: 0.3, restitution: 0.1 }, obstacles: [] },
      wind: { fromDeg: 90, mean: { kind: 'constant', speedMps: 2 }, gust: { amplitudeMps: 1, lengthM: 5, startS: 1 } },
      groundEffect: null,
      sensors: { seed: 7, gyro: imu, accelerometer: { ...imu, vibrationSigma: 0.1, mountPositionM: [0, 0, 0] },
        barometer: null, gps: null, flyOnGyro: { gyroCutoffHz: 30, dgyroCutoffHz: 20, notch0: null, notch1: null } },
    })
    const html = await rendered({ ...complete, header: { ...header, startRequest } })
    for (const value of ['1500 mAh used from pack (charge)', '3 × 2 samples, 4 m spacing', 'From 90°',
      '1 m/s, length 5 m, starts at 1 s', '>Turbulence</dt><dd><span>None</span>', 'Noise σ 1e-5 rad/s',
      'Rate low-pass 30 Hz', 'the rate loop uses the modelled gyroscope', 'vibration is omitted from the gyroscope model']) {
      expect(html.toLowerCase()).toContain(value.toLowerCase())
    }
    const recordedOnly = JSON.parse(startRequest)
    recordedOnly.sensors.flyOnGyro = null
    recordedOnly.wind.turbulence = { kind: 'dryden', seed: 4 }
    const withoutFeedback = await rendered({ ...complete, header: { ...header, startRequest: JSON.stringify(recordedOnly) } })
    expect(withoutFeedback).toContain('Modelled sensor outputs are recorded only.')
    expect(withoutFeedback).toContain('Dryden, seed 4')
  })

  it('falls back to raw values for malformed or unfamiliar shapes', async () => {
    const vehicleLoad = JSON.stringify({
      ...load, vehicle: { ...load.vehicle, motors: [{ partId: 'm1', thrustAxis: 'future axis' }] },
      propulsion: ['future propulsion'], aero: { coefficients: 'future drag' },
    })
    const startRequest = JSON.stringify({
      ...JSON.parse(header.startRequest), cutoff: { type: 'future cutoff' },
      wind: ['future wind'], groundEffect: 'future effect', sensors: { gyro: 'future gyro' },
    })
    const html = (await rendered({ ...complete, header: { ...header, vehicleLoad, startRequest } }))
      .replace(/<details class="report-screen-only">.*?<\/details>/gs, '')
    expect(html).toContain('<pre')
    for (const field of ['axis', 'propulsion', 'drag', 'cutoff', 'wind', 'effect', 'gyro']) {
      expect(html).toContain('future ' + field)
    }
  })

  it('shows a tilted thrust axis and treats an absent throttle map as ideal', async () => {
    const { throttleMap, ...withoutMap } = propulsion.motors[0]!
    expect(throttleMap).toBeDefined()
    const vehicleLoad = JSON.stringify({
      ...load, vehicle: { ...load.vehicle, motors: [{ ...motors[0], thrustAxis: [0, 0.6, 0.8] }, ...motors.slice(1)] },
      propulsion: { ...propulsion, motors: [withoutMap, ...propulsion.motors.slice(1)] },
    })
    const html = await rendered({ ...complete, header: { ...header, vehicleLoad } })
    expect(html).toContain('Thrust axis')
    expect(html).toContain('(0, 0.6, 0.8)')
    expect(html).toContain('No measured map recorded (ideal ESC)')
    expect(html).toContain('Motors 2-4')
  })

  it('shows a zero reference line for a series that reaches zero', async () => {
    const data = await readReport(apiFor(complete), header.runId, new AbortController().signal)
    data.graphs = [{
      channel: 'pack.current', points: [{ timeS: 0, value: -0.00001 }, { timeS: 1, value: 0.00001 }],
    }]
    const html = await render(data)
    expect(html).toContain('class="report-zero-line"')
    expect(html).toContain('-1e-5')
    expect(await rendered(complete)).not.toContain('class="report-zero-line"')
  })

  it('uses Not recorded when the request line is missing', async () => {
    const html = await rendered({ ...complete, header: { ...header, startRequest: '' } })
    expect(html).toContain('>Conditions</dt><dd><span class="report-muted">Not recorded</span>')
    expect(html).not.toContain('>Wind</dt>')
    expect(html).not.toContain('uses exact simulated state')
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
