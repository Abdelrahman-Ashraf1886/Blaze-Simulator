/**
 * Parametric multirotor frame geometry. Pure functions, unit-tested; the
 * renderer only draws what these return.
 *
 * World frame: right-handed, Z-up, metres; +X forward, +Y left. The frame sits on
 * the ground plane: plate and arms occupy z ∈ [0, armThickness].
 *
 * Motor numbering and spin directions follow PX4's generic airframes, taken from
 * PX4-Autopilot v1.13.3 `src/lib/mixer/MultirotorMixer/geometries/{quad_x,hex_x,octa_x}.toml`.
 * Those files use PX4's body frame (x forward, y right); y is negated here.
 * Spin is as seen from above.
 */
import type { FrameParams, FrameType, MotorMount, Spin } from '../../electron/ipc/contract'
import type { Bounds, Vec3 } from './views'

interface Px4Rotor {
  name: string
  /** Unit vector in PX4 body axes: x forward, y right. */
  x: number
  y: number
  spin: Spin
}

const S2 = 0.707107
const C30 = 0.866025
const C22 = 0.9238795
const S22 = 0.3826834

export const PX4_ROTORS: Record<FrameType, readonly Px4Rotor[]> = {
  'quad-x': [
    { name: 'Front right', x: S2, y: S2, spin: 'ccw' },
    { name: 'Rear left', x: -S2, y: -S2, spin: 'ccw' },
    { name: 'Front left', x: S2, y: -S2, spin: 'cw' },
    { name: 'Rear right', x: -S2, y: S2, spin: 'cw' },
  ],
  'hex-x': [
    { name: 'Mid right', x: 0, y: 1, spin: 'cw' },
    { name: 'Mid left', x: 0, y: -1, spin: 'ccw' },
    { name: 'Front left', x: C30, y: -0.5, spin: 'cw' },
    { name: 'Rear right', x: -C30, y: 0.5, spin: 'ccw' },
    { name: 'Front right', x: C30, y: 0.5, spin: 'ccw' },
    { name: 'Rear left', x: -C30, y: -0.5, spin: 'cw' },
  ],
  'octo-x': [
    { name: 'Front right', x: C22, y: S22, spin: 'cw' },
    { name: 'Rear left', x: -C22, y: -S22, spin: 'cw' },
    { name: 'Mid front right', x: S22, y: C22, spin: 'ccw' },
    { name: 'Rear right', x: -C22, y: S22, spin: 'ccw' },
    { name: 'Front left', x: C22, y: -S22, spin: 'ccw' },
    { name: 'Mid rear left', x: -S22, y: -C22, spin: 'ccw' },
    { name: 'Mid front left', x: S22, y: -C22, spin: 'cw' },
    { name: 'Mid rear right', x: -S22, y: C22, spin: 'cw' },
  ],
}

export interface MotorMountPoint {
  id: string // `motor-1` … `motor-n`, PX4 numbering
  number: number
  name: string
  /** Mount surface centre: arm tip, top face. */
  position: Vec3
  /** Unit vector from the frame centre along the arm (XY plane). */
  armDirection: Vec3
  /** Arm angle from +X towards +Y (left), radians. */
  angle: number
  spin: Spin
  /** Rotation about the arm axis, radians (right-hand rule about `armDirection`). */
  tilt: number
  defaultSpin: Spin
  /** True when spin or tilt differ from the PX4 default. */
  customised: boolean
}

export interface PlateMountPoint {
  id: 'plate-top' | 'plate-bottom'
  name: string
  position: Vec3
  normal: Vec3
}

export interface FrameGeometry {
  motors: MotorMountPoint[]
  plates: PlateMountPoint[]
  /** Arm boxes: centre, length along `direction`, width, thickness. */
  arms: { center: Vec3; angle: number; length: number }[]
  bounds: Bounds
}

/**
 * Builds the frame from its layout and parameters. `overrides` holds per-motor
 * spin/tilt changes keyed by mount id; keys that do not exist on this layout are
 * ignored (e.g. after a layout change).
 */
export function buildFrame(
  type: FrameType,
  p: FrameParams,
  overrides: Readonly<Record<string, MotorMount>> = {},
): FrameGeometry {
  const r = p.motorDiagonal / 2
  const top = p.armThickness
  const motors = PX4_ROTORS[type].map((rotor, i): MotorMountPoint => {
    const dx = rotor.x
    const dy = -rotor.y // PX4 y-right → our y-left
    const n = Math.hypot(dx, dy)
    const dir: Vec3 = [dx / n, dy / n, 0]
    const id = `motor-${i + 1}`
    const o = overrides[id]
    const spin = o?.spin ?? rotor.spin
    const tilt = o?.tilt ?? 0
    return {
      id,
      number: i + 1,
      name: rotor.name,
      position: [dir[0] * r, dir[1] * r, top],
      armDirection: dir,
      angle: Math.atan2(dir[1], dir[0]),
      spin,
      tilt,
      defaultSpin: rotor.spin,
      customised: spin !== rotor.spin || tilt !== 0,
    }
  })
  // Each arm runs from the frame centre to just past the motor axis (half an arm width).
  const armLength = r + p.armWidth / 2
  const arms = motors.map((m) => ({
    center: [(m.armDirection[0] * armLength) / 2, (m.armDirection[1] * armLength) / 2, top / 2] as Vec3,
    angle: m.angle,
    length: armLength,
  }))
  const reach = Math.max(armLength, (p.plateSize / 2) * Math.SQRT2)
  return {
    motors,
    plates: [
      { id: 'plate-top', name: 'Plate top', position: [0, 0, top], normal: [0, 0, 1] },
      { id: 'plate-bottom', name: 'Plate bottom', position: [0, 0, 0], normal: [0, 0, -1] },
    ],
    arms,
    // Headroom above the frame keeps parts placed on top in view.
    bounds: { min: [-reach, -reach, 0], max: [reach, reach, Math.max(top, reach * 0.35)] },
  }
}
