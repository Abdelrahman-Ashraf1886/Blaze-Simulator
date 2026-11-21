import { Edges, TransformControls } from '@react-three/drei'
import { useLoader, type ThreeEvent } from '@react-three/fiber'
import { Component, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Vector3, type Mesh, type Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { assetUrl, type AssemblyDocument, type AssemblyPart, type PartKind, type PartShape } from '../../../electron/ipc/contract'
import type { FrameGeometry } from '@/three/frame-geometry'
import { placeModel } from '@/three/model-units'
import type { Vec3 } from '@/three/views'
import { attach, halfHeight, mountFrames, resizable, scaledShape, shapeExtent, updatePart } from './assembly-ops'
import { useAssembly } from './assembly-store'
import { editSize } from './place-actions'
import { useAssets } from './asset-store'
import { NO_CAPTURE } from './capture'
import { mountPoints, snapMount } from './inspection'
import { useComponentIndex } from './component-index'
import { linkedComponent, type ComponentIndex } from './links'
import { toSI, type Unit } from '@/domain/units'
import {
  BatteryModel,
  EscModel,
  FlightControllerModel,
  GpsModel,
  ModuleModel,
  PowerModuleModel,
  CameraModel,
  LandingGearModel,
  RadioModel,
  MotorModel,
  PropellerModel,
} from '@/three/part-models'
import { SNAP_DEG, SNAP_MM, useWorkshopView } from './view-store'

// sRGB hex; three.js materials do not read CSS variables.
const KIND_COLOR: Record<PartKind, string> = {
  motor: '#7b838d',
  propeller: '#8d96a0',
  battery: '#5f6b5c',
  'flight-controller': '#4f5f6e',
  esc: '#5d5868',
  gps: '#4f5f6e',
  camera: '#585e66',
  sensor: '#5d5868',
  'landing-gear': '#5f6670',
  payload: '#6b6255',
  custom: '#666c74',
}
const EDGE = '#9aa3ad'
const SELECTED = '#62d2e0'

/**
 * Renders every part inside the frame of what it is attached to (a mount or a
 * parent part), so attached parts follow frame edits and motor tilt. The
 * selected part gets a move/rotate gizmo; one drag = one undo step.
 */
export function PartsModel({
  doc,
  geo,
  editable = true,
}: {
  /** The document as displayed (exploded positions in exploded view). */
  doc: AssemblyDocument
  geo: FrameGeometry
  /** False in exploded view: the gizmo is hidden so display offsets are never saved. */
  editable?: boolean
}) {
  const selection = useWorkshopView((s) => s.selection)
  const detail = useWorkshopView((s) => s.detail)
  const components = useComponentIndex()
  const gizmo = useWorkshopView((s) => s.gizmo)
  const snap = useWorkshopView((s) => s.snap)
  const frames = useMemo(() => mountFrames(geo), [geo])
  // Object3D of each rendered part, for the gizmo. Updated only when parts mount/unmount.
  const [objects, setObjects] = useState<ReadonlyMap<string, Object3D>>(() => new Map())
  const onObject = useCallback((id: string, obj: Object3D | null) => {
    setObjects((prev) => {
      if (obj ? prev.get(id) === obj : !prev.has(id)) return prev
      const next = new Map(prev)
      if (obj) next.set(id, obj)
      else next.delete(id)
      return next
    })
  }, [])

  const children = useMemo(() => {
    const byParent = new Map<string, AssemblyPart[]>()
    for (const p of doc.parts) {
      const key = p.parentId ?? (p.mountId && frames.has(p.mountId) ? `mount:${p.mountId}` : 'world')
      byParent.set(key, [...(byParent.get(key) ?? []), p])
    }
    return byParent
  }, [doc.parts, frames])

  const byId = useMemo(() => new Map(doc.parts.map((p) => [p.id, p])), [doc.parts])
  const node = (p: AssemblyPart) => (
    <PartNode
      key={p.id}
      part={p}
      selected={selection?.kind === 'part' && selection.id === p.id}
      onObject={onObject}
      look={detail ? lookOf(p, byId, geo, components) : null}
    >
      {(children.get(p.id) ?? []).map(node)}
    </PartNode>
  )

  const selectedId = selection?.kind === 'part' ? selection.id : null
  const target = selectedId ? objects.get(selectedId) : undefined
  const selectedPart = selectedId ? doc.parts.find((p) => p.id === selectedId) : undefined

  return (
    <>
      {(children.get('world') ?? []).map(node)}
      {[...frames].map(([mountId, f]) => {
        const attached = children.get(`mount:${mountId}`)
        if (!attached) return null
        return (
          <group key={mountId} position={f.position} quaternion={f.quaternion}>
            {attached.map(node)}
          </group>
        )
      })}
      {editable && target && selectedPart && (
        <TransformControls
          ref={drawOnTop}
          key={`${selectedPart.id}:${gizmo}`}
          object={target}
          mode={gizmo === 'scale' && !resizable(selectedPart) ? 'translate' : gizmo}
          size={0.8}
          translationSnap={snap ? SNAP_MM / 1000 : null}
          rotationSnap={snap ? (SNAP_DEG * Math.PI) / 180 : null}
          // Moving with snapping on: a mount under the part lights up, and releasing attaches there.
          onObjectChange={() => {
            if (gizmo === 'scale') return
            const q = target.quaternion.clone().normalize()
            useWorkshopView.getState().setDragPose({
              id: selectedPart.id,
              position: [target.position.x, target.position.y, target.position.z],
              rotation: [q.x, q.y, q.z, q.w],
            })
            if (gizmo !== 'translate' || !snap) return
            const c = target.getWorldPosition(new Vector3())
            const h = halfHeight(selectedPart.shape, useAssets.getState().assets)
            const current = selectedPart.parentId === null ? selectedPart.mountId : null
            useWorkshopView.getState().setSnapTarget(snapMount(geo, [c.x, c.y, c.z], h, current))
          }}
          onMouseUp={() => {
            useWorkshopView.getState().setDragPose(null)
            if (gizmo === 'scale' && resizable(selectedPart)) {
              const s = target.scale.clone()
              target.scale.set(1, 1, 1)
              const shape = scaledShape(selectedPart.shape, [Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)])
              if (shape && JSON.stringify(shape) !== JSON.stringify(selectedPart.shape)) {
                editSize(`Resize ${selectedPart.name}`, geo, selectedPart, { shape })
              }
              return
            }
            const mountId = useWorkshopView.getState().snapTarget
            useWorkshopView.getState().setSnapTarget(null)
            if (mountId) {
              const label = mountPoints(geo).find((m) => m.id === mountId)?.label ?? mountId
              const assets = useAssets.getState().assets
              useAssembly
                .getState()
                .edit(`Attach ${selectedPart.name} to ${label}`, (d) =>
                  attach(d, geo, selectedPart.id, { kind: 'mount', id: mountId }, assets),
                )
              return
            }
            const o = target
            const position: [number, number, number] = [o.position.x, o.position.y, o.position.z].map(
              (v) => Math.round(v * 1e7) / 1e7,
            ) as [number, number, number]
            const q = o.quaternion.clone().normalize()
            const rotation: [number, number, number, number] = [q.x, q.y, q.z, q.w]
            const same =
              position.every((v, i) => v === selectedPart.position[i]) &&
              rotation.every((v, i) => Math.abs(v - selectedPart.rotation[i]!) < 1e-12)
            if (same) return
            useAssembly
              .getState()
              .edit(`${gizmo === 'translate' ? 'Move' : 'Rotate'} ${selectedPart.name}`, (d) =>
                updatePart(d, selectedPart.id, { position, rotation }),
              )
          }}
        />
      )}
    </>
  )
}

/** What a detailed model needs beyond the part's shape. */
interface Look {
  spin: 'cw' | 'ccw'
  blades: number
  ports: number
  /** Stated propeller pitch in metres, if linked. */
  pitch?: number
  /** Carbon-fibre propeller (from the linked component's material). */
  carbon: boolean
  /** Linked component category and peripheral role, to pick GPS / radio / power-module models. */
  category?: string
  role?: string
}

/** Spin from the motor mount the part (or its root) sits on; blades and ports from a linked component. */
function lookOf(part: AssemblyPart, byId: ReadonlyMap<string, AssemblyPart>, geo: FrameGeometry, components: ComponentIndex): Look {
  let root = part
  for (let i = 0; root.parentId && byId.has(root.parentId) && i < 64; i++) root = byId.get(root.parentId)!
  const spin = geo.motors.find((m) => m.id === root.mountId)?.spin ?? 'ccw'
  const c = linkedComponent(part, components)
  const blades = typeof c?.specs.blades?.value === 'number' ? (c.specs.blades.value as number) : 2
  const ports = Array.isArray(c?.specs.ports?.value) ? (c.specs.ports.value as unknown[]).length : 6
  const p = c?.specs.pitch as { value: number; unit: Unit } | undefined
  const material = c?.specs.material?.value
  return {
    spin,
    blades,
    ports,
    pitch: p && typeof p.value === 'number' ? toSI(p.value, p.unit) : undefined,
    carbon: typeof material === 'string' && /CF|carbon/i.test(material),
    category: c?.category,
    role: typeof c?.specs.role?.value === 'string' ? (c.specs.role.value as string) : undefined,
  }
}

/** A detailed model for the part's kind and envelope, or null to draw the plain shape. */
function detailedModel(part: AssemblyPart, look: Look): ReactNode {
  const s = part.shape
  if (s.type === 'cylinder') {
    if (part.kind === 'motor') return <MotorModel radius={s.radius} height={s.height} />
    if (part.kind === 'propeller')
      return <PropellerModel radius={s.radius} height={s.height} blades={look.blades} spin={look.spin} pitch={look.pitch} carbon={look.carbon} />
    return null
  }
  if (s.type !== 'box') return null
  if (part.kind === 'battery') return <BatteryModel size={s.size} />
  if (part.kind === 'esc') return <EscModel size={s.size} />
  if (part.kind === 'flight-controller') return <FlightControllerModel size={s.size} ports={look.ports} />
  if (look.category === 'power-module') return <PowerModuleModel size={s.size} />
  if (look.role === 'gps' || part.kind === 'gps') return <GpsModel size={s.size} />
  if (part.kind === 'camera') return <CameraModel size={s.size} />
  if (part.kind === 'landing-gear') return <LandingGearModel size={s.size} />
  if (part.kind === 'sensor') return <ModuleModel size={s.size} />
  if (look.role === 'telemetry-radio') return <RadioModel size={s.size} />
  if (part.kind === 'payload') return <ModuleModel size={s.size} />
  return null
}

function PartNode({
  part,
  selected,
  onObject,
  look,
  children,
}: {
  part: AssemblyPart
  selected: boolean
  onObject: (id: string, obj: Object3D | null) => void
  /** Null: plain shapes. */
  look: Look | null
  children: ReactNode
}) {
  const ref = useCallback((obj: Object3D | null) => onObject(part.id, obj), [onObject, part.id])
  const select = (e: ThreeEvent<MouseEvent>) => {
    if (useWorkshopView.getState().measuring) return // the measure tool takes the click
    e.stopPropagation()
    useWorkshopView.getState().selectPart(part.id)
  }
  const color = KIND_COLOR[part.kind]
  const shape = part.shape
  const model = look ? detailedModel(part, look) : null
  if (model) {
    return (
      <group ref={ref} position={part.position} quaternion={part.rotation} name={part.name}>
        {selected && <DimensionLines shape={shape} />}
        {/* The envelope takes the clicks (thin blades are hard to hit) and shows the selection. */}
        <Envelope shape={shape} selected={selected} onClick={select} />
        {model}
        {children}
      </group>
    )
  }
  return (
    <group ref={ref} position={part.position} quaternion={part.rotation} name={part.name}>
      {shape.type === 'box' && (
        <mesh onClick={select}>
          <boxGeometry args={shape.size} />
          <meshStandardMaterial color={color} roughness={0.65} metalness={0.1} transparent={false} />
          <Edges color={selected ? SELECTED : EDGE} />
        </mesh>
      )}
      {selected && <DimensionLines shape={shape} />}
      {shape.type === 'model' && <ModelShape shape={shape} selected={selected} onClick={select} />}
      {shape.type === 'cylinder' && (
        // Cylinder axis along the part's local Z.
        <mesh onClick={select} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[shape.radius, shape.radius, shape.height, 48]} />
          <meshStandardMaterial
            color={color}
            roughness={0.6}
            metalness={0.1}
            transparent={part.kind === 'propeller'}
            opacity={part.kind === 'propeller' ? 0.35 : 1}
          />
          <Edges color={selected ? SELECTED : EDGE} threshold={30} />
        </mesh>
      )}
      {children}
    </group>
  )
}

type ModelShapeProps = { shape: Extract<PartShape, { type: 'model' }>; selected: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void }

/**
 * An imported model, converted to metres and Z-up and centred on the part origin
 * (see model-units.ts). While loading, or if the file cannot be shown, its
 * bounding box is drawn instead so the part stays visible and selectable.
 */
function ModelShape({ shape, selected, onClick }: ModelShapeProps) {
  const asset = useAssets((s) => s.assets[shape.assetId])
  if (!asset) return null
  const placement = placeModel(asset.bounds, shape.units, shape.upAxis)
  const box = <BoundsBox extent={placement.extent} selected={selected} onClick={onClick} solid={false} />
  return (
    <ModelErrorBoundary assetId={shape.assetId} fallback={box}>
      <Suspense fallback={box}>
        <group onClick={onClick} quaternion={placement.rotation} scale={placement.scale}>
          <LoadedModel assetId={shape.assetId} offset={placement.offset} />
        </group>
        {selected && <BoundsBox extent={placement.extent} selected solid={false} />}
      </Suspense>
    </ModelErrorBoundary>
  )
}

function LoadedModel({ assetId, offset }: { assetId: string; offset: Vec3 }) {
  const gltf = useLoader(GLTFLoader, assetUrl(assetId))
  // The loader caches one scene per file; every part needs its own copy.
  const scene = useMemo(() => cloneSkinned(gltf.scene), [gltf])
  useEffect(() => {
    let triangles = 0
    scene.traverse((o) => {
      const g = (o as Mesh).isMesh ? (o as Mesh).geometry : null
      if (g) triangles += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3
    })
    useAssets.getState().setStatus(assetId, { state: 'loaded', triangles: Math.round(triangles) })
  }, [scene, assetId])
  return <primitive object={scene} position={[...offset]} />
}

function BoundsBox({
  extent,
  selected,
  solid,
  onClick,
}: {
  extent: Vec3
  selected: boolean
  solid: boolean
  onClick?: (e: ThreeEvent<MouseEvent>) => void
}) {
  return (
    <mesh onClick={onClick}>
      <boxGeometry args={extent.map((v) => Math.max(v, 1e-4)) as [number, number, number]} />
      <meshBasicMaterial transparent opacity={solid ? 1 : 0} depthWrite={false} />
      <Edges color={selected ? SELECTED : EDGE} />
    </mesh>
  )
}

class ModelErrorBoundary extends Component<{ assetId: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    useAssets.getState().setStatus(this.props.assetId, { state: 'error', message })
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Invisible envelope of a detailed part: click target, and its outline when selected. */
function Envelope({ shape, selected, onClick }: { shape: PartShape; selected: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  if (shape.type === 'box') {
    return (
      <mesh onClick={onClick}>
        <boxGeometry args={shape.size} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        {selected && <Edges color={SELECTED} />}
      </mesh>
    )
  }
  if (shape.type === 'cylinder') {
    return (
      <mesh onClick={onClick} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[shape.radius, shape.radius, shape.height, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        {selected && <Edges color={SELECTED} threshold={30} />}
      </mesh>
    )
  }
  return null
}

/**
 * The gizmo's materials already skip the depth test, but opaque and transparent
 * parts drawn after it still cover it. Drawing it last keeps it visible.
 */
function drawOnTop(controls: Object3D | null) {
  if (controls) controls.userData[NO_CAPTURE] = true // not part of saved images
  controls?.traverse((o) => {
    o.renderOrder = 1000
  })
}

const AXIS = ['#e0605a', '#6fc27a', '#5aa7e0'] as const

/**
 * Extent lines of the selected part along its own X, Y and Z, from one corner of
 * its bounding box. Drawn over everything; the mm labels are `DimensionLabels`.
 */
function DimensionLines({ shape }: { shape: PartShape }) {
  const assets = useAssets((s) => s.assets)
  const e = shapeExtent(shape, assets)
  if (!e) return null
  const [hx, hy, hz] = [e[0] / 2, e[1] / 2, e[2] / 2]
  const edges: [number[], number[]][] = [
    [[-hx, -hy, -hz], [hx, -hy, -hz]],
    [[-hx, -hy, -hz], [-hx, hy, -hz]],
    [[-hx, -hy, -hz], [-hx, -hy, hz]],
  ]
  return (
    <group>
      {edges.map(([a, b], i) => (
        <lineSegments key={i} renderOrder={999}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[new Float32Array([...a, ...b]), 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={AXIS[i]} depthTest={false} transparent />
        </lineSegments>
      ))}
    </group>
  )
}
