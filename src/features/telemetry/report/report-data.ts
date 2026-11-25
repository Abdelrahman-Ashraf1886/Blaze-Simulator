import type { DesktopApiWithRecordings, RecordingHeader, RecordingSeries, RecordingSummary } from '../../../../electron/ipc/contract'
import { BUILTIN_SCENARIO_NAMES, ScenarioReportSchema } from '../../../../electron/main/engine/protocol'
import { createFlightMetrics, flightMetricChannels, type FlightMetric } from '../../../domain/flight-metrics'
import { sampleQuery } from '../samples'

type Fields = Record<string, unknown>
type RecordingApi = DesktopApiWithRecordings['recording']
const rotationAxis = { roll: 'x', pitch: 'y', yaw: 'z' } as const

function fields(value: unknown): Fields | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Fields
}

function parseLine(text: string) {
  try { return fields(JSON.parse(text)) } catch { return undefined }
}

export function parseReportRequests(header: Pick<RecordingHeader, 'vehicleLoad' | 'startRequest'>, requests: readonly string[] = []) {
  const load = parseLine(header.vehicleLoad)
  const start = parseLine(header.startRequest)
  const vehicle = load?.type === 'vehicle.load' ? fields(load.vehicle) : undefined
  const flight = start?.type === 'flight.session.start'
  const scenario = start?.type === 'scenario.run'
  const stepTest = start?.type === 'stepTest.run'
  // protocol.ts:418–435,631–650,715–739. Keep optional fields and values as sent.
  const config = flight ? start : scenario || stepTest ? fields(start.config) : undefined
  const controller = flight ? fields(start.controller) : undefined
  const step = stepTest ? fields(fields(start.test)?.step) : undefined
  const scenarioRequest = scenario ? fields(start.scenario) : undefined
  let controllerMode: string | undefined
  if (flight) {
    // engine-host/src/flight_session.rs:286–307.
    controllerMode = typeof controller?.mode === 'string' ? 'FlightLoop · ' + controller.mode
      : start.controller === undefined ? 'Attitude hold' : undefined
  } else if (step && typeof step.type === 'string') {
    // engine-core/src/step_test.rs:180–198.
    controllerMode = 'FlightLoop · ' + step.type + ' step'
  } else if (scenarioRequest) {
    // engine-host/src/scenario_run.rs:274–291.
    const custom = scenarioRequest.type === 'custom' ? fields(scenarioRequest.scenario) : undefined
    const builtin = scenarioRequest.type === 'builtin' ? BUILTIN_SCENARIO_NAMES.find((name) => name === scenarioRequest.name) : undefined
    if (custom || builtin) {
      const scripted = custom?.flightScript != null || ['wind_hold', 'gust', 'takeoff_hold_land', 'terrain'].some((name) => name === builtin)
      controllerMode = scripted ? 'FlightLoop · scripted commands' : 'Attitude hold'
    }
  }
  // v1 captures requests only (scenario-run.ts:50–57). A recorded response
  // must be a successful engine envelope for this particular start request.
  const scenarioId = scenario ? start.id : undefined
  const scenarioResponse = typeof scenarioId === 'number' ? requests.map(parseLine).find(
    (line) => line && line.id === scenarioId && line.ok === true && fields(line.result)?.report !== undefined,
  ) : undefined
  const scenarioReport = ScenarioReportSchema.safeParse(fields(scenarioResponse?.result)?.report).data
  const gains = fields(config?.gains)
  const wind = fields(config?.wind)
  const environment = fields(config?.environment)
  const terrain = fields(environment?.terrain)
  const surfaces = terrain && Array.isArray(terrain.heightsM)
    ? { ...environment, terrain: { ...terrain, heightsM: { recordedSampleCount: terrain.heightsM.length } } }
    : config?.environment
  const rateStepAxis = step?.type === 'rate' && typeof step.axis === 'string' && Object.hasOwn(rotationAxis, step.axis)
    ? rotationAxis[step.axis as keyof typeof rotationAxis] : undefined
  return {
    vehicle, propulsion: load?.type === 'vehicle.load' ? load.propulsion : undefined,
    aero: load?.type === 'vehicle.load' ? load.aero : undefined,
    config, environment: surfaces, wind, controllerMode, gains, rateStepAxis, scenarioReport,
    thrustFactor: (flight ? controller?.thrustModelFactor : config?.thrustModelFactor) ?? gains?.THR_MDL_FAC,
    turbulence: fields(wind?.turbulence), sensors: config?.sensors, scenarioRequest, test: stepTest ? start.test : undefined,
    airmode: flight ? controller?.airmode : config?.airmode,
    loadMissing: load?.type !== 'vehicle.load', startMissing: config === undefined,
  }
}

export interface ReportData {
  summary: RecordingSummary
  recorded: ReturnType<typeof parseReportRequests>
  metrics: FlightMetric[]
  graphs: RecordingSeries[]
  notices: string[]
}

// SVG nominal width uses the minimum app width in DESIGN.md:45–47, with
// the existing one-point-per-CSS-pixel budget (telemetry/samples.ts:22–24).
export const reportGraphWidth = 880
export const reportPlots = [
  ['Step response', 'stepTest.measured', 'stepTest.setpoint'],
  ['CoM altitude', 'state.com.z', 'setpoint.position.z'],
  ['Vertical speed', 'state.velocity.z'],
  ['Roll rate', 'state.bodyRates.x', 'setpoint.rates.x'],
  ['Pitch rate', 'state.bodyRates.y', 'setpoint.rates.y'],
  ['Yaw rate', 'state.bodyRates.z', 'setpoint.rates.z'],
  ['Pack voltage', 'pack.voltage'],
  ['Pack current', 'pack.current'],
] as const

function reportGraphChannels(header: RecordingHeader) {
  const names = new Set(header.channels.map(({ name }) => name))
  return reportPlots.flatMap(([, ...signals]) => signals.filter((name) => names.has(name)))
}

export async function readReport(api: RecordingApi, id: string, signal: AbortSignal): Promise<ReportData> {
  const result = await api.summary(id)
  signal.throwIfAborted()
  if (!result.ok && result.error.code !== 'VALIDATION') throw new Error('Recording could not be read. ' + result.error.message)
  // The current summary IPC returns a validation error on malformed frames
  // (reader.ts:197–203, handlers.ts:184–185). It has no partial data in that case.
  const summary: RecordingSummary = result.ok ? result.data : {
    header: null, end: null, sampleCount: 0, requestCount: 0, bytes: 0, incomplete: true, integrityError: result.error.message,
  }
  const header = summary.header
  const notices: string[] = []
  let requests: string[] = []
  if (header?.kind === 'scenario' && summary.requestCount) {
    const reply = await api.readRequests(id)
    signal.throwIfAborted()
    if (reply.ok) requests = reply.data
    else notices.push('Recorded requests could not be read. ' + reply.error.message)
  }
  const recorded = parseReportRequests(header ?? { vehicleLoad: '', startRequest: '' }, requests)
  const channels = header?.channels.map(({ name }) => name) ?? []
  const accumulator = createFlightMetrics({ channels, elapsedS: summary.end?.elapsedS, rateStepAxis: recorded.rateStepAxis })
  let graphs: RecordingSeries[] = []
  if (header && summary.sampleCount) {
    const inputs = flightMetricChannels(channels)
    const timeAt = (row: number) => (header.firstSampleStep + row * header.samplePeriodSteps) * header.stepLengthS
    // Bound one raw window to 10 s at the 250 Hz recording rate: about 70 metric
    // channels are 175,000 points per IPC reply.
    const windowS = 10
    const samplesPerSecond = 250
    const rowsPerWindow = Math.max(1, Math.min(windowS * samplesPerSecond,
      Math.floor(windowS / (header.samplePeriodSteps * header.stepLengthS))))
    if (!inputs.length) accumulator.add({ timeS: timeAt(summary.sampleCount - 1), values: {} })
    for (let first = 0; inputs.length && first < summary.sampleCount; first += rowsPerWindow) {
      const stop = Math.min(summary.sampleCount, first + rowsPerWindow)
      const reply = await api.readSamples({ id, channels: inputs, fromS: timeAt(first), toS: timeAt(stop - 1) })
      signal.throwIfAborted()
      if (!reply.ok) {
        notices.push('Metrics cover only the sample windows read successfully. ' + reply.error.message)
        break
      }
      for (let row = 0; row < stop - first; row++) {
        const timeS = timeAt(first + row)
        const values: Record<string, number | null> = {}
        for (const { channel, points } of reply.data) {
          const point = points[row]
          if (point?.timeS === timeS) values[channel] = point.value
        }
        accumulator.add({ timeS, values })
      }
    }
    const query = sampleQuery(id, reportGraphChannels(header), reportGraphWidth, {
      fromS: timeAt(0), toS: timeAt(summary.sampleCount - 1),
    })
    if (query) {
      const reply = await api.readSamples(query)
      signal.throwIfAborted()
      if (reply.ok) graphs = reply.data
      else notices.push('Graph samples could not be read. ' + reply.error.message)
    }
  }
  return { summary, recorded, notices, graphs, metrics: accumulator.results() }
}
