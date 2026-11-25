import { randomUUID } from 'node:crypto'
import type { EngineStatus, RecordingChannel, RecordingEnd, RecordingHeader, RecordingKind, RecordingOptions, RecordingProgress } from '../../ipc/contract'
import { telemetryChannels } from '../../../src/domain/telemetry-channels'
import { MAX_SCENARIO_S, type FlightSessionStartParams, type ScenarioRequest, type StepTestRunParams, type StepTestRunResult } from '../engine/protocol'
import { FLOAT_BYTES, FRAME_BYTES, PREAMBLE_BYTES, ROW_COUNT_BYTES } from './format'
import type { RecordingStore } from './store'
import type { RecordingWriter } from './writer'

/** D11, documentation/plans/phase-7-telemetry.md:47. */
export const RECORD_EVERY_STEPS = 4
// simulation-engine/engine-core/src/sim.rs:28 (also used for scenario and step-test traces).
const STEP_LENGTH_S = 1e-3

type Sampling = Pick<RecordingHeader, 'channels' | 'samplePeriodSteps'> & { bufferedS: number }
type EngineVersion = Pick<EngineStatus, 'engineVersion' | 'protocolVersion'>
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The engine adds sensor channels when at least one sensor is on (engine-core sensors.rs, Sensors::new). */
function hasSensors(sensors: FlightSessionStartParams['sensors']): boolean {
  return sensors != null && (sensors.gyro ?? sensors.accelerometer ?? sensors.barometer ?? sensors.gps) !== null
}

function sampled(sampling: ReturnType<typeof telemetryChannels>, bufferedS: number): Sampling {
  return { channels: sampling.map(({ name, unit, label }) => ({ name, unit, label })), samplePeriodSteps: RECORD_EVERY_STEPS, bufferedS }
}

function scenarioSampling(motors: number, request: ScenarioRequest, sensors: boolean): Sampling {
  // engine-host/src/scenario_run.rs:178-190,239-247,274-291 selects the controller.
  const scripted = request.type === 'custom'
    ? request.scenario.flightScript !== undefined
    : request.name === 'wind_hold' || request.name === 'gust' || request.name === 'takeoff_hold_land' || request.name === 'terrain'
  return sampled(telemetryChannels(motors, scripted ? 'flightLoop' : 'attitudeHold', sensors), MAX_SCENARIO_S)
}

function traceSampling(motors: number, test: StepTestRunParams['test']): Sampling {
  // engine-core/src/trace.rs:16-22,35-39,60-69 and step_test.rs:210-230,266-279.
  const unit = { rate: 'rad/s', attitude: 'rad', altitude: 'm', position: 'm' }[test.step.type]
  const axes = ['x', 'y', 'z', 'w']
  const channels: RecordingChannel[] = [
    { name: 'time', label: 'Simulated time', unit: 's' },
    { name: 'stepTest.setpoint', label: 'Step setpoint', unit },
    { name: 'stepTest.measured', label: 'Measured response', unit },
    ...axes.slice(0, 3).map((axis) => ({ name: `setpoint.rates.${axis}`, label: `Commanded body rate ${axis.toUpperCase()}`, unit: 'rad/s' })),
    ...axes.map((axis) => ({ name: `setpoint.attitude.${axis}`, label: `Commanded attitude ${axis.toUpperCase()}`, unit: '1' })),
    ...Array.from({ length: motors }, (_, i) => ({ name: `motor.${i}.command`, label: `Motor ${i} command`, unit: '1' })),
    ...['positive', 'negative'].flatMap((sign) => ['roll', 'pitch', 'yaw', 'collective'].map((axis) => ({
      name: `controller.saturation.${sign}.${axis}`, label: `${axis} ${sign} saturation`, unit: '1',
    }))),
  ]
  return { channels, samplePeriodSteps: test.decimationSteps, bufferedS: test.durationS }
}

export function traceRows(trace: StepTestRunResult['trace']): (number | null)[][] {
  return trace.samples.map((sample) => {
    const { signal, saturation } = sample
    const values = signal.kind === 'rate' ? [signal.setpointRadps, signal.measuredRadps]
      : signal.kind === 'attitude' ? [signal.setpointRad, signal.measuredRad] : [signal.setpointM, signal.measuredM]
    return [sample.timeS, ...values, ...sample.commandedBodyRatesRadps,
      ...(sample.commandedAttitudeXyzw ?? [null, null, null, null]), ...sample.motorCommands01,
      ...saturation.positive.map(Number), ...saturation.negative.map(Number)]
  })
}

type Store = Pick<RecordingStore, 'start' | 'get'>

export class RunRecording {
  private readonly runId = randomUUID()
  private readonly startedAt = new Date().toISOString()
  private vehicleLoad: string | undefined
  private opening: Promise<void> | undefined
  private writer: RecordingWriter | null = null
  private readonly beforeOpen: ((writer: RecordingWriter) => boolean)[] = []
  private readonly steps = new Set<Promise<unknown>>()
  private startupBytes = 0
  private maxPendingBytes = 0
  private ending: Promise<void> | undefined
  private failure: string | undefined
  private elapsedS = 0
  private finalStateHash: string | null = null

  constructor(
    private readonly store: Store,
    private readonly projectName: (id: string) => string,
    private readonly appVersion: string,
    private readonly version: EngineVersion,
    private readonly kind: RecordingKind,
    private readonly options: RecordingOptions,
    private readonly sampling: Sampling,
    private readonly settled: () => void,
  ) {}

  get live(): boolean { return this.options.live === true }

  readonly captureVehicle = (line: string) => { this.vehicleLoad = line }

  readonly captureStart = (startRequest: string) => {
    if (this.ending) return
    this.opening = this.open(startRequest).then((writer) => {
      this.writer = writer
      if (writer) {
        for (const write of this.beforeOpen) {
          if (!write(writer)) {
            void this.finish('failed', 'Could not flush the recording')
            break
          }
        }
      }
    }, (error: unknown) => { this.failure = message(error) }).finally(() => { this.beforeOpen.length = 0 })
  }

  private async open(startRequest: string) {
    const { engineVersion, protocolVersion } = this.version
    if (!this.vehicleLoad || engineVersion === null || protocolVersion === null) throw new Error('Engine recording metadata is unavailable')
    const { channels, samplePeriodSteps, bufferedS } = this.sampling
    const header: RecordingHeader = {
      runId: this.runId, startedAt: this.startedAt, projectId: this.options.projectId, projectName: this.projectName(this.options.projectId),
      title: this.options.title, kind: this.kind, appVersion: this.appVersion, engineVersion, protocolVersion,
      channels, samplePeriodSteps, stepLengthS: STEP_LENGTH_S, firstSampleStep: 0,
      vehicleLoad: this.vehicleLoad, startRequest,
    }
    // Hold 3 s of flight samples (the app quit budget), or the full engine batch for a scenario
    // or step test. Allow one frame per row for flight and space for the measured header and
    // request text. The header allowance also gives the live request backlog headroom.
    const rows = Math.ceil(bufferedS / STEP_LENGTH_S / samplePeriodSteps) + 1
    this.maxPendingBytes = rows * channels.length * FLOAT_BYTES
      + (this.kind === 'flight' ? rows : 1) * (FRAME_BYTES + ROW_COUNT_BYTES)
      + PREAMBLE_BYTES + FRAME_BYTES + Buffer.byteLength(JSON.stringify(header), 'utf8')
    const writer = await this.store.start(header, { maxPendingBytes: this.maxPendingBytes })
    if (writer === null) {
      const run = await this.store.get(this.runId).catch(() => null)
      this.failure ??= run?.endReason ?? 'Could not open the recording'
    }
    return writer
  }

  readonly captureStep = (line: string) => {
    this.enqueue(() => FRAME_BYTES + Buffer.byteLength(line, 'utf8'), (writer) => writer.appendRequest(line))
  }

  trackStep<T>(request: Promise<T>): Promise<T> {
    this.steps.add(request)
    const settled = () => { this.steps.delete(request) }
    void request.then(settled, settled)
    return request
  }

  async replace() {
    await Promise.allSettled(this.steps)
    await this.finish('aborted', 'replaced by a new start')
  }

  sampled(channels?: string[], rows?: readonly (readonly (number | null)[])[]) {
    if (!channels || channels.length !== this.sampling.channels.length
      || !channels.every((name, i) => name === this.sampling.channels[i]?.name)) {
      this.failure ??= 'Engine recording channels do not match the channel table'
      void this.finish('failed', this.failure)
      return
    }
    this.append(rows)
  }

  async appendBatch(rows: () => (number | null)[][]) {
    await this.opening
    if (this.ending || !this.writer) return
    try {
      this.append(rows())
    } catch (error) {
      this.failure = message(error)
      await this.finish('failed', this.failure)
    }
  }

  append(rows?: readonly (readonly (number | null)[])[]) {
    if (!rows?.length) return
    this.enqueue(() => FRAME_BYTES + ROW_COUNT_BYTES + rows.length * this.sampling.channels.length * FLOAT_BYTES, (writer) => writer.appendSamples(rows))
  }

  private enqueue(bytes: () => number, write: (writer: RecordingWriter) => boolean) {
    if (this.ending || this.failure) return
    if (this.writer) {
      if (!write(this.writer)) void this.finish('failed', 'Could not write the recording')
    } else if (this.opening) {
      // Flight can step while the file opens. Apply the same backlog bound before encoding.
      this.startupBytes += bytes()
      if (this.startupBytes <= this.maxPendingBytes) this.beforeOpen.push(write)
      else {
        this.failure = 'Recording buffer full while opening the file'
        void this.finish('failed', this.failure)
      }
    }
  }

  update(elapsedS: number, stateHash: string) {
    this.elapsedS = elapsedS
    this.finalStateHash = stateHash
  }

  finish(status: RecordingEnd['status'], reason: string, engineError: string | null = null): Promise<void> {
    this.ending ??= this.close({ status, reason, elapsedS: this.elapsedS, finalStateHash: this.finalStateHash, engineError })
    return this.ending
  }

  private async close(end: RecordingEnd) {
    try {
      await this.opening
      if (this.writer) {
        const result = await this.writer.finish(end)
        this.failure ??= result.failure ?? undefined
      }
    } catch (error) {
      this.failure ??= message(error)
    } finally {
      this.settled()
    }
  }

  reply<T extends object>(data: T, includeRunId = false): T & RecordingProgress {
    return {
      ...data,
      ...(includeRunId && (this.writer || (this.opening && !this.failure)) ? { recordingId: this.runId } : {}),
      ...(this.failure ? { recordingError: this.failure } : {}),
    }
  }
}

export class SessionRecorder {
  flight: RunRecording | undefined
  private readonly runs = new Set<RunRecording>()
  private closing = false

  constructor(
    private readonly store: Store,
    private readonly projectName: (id: string) => string,
    private readonly appVersion: string,
    private readonly engineVersion: () => EngineVersion,
  ) {}

  private begin(kind: RecordingKind, options: RecordingOptions, sampling: Sampling): RunRecording | undefined {
    if (this.closing) return
    const run = new RunRecording(this.store, this.projectName, this.appVersion, this.engineVersion(), kind, options, sampling, () => {
      this.runs.delete(run)
    })
    this.runs.add(run)
    return run
  }

  startFlight(options: RecordingOptions, motors: number, flightLoop: boolean, sensors?: FlightSessionStartParams['sensors']) {
    return this.begin('flight', options, sampled(telemetryChannels(motors, flightLoop ? 'flightLoop' : 'attitudeHold', hasSensors(sensors)), 3))
  }

  replaceFlight(run: RunRecording | undefined) {
    void this.flight?.replace()
    this.flight = run
  }

  startScenario(options: RecordingOptions, motors: number, scenario: ScenarioRequest, sensors?: FlightSessionStartParams['sensors']) {
    return this.begin('scenario', options, scenarioSampling(motors, scenario, hasSensors(sensors)))
  }

  startStepTest(options: RecordingOptions, motors: number, test: StepTestRunParams['test']) {
    return this.begin('step-test', options, traceSampling(motors, test))
  }

  failFlight(error: string) {
    void this.flight?.finish('failed', error, error)
  }

  async shutdown(reason: string): Promise<void> {
    this.closing = true
    await Promise.all([...this.runs].map((run) => run.finish('aborted', reason)))
  }
}
