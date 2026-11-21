import { Edges } from '@react-three/drei'
import { useMemo } from 'react'
import { DoubleSide, Vector3 } from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import type { CollisionBody } from '@/domain/collisions'
import type { CollisionShape } from '@/domain/mass'
import type { FrameGeometry } from '@/three/frame-geometry'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
import { interferenceInput } from './interference-input'
import { useLiveDoc, useOverlaps } from './InterferencePanel'
import { useWorkshopView } from './view-store'

// sRGB hex; three.js materials do not read CSS variables.
const SHAPE = '#e8b04a'
const OVERLAP = '#e5484d'

/** No hit testing: the overlay must not take clicks meant for the parts under it. */
const noRaycast = () => null

/**
 * Collision shapes in the 3D view, in body (= workshop world) coordinates, exactly as
 * the interference check and the engine see them:
 * - parts overlapping deeper than the tolerance are always outlined red (both parts);
 * - the debug view (B) draws every shape, the frame's plate and arms included.
 * Hidden in exploded view, where parts are not at their real poses.
 */
export function CollisionShapes({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const { bodies, highlighted, show } = useCollisionView(doc, geo)
  if (!show && highlighted.size === 0) return null
  return (
    <group name="collision-shapes">
      {bodies
        .filter((b) => show || highlighted.has(b.id))
        .map((b) => (
          <ShapeMesh key={b.id} body={b} overlap={highlighted.has(b.id)} debug={show} />
        ))}
    </group>
  )
}

/** Hidden DOM mirror of what is drawn, for tests and screen readers. */
export function CollisionStatus({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const { bodies, highlighted, show } = useCollisionView(doc, geo)
  return (
    <span
      className="sr-only"
      data-testid="collision-view"
      data-shapes={show ? bodies.length : 0}
      data-hulls={bodies.filter((b) => b.shape.type === 'hull').length}
      data-highlighted={[...highlighted].sort().join(',')}
    >
      {highlighted.size > 0 ? `${highlighted.size} overlapping collision shapes highlighted` : ''}
    </span>
  )
}

function useCollisionView(doc: AssemblyDocument, geo: FrameGeometry) {
  const show = useWorkshopView((s) => s.showCollision)
  const exploded = useWorkshopView((s) => s.exploded)
  const live = useLiveDoc(doc)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const overlaps = useOverlaps(doc, geo)
  const bodies = useMemo(() => interferenceInput(live, geo, components, assets).bodies, [live, geo, components, assets])
  const highlighted = useMemo(() => new Set(overlaps.filter((o) => o.status === 'error').flatMap((o) => o.bodies)), [overlaps])
  if (exploded) return { bodies: [], highlighted: new Set<string>(), show: false }
  return { bodies, highlighted, show }
}

/**
 * An overlapping shape is outlined in red; the debug view also fills every shape. The
 * fill is left out otherwise: translucent fills over parts cost fill rate (measured with
 * the 50-part performance build: 44 rendered fps with fills, 48 with outlines only, 50
 * without the overlay, at 1080p).
 */
function ShapeMesh({ body, overlap, debug }: { body: CollisionBody; overlap: boolean; debug: boolean }) {
  const color = overlap ? OVERLAP : SHAPE
  return (
    <group position={body.position} quaternion={body.quaternion} userData={{ collisionBody: body.id }}>
      <mesh raycast={noRaycast} renderOrder={900} {...(body.shape.type === 'cylinder' ? { 'rotation-x': Math.PI / 2 } : {})}>
        <ShapeGeometry shape={body.shape} />
        <meshBasicMaterial color={color} transparent opacity={overlap ? 0.38 : 0.08} depthWrite={false} side={DoubleSide} visible={debug} />
        <Edges color={color} threshold={20} renderOrder={901} />
      </mesh>
    </group>
  )
}

function ShapeGeometry({ shape }: { shape: CollisionShape }) {
  const hull = useMemo(
    () => (shape.type === 'hull' && shape.points.length >= 4 ? new ConvexGeometry(shape.points.map((p) => new Vector3(...p))) : null),
    [shape],
  )
  if (shape.type === 'box') {
    // A zero thickness is drawn as a sheet.
    return <boxGeometry args={shape.halfExtents.map((h) => Math.max(h * 2, 1e-5)) as [number, number, number]} />
  }
  // Cylinder axis along the shape's local Z (the mesh is turned from three's Y).
  if (shape.type === 'cylinder') return <cylinderGeometry args={[shape.radius, shape.radius, shape.halfHeight * 2, 32]} />
  return hull ? <primitive object={hull} attach="geometry" /> : null
}
