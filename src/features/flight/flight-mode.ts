import type { FlightStartInput } from '../../../electron/ipc/contract'
import type { TuningOverrides } from '../../domain/controller-params'
import { thrustFactor, type BuildThrustCurveFit } from '../../domain/thrust-curve'
import type { FlightMode } from './frame'

export const FLIGHT_MODE_LABELS = {
  attitudeHold: 'Attitude hold',
  stabilized: 'Stabilized',
  altitude: 'Altitude',
  position: 'Position',
} satisfies Record<FlightMode, string>

// closed_loop.rs:144–160 accepts exactly the serialized Gains fields (controller.rs:26–103).
const attitudeHoldNames = new Set([
  'MC_ROLL_P', 'MC_PITCH_P', 'MC_YAW_P', 'MC_YAW_WEIGHT',
  'MC_ROLLRATE_MAX', 'MC_PITCHRATE_MAX', 'MC_YAWRATE_MAX',
  'MC_ROLLRATE_P', 'MC_ROLLRATE_I', 'MC_RR_INT_LIM', 'MC_ROLLRATE_D', 'MC_ROLLRATE_FF', 'MC_ROLLRATE_K',
  'MC_PITCHRATE_P', 'MC_PITCHRATE_I', 'MC_PR_INT_LIM', 'MC_PITCHRATE_D', 'MC_PITCHRATE_FF', 'MC_PITCHRATE_K',
  'MC_YAWRATE_P', 'MC_YAWRATE_I', 'MC_YR_INT_LIM', 'MC_YAWRATE_D', 'MC_YAWRATE_FF', 'MC_YAWRATE_K',
  'MC_ACRO_R_MAX', 'MC_ACRO_P_MAX', 'MC_ACRO_Y_MAX',
  'MPC_Z_P', 'MPC_Z_VEL_P_ACC', 'MPC_Z_VEL_I_ACC', 'MPC_Z_VEL_D_ACC',
  'MPC_THR_HOVER', 'MPC_USE_HTE', 'MPC_THR_MIN', 'MPC_THR_MAX', 'MPC_Z_VEL_MAX_UP', 'MPC_Z_VEL_MAX_DN',
  'THR_MDL_FAC',
])

export function flightStartWithTuning(mode: FlightMode, saved: TuningOverrides, fit: BuildThrustCurveFit | null = null): {
  session: Pick<FlightStartInput, 'controller' | 'gains'>
  unsupported: string[]
} {
  const gains = { ...saved, THR_MDL_FAC: thrustFactor(fit, saved) }
  if (mode !== 'attitudeHold') return { session: { controller: { mode }, gains }, unsupported: [] }
  const entries = Object.entries(saved)
  return {
    session: { gains: Object.fromEntries(Object.entries(gains).filter(([name]) => attitudeHoldNames.has(name))) },
    unsupported: entries.map(([name]) => name).filter((name) => !attitudeHoldNames.has(name)),
  }
}
