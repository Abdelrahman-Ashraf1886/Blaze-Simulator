import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { getDefaultHighWaterMark, type Readable } from 'node:stream'
import { z } from 'zod'
import { MAX_ASSET_BYTES } from '../../ipc/contract'
import type { EngineStatus } from '../../ipc/contract'
import {
  PROTOCOL_VERSION,
  FlightSessionEndResultSchema,
  FlightSessionStartParamsSchema,
  FlightSessionStartResultSchema,
  FlightSessionStepParamsSchema,
  FlightSessionStepResultSchema,
  type FlightSessionEndResult,
  type FlightSessionStartParams,
  type FlightSessionStartResult,
  type FlightSessionStepParams,
  type FlightSessionStepResult,
  ScenarioRunParamsSchema,
  ScenarioRunResultSchema,
  SimRunParamsSchema,
  SimRunResultSchema,
  BodyDragSchema,
  PropulsionDefinitionSchema,
  VehicleDefinitionSchema,
  VehicleLoadResultSchema,
  type EngineCommand,
  type BodyDrag,
  type PropulsionDefinition,
  type ScenarioRunParams,
  type StepTestRunParams,
  type ScenarioRunResult,
  type SimRunParams,
  type SimRunResult,
  type VehicleDefinition,
  type VehicleLoadResult,
} from './protocol'
import { runStepTest } from './step-test'

export const MAX_ENGINE_REQUEST_BYTES = MAX_ASSET_BYTES
// ARCHITECTURE.md:49 bounds 60,001 rows for six motors with gyro and sensors at
// 300,545,031 bytes. The recorder uses every fourth step (session-recorder.ts:10).
// Allow the 1 kHz reply plus one request-sized allowance for echoed data and metadata.
export const MAX_ENGINE_REPLY_BYTES = Math.ceil((300_545_031 + MAX_ENGINE_REQUEST_BYTES) / MAX_ASSET_BYTES) * MAX_ASSET_BYTES

const replyId = z.int().nonnegative()
const engineReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ id: replyId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    id: replyId.nullable(), ok: z.literal(false),
    error: z.strictObject({ code: z.string().min(1), message: z.string() }),
  }),
])
export const engineHelloSchema = z.strictObject({
  engineVersion: z.string().min(1), protocolVersion: z.int().nonnegative(), threads: z.int().positive(),
})

export function parseEngineReply(line: string) {
  return engineReplySchema.parse(JSON.parse(line))
}

/** Decode complete pipe records, checking byte length before retaining or decoding them. */
export function watchEngineLines(input: Readable, limit: number, onLine: (line: string) => void, fail: (error: Error) => void) {
  const pageSize = Math.min(getDefaultHighWaterMark(false), limit)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let pages: Buffer[] = []
  let fill = 0
  let length = 0
  let closed = false
  const close = () => {
    closed = true
    pages = []
    input.off('data', consume)
    input.off('end', end)
    input.off('error', broken)
  }
  const broken = (error: Error) => {
    close()
    fail(error)
  }
  const end = () => {
    if (length) broken(new Error('Engine pipe ended with an incomplete line'))
    else close()
  }
  const consume = (chunk: Buffer) => {
    for (let offset = 0; offset < chunk.length && !closed;) {
      const newline = chunk.indexOf(10, offset)
      const stop = newline < 0 ? chunk.length : newline
      length += stop - offset
      if (length > limit) return broken(new Error(`Engine pipe line exceeds ${limit} bytes`))
      while (offset < stop) {
        if (fill === 0) pages.push(Buffer.allocUnsafe(pageSize))
        const written = Math.min(stop - offset, pageSize - fill)
        chunk.copy(pages[pages.length - 1]!, fill, offset, offset + written)
        offset += written
        fill = (fill + written) % pageSize
      }
      if (newline < 0) return
      try {
        const line = decoder.decode(pages.length === 1 ? pages[0]!.subarray(0, length) : Buffer.concat(pages, length))
        pages = []
        length = 0
        fill = 0
        onLine(line)
      } catch (error) {
        return broken(error instanceof Error ? error : new Error('Invalid engine pipe record'))
      }
      offset = stop + 1
    }
  }
  input.on('data', consume)
  input.on('end', end)
  input.on('error', broken)
  return close
}

export type CaptureRequestLine = (line: string) => void

export interface SupervisorOptions {
  binaryPath: string
  requestTimeoutMs?: number
  healthIntervalMs?: number
  /** Restart delays; the last value repeats until `maxRestarts` is reached. */
  backoffMs?: readonly number[]
  /** Consecutive failed starts before giving up (state `failed`). */
  maxRestarts?: number
  log?: (line: string, level?: 'info' | 'error') => void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Plain-language reason shown in the UI when the engine process cannot be started. */
export function describeStartError(e: NodeJS.ErrnoException, binaryPath: string): string {
  if (e.code === 'ENOENT') return `Engine executable not found: ${binaryPath}`
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return `Not allowed to start the engine executable (${e.code}): ${binaryPath}`
  }
  return `Engine could not start: ${e.message}`
}

/**
 * Owns the `drone-engine` sidecar: spawn, handshake, health pings, automatic
 * restart with backoff, and orderly shutdown. Emits `status` on every change.
 */
export class EngineSupervisor extends EventEmitter<{ status: [EngineStatus] }> {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private healthTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private consecutiveFailures = 0
  private stopping = false
  private readonly opts: Required<SupervisorOptions>

  private _status: EngineStatus = {
    state: 'stopped',
    engineVersion: null,
    protocolVersion: null,
    threads: null,
    latencyMs: null,
    lastError: null,
    restarts: 0,
    revision: 0,
  }

  constructor(options: SupervisorOptions) {
    super()
    this.opts = {
      requestTimeoutMs: 3000,
      healthIntervalMs: 2000,
      backoffMs: [250, 1000, 3000],
      maxRestarts: 5,
      log: () => {},
      ...options,
    }
  }

  get status(): EngineStatus {
    return { ...this._status }
  }

  /** OS process id of the running engine, if any. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    this.stopping = false
    this.launch('starting')
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const child = this.child
    if (!child) return this.update({ state: 'stopped' })
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    try {
      await this.request({ type: 'shutdown' }, 1000)
    } catch {
      /* fall through to kill */
    }
    const timeout = setTimeout(() => child.kill(), 1000)
    await exited
    clearTimeout(timeout)
    this.update({ state: 'stopped', latencyMs: null })
  }

  async ping(): Promise<number> {
    const t0 = performance.now()
    z.strictObject({ engineUptimeUs: z.int().nonnegative() }).parse(await this.request({ type: 'ping' }))
    return performance.now() - t0
  }

  /**
   * Sends a vehicle definition. Resolves with the engine's recomputed totals,
   * or with its list of validation errors (`valid: false`); an invalid
   * definition also clears the engine's loaded vehicle. Optional (4.5):
   * `propulsion` (the motors' fitted coefficients and the battery) and `aero`
   * (per-axis body drag).
   */
  async loadVehicle(
    vehicle: VehicleDefinition,
    extra: { propulsion?: PropulsionDefinition; aero?: BodyDrag } = {},
    capture?: CaptureRequestLine,
  ): Promise<VehicleLoadResult> {
    const checked = VehicleDefinitionSchema.parse(vehicle)
    const result = await this.request({
      type: 'vehicle.load',
      vehicle: checked,
      ...(extra.propulsion ? { propulsion: PropulsionDefinitionSchema.parse(extra.propulsion) } : {}),
      ...(extra.aero ? { aero: BodyDragSchema.parse(extra.aero) } : {}),
    }, undefined, capture)
    return VehicleLoadResultSchema.parse(result)
  }

  /**
   * Batch run of the loaded vehicle from rest. The engine caps a run at
   * 120 000 steps (≈0.9 s of compute), so the default timeout is enough.
   */
  async runSim(params: SimRunParams): Promise<SimRunResult> {
    const checked = SimRunParamsSchema.parse(params)
    const result = await this.request({ type: 'sim.run', ...checked })
    return SimRunResultSchema.parse(result)
  }

  /** Live flight (4.8 part B): replaces any session; the loaded vehicle must carry propulsion. */
  async startFlightSession(params: FlightSessionStartParams, capture?: CaptureRequestLine): Promise<FlightSessionStartResult> {
    const checked = FlightSessionStartParamsSchema.parse(params)
    return FlightSessionStartResultSchema.parse(await this.request({ type: 'flight.session.start', ...checked }, undefined, capture))
  }

  /** Advances the session by `steps` 1 ms steps with the setpoint held (at most 100 steps, well inside the timeout). */
  async stepFlightSession(params: FlightSessionStepParams, capture?: CaptureRequestLine): Promise<FlightSessionStepResult> {
    const checked = FlightSessionStepParamsSchema.parse(params)
    return FlightSessionStepResultSchema.parse(await this.request({ type: 'flight.session.step', ...checked }, undefined, capture))
  }

  async endFlightSession(): Promise<FlightSessionEndResult> {
    return FlightSessionEndResultSchema.parse(await this.request({ type: 'flight.session.end' }))
  }

  /**
   * A scripted scenario (4.9 part B) on the loaded vehicle, which needs propulsion. The engine bounds it
   * (60 s, or 10 s with a ground), so the default timeout is enough.
   */
  async runScenario(params: ScenarioRunParams, capture?: CaptureRequestLine): Promise<ScenarioRunResult> {
    const checked = ScenarioRunParamsSchema.parse(params)
    return ScenarioRunResultSchema.parse(await this.request({ type: 'scenario.run', ...checked }, undefined, capture))
  }

  runStepTest(params: StepTestRunParams, capture?: CaptureRequestLine) {
    return runStepTest((command) => this.request(command, undefined, capture), params)
  }

  private launch(state: 'starting' | 'restarting'): void {
    this.update({ state })
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.opts.binaryPath, [], { stdio: 'pipe', windowsHide: true })
    } catch (e) {
      return this.onFailure(describeStartError(e as NodeJS.ErrnoException, this.opts.binaryPath))
    }
    this.child = child

    // A write after the engine has gone fails its own request (the write callback) and also raises 'error' on the
    // pipe. Unhandled, that would end the main process; the 'exit' handler below does the recovery.
    child.stdin.on('error', (e) => this.opts.log(`[engine] stdin: ${e.message}`))
    // Node may emit 'error' without 'exit' (e.g. ENOENT), so both paths funnel here once.
    const gone = (reason: string) => {
      if (this.child !== child) return
      this.child = null
      this.rejectAll(new Error(reason))
      this.clearTimers()
      if (!this.stopping) this.onFailure(reason)
    }
    const invalidPipe = (error: Error) => {
      if (this.child !== child) return
      // Reject the old process' requests before a replacement can accept work.
      gone(error.message)
      child.kill()
    }
    const closeStdout = watchEngineLines(child.stdout, MAX_ENGINE_REPLY_BYTES, (line) => {
      if (this.child === child) this.onLine(line)
    }, invalidPipe)
    const closeStderr = watchEngineLines(child.stderr, getDefaultHighWaterMark(false),
      // stderr is the engine's own log (engine-host/src/main.rs: started, exiting), not only errors.
      (line) => this.opts.log(`[engine] ${line}`, 'info'), invalidPipe)
    child.once('close', () => {
      closeStdout()
      closeStderr()
    })
    child.on('error', (e) => {
      this.opts.log(`[engine] process error: ${e.message}`)
      if (child.pid === undefined) gone(describeStartError(e, this.opts.binaryPath))
    })
    child.once('exit', (code, signal) =>
      gone(`Engine exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`})`),
    )

    void this.handshake(child)
  }

  private async handshake(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      const hello = engineHelloSchema.parse(await this.request({ type: 'hello' }))
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        this.stopping = true // incompatible binary: restarting will not help
        child.kill()
        this.update({
          state: 'failed',
          lastError: `Engine speaks protocol v${hello.protocolVersion}; this app needs v${PROTOCOL_VERSION}. Reinstall to get matching versions.`,
        })
        return
      }
      this.consecutiveFailures = 0
      this.update({
        state: 'connected',
        engineVersion: hello.engineVersion,
        protocolVersion: hello.protocolVersion,
        threads: hello.threads,
        lastError: null,
      })
      await this.healthCheck()
      this.healthTimer = setInterval(() => void this.healthCheck(), this.opts.healthIntervalMs)
    } catch (e) {
      if (this.child === child) child.kill() // exit handler schedules the restart
      this.opts.log(`[engine] handshake failed: ${(e as Error).message}`)
    }
  }

  private async healthCheck(): Promise<void> {
    try {
      const latencyMs = await this.ping()
      if (this._status.state === 'connected') this.update({ latencyMs })
    } catch (e) {
      this.opts.log(`[engine] health ping failed: ${(e as Error).message}`)
      this.child?.kill()
    }
  }

  private onFailure(reason: string): void {
    this.opts.log(`[engine] ${reason}`, 'error')
    this.consecutiveFailures++
    if (this.consecutiveFailures > this.opts.maxRestarts) {
      this.update({ state: 'failed', lastError: reason, latencyMs: null })
      return
    }
    const delays = this.opts.backoffMs
    const delay = delays[Math.min(this.consecutiveFailures - 1, delays.length - 1)] ?? 1000
    this.update({ state: 'restarting', lastError: reason, latencyMs: null, restarts: this._status.restarts + 1 })
    this.restartTimer = setTimeout(() => this.launch('restarting'), delay)
  }

  private request(command: EngineCommand, timeoutMs = this.opts.requestTimeoutMs, capture?: CaptureRequestLine): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('engine not running'))
    if (this.stopping && command.type !== 'shutdown') return Promise.reject(new Error('engine is stopping'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`engine request ${command.type} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const line = `${JSON.stringify({ id, ...command })}\n`
      if (Buffer.byteLength(line) > MAX_ENGINE_REQUEST_BYTES) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Engine request exceeds its byte limit'))
        return
      }
      child.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
      try {
        capture?.(line)
      } catch (error) {
        this.opts.log(`[recordings] could not capture engine request: ${String(error)}`)
      }
    })
  }

  private onLine(line: string): void {
    let msg: ReturnType<typeof parseEngineReply>
    try {
      msg = parseEngineReply(line)
    } catch {
      throw new Error('Malformed engine response')
    }
    if (msg.id === null) throw new Error('Engine response has no request ID')
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private clearTimers(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.healthTimer = this.restartTimer = null
  }

  private update(patch: Partial<Omit<EngineStatus, 'revision'>>): void {
    this._status = { ...this._status, ...patch, revision: this._status.revision + 1 }
    this.emit('status', this.status)
  }
}
