import type { FlightSetpoint, Px4Sticks } from './frame'

// UI stick limits, not controller tuning defaults; no existing stick settings in this phase.
export const MAX_TILT_RAD = 30 * Math.PI / 180
export const MAX_YAW_RATE_RADPS = Math.PI / 2
export const MAX_VERTICAL_SPEED_MPS = 2
export const STICK_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

// PX4 v1.13.3 Sticks.cpp:54–58; the host takes forward/right/yaw-right/up (protocol.ts:124–133).
export function mapPx4Sticks(keys: ReadonlySet<string>): Px4Sticks {
  const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative))
  return {
    forward: axis('ArrowUp', 'ArrowDown'),
    right: axis('ArrowRight', 'ArrowLeft'),
    yawRight: axis('KeyD', 'KeyA'),
    throttle: axis('KeyW', 'KeyS'),
  }
}

export interface HeadingHold { headingRad: number; yawActive: boolean }

/** Capture on start or return to zero yaw input; retain the target through drift.
 * During a rate command, attitude follows measured heading. Opposing keys cancel.
 */
export function updateHeadingHold(previous: HeadingHold | null, keys: ReadonlySet<string>, currentHeadingRad: number): HeadingHold {
  const yawActive = mapPx4Sticks(keys).yawRight !== 0
  return {
    headingRad: !previous || yawActive || previous.yawActive ? currentHeadingRad : previous.headingRad,
    yawActive,
  }
}

/** Centred throttle commands vertical velocity; opposing keys cancel. yaw is a held heading
 * supplied by the caller (current heading at capture); the engine integrates yaw rate.
 * Body axes: positive roll tilts right, positive pitch tilts forward, positive yaw turns left.
 * Radial limiting keeps combined roll/pitch within the stated 30 degree tilt cone.
 */
export function mapSticks(keys: ReadonlySet<string>, yawRad = 0): FlightSetpoint {
  const { forward, right, yawRight, throttle } = mapPx4Sticks(keys)
  let roll = right
  let pitch = forward
  const scale = MAX_TILT_RAD / Math.max(1, Math.hypot(roll, pitch))
  roll *= scale
  pitch *= scale
  // Rz(yaw) Ry(pitch) Rx(roll), body -> world, x/y/z/w.
  const [sr, cr] = [Math.sin(roll / 2), Math.cos(roll / 2)]
  const [sp, cp] = [Math.sin(pitch / 2), Math.cos(pitch / 2)]
  const [sy, cy] = [Math.sin(yawRad / 2), Math.cos(yawRad / 2)]
  return {
    attitude: [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy],
    yawRateRadps: (-yawRight || 0) * MAX_YAW_RATE_RADPS,
    verticalVelocityMps: throttle * MAX_VERTICAL_SPEED_MPS,
  }
}
