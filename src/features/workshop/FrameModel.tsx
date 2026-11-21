import { Edges } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { useMemo } from 'react'
import { Quaternion, Vector3 } from 'three'
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
  const t = params.armThickness
  return (
    <group>
      <mesh position={[0, 0, t / 2]}>
        <boxGeometry args={[params.plateSize, params.plateSize, t]} />
        <meshStandardMaterial color={C.frame} roughness={0.7} metalness={0.15} />
        <Edges color={C.frameEdge} />
      </mesh>
      {geo.arms.map((arm, i) => (
        <mesh key={i} position={arm.center} rotation-z={arm.angle}>
          <boxGeometry args={[arm.length, params.armWidth, t]} />
          <meshStandardMaterial color={C.frame} roughness={0.7} metalness={0.15} />
          <Edges color={C.frameEdge} />
        </mesh>
      ))}
      {geo.motors.map((m) => (
        <MotorMount key={m.id} mount={m} armWidth={params.armWidth} selected={selected === m.id} />
      ))}
    </group>
  )
}

function MotorMount({ mount, armWidth, selected }: { mount: MotorMountPoint; armWidth: number; selected: boolean }) {
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
      <mesh rotation-x={Math.PI / 2} position-z={0.0005} onClick={select}>
        <cylinderGeometry args={[padRadius, padRadius, 0.001, 32]} />
        <meshStandardMaterial color={selected ? C.selected : C.pad} roughness={0.6} />
      </mesh>
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
