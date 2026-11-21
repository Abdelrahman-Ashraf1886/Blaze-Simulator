import { useThree, type ThreeEvent } from '@react-three/fiber'
import type { ReactNode } from 'react'
import { Vector3, type BufferGeometry, type Camera, type Material, type Mesh } from 'three'
import type { Vec3 } from '@/three/views'
import { toMm } from './frame-values'
import { measure, nearestOnScreen } from './inspection'
import { ScreenLabel } from './screen-labels'
import { useWorkshopView } from './view-store'

const LINE = '#f2c14e' // amber: a temporary annotation, not part of the model

/**
 * Wraps the model. In measure mode a click picks the surface point under the
 * pointer (or, with snapping on, the nearest mesh vertex within 8 px) instead of
 * selecting. Lines, grid and invisible helper boxes are ignored.
 */
export function MeasureCapture({ children }: { children: ReactNode }) {
  const measuring = useWorkshopView((s) => s.measuring)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const mesh = e.object as Mesh
    if (!mesh.isMesh) return // lines and edges: let the next hit handle it
    const material = mesh.material as Material | Material[]
    if (!Array.isArray(material) && material.transparent && material.opacity === 0) return
    e.stopPropagation()
    let point: Vec3 = [e.point.x, e.point.y, e.point.z]
    if (useWorkshopView.getState().snap) {
      const pointer: [number, number] = [e.nativeEvent.offsetX, e.nativeEvent.offsetY]
      const snapped = nearestOnScreen(vertices(mesh, camera, size), pointer)
      if (snapped) point = snapped
    }
    useWorkshopView.getState().addMeasurePoint(point)
  }
  return <group onClick={measuring ? onClick : undefined}>{children}</group>
}

function vertices(mesh: Mesh, camera: Camera, size: { width: number; height: number }) {
  const pos = (mesh.geometry as BufferGeometry).getAttribute('position')
  if (!pos) return []
  mesh.updateWorldMatrix(true, false)
  const v = new Vector3()
  const out: { world: Vec3; screen: [number, number] }[] = []
  // Large imported meshes: sample at most ~200k vertices so a click stays instant.
  const step = Math.max(1, Math.floor(pos.count / 200_000))
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    const world: Vec3 = [v.x, v.y, v.z]
    v.project(camera)
    if (v.z < -1 || v.z > 1) continue
    out.push({ world, screen: [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height] })
  }
  return out
}

/** The measured segment and its end points, drawn over everything. */
export function MeasureLine() {
  const points = useWorkshopView((s) => s.measure)
  if (points.length === 0) return null
  const [a, b] = points
  return (
    <group>
      {points.map((p, i) => (
        <mesh key={i} position={[...p]} renderOrder={1001}>
          <sphereGeometry args={[0.0025, 12, 8]} />
          <meshBasicMaterial color={LINE} depthTest={false} transparent />
        </mesh>
      ))}
      {a && b && (
        <lineSegments renderOrder={1001}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[new Float32Array([...a, ...b]), 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={LINE} depthTest={false} transparent />
        </lineSegments>
      )}
    </group>
  )
}

/** Distance label at the middle of the measured segment (DOM overlay, constant size). */
export function MeasureLabel() {
  const points = useWorkshopView((s) => s.measure)
  const [a, b] = points
  if (!a || !b) return null
  const m = measure(a, b)
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  return (
    <ScreenLabel id="measure" position={mid} interactive={false}>
      <span
        data-testid="measure-label"
        className="num block whitespace-nowrap rounded-[3px] border border-[#f2c14e]/70 bg-bg/90 px-1.5 py-px text-[11.5px] leading-4 text-fg"
      >
        {fmt(m.distanceMm)} mm
      </span>
    </ScreenLabel>
  )
}

/** Status strip text for the measure tool. */
export function measureStatus(points: readonly Vec3[]): string {
  const [a, b] = points
  if (!a) return 'Measure: click the first point'
  if (!b) return 'Measure: click the second point'
  const m = measure(a, b)
  const [dx, dy, dz] = m.deltaMm.map((v) => fmt(Math.abs(v)))
  return `Measure: ${fmt(m.distanceMm)} mm · ΔX ${dx} · ΔY ${dy} · ΔZ ${dz}`
}

const fmt = (mm: number) => toMm(mm / 1000)
