import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import type { Environment, VehicleDefinition } from '../../../electron/main/engine/protocol'
import { materials } from '@/three/materials'
import { EnvironmentMeshes } from '../workshop/environment/EnvironmentMeshes'
import { terrainMeshData } from '../workshop/environment/terrain-mesh'

type Shape = VehicleDefinition['parts'][number]['shape']

function Hull({ points }: { points: number[][] }) {
  const geometry = useMemo(() => new ConvexGeometry(points.map(([x, y, z]) => new Vector3(x, y, z))), [points])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <primitive attach="geometry" object={geometry} />
}

function CollisionMesh({ shape, obstacle = false }: { shape: Shape; obstacle?: boolean }) {
  return <mesh rotation-x={shape.type === 'cylinder' ? Math.PI / 2 : 0}>
    {shape.type === 'box' && <boxGeometry args={shape.halfExtents.map((value) => 2 * value) as [number, number, number]} />}
    {shape.type === 'cylinder' && <cylinderGeometry args={[shape.radius, shape.radius, 2 * shape.halfHeight]} />}
    {shape.type === 'hull' && <Hull points={shape.points} />}
    <primitive attach="material" object={obstacle ? materials().aluminium : materials().carbon} />
  </mesh>
}

function ReplayTerrain({ terrain }: { terrain: NonNullable<Environment['terrain']> }) {
  const { geometry, origin } = useMemo(() => {
    const data = terrainMeshData({ ...terrain, heightsM: Float64Array.from(terrain.heightsM) })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
    geometry.setIndex(new BufferAttribute(data.indices, 1))
    geometry.computeVertexNormals()
    return { geometry, origin: data.origin }
  }, [terrain])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh position={origin}>
    <primitive attach="geometry" object={geometry} />
    <meshStandardMaterial color="#22262c" />
  </mesh>
}

export function ReplayModel({ vehicle }: { vehicle: VehicleDefinition }) {
  return <>{vehicle.parts.map(({ partId, pose, shape }) =>
    <group key={partId} position={pose.position} quaternion={pose.quaternion}><CollisionMesh shape={shape} /></group>,
  )}</>
}

export function ReplayEnvironment({ environment }: { environment?: Environment }) {
  if (!environment) return null
  return <>
    {environment.ground && <EnvironmentMeshes />}
    {environment.terrain && <ReplayTerrain terrain={environment.terrain} />}
    {environment.obstacles.map((obstacle) => {
      const shape: Shape = obstacle.type === 'hull' ? { type: 'hull', points: obstacle.points }
        : obstacle.type === 'cylinder' ? { type: 'cylinder', radius: obstacle.radius, halfHeight: obstacle.height / 2 }
          : { type: 'box', halfExtents: obstacle.halfExtents }
      return <group key={obstacle.id} position={obstacle.center} quaternion={obstacle.quaternion}>
        <CollisionMesh shape={shape} obstacle />
      </group>
    })}
  </>
}
