/** Renderer boundary for Part B. SI units; right-handed +X forward, +Y left, +Z up. */
import type { FlightStepInput, FlightStepResult } from '../../../electron/ipc/contract'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
export interface AxisVector { x: number; y: number; z: number }
export interface FlightFrame {
  timeS: number
  /** World position of the assembly/frame origin (not the CoM). */
  positionM: Vec3
  /** Body to world, x/y/z/w, with no renderer axis conversion. */
  quaternion: Quat
  /** World CoM, already transformed by the source. */
  comM: Vec3
  linearVelocityMps: Vec3
  angularVelocityBodyRadps: Vec3
  /** Same stable order as the vehicle definition's motors. */
  /** `dragTorqueNm` is the air's drag torque k_Q ω² the motor holds the rotor against. */
  motors: { throttle: number; omegaRadps: number; thrustN: number; dragTorqueNm: number }[]
  totalThrustN: number
  thrustBodyN: AxisVector
  dragBodyN: AxisVector
  environmentLoads: Pick<FlightStepResult['diagnostic']['loads'],
    'windComWorldMps' | 'turbulence' | 'groundEffectAddedThrustN' | 'groundEffectStatus' | 'windAboveRange' | 'windInvalid'> | null
  armTorqueNm: AxisVector
  /** The rotors' drag torque on the body, −s·Q·a per motor. */
  dragReactionTorqueNm: AxisVector
  /** Spinning the rotors up or down, −s·J·dω/dt·a per motor. */
  spinUpReactionTorqueNm: AxisVector
  rotorGyroTorqueNm: AxisVector
  totalTorqueNm: AxisVector
  packVoltageV: number
  packCurrentA: number
  chargeUsedMah: number
  densityKgM3: number
  control: {
    torqueDemand: Vec3
    rateIntegral: Vec3
    saturation: { positive: [boolean, boolean, boolean, boolean]; negative: [boolean, boolean, boolean, boolean] }
  } | null
  flightLoop: (Omit<NonNullable<FlightStepResult['diagnostic']['flightLoop']>, 'hoverThrust'> & {
    hoverThrust: { estimate: number | null; standardDeviation: number | null; valid: boolean }
    requestedMode: FlightStepInput['setpoint']['mode']
  }) | null
  ended: 'voltageCutoff' | 'chargeCutoff' | null
  contacts: { part: string; object: string; startS: number; endS: number | null }[]
}

export interface FlightSetpoint {
  attitude: Quat
  yawRateRadps: number
  verticalVelocityMps: number
}
export type Px4Sticks = NonNullable<FlightStepInput['setpoint']['sticks']>
export type Px4Mode = Exclude<NonNullable<FlightStepInput['setpoint']['mode']>, 'rates'>
export type FlightMode = 'attitudeHold' | Px4Mode
export type AutoCommand = NonNullable<FlightStepInput['setpoint']['command']>
export type SetpointProvider = () => FlightSetpoint | { mode: Px4Mode; sticks: Px4Sticks } | { command: AutoCommand }
/** start begins a fresh run; subscribe returns cleanup. stop is idempotent and preserves the last frame.
 * Sources stop themselves after publishing an ended frame. No callbacks after stop/unsubscribe.
 * Part B owns transport errors/readiness outside this per-sample interface.
 */
export interface FlightSource {
  start(setpoint: SetpointProvider): void
  stop(): void
  subscribe(listener: (frame: FlightFrame) => void): () => void
}

/** FlightViewport is Z-up, so world vectors use the same XYZ ordering as the pose. */
export function windArrow(wind: Vec3): { direction: Vec3; speedMps: number } | null {
  const speedMps = Math.hypot(...wind)
  return speedMps === 0 ? null : { direction: [wind[0] / speedMps, wind[1] / speedMps, wind[2] / speedMps], speedMps }
}

/** Direct three.js props. comM belongs outside the posed assembly group. */
export function frameToPose(frame: FlightFrame): { position: Vec3; quaternion: Quat; comWorld: Vec3 } {
  return { position: [...frame.positionM], quaternion: [...frame.quaternion], comWorld: [...frame.comM] }
}
