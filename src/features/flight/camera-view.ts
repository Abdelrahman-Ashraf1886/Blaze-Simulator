import { Quaternion, Vector3 } from 'three'
import { CAMERA_FOV_DEG, type AssemblyDocument, type AssemblyPart } from '../../../electron/ipc/contract'
import type { FrameGeometry } from '../../three/frame-geometry'
import { worldMatrix } from '../workshop/assembly-ops'
import {
  chaseCameraPose, chaseHeading, easeChaseHeading, fixedCameraPose, followCameraPose, fpvCameraPose,
  orbitCameraPose, type CameraPose,
} from './cameras'
import type { FlightFrame, Vec3 } from './frame'

export const CAMERA_MODES = ['Follow', 'Chase', 'Orbit', 'Fixed', 'FPV'] as const
export type CameraMode = typeof CAMERA_MODES[number]
export type ExteriorMode = 'Chase' | 'Orbit' | 'Fixed'
export const isExterior = (mode: CameraMode): mode is ExteriorMode => mode !== 'Follow' && mode !== 'FPV'

export const CAMERA_NEAR_M = 0.005
export const CAMERA_FAR_M = 500
export const cameraPrefKey = (mode: ExteriorMode) => `flight-camera-${mode.toLowerCase()}`
export interface CameraSettings { distanceM: number; heightM: number; fovDeg: number }
export interface CameraDrag { azimuthRad: number; heightM: number }
export const initialDrag: CameraDrag = { azimuthRad: 0, heightM: 0 }

// Reuse the pre-6.8 Follow framing (FlightViewport.tsx:128,136,139).
export function followSettings(geo: FrameGeometry): CameraSettings {
  const distanceM = Math.max(1.2, ...geo.arms.map((arm) => arm.length * 6))
  return { distanceM, heightM: distanceM * 0.7, fovDeg: 45 }
}

export function startingCameraSettings(follow: CameraSettings): CameraSettings {
  return { ...follow, distanceM: Math.hypot(follow.distanceM, follow.distanceM) }
}

export function cameraSettingValid(key: keyof CameraSettings, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (key === 'fovDeg') return value > CAMERA_FOV_DEG.min && value < CAMERA_FOV_DEG.max
  if (key === 'distanceM') return value >= CAMERA_NEAR_M && value <= CAMERA_FAR_M
  return Math.abs(value) <= CAMERA_FAR_M
}

export function cameraSettingsFromPref(value: unknown, starting: CameraSettings): CameraSettings {
  const raw = value && typeof value === 'object' ? value as Partial<Record<keyof CameraSettings, unknown>> : null
  return {
    distanceM: cameraSettingValid('distanceM', raw?.distanceM) ? raw.distanceM : starting.distanceM,
    heightM: cameraSettingValid('heightM', raw?.heightM) ? raw.heightM : starting.heightM,
    fovDeg: cameraSettingValid('fovDeg', raw?.fovDeg) ? raw.fovDeg : starting.fovDeg,
  }
}

function assemblyPartPose(doc: AssemblyDocument, geo: FrameGeometry, partId: string) {
  const position = new Vector3()
  const rotation = new Quaternion()
  worldMatrix(doc, geo, partId).decompose(position, rotation, new Vector3())
  return { position: position.toArray(), rotation: rotation.normalize().toArray() }
}

export function cameraMount(doc: AssemblyDocument, geo: FrameGeometry, part: AssemblyPart): CameraPose | undefined {
  if (part.kind !== 'camera' || !cameraSettingValid('fovDeg', part.cameraFovDeg)) return undefined
  const { position, rotation } = assemblyPartPose(doc, geo, part.id)
  return { positionM: position, quaternion: rotation, fovDeg: part.cameraFovDeg }
}

/** Keep the mounted camera's children in the same rendered poses. */
export function hideCameraPart(doc: AssemblyDocument, geo: FrameGeometry, partId: string): AssemblyDocument {
  return {
    ...doc,
    parts: doc.parts.filter((part) => part.id !== partId).map((part) => part.parentId === partId
      ? { ...part, ...assemblyPartPose(doc, geo, part.id), parentId: null, mountId: null }
      : part),
  }
}

export interface CameraViewState {
  mode?: CameraMode
  heading?: number
  fixedAnchor?: Vec3
  lastTimeS?: number
  running?: boolean
  pose?: CameraPose
}

export function viewCameraPose(
  state: CameraViewState, frame: FlightFrame, mode: CameraMode, running: boolean, deltaS: number,
  follow: CameraSettings, exterior: CameraSettings, drag: CameraDrag, mount?: CameraPose,
): CameraPose {
  if (mode !== state.mode || (running && !state.running) || frame.timeS < (state.lastTimeS ?? frame.timeS)) {
    state.heading = undefined
    state.fixedAnchor = undefined
    state.pose = undefined
  }
  state.mode = mode
  state.running = running
  state.lastTimeS = frame.timeS
  const { distanceM, heightM, fovDeg } = exterior
  // Start on the same side as Follow's (-distance, -distance) world offset.
  const azimuthRad = Math.atan2(-1, -1) + drag.azimuthRad
  switch (mode) {
    case 'Chase':
      state.heading = easeChaseHeading(state.heading, chaseHeading(frame), deltaS)
      return chaseCameraPose(frame, distanceM, heightM, fovDeg, state.heading)
    case 'Orbit':
      return orbitCameraPose(frame, azimuthRad, distanceM, heightM + drag.heightM, fovDeg)
    case 'Fixed': {
      const anchor = state.fixedAnchor ??= [...frame.positionM]
      const position: Vec3 = [
        anchor[0] + distanceM * Math.cos(azimuthRad),
        anchor[1] + distanceM * Math.sin(azimuthRad),
        anchor[2] + heightM + drag.heightM,
      ]
      if (state.pose && position.every((value, axis) => value === frame.positionM[axis])) {
        return { ...state.pose, positionM: position, fovDeg }
      }
      return state.pose = fixedCameraPose(frame, position, fovDeg)
    }
    case 'FPV':
      if (mount) return fpvCameraPose(frame, mount)
      return followCameraPose(frame, follow.distanceM, follow.heightM, follow.fovDeg)
    case 'Follow':
      return followCameraPose(frame, follow.distanceM, follow.heightM, follow.fovDeg)
  }
}
