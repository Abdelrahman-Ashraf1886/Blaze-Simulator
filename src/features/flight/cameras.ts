import { Matrix4, Quaternion, Vector3 } from 'three'
import type { FlightFrame, Vec3 } from './frame'

interface CameraFrame {
  readonly positionM: Readonly<FlightFrame['positionM']>
  /** FLU orientation in x/y/z/w order, consistent with frame.ts:1–10. */
  readonly quaternion: Readonly<FlightFrame['quaternion']>
}

export interface CameraPose extends CameraFrame {
  readonly fovDeg: number
}

function horizontalHeading(frame: CameraFrame): Vector3 {
  const attitude = new Quaternion(...frame.quaternion)
  const nose = new Vector3(1, 0, 0).applyQuaternion(attitude)
  nose.z = 0
  // Near vertical, the projected nose is ill-conditioned. If its squared length
  // is within machine epsilon, take heading from the projected body-left axis.
  if (nose.lengthSq() <= Number.EPSILON) {
    const left = new Vector3(0, 1, 0).applyQuaternion(attitude)
    nose.set(left.y, -left.x, 0)
  }
  return nose.normalize()
}

function lookAtFrame(position: Vector3, frame: CameraFrame, fovDeg: number): CameraPose {
  const forward = new Vector3(...frame.positionM).sub(position)
  if (forward.lengthSq() === 0) throw new RangeError('Camera and target positions must differ')
  forward.normalize()
  const left = new Vector3(-forward.y, forward.x, 0)
  if (left.lengthSq() === 0) {
    // Use heading as screen up when the sightline is parallel to world up.
    left.crossVectors(horizontalHeading(frame), forward)
  }
  left.normalize()
  const up = new Vector3().crossVectors(forward, left)
  const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(forward, left, up))
  return { positionM: position.toArray(), quaternion: quaternion.toArray(), fovDeg }
}

/** Chase looks back at the frame origin from behind its horizontal heading. */
export function chaseCameraPose(frame: CameraFrame, distanceM: number, heightM: number, fovDeg: number): CameraPose {
  const position = new Vector3(...frame.positionM).addScaledVector(horizontalHeading(frame), -distanceM)
  position.z += heightM
  return lookAtFrame(position, frame, fovDeg)
}

/** Orbit azimuth measures the camera offset from world +X toward +Y. */
export function orbitCameraPose(
  frame: CameraFrame,
  azimuthRad: number,
  distanceM: number,
  heightM: number,
  fovDeg: number,
): CameraPose {
  const offset = new Vector3(distanceM * Math.cos(azimuthRad), distanceM * Math.sin(azimuthRad), heightM)
  return lookAtFrame(offset.add(new Vector3(...frame.positionM)), frame, fovDeg)
}

/** The fixed camera stays at the supplied world point and looks at the frame. */
export function fixedCameraPose(frame: CameraFrame, positionM: Readonly<Vec3>, fovDeg: number): CameraPose {
  return lookAtFrame(new Vector3(...positionM), frame, fovDeg)
}

/** Phase 6 plan D17 (line 77): use the camera part's body-relative pose and FOV. */
export function fpvCameraPose(frame: CameraFrame, part: CameraPose): CameraPose {
  const bodyToWorld = new Quaternion(...frame.quaternion)
  const position = new Vector3(...part.positionM).applyQuaternion(bodyToWorld).add(new Vector3(...frame.positionM))
  const quaternion = bodyToWorld.multiply(new Quaternion(...part.quaternion))
  return { positionM: position.toArray(), quaternion: quaternion.toArray(), fovDeg: part.fovDeg }
}
