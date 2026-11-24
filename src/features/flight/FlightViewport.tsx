import '@/three/setup'
import { Canvas, useFrame } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport } from '@react-three/drei'
import { Suspense, useMemo, useRef, useState, type PointerEvent } from 'react'
import { DoubleSide, Quaternion, Vector3, type Group, type Mesh } from 'three'
import type { AssemblyDocument, AssemblyPart, Spin } from '../../../electron/ipc/contract'
import type { FrameGeometry } from '@/three/frame-geometry'
import { FrameModel } from '../workshop/FrameModel'
import { PartsModel } from '../workshop/PartsModel'
import { mountFrames, shapeExtent, subtreeIds, worldMatrix, type AssetBounds } from '../workshop/assembly-ops'
import { useAssets } from '../workshop/asset-store'
import { EnvironmentMeshes } from '../workshop/environment/EnvironmentMeshes'
import { useComponentIndex } from '../workshop/component-index'
import { linkedComponent, type ComponentIndex } from '../workshop/links'
import { PropellerModel } from '@/three/part-models'
import { toSI, type Unit } from '@/domain/units'
import { frameToPose, type FlightFrame } from './frame'
import { integrateRotorAngle, ROTOR_BLUR_THRESHOLD_RADPS, rotorIsBlurred } from './rotor-spin'
import { readPref, writePref } from '@/lib/prefs'
import { CameraRig, FlightCameraControls } from './camera-controls'
import {
  CAMERA_FAR_M, CAMERA_NEAR_M, cameraMount, cameraPrefKey, cameraSettingsFromPref, cameraSettingValid, followSettings,
  hideCameraPart, initialDrag, isExterior, startingCameraSettings, type CameraDrag, type CameraMode,
  type CameraSettings, type ExteriorMode,
} from './camera-view'

const readCameraSettings = (mode: ExteriorMode, starting: CameraSettings) =>
  cameraSettingsFromPref(readPref<unknown>(cameraPrefKey(mode), null), starting)

function FlightParts({ frame, doc, geo, hiddenCameraId }: {
  frame: FlightFrame; doc: AssemblyDocument; geo: FrameGeometry; hiddenCameraId?: string
}) {
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const models = useMemo(() => flightRotorModels(doc, geo, components, assets), [doc, geo, components, assets])
  const stationary = useMemo(() => hiddenCameraId
    ? hideCameraPart(models.stationary, geo, hiddenCameraId) : models.stationary, [models.stationary, geo, hiddenCameraId])
  return <>
    <PartsModel doc={stationary} geo={geo} editable={false} />
    {models.rotors.map((rotor) => <SpinningPropeller key={rotor.prop.id} rotor={rotor} frame={frame} geo={geo} />)}
  </>
}

/** Prepare assembly-space pivots once per assembly change, never in useFrame. */
export function flightRotorModels(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds): { rotors: Rotor[]; stationary: AssemblyDocument } {
    const mounts = mountFrames(geo)
    const moving = new Set<string>()
    const rotors = geo.motors.flatMap((mount, motorIndex) => {
      // Same mount order and attachment rule as mass-input.ts::motorInputs,
      // which supplies the engine's vehicle definition. Never use part order.
      const motor = doc.parts.find((p) => p.kind === 'motor' && p.parentId === null && p.mountId === mount.id)
      if (!motor) return []
      return doc.parts.filter((p) => p.kind === 'propeller' && p.parentId === motor.id).map((prop) => {
        // Preserve attachments to the propeller without drawing any part twice.
        const descendants = subtreeIds(doc, prop.id)
        for (const id of descendants) moving.add(id)
        const position = new Vector3()
        const orientation = new Quaternion()
        worldMatrix(doc, geo, prop.id).decompose(position, orientation, new Vector3())
        const axis = new Vector3(0, 0, 1).applyQuaternion(mounts.get(mount.id)!.quaternion)
        const discOrientation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), axis)
        const component = linkedComponent(prop, components)
        const statedBlades = component?.specs.blades?.value
        // Same unlinked display model as the workshop's PropellerModel (two blades).
        const blades = typeof statedBlades === 'number' ? statedBlades : 2
        const pitch = component?.specs.pitch as { value: number; unit: Unit } | undefined
        const extent = shapeExtent(prop.shape, assets)
        const radius = prop.shape.type === 'cylinder' ? prop.shape.radius : extent ? Math.hypot(extent[0], extent[1]) / 2 : null
        const localDoc: AssemblyDocument = {
          ...doc,
          parts: doc.parts.filter((p) => descendants.has(p.id)).map((p) => p.id === prop.id
            ? { ...p, parentId: null, mountId: null, position: [0, 0, 0], rotation: [0, 0, 0, 1] }
            : p),
        }
        const childrenDoc: AssemblyDocument = {
          ...localDoc,
          parts: localDoc.parts.filter((p) => p.id !== prop.id).map((p) => p.parentId === prop.id ? { ...p, parentId: null } : p),
        }
        return { prop, motorIndex, spin: mount.spin, position, orientation, axis, discOrientation, radius, blades,
          pitch: pitch && typeof pitch.value === 'number' ? toSI(pitch.value, pitch.unit) : undefined,
          carbon: typeof component?.specs.material?.value === 'string' && /CF|carbon/i.test(component.specs.material.value),
          localDoc: { ...localDoc, parts: localDoc.parts.filter((p) => p.id === prop.id) }, childrenDoc }
      })
    })
    return { rotors, stationary: { ...doc, parts: doc.parts.filter((p) => !moving.has(p.id)) } }
}

interface Rotor {
  prop: AssemblyPart
  motorIndex: number
  spin: Spin
  position: Vector3
  orientation: Quaternion
  axis: Vector3
  discOrientation: Quaternion
  radius: number | null
  blades: number
  pitch: number | undefined
  carbon: boolean
  localDoc: AssemblyDocument
  childrenDoc: AssemblyDocument
}

function SpinningPropeller({ rotor, frame, geo }: { rotor: Rotor; frame: FlightFrame; geo: FrameGeometry }) {
  const rotation = useRef<Group>(null)
  const blades = useRef<Group>(null)
  const disc = useRef<Mesh>(null)
  const angle = useRef(0)
  const previousTime = useRef(frame.timeS)
  useFrame((_, dtS) => {
    if (frame.timeS < previousTime.current) angle.current = 0
    previousTime.current = frame.timeS
    const omega = frame.motors[rotor.motorIndex]?.omegaRadps ?? 0
    angle.current = integrateRotorAngle(angle.current, omega, dtS, rotor.spin)
    rotation.current?.quaternion.setFromAxisAngle(rotor.axis, angle.current)
    const blurred = rotor.radius !== null && rotorIsBlurred(omega, dtS, rotor.blades)
    if (blades.current) blades.current.visible = !blurred
    if (disc.current) disc.current.visible = blurred
  })
  return <group position={rotor.position}>
    <group ref={rotation}>
      <group quaternion={rotor.orientation}>
        <group ref={blades}>
          {rotor.prop.shape.type === 'cylinder'
            ? <PropellerModel radius={rotor.prop.shape.radius} height={rotor.prop.shape.height} blades={rotor.blades} spin={rotor.spin} pitch={rotor.pitch} carbon={rotor.carbon} />
            : <PartsModel doc={rotor.localDoc} geo={geo} editable={false} />}
        </group>
        <PartsModel doc={rotor.childrenDoc} geo={geo} editable={false} />
      </group>
    </group>
    {rotor.radius !== null && <mesh ref={disc} quaternion={rotor.discOrientation} visible={false}>
      <circleGeometry args={[rotor.radius, 64]} />
      <meshStandardMaterial color="#8d96a0" side={DoubleSide} transparent opacity={0.25} depthWrite={false} />
    </mesh>}
  </group>
}

export function FlightViewport({ frame, doc, geo, projectId, running = false }: {
  frame: FlightFrame; doc: AssemblyDocument; geo: FrameGeometry; projectId?: string; running?: boolean
}) {
  const pose = frameToPose(frame)
  const follow = useMemo(() => followSettings(geo), [geo])
  const starting = startingCameraSettings(follow)
  const cameraOptions = useMemo(() => ({
    position: [-follow.distanceM, -follow.distanceM, follow.distanceM] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    near: CAMERA_NEAR_M, far: CAMERA_FAR_M, fov: follow.fovDeg,
  }), [follow])
  const [mode, setMode] = useState<CameraMode>('Follow')
  const [partId, choosePart] = useState('')
  const [prefs, setPrefs] = useState<Record<ExteriorMode, CameraSettings>>(() => ({
    Chase: readCameraSettings('Chase', starting),
    Orbit: readCameraSettings('Orbit', starting),
    Fixed: readCameraSettings('Fixed', starting),
  }))
  const [drag, setDrag] = useState<Partial<Record<'Orbit' | 'Fixed', CameraDrag>>>({})
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const cameras = useMemo(() => doc.parts.filter((part) => part.kind === 'camera'), [doc.parts])
  const part = cameras.find((entry) => entry.id === partId)
  const mount = useMemo(() => part && cameraMount(doc, geo, part), [doc, geo, part])
  const activeMode = mode === 'FPV' && !mount ? 'Follow' : mode
  const settings = isExterior(activeMode) ? prefs[activeMode] : starting
  const pointerMode = activeMode === 'Orbit' || activeMode === 'Fixed' ? activeMode : null

  function moveCamera(event: PointerEvent<HTMLDivElement>, mode: 'Orbit' | 'Fixed') {
    if (!pointer.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const { clientWidth, clientHeight } = event.currentTarget
    if (!clientWidth || !clientHeight) return
    // A full-width drag is a revolution. A full-height drag moves one camera radius.
    const azimuthRad = 2 * Math.PI * (pointer.current.x - event.clientX) / clientWidth
    const heightM = settings.distanceM * (event.clientY - pointer.current.y) / clientHeight
    pointer.current = { x: event.clientX, y: event.clientY }
    setDrag((previous) => {
      const current = previous[mode] ?? initialDrag
      return {
        ...previous,
        [mode]: {
          azimuthRad: (current.azimuthRad + azimuthRad) % (2 * Math.PI),
          heightM: Math.max(-CAMERA_FAR_M, Math.min(CAMERA_FAR_M, current.heightM + heightM)),
        },
      }
    })
  }

  return (
    <div className="flex h-full flex-col">
      {projectId && <FlightCameraControls mode={activeMode} setMode={setMode} parts={cameras} part={part} choosePart={(id) => {
        choosePart(id)
        if (mode === 'FPV' && !cameras.some((entry) => entry.id === id && cameraSettingValid('fovDeg', entry.cameraFovDeg))) setMode('Follow')
      }} projectId={projectId} mount={mount} settings={settings} starting={starting} update={(entry, key, value) => {
        const next = { ...prefs[entry], [key]: value }
        writePref(cameraPrefKey(entry), next)
        setPrefs({ ...prefs, [entry]: next })
      }} />}
      <div className="pointer-events-none relative min-h-[240px] flex-1" aria-label="Z-up flight view" data-testid="flight-viewport" data-camera={activeMode}>
        <Canvas camera={cameraOptions} dpr={[1, 2]} fallback={<p className="p-4 text-warn">WebGL is unavailable. Flight diagnostics remain available.</p>}>
          <color attach="background" args={['#101215']} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[3, -2, 5]} intensity={2} />
          <CameraRig frame={frame} mode={activeMode} running={running} follow={follow} exterior={settings}
            drag={pointerMode ? drag[pointerMode] ?? initialDrag : initialDrag} mount={mount} />
          <EnvironmentMeshes environment={doc.environment} />
          <group position={pose.position} quaternion={pose.quaternion}>
            {/* Reused workshop models are display-only here; no editor gizmos or picking. */}
            <group raycast={() => null}>
              <Suspense fallback={null}>
                <FrameModel geo={geo} params={doc.frame} />
                <FlightParts frame={frame} doc={doc} geo={geo} hiddenCameraId={activeMode === 'FPV' ? part?.id : undefined} />
              </Suspense>
            </group>
          </group>
          <mesh position={pose.comWorld} renderOrder={10}>
            <sphereGeometry args={[0.012, 16, 12]} />
            <meshBasicMaterial color="#d9a03f" depthTest={false} />
          </mesh>
          <GizmoHelper alignment="bottom-right" margin={[48, 48]}>
            <GizmoViewport disabled axisColors={['#e0605a', '#6fc27a', '#5aa7e0']} labelColor="#101215" />
          </GizmoHelper>
        </Canvas>
        {pointerMode && <div className="pointer-events-auto absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.currentTarget.setPointerCapture(event.pointerId)
            pointer.current = { x: event.clientX, y: event.clientY }
          }}
          onPointerMove={(event) => moveCamera(event, pointerMode)}
          onLostPointerCapture={() => { pointer.current = null }} />}
        <p className="pointer-events-none absolute left-3 top-3 text-[12px] text-warn">Live engine · {activeMode} camera · Amber sphere: CoM</p>
        <p className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] text-[12px] text-muted">Propeller motion blur: translucent discs at ≥{ROTOR_BLUR_THRESHOLD_RADPS.toFixed(1)} rad/s (900 rpm), or sooner at the display’s blade-sampling limit.</p>
      </div>
    </div>
  )
}
