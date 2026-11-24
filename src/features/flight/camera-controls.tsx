import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { Link } from 'react-router'
import { PerspectiveCamera } from 'three'
import { NumberField } from '@/components/number-field'
import type { AssemblyPart } from '../../../electron/ipc/contract'
import { useAssembly } from '../workshop/assembly-store'
import { useWorkshopView } from '../workshop/view-store'
import {
  CAMERA_MODES, cameraSettingValid, isExterior, viewCameraPose,
  type CameraDrag, type CameraMode, type CameraSettings, type CameraViewState,
} from './camera-view'
import { toThreeCameraQuaternion, type CameraPose } from './cameras'
import type { FlightFrame } from './frame'

export function CameraRig({ frame, mode, running, follow, exterior, drag, mount }: {
  frame: FlightFrame
  mode: CameraMode
  running: boolean
  follow: CameraSettings
  exterior: CameraSettings
  drag: CameraDrag
  mount?: CameraPose
}) {
  const view = useRef<CameraViewState>({})
  useFrame(({ camera }, deltaS) => {
    const pose = viewCameraPose(view.current, frame, mode, running, deltaS, follow, exterior, drag, mount)
    camera.position.set(...pose.positionM)
    camera.quaternion.copy(toThreeCameraQuaternion(pose.quaternion))
    if (camera instanceof PerspectiveCamera && camera.fov !== pose.fovDeg) {
      camera.fov = pose.fovDeg
      camera.updateProjectionMatrix()
    }
  })
  return null
}

const numericFields = [
  ['distanceM', 'Distance', 'm'],
  ['heightM', 'Height offset', 'm'],
  ['fovDeg', 'Vertical FOV', '°'],
] as const

function selectPartAfterWorkshopLoads(projectId: string, partId: string) {
  // WorkshopPage.tsx:226–235 reloads the assembly and clears selection on entry.
  const unsubscribe = useAssembly.subscribe((next, previous) => {
    if (next.loading || !previous.loading) return
    unsubscribe()
    if (window.location.hash === `#/workshop/${projectId}` && next.projectId === projectId
      && next.doc?.parts.some((entry) => entry.id === partId)) {
      useWorkshopView.getState().selectPart(partId)
    }
  })
}

export function FlightCameraControls({ mode, setMode, parts, part, choosePart, projectId, mount, settings, starting, update }: {
  mode: CameraMode
  setMode: (mode: CameraMode) => void
  parts: AssemblyPart[]
  part?: AssemblyPart
  choosePart: (id: string) => void
  projectId: string
  mount?: CameraPose
  settings: CameraSettings
  starting: CameraSettings
  update: (mode: 'Chase' | 'Orbit' | 'Fixed', key: keyof CameraSettings, value: number) => void
}) {
  return (
    <div className="space-y-1 border-b border-line px-3 py-2 text-[12px] text-fg-muted"
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label>
          Camera view{' '}
          <select aria-label="Camera view" className="rounded border border-line bg-chrome text-fg" value={mode}
            onChange={(event) => {
              const next = CAMERA_MODES.find((entry) => entry === event.currentTarget.value)
              if (next) setMode(next)
            }}>
            {CAMERA_MODES.map((entry) => (
              <option key={entry} value={entry} disabled={entry === 'FPV' && !mount}>
                {entry === 'FPV' && !mount ? 'FPV (unavailable)' : entry}
              </option>
            ))}
          </select>
        </label>
        {parts.length > 0 && (
          <label>
            FPV camera part{' '}
            <select aria-label="FPV camera part" className="rounded border border-line bg-chrome text-fg" value={part?.id ?? ''}
              onChange={(event) => choosePart(event.currentTarget.value)}>
              <option value="">Choose a part</option>
              {parts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
        )}
        {!mount && (
          part ? (
            <Link className="text-accent underline" to={`/workshop/${projectId}`}
              onClick={(event) => {
                if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
                  selectPartAfterWorkshopLoads(projectId, part.id)
                }
              }}>Set vertical FOV on {part.name}</Link>
          ) : parts.length > 0 ? (
            <span>Choose a camera part to use FPV.</span>
          ) : (
            <Link className="text-accent underline" to={`/workshop/${projectId}`}>Add a camera part for FPV</Link>
          )
        )}
      </div>
      {isExterior(mode) && (
        <div>
          <p>Starting view preferences · {starting.distanceM.toFixed(2)} m distance · {starting.heightM.toFixed(2)} m height offset · {starting.fovDeg}° vertical FOV</p>
          <div className="flex flex-wrap gap-x-4">
            {numericFields.map(([key, label, unit]) => (
              <NumberField key={`${mode}:${key}:${settings[key]}`} id={`flight-camera-${key}`}
                label={label} unit={unit} initial={String(settings[key])}
                parse={(text) => {
                  const value = Number(text.trim().replace(',', '.'))
                  return text.trim() && cameraSettingValid(key, value)
                    ? { ok: true, value }
                    : { ok: false, message: key === 'fovDeg' ? 'Enter an angle between 0° and 180° (exclusive)' : 'Enter a distance within the viewing range' }
                }}
                onCommit={(value) => update(mode, key, value)} />
            ))}
          </div>
          {(mode === 'Orbit' || mode === 'Fixed') && <p>Drag the flight view to reposition the camera.</p>}
        </div>
      )}
    </div>
  )
}
