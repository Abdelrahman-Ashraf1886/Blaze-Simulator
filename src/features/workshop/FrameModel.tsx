import { Edges } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { useMemo } from 'react'
import { ExtrudeGeometry, Quaternion, Vector3, type Shape } from 'three'
import { materials } from '@/three/materials'
import { armShape, plateShape } from '@/three/frame-shapes'
import type { FrameParams } from '../../../electron/ipc/contract'
import { cn } from '@/lib/utils'
import type { FrameGeometry, MotorMountPoint } from '@/three/frame-geometry'
import { ScreenLabel } from './screen-labels'
import { useWorkshopView } from './view-store'

// sRGB hex; three.js materials do not read CSS variables.
const C = {
  frame: '#2f343b',
  frameEdge: '#5a626d',
  pad: '#454c55',
  arc: '#9aa3ad',
  selected: '#62d2e0', // accent: selection
}

/** Draws the parametric frame and its motor mounts from precomputed geometry. Labels: `MountLabels`. */
export function FrameModel({ geo, params }: { geo: FrameGeometry; params: FrameParams }) {
  const selected = useWorkshopView((s) => s.selectedMount)
  const detail = useWorkshopView((s) => s.detail)
  const t = params.armThickness
  const m = materials()
  const armLength = geo.arms[0]?.length ?? 0
  // Extruded carbon outlines with a small bevel, all within z ∈ [0, t]. The arms are a
  // hair thinner than the plate so the faces where they overlap never z-fight.
  const plate = useMemo(() => extrude(plateShape(params.plateSize), t, 0), [params.plateSize, t])
  const arm = useMemo(() => {
    const outline = armShape(armLength, params.armWidth, params.plateSize)
    return { geometry: extrude(outline.shape, t - 0.0002, 0.0001), outline }
  }, [armLength, params.armWidth, params.plateSize, t])
  if (!detail) {
    return (
      <group key="simple">
        <mesh position={[0, 0, t / 2]}>
          <boxGeometry args={[params.plateSize, params.plateSize, t]} />
          <meshStandardMaterial color={C.frame} roughness={0.7} metalness={0.15} />
          <Edges color={C.frameEdge} />
        </mesh>
        {geo.arms.map((a, i) => (
          <mesh key={i} position={a.center} rotation-z={a.angle}>
            <boxGeometry args={[a.length, params.armWidth, t]} />
            <meshStandardMaterial color={C.frame} roughness={0.7} metalness={0.15} />
            <Edges color={C.frameEdge} />
          </mesh>
        ))}
        {geo.motors.map((mm) => (
          <MotorMount key={mm.id} mount={mm} armWidth={params.armWidth} selected={selected === mm.id} detail={false} />
        ))}
      </group>
    )
  }
  const screw = Math.max(Math.min(params.armWidth * 0.09, 0.0018), 0.0009)
  return (
    <group key="detail">
      <mesh geometry={plate} material={m.carbon} />
      {geo.arms.map((a, i) => (
        <group key={i} rotation-z={a.angle}>
          <mesh geometry={arm.geometry} material={m.carbon} />
          {/* Two socket-head screws clamp each arm under the plate. */}
          {[-1, 1].map((side) => (
            <SocketScrew key={side} x={arm.outline.root + params.plateSize * 0.12} y={side * arm.outline.rootWidth * 0.26} z={t} r={screw} />
          ))}
        </group>
      ))}
      {geo.motors.map((mm) => (
        <MotorMount key={mm.id} mount={mm} armWidth={params.armWidth} selected={selected === mm.id} detail />
      ))}
    </group>
  )
}

/** Extrudes an outline to `depth` with a 0.2 mm bevel, starting at `z0`. */
function extrude(shape: Shape, depth: number, z0: number) {
  const bevel = Math.min(0.0002, depth * 0.1)
  const g = new ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * bevel, depth * 0.5),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 24,
  })
  g.translate(0, 0, z0 + bevel)
  return g
}

/** A socket-head cap screw on a surface at height z: aluminium head with a dark hex socket. */
function SocketScrew({ x, y, z, r }: { x: number; y: number; z: number; r: number }) {
  const m = materials()
  return (
    <group position={[x, y, z]}>
      <mesh rotation-x={Math.PI / 2} position-z={r * 0.35} material={m.aluminium}>
        <cylinderGeometry args={[r, r, r * 0.7, 16]} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position-z={r * 0.72} material={m.chip}>
        <cylinderGeometry args={[r * 0.45, r * 0.45, r * 0.05, 6]} />
      </mesh>
    </group>
  )
}

/** Matches materials().anodizedBlack. */
const ANODIZED_BLACK = '#1d2024'

function MotorMount({ mount, armWidth, selected, detail }: { mount: MotorMountPoint; armWidth: number; selected: boolean; detail: boolean }) {
  const select = (e: ThreeEvent<MouseEvent>) => {
    if (useWorkshopView.getState().measuring) return // the measure tool takes the click
    e.stopPropagation()
    useWorkshopView.getState().selectMount(mount.id)
  }
  // Tilt: rotation about the outward arm axis, applied to everything mounted here.
  const tilt = useMemo(
    () => new Quaternion().setFromAxisAngle(new Vector3(...mount.armDirection), mount.tilt),
    [mount.armDirection, mount.tilt],
  )
  const padRadius = armWidth * 0.9
  const color = selected ? C.selected : C.arc
  return (
    <group position={mount.position} quaternion={tilt}>
      {/* The mount pad: clickable, and the motor's footprint. Anodized, with the four motor bolts. */}
      <mesh rotation-x={Math.PI / 2} position-z={0.0005} onClick={select}>
        <cylinderGeometry args={[padRadius, padRadius, 0.001, 32]} />
        {/* One material whose props change: swapping an attached primitive for a
            new material on a live mesh leaves the renderer with a detached one. */}
        <meshStandardMaterial
          color={selected ? C.selected : detail ? ANODIZED_BLACK : C.pad}
          metalness={detail && !selected ? 0.6 : 0}
          roughness={detail && !selected ? 0.4 : 0.6}
        />
      </mesh>
      {detail &&
        [0, 1, 2, 3].map((i) => {
          const a = Math.PI / 4 + (i * Math.PI) / 2
          return (
            <mesh key={i} rotation-x={Math.PI / 2} position={[Math.cos(a) * armWidth * 0.48, Math.sin(a) * armWidth * 0.48, 0.0012]} material={materials().steel}>
              <cylinderGeometry args={[armWidth * 0.07, armWidth * 0.07, 0.0004, 12]} />
            </mesh>
          )
        })}
      <SpinArrow radius={armWidth * 1.7} spin={mount.spin} color={color} />
    </group>
  )
}

/**
 * A 270° arc with an arrowhead showing rotation as seen from above. With Z up,
 * increasing angle in the XY plane is counter-clockwise from above.
 */
function SpinArrow({ radius, spin, color }: { radius: number; spin: 'cw' | 'ccw'; color: string }) {
  const positions = useMemo(() => {
    const sweep = (Math.PI * 3) / 2
    const steps = 40
    const dir = spin === 'ccw' ? 1 : -1
    const pts: number[] = []
    const at = (a: number): [number, number] => [radius * Math.cos(a), radius * Math.sin(a)]
    for (let i = 0; i <= steps; i++) {
      const [x, y] = at(dir * (sweep * i) / steps)
      pts.push(x, y, 0.001)
    }
    // Arrowhead at the end of the sweep, pointing along the direction of rotation.
    const end = dir * sweep
    const [ex, ey] = at(end)
    const tx = -Math.sin(end) * dir
    const ty = Math.cos(end) * dir
    const head = radius * 0.45
    for (const side of [1, -1]) {
      // back along the tangent, splayed towards/away from the centre
      const bx = ex - tx * head + Math.cos(end) * head * 0.55 * side
      const by = ey - ty * head + Math.sin(end) * head * 0.55 * side
      pts.push(ex, ey, 0.001, bx, by, 0.001)
    }
    return new Float32Array(pts)
  }, [radius, spin])
  const arcCount = 41
  return (
    <group>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions.slice(0, arcCount * 3), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </line>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions.slice(arcCount * 3), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </lineSegments>
    </group>
  )
}

/** Clickable motor labels (DOM overlay); a constant size on screen. */
export function MountLabels({ geo, armWidth }: { geo: FrameGeometry; armWidth: number }) {
  const selected = useWorkshopView((s) => s.selectedMount)
  return (
    <>
      {geo.motors.map((m) => (
        <ScreenLabel key={m.id} id={m.id} position={[m.position[0], m.position[1], m.position[2] + armWidth * 1.4]}>
          <button
            type="button"
            data-testid={`mount-${m.id}`}
            data-spin={m.spin}
            aria-pressed={selected === m.id}
            onClick={() => useWorkshopView.getState().selectMount(m.id)}
            title={`Motor ${m.number} · ${m.name} · ${m.spin.toUpperCase()}${m.tilt ? ` · tilt ${deg(m.tilt)}°` : ''}`}
            className={cn(
              'num cursor-pointer select-none whitespace-nowrap rounded-[3px] border px-1.5 py-px text-[11px] leading-4',
              selected === m.id
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-line-strong bg-chrome/90 text-fg hover:border-fg-subtle',
            )}
          >
            {m.number} · {m.spin.toUpperCase()}
          </button>
        </ScreenLabel>
      ))}
    </>
  )
}

const deg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 10) / 10
