import { Quaternion, Vector3 } from 'three'
import type { FlightFrame, FlightSource, SetpointProvider, Vec3 } from './frame'

export const DEMO_STEP_MS = 50
export const DEMO_DURATION_S = 10

/** Scripted diagnostics, never a physics calculation or a prediction for the current build.
 * Includes a sustained allocator limit at 5–7 s and a scripted battery cutoff at 10 s.
 * Inject custom frames for transport lifecycle tests (including contacts/voltage cutoff).
 */
export function demoFrame(timeS: number, motorCount = 4, bodyCom: Vec3 = [0, 0, 0]): FlightFrame {
  const positionM: Vec3 = [0.25 * Math.sin(timeS), 0, 1 + 0.1 * Math.sin(timeS)]
  const quaternion: FlightFrame['quaternion'] = [0, 0, Math.sin(timeS * 0.05), Math.cos(timeS * 0.05)]
  const com = new Vector3(...bodyCom).applyQuaternion(new Quaternion(...quaternion)).add(new Vector3(...positionM))
  const zero = () => ({ x: 0, y: 0, z: 0 })
  return {
    timeS, positionM, quaternion, comM: [com.x, com.y, com.z],
    linearVelocityMps: [0.25 * Math.cos(timeS), 0, 0.1 * Math.cos(timeS)],
    angularVelocityBodyRadps: [0, 0, 0.1],
    motors: Array.from({ length: motorCount }, () => ({ throttle: 0.5, omegaRadps: 400, thrustN: 3, dragTorqueNm: 0.03 })),
    totalThrustN: motorCount * 3, thrustBodyN: { x: 0, y: 0, z: motorCount * 3 }, dragBodyN: zero(),
    armTorqueNm: zero(), dragReactionTorqueNm: zero(), spinUpReactionTorqueNm: zero(), rotorGyroTorqueNm: zero(), totalTorqueNm: zero(),
    packVoltageV: 16.8 - timeS * 0.2, packCurrentA: 8, chargeUsedMah: timeS * 8 / 3.6,
    densityKgM3: 1.225,
    control: { torqueDemand: [0, 0, 0], rateIntegral: [0, 0, 0], saturation: { positive: [timeS >= 5 && timeS <= 7, false, false, false], negative: [false, false, false, false] } },
    flightLoop: null,
    ended: timeS >= DEMO_DURATION_S ? 'chargeCutoff' : null, contacts: [],
  }
}

export class FakeFlightSource implements FlightSource {
  private listeners = new Set<(frame: FlightFrame) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  constructor(private readonly frames: readonly FlightFrame[] = Array.from({ length: 201 }, (_, i) => demoFrame(i / 20))) {}
  subscribe(listener: (frame: FlightFrame) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  start(setpoint: SetpointProvider) {
    this.stop()
    const generation = this.generation
    let index = 0
    const publish = () => {
      if (generation !== this.generation) return
      const frame = this.frames[index++]
      if (!frame) { this.stop(); return }
      setpoint() // Exercise the provider boundary; the demo deliberately ignores stick input.
      if (generation !== this.generation) return
      if (frame.ended || index === this.frames.length) {
        if (this.timer !== null) clearInterval(this.timer)
        this.timer = null
      }
      for (const listener of this.listeners) {
        if (generation !== this.generation) break
        // Give subscribers their own snapshot; consumers cannot alter future scripted runs.
        listener(structuredClone(frame))
      }
    }
    if (this.frames.length === 0) return
    this.timer = setInterval(publish, DEMO_STEP_MS)
    publish()
  }
  stop() {
    this.generation++
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
