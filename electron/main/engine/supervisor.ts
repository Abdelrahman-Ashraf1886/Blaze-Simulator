import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import type { EngineStatus } from '../../ipc/contract'
import {
  PROTOCOL_VERSION,
  SimRunParamsSchema,
  SimRunResultSchema,
  PropulsionDefinitionSchema,
  VehicleDefinitionSchema,
  VehicleLoadResultSchema,
  isEngineResponse,
  type EngineCommand,
  type HelloResult,
  type PropulsionDefinition,
  type SimRunParams,
  type SimRunResult,
  type VehicleDefinition,
  type VehicleLoadResult,
} from './protocol'

export interface SupervisorOptions {
  binaryPath: string
  requestTimeoutMs?: number
  healthIntervalMs?: number
  /** Restart delays; the last value repeats until `maxRestarts` is reached. */
  backoffMs?: readonly number[]
  /** Consecutive failed starts before giving up (state `failed`). */
  maxRestarts?: number
  log?: (line: string) => void
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
  private readonly opts: Required<Omit<SupervisorOptions, 'log'>> & { log: (l: string) => void }

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
    await this.request({ type: 'ping' })
    return performance.now() - t0
  }

  /**
   * Sends a vehicle definition. Resolves with the engine's recomputed totals,
   * or with its list of validation errors (`valid: false`); an invalid
   * definition also clears the engine's loaded vehicle. `propulsion` (4.5) adds
   * the motors' fitted coefficients and the battery.
   */
  async loadVehicle(vehicle: VehicleDefinition, propulsion?: PropulsionDefinition): Promise<VehicleLoadResult> {
    const checked = VehicleDefinitionSchema.parse(vehicle)
    const result = await this.request({
      type: 'vehicle.load',
      vehicle: checked,
      ...(propulsion ? { propulsion: PropulsionDefinitionSchema.parse(propulsion) } : {}),
    })
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

  private launch(state: 'starting' | 'restarting'): void {
    this.update({ state })
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.opts.binaryPath, [], { stdio: 'pipe', windowsHide: true })
    } catch (e) {
      return this.onFailure(describeStartError(e as NodeJS.ErrnoException, this.opts.binaryPath))
    }
    this.child = child

    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => this.opts.log(`[engine] ${line}`))
    // Node may emit 'error' without 'exit' (e.g. ENOENT), so both paths funnel here once.
    const gone = (reason: string) => {
      if (this.child !== child) return
      this.child = null
      this.rejectAll(new Error(reason))
      this.clearTimers()
      if (!this.stopping) this.onFailure(reason)
    }
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
      const hello = (await this.request({ type: 'hello' })) as HelloResult
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
    this.opts.log(`[engine] ${reason}`)
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

  private request(command: EngineCommand, timeoutMs = this.opts.requestTimeoutMs): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('engine not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`engine request ${command.type} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private onLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.opts.log(`[engine] non-JSON stdout: ${line}`)
      return
    }
    if (!isEngineResponse(msg) || msg.id === null) {
      this.opts.log(`[engine] unexpected message: ${line}`)
      return
    }
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
