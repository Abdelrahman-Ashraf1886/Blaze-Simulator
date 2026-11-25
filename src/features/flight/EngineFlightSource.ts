/**
 * The live flight source (4.8 part B): renderer-driven lockstep against the engine's flight session.
 *
 * The engine never runs on its own clock. On each animation frame this sends ONE step request carrying the
 * real time elapsed since the last request, in whole 1 ms steps (capped, so a slow frame slows the simulation
 * instead of sending a huge request), with the current stick setpoint held over those steps. The response's
 * last diagnostic becomes one `FlightFrame`, so subscribers see at most one frame per animation frame, never
 * the 1 kHz step stream.
 */
import type { DesktopApi, FlightStartInput, FlightStepInput, FlightStepResult } from '../../../electron/ipc/contract'
import { flightTiming } from './flight-timing'
import type { AxisVector, FlightFrame, FlightSource, SetpointProvider, Vec3 } from './frame'

/** Most simulated time one request advances (ms = steps). Engine limit is 100; 50 ms bounds the gap between frames. */
export const MAX_STEP_MS = 50

/** Whole 1 ms steps owed for `owedMs` of real time, and the time still owed afterwards. */
export function stepsForElapsed(owedMs: number): { steps: number; owedMs: number } {
  if (!Number.isFinite(owedMs) || owedMs < 1) return { steps: 0, owedMs: Number.isFinite(owedMs) && owedMs > 0 ? owedMs : 0 }
  const whole = Math.floor(owedMs)
  // Time beyond the cap is dropped, not caught up: a slow frame slows the simulation.
  if (whole > MAX_STEP_MS) return { steps: MAX_STEP_MS, owedMs: 0 }
  return { steps: whole, owedMs: owedMs - whole }
}

/**
 * The stick setpoint as the controller takes it: a vertical-speed hold (no altitude target), a yaw-rate
 * feed-forward and the attitude. Each request carries the current one for all its steps.
 */
export function toEngineSetpoint(s: ReturnType<SetpointProvider>): FlightStepInput['setpoint'] {
  if ('mode' in s || 'command' in s) return s
  return { attitude: [...s.attitude], yawRateRadps: s.yawRateRadps, climbRateMps: s.verticalVelocityMps }
}

type Diagnostic = FlightStepResult['diagnostic']
type EngineContact = FlightStepResult['contacts'][number]
type EndReason = FlightStepResult['endReason']

const axes = (v: readonly [number, number, number]): AxisVector => ({ x: v[0], y: v[1], z: v[2] })
const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60

/**
 * The ONE place the engine's camelCase diagnostic becomes a `FlightFrame`. Conversions only: rpm to rad/s,
 * coulombs to mAh (1 mAh = 3.6 C), vectors to axis objects; the total thrust is the sum of the motors'.
 */
export function toFlightFrame(d: Diagnostic, endReason: EndReason, contacts: readonly EngineContact[], requestedMode?: FlightStepInput['setpoint']['mode']): FlightFrame {
  const loop = d.flightLoop
  const variance = loop?.hoverThrust.variance
  return {
    timeS: d.state.timeS,
    positionM: [...d.state.positionM],
    quaternion: [...d.state.quaternion],
    comM: [...d.state.comM],
    linearVelocityMps: [...d.state.linearVelocityMps],
    angularVelocityBodyRadps: [...d.state.angularVelocityBodyRadps],
    motors: d.motors.map((m) => ({ throttle: m.throttle, omegaRadps: m.rpm * RAD_PER_S_PER_RPM, thrustN: m.thrustN, dragTorqueNm: m.dragTorqueNm })),
    totalThrustN: d.motors.reduce((sum, m) => sum + m.thrustN, 0),
    thrustBodyN: axes(d.loads.thrustBodyN),
    dragBodyN: axes(d.loads.dragBodyN),
    environmentLoads: {
      windComWorldMps: [...d.loads.windComWorldMps],
      ...(d.loads.turbulence && { turbulence: {
        ...d.loads.turbulence, velocityWorldMps: [...d.loads.turbulence.velocityWorldMps],
      } }),
      groundEffectAddedThrustN: d.loads.groundEffectAddedThrustN,
      groundEffectStatus: d.loads.groundEffectStatus,
      windAboveRange: d.loads.windAboveRange,
      windInvalid: d.loads.windInvalid,
    },
    armTorqueNm: axes(d.loads.armTorqueNm),
    dragReactionTorqueNm: axes(d.loads.dragReactionTorqueNm),
    spinUpReactionTorqueNm: axes(d.loads.spinUpReactionTorqueNm),
    rotorGyroTorqueNm: axes(d.loads.rotorGyroTorqueNm),
    totalTorqueNm: axes(d.loads.totalTorqueNm),
    packVoltageV: d.battery.voltageV,
    packCurrentA: d.battery.currentA,
    chargeUsedMah: d.battery.chargeUsedC / 3.6,
    densityKgM3: d.airDensityKgM3,
    control: d.control && {
      torqueDemand: [...d.control.torqueDemand],
      rateIntegral: [...d.control.rateIntegral],
      saturation: { positive: [...d.control.saturation.positive], negative: [...d.control.saturation.negative] },
    },
    flightLoop: loop ? {
      ...loop,
      landState: loop.landState && { ...loop.landState },
      positionSetpointM: [...loop.positionSetpointM],
      velocitySetpointMps: [...loop.velocitySetpointMps],
      accelerationSetpointMps2: [...loop.accelerationSetpointMps2],
      velocityIntegral: [...loop.velocityIntegral],
      saturation: { positive: [...loop.saturation.positive], negative: [...loop.saturation.negative] },
      requestedMode,
      hoverThrust: {
        estimate: loop.hoverThrust.estimate,
        standardDeviation: variance != null && variance >= 0 ? Math.sqrt(variance) : null,
        valid: loop.hoverThrust.valid,
      },
    } : null,
    ended: endReason,
    contacts: contacts.map((c) => ({ part: c.partId, object: c.with, startS: c.startS, endS: c.endS })),
  }
}

/** Before a run: at rest at the start position, nothing spinning, nothing measured. */
export function idleFrame(motorCount: number, startPositionM: Vec3, bodyCom: Vec3): FlightFrame {
  const zero = () => ({ x: 0, y: 0, z: 0 })
  return {
    timeS: 0,
    positionM: [...startPositionM],
    quaternion: [0, 0, 0, 1],
    comM: [startPositionM[0] + bodyCom[0], startPositionM[1] + bodyCom[1], startPositionM[2] + bodyCom[2]],
    linearVelocityMps: [0, 0, 0],
    angularVelocityBodyRadps: [0, 0, 0],
    motors: Array.from({ length: motorCount }, () => ({ throttle: 0, omegaRadps: 0, thrustN: 0, dragTorqueNm: 0 })),
    totalThrustN: 0,
    thrustBodyN: zero(),
    dragBodyN: zero(),
    environmentLoads: null,
    armTorqueNm: zero(),
    dragReactionTorqueNm: zero(),
    spinUpReactionTorqueNm: zero(),
    rotorGyroTorqueNm: zero(),
    totalTorqueNm: zero(),
    packVoltageV: 0,
    packCurrentA: 0,
    chargeUsedMah: 0,
    densityKgM3: 0,
    control: null,
    flightLoop: null,
    ended: null,
    contacts: [],
  }
}

type EngineApi = Pick<DesktopApi['engine'], 'flightStart' | 'flightStep' | 'flightEnd'>
export interface EngineFlightSourceOptions {
  /** Milliseconds, monotonic. */
  now?: () => number
  /** Runs `callback` on the next animation frame; returns its cancel function. */
  schedule?: (callback: () => void) => () => void
}

type Frames = { requestAnimationFrame(callback: () => void): number; cancelAnimationFrame(handle: number): void }
const animationFrame = (callback: () => void) => {
  const frames = globalThis as unknown as Frames
  const handle = frames.requestAnimationFrame(callback)
  return () => frames.cancelAnimationFrame(handle)
}

/**
 * `start` loads the vehicle and starts a session (asynchronously; a refusal reaches `onError`), then steps it on
 * every frame. The session ends on `stop` or after the frame that carries a cut-off.
 */
export class EngineFlightSource implements FlightSource {
  private listeners = new Set<(frame: FlightFrame) => void>()
  private errorListeners = new Set<(message: string) => void>()
  private generation = 0
  private sessionOpen = false
  private cancelFrame: (() => void) | null = null
  private clockResetAt: number | null = null
  private contacts = new Map<string, EngineContact>()
  private readonly now: () => number
  private readonly schedule: (callback: () => void) => () => void

  constructor(
    private readonly api: EngineApi,
    private readonly input: FlightStartInput,
    options: EngineFlightSourceOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? animationFrame
  }

  subscribe(listener: (frame: FlightFrame) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Engine and transport errors (a refused start or step); the source has stopped when this fires. */
  onError(listener: (message: string) => void) {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  start(setpoint: () => ReturnType<SetpointProvider> | null) {
    this.stop()
    this.contacts.clear()
    void this.run(this.generation, setpoint)
  }

  /** A pause or resume discards elapsed time and any fractional step carried over. */
  resetStepClock() {
    this.clockResetAt = this.now()
  }

  stop() {
    this.generation++
    this.cancelFrame?.()
    this.cancelFrame = null
    this.clockResetAt = null
    if (this.sessionOpen) {
      this.sessionOpen = false
      void Promise.resolve(this.api.flightEnd()).catch(() => {})
    }
  }

  private fail(generation: number, message: string) {
    if (generation !== this.generation) return
    this.stop()
    for (const listener of this.errorListeners) listener(message)
  }

  private publish(generation: number, frame: FlightFrame) {
    for (const listener of this.listeners) {
      if (generation !== this.generation) break
      listener(frame)
    }
  }

  private async run(generation: number, setpoint: () => ReturnType<SetpointProvider> | null) {
    try {
      const started = await this.api.flightStart(this.input)
      if (generation !== this.generation) {
        // Stopped while the engine was starting: do not leave its session behind.
        if (started.ok) void Promise.resolve(this.api.flightEnd()).catch(() => {})
        return
      }
      if (!started.ok) return this.fail(generation, started.error.message)
      this.sessionOpen = true
      this.publish(generation, toFlightFrame(started.data.diagnostic, null, []))
      let last = this.now()
      let owedMs = 0
      const tick = async () => {
        if (generation !== this.generation) return
        const t = this.now()
        if (this.clockResetAt !== null) {
          last = Math.max(last, this.clockResetAt)
          owedMs = 0
          this.clockResetAt = null
        }
        owedMs += t - last
        last = t
        const due = stepsForElapsed(owedMs)
        owedMs = due.owedMs
        if (due.steps > 0) {
          try {
            const input = setpoint()
            if (input === null) {
              owedMs = 0
            } else {
              const command = toEngineSetpoint(input)
              const result = await (flightTiming
                ? flightTiming.step(this.api, due.steps, command)
                : this.api.flightStep({ steps: due.steps, setpoint: command }))
              if (generation !== this.generation) return
              if (!result.ok) return this.fail(generation, result.error.message)
              for (const c of result.data.contacts) this.contacts.set(`${c.partId}|${c.with}|${c.startS}`, c)
              this.publish(generation, toFlightFrame(result.data.diagnostic, result.data.endReason, [...this.contacts.values()], command.mode))
              // A cut-off ended the run: sources stop themselves after publishing an ended frame.
              if (result.data.endReason !== null) return this.stop()
            }
          } catch (e) {
            return this.fail(generation, (e as Error).message)
          }
        }
        if (generation === this.generation) this.cancelFrame = this.schedule(() => void tick())
      }
      this.cancelFrame = this.schedule(() => void tick())
    } catch (e) {
      this.fail(generation, (e as Error).message)
    }
  }
}
