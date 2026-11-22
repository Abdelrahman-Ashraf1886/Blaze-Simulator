import '@/three/setup'
import { Canvas, useFrame } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport } from '@react-three/drei'
import { Suspense, useMemo } from 'react'
import { Vector3 } from 'three'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import type { FrameGeometry } from '@/three/frame-geometry'
import { FrameModel } from '../workshop/FrameModel'
import { PartsModel } from '../workshop/PartsModel'
import { frameToPose, type FlightFrame } from './frame'

function FollowCamera({ frame, distance }: { frame: FlightFrame; distance: number }) {
  const target = useMemo(() => new Vector3(), [])
  useFrame(({ camera }) => {
    target.set(...frame.positionM)
    camera.up.set(0, 0, 1)
    camera.position.set(target.x - distance, target.y - distance, target.z + distance * 0.7)
    camera.lookAt(target)
  })
  return null
}

export function FlightViewport({ frame, doc, geo }: { frame: FlightFrame; doc: AssemblyDocument; geo: FrameGeometry }) {
  const pose = frameToPose(frame)
  const distance = Math.max(1.2, ...geo.arms.map((arm) => arm.length * 6))
  return (
    <div className="pointer-events-none relative h-full min-h-[240px]" aria-label="Z-up flight view" data-testid="flight-viewport">
      <Canvas camera={{ position: [-distance, -distance, distance], up: [0, 0, 1], near: 0.005, far: 500, fov: 45 }} dpr={[1, 2]} fallback={<p className="p-4 text-warn">WebGL is unavailable. Flight diagnostics remain available.</p>}>
        <color attach="background" args={['#101215']} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[3, -2, 5]} intensity={2} />
        <FollowCamera frame={frame} distance={distance} />
        <mesh position={[0, 0, -0.001]}>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#22262c" />
        </mesh>
        <gridHelper args={[200, 200, '#454c55', '#2f343b']} rotation-x={Math.PI / 2} />
        {doc.environment?.obstacles.map((obstacle) => (
          <mesh key={obstacle.id} position={obstacle.center} rotation-z={obstacle.yaw}>
            <boxGeometry args={obstacle.size} />
            <meshStandardMaterial color="#6b6255" />
          </mesh>
        ))}
        <group position={pose.position} quaternion={pose.quaternion}>
          {/* Reused workshop models are display-only here; no editor gizmos or picking. */}
          <group raycast={() => null}>
            <Suspense fallback={null}>
              <FrameModel geo={geo} params={doc.frame} />
              <PartsModel doc={doc} geo={geo} editable={false} />
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
      <p className="pointer-events-none absolute left-3 top-3 text-[12px] text-warn">Demo data · Follow camera · Amber sphere: CoM</p>
    </div>
  )
}
