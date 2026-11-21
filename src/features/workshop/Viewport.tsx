import '@/three/setup'
import { CameraControls, GizmoHelper, GizmoViewport, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type CameraControlsImpl from 'camera-controls'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PMREMGenerator, Sphere, Vector3 } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import {
  EMPTY_SCENE_BOUNDS,
  allOnScreen,
  boundingSphere,
  corners,
  presetPosition,
  type Bounds,
  type Vec3,
  type ViewPreset,
} from '@/three/views'
import { cn } from '@/lib/utils'
import { registerTestHook, testHooksEnabled } from '@/lib/test-hooks'
import { NO_CAPTURE, setViewportCapture } from './capture'
import { LabelContext, LabelProjector, LabelRegistry } from './screen-labels'
import { useWorkshopView } from './view-store'

// Viewport palette (sRGB hex; three.js materials do not read CSS variables).
const COLORS = {
  background: '#101215',
  gridMinor: '#1d2025',
  gridMajor: '#2b3038',
  axisX: '#e0605a', // forward
  axisY: '#6fc27a', // left
  axisZ: '#5aa7e0', // up
}

/** Distance from the bounding sphere to the frame edge, as a fraction of the radius. */
const FIT_PADDING = 1.12

export function Viewport({
  bounds = EMPTY_SCENE_BOUNDS,
  focusBounds,
  children,
  overlay,
}: {
  bounds?: Bounds
  /** What "fit" frames when set (the selection); otherwise `bounds`. */
  focusBounds?: Bounds | null
  /** Scene content, rendered inside the canvas. */
  children?: ReactNode
  /** DOM content above the canvas, e.g. `ScreenLabel`s. */
  overlay?: ReactNode
}) {
  const projection = useWorkshopView((s) => s.projection)
  const showGrid = useWorkshopView((s) => s.showGrid)
  const measuring = useWorkshopView((s) => s.measuring)
  const [labels] = useState(() => new LabelRegistry())

  return (
    <LabelContext.Provider value={labels}>
    <div
      data-testid="viewport-3d"
      data-projection={projection}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden"
      style={{ background: COLORS.background }}
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true }}
        onPointerMissed={() => {
          if (!useWorkshopView.getState().measuring) useWorkshopView.getState().selectMount(null)
        }}
        fallback={
          <p className="p-6 text-[12.5px] text-fg-muted">
            WebGL is not available, so the 3D viewport cannot be shown. Update the graphics driver or enable
            hardware acceleration.
          </p>
        }
      >
        <color attach="background" args={[COLORS.background]} />
        {projection === 'perspective' ? (
          <PerspectiveCamera makeDefault fov={35} near={0.005} far={200} />
        ) : (
          <OrthographicCamera makeDefault near={-100} far={100} />
        )}
        <CameraRig bounds={bounds} focusBounds={focusBounds ?? null} />
        <SceneEnvironment />
        <hemisphereLight args={['#dfe6ee', '#1a1d21', 0.45]} />
        <directionalLight position={[2, -1.5, 3]} intensity={1.4} />
        <directionalLight position={[-2, 2, 1.2]} intensity={0.35} />
        {showGrid && <GroundGrid />}
        <OriginAxes />
        {children}
        <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
          <GizmoViewport
            disabled
            axisColors={[COLORS.axisX, COLORS.axisY, COLORS.axisZ]}
            labelColor="#0c0d0f"
            hideNegativeAxes
          />
        </GizmoHelper>
        <FramingProbe bounds={bounds} />
        <CaptureBinder />
        <RenderCounter />
        <LabelProjector />
        {testHooksEnabled() && <TestProjector />}
      </Canvas>
      {/* While measuring, labels must not take the clicks meant for the model under them. */}
      <div
        className={cn('pointer-events-none absolute inset-0 overflow-hidden', measuring && '[&_*]:!pointer-events-none')}
      >
        {overlay}
      </div>
    </div>
    </LabelContext.Provider>
  )
}

/**
 * Owns the camera controls. Applies view presets and "fit", re-frames on resize
 * until the user moves the camera by hand, and keeps the viewing direction when
 * switching between perspective and orthographic projection.
 */
function CameraRig({ bounds, focusBounds }: { bounds: Bounds; focusBounds: Bounds | null }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const [controls, setControls] = useState<CameraControlsImpl | null>(null)
  const request = useWorkshopView((s) => s.request)
  const userMoved = useWorkshopView((s) => s.userMoved)
  // Re-frame automatically on resize until the user takes over the camera.
  const autoFit = useRef(true)
  // Start from the preset the toolbar shows, so the status strip and camera agree.
  const preset = useRef<ViewPreset>(useWorkshopView.getState().preset ?? 'iso')
  const pose = useRef<{ position: Vector3; target: Vector3 } | null>(null)

  const fit = (c: CameraControlsImpl, transition: boolean, b: Bounds = bounds) => {
    const { center, radius } = boundingSphere(b)
    void c.fitToSphere(new Sphere(new Vector3(...center), radius * FIT_PADDING), transition)
  }
  const lookFrom = (c: CameraControlsImpl, p: ViewPreset, transition: boolean) => {
    const { center } = boundingSphere(bounds)
    const pos: Vec3 = presetPosition(p, bounds)
    void c.setLookAt(...pos, ...center, transition)
    fit(c, transition)
  }

  // New controls instance (first mount or projection switch): restore direction, then frame.
  useEffect(() => {
    if (!controls) return
    controls.updateCameraUp()
    if (pose.current) {
      const { position: p, target: t } = pose.current
      void controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false)
      fit(controls, false)
    } else {
      lookFrom(controls, preset.current, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per controls instance
  }, [controls])

  useEffect(() => {
    if (!controls || !request) return
    autoFit.current = true
    if (request.kind === 'preset') {
      preset.current = request.preset
      lookFrom(controls, request.preset, true)
    } else {
      // Fitting a selection is a deliberate camera move: no auto re-framing to the whole assembly after it.
      if (focusBounds) autoFit.current = false
      fit(controls, true, focusBounds ?? bounds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to new requests only
  }, [request])

  // Re-frame on viewport resize and when the framed content changes size,
  // until the user takes over the camera.
  const boundsKey = [...bounds.min, ...bounds.max].join(',')
  useEffect(() => {
    if (controls && autoFit.current) fit(controls, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on size and bounds only
  }, [size.width, size.height, boundsKey])

  return (
    <CameraControls
      key={camera.uuid}
      ref={setControls}
      makeDefault
      minDistance={0.02}
      maxDistance={50}
      onStart={() => {
        autoFit.current = false
        userMoved()
      }}
      onChange={() => {
        if (!controls) return
        pose.current = { position: controls.getPosition(new Vector3()), target: controls.getTarget(new Vector3()) }
      }}
    />
  )
}

/** Ground plane grid: 10 mm cells, 100 mm major lines, 2 m across. */
function GroundGrid() {
  return (
    <group rotation-x={Math.PI / 2}>
      <gridHelper args={[2, 200, COLORS.gridMinor, COLORS.gridMinor]} />
      <gridHelper args={[2, 20, COLORS.gridMajor, COLORS.gridMajor]} position-y={0.0001} />
    </group>
  )
}

/** 100 mm axis lines at the origin: X red (forward), Y green (left), Z blue (up). */
function OriginAxes() {
  const len = 0.1
  const axes: [Vec3, string][] = [
    [[len, 0, 0], COLORS.axisX],
    [[0, len, 0], COLORS.axisY],
    [[0, 0, len], COLORS.axisZ],
  ]
  return (
    <group position-z={0.0002}>
      {axes.map(([end, color]) => (
        <line key={color}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0, ...end]), 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={color} />
        </line>
      ))}
    </group>
  )
}

/**
 * Image-based lighting from three's procedural RoomEnvironment (no files are
 * downloaded): metal and clear-coated carbon get believable reflections.
 */
function SceneEnvironment() {
  const get = useThree((s) => s.get)
  useEffect(() => {
    const { gl, scene, invalidate } = get()
    const pmrem = new PMREMGenerator(gl)
    const room = new RoomEnvironment()
    const env = pmrem.fromScene(room, 0.04).texture
    scene.environment = env
    scene.environmentIntensity = 0.55
    invalidate()
    return () => {
      scene.environment = null
      env.dispose()
      room.dispose()
      pmrem.dispose()
    }
  }, [get])
  return null
}

/**
 * Counts rendered frames on `window.__blazeRenders`. With on-demand rendering this
 * is how tests check that an idle viewport renders nothing and measure the frame
 * rate while orbiting. Costs one increment per frame.
 */
function RenderCounter() {
  useFrame(() => {
    const w = window as unknown as { __blazeRenders?: number }
    w.__blazeRenders = (w.__blazeRenders ?? 0) + 1
  })
  return null
}

/**
 * Test hook (test and development builds only): `__blazeTest.projectObject(name)` gives the
 * screen position (client pixels) of the named scene object's origin, e.g. a part, so an
 * end-to-end test can press on its gizmo with the real pointer.
 */
function TestProjector() {
  const get = useThree((s) => s.get)
  useEffect(
    () =>
      registerTestHook('projectObject', (name: string) => {
        const { scene, camera, gl } = get()
        const obj = scene.getObjectByName(name)
        if (!obj) return null
        const v = obj.getWorldPosition(new Vector3()).project(camera)
        const r = gl.domElement.getBoundingClientRect()
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
      }),
    [get],
  )
  return null
}

/**
 * Registers the image capture: renders one frame of the scene (without the gizmo or
 * the axis widget) at device pixels, at least 2×, and encodes it as PNG. The image
 * is read right after rendering, so the canvas does not need `preserveDrawingBuffer`.
 */
function CaptureBinder() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    setViewportCapture(async () => {
      const prev = gl.getPixelRatio()
      const ratio = Math.max(prev, 2)
      const hidden: { visible: boolean }[] = []
      scene.traverse((o) => {
        if (o.userData[NO_CAPTURE] && o.visible) {
          o.visible = false
          hidden.push(o)
        }
      })
      try {
        if (ratio !== prev) gl.setPixelRatio(ratio)
        gl.render(scene, camera)
        const blob = await new Promise<Blob | null>((resolve) => gl.domElement.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('The 3D view could not be encoded as PNG.')
        return new Uint8Array(await blob.arrayBuffer())
      } finally {
        for (const o of hidden) o.visible = true
        if (ratio !== prev) gl.setPixelRatio(prev)
        invalidate()
      }
    })
    return () => setViewportCapture(null)
  }, [gl, scene, camera, invalidate])
  return null
}

/**
 * Reports on the viewport element whether the framed bounds are fully on screen
 * (`data-bounds-in-view`). Runs only when a frame is rendered (demand mode), so it
 * costs nothing while idle. Used by end-to-end tests to verify framing on resize.
 */
function FramingProbe({ bounds }: { bounds: Bounds }) {
  const gl = useThree((s) => s.gl)
  const last = useRef<string | null>(null)
  useFrame(({ camera }) => {
    const ndc = corners(bounds).map((c) => {
      const v = new Vector3(...c).project(camera)
      return [v.x, v.y, v.z] as const
    })
    const value = String(allOnScreen(ndc))
    if (value === last.current) return
    last.current = value
    gl.domElement.closest('[data-testid=viewport-3d]')?.setAttribute('data-bounds-in-view', value)
  })
  return null
}
