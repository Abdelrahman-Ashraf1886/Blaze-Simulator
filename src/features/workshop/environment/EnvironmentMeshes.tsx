import { memo, useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import type { AssetInfo, EnvironmentDoc, ObstacleDoc } from '../../../../electron/ipc/contract'
import type { TerrainGrid } from '@/domain/terrain'
import { useAssets } from '../asset-store'
import { hullPoints } from './obstacles'
import { terrainMeshData } from './terrain-mesh'
import { useTerrainGrid } from './terrain-preview'

export const EnvironmentMeshes = memo(function EnvironmentMeshes({ environment }: { environment?: EnvironmentDoc | null }) {
  const terrainId = environment?.terrain?.assetId
  return <>
    {!environment?.terrain && <GroundPlane />}
    {terrainId && <SelectedTerrain key={terrainId} id={terrainId} />}
    {environment?.obstacles.map((obstacle) => <ObstacleMesh key={obstacle.id} obstacle={obstacle} />)}
  </>
})

function SelectedTerrain({ id }: { id: string }) {
  const grid = useTerrainGrid(id)?.grid
  return grid ? <TerrainMesh grid={grid} /> : null
}

function GroundPlane() {
  return <>
    <mesh position={[0, 0, -0.001]}>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#22262c" />
    </mesh>
    <gridHelper args={[200, 200, '#454c55', '#2f343b']} rotation-x={Math.PI / 2} />
  </>
}

function TerrainMesh({ grid }: { grid: TerrainGrid }) {
  const { geometry, origin } = useMemo(() => {
    const { positions, indices, origin } = terrainMeshData(grid)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setIndex(new BufferAttribute(indices, 1))
    geometry.computeVertexNormals()
    return { geometry, origin }
  }, [grid])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh position={origin}>
    <primitive attach="geometry" object={geometry} />
    <meshStandardMaterial color="#22262c" />
  </mesh>
}

function ObstacleMesh({ obstacle }: { obstacle: ObstacleDoc }) {
  const modelId = obstacle.type === 'hull' ? obstacle.assetId : null
  const model = useAssets((s) => modelId ? s.assets[modelId] : undefined)
  const { center, yaw } = obstacle
  if (center === null || yaw === null) return null
  if (obstacle.type === 'hull') return <group position={center} rotation-z={yaw}>
    <HullMesh obstacle={obstacle} model={model} />
  </group>
  const geometry = obstacle.type === 'cylinder'
    ? obstacle.radius !== null && obstacle.height !== null && <cylinderGeometry args={[obstacle.radius, obstacle.radius, obstacle.height, 32]} />
    : obstacle.size && <boxGeometry args={obstacle.size} />
  if (!geometry) return null
  return <group position={center} rotation-z={yaw}>
    <mesh rotation-x={obstacle.type === 'cylinder' ? Math.PI / 2 : 0}>
      {geometry}
      <meshStandardMaterial color="#6b6255" />
    </mesh>
  </group>
}

function HullMesh({ obstacle, model }: { obstacle: Extract<ObstacleDoc, { type: 'hull' }>; model?: AssetInfo }) {
  const geometry = useMemo(() => {
    const points = hullPoints(obstacle, model)
    return points && new ConvexGeometry(points.map((point) => new Vector3(...point)))
  }, [obstacle, model])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return <mesh>
    <primitive attach="geometry" object={geometry} />
    <meshStandardMaterial color="#6b6255" />
  </mesh>
}
