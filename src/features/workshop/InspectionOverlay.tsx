import { Vector3 } from 'three'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { cn } from '@/lib/utils'
import type { FrameGeometry } from '@/three/frame-geometry'
import type { Vec3 } from '@/three/views'
import { shapeExtent } from './assembly-ops'
import { useAssets } from './asset-store'
import { toMm } from './frame-values'
import { mountPoints, worldMatrices } from './inspection'
import { ScreenLabel } from './screen-labels'
import { useWorkshopView } from './view-store'

const AXES = [
  { key: 'x', label: 'X', color: '#e0605a' },
  { key: 'y', label: 'Y', color: '#6fc27a' },
  { key: 'z', label: 'Z', color: '#5aa7e0' },
] as const

/**
 * mm labels for the selected part's extent lines (drawn in `PartsModel`), placed at
 * the middle of each line. `doc` is the displayed document, so labels follow the
 * exploded view.
 */
export function DimensionLabels({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const selection = useWorkshopView((s) => s.selection)
  const assets = useAssets((s) => s.assets)
  const part = selection?.kind === 'part' ? doc.parts.find((p) => p.id === selection.id) : undefined
  if (!part) return null
  const e = shapeExtent(part.shape, assets)
  const m = worldMatrices(doc, geo).get(part.id)
  if (!e || !m) return null
  const [hx, hy, hz] = [e[0] / 2, e[1] / 2, e[2] / 2]
  const mids: Vec3[] = [
    [0, -hy, -hz],
    [-hx, 0, -hz],
    [-hx, -hy, 0],
  ]
  return (
    <>
      {AXES.map((a, i) => {
        const w = new Vector3(...mids[i]!).applyMatrix4(m)
        return (
          <ScreenLabel key={a.key} id={`dim-${a.key}`} position={[w.x, w.y, w.z]} interactive={false}>
            <span
              data-testid={`dim-${a.key}`}
              className="num whitespace-nowrap rounded-[3px] bg-bg/85 px-1 text-[11px] leading-4 text-fg"
            >
              <span style={{ color: a.color }}>{a.label}</span> {toMm(e[i]!)} mm
            </span>
          </ScreenLabel>
        )
      })}
    </>
  )
}

/**
 * Connection markers: every mount a selected part can attach to (outside exploded
 * view). Guides only, never in the way of the gizmo or the canvas: the current
 * mount is filled, and the mount a dragged part would snap to is enlarged.
 * Attaching is done by dragging onto a marker or with "Attached to".
 */
export function MountMarkers({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const selection = useWorkshopView((s) => s.selection)
  const exploded = useWorkshopView((s) => s.exploded)
  const snapTarget = useWorkshopView((s) => s.snapTarget)
  const part = selection?.kind === 'part' ? doc.parts.find((p) => p.id === selection.id) : undefined
  if (!part || exploded) return null
  const current = part.parentId === null ? part.mountId : null
  return (
    <>
      {mountPoints(geo).map((mp) => (
        <ScreenLabel key={mp.id} id={`marker-${mp.id}`} position={mp.position} interactive={false}>
          <span
            data-testid={`mount-marker-${mp.id}`}
            data-current={mp.id === current || undefined}
            data-hot={mp.id === snapTarget || undefined}
            title={mp.label}
            className={cn(
              'block rounded-full border-2 border-accent transition-[width,height]',
              mp.id === snapTarget ? 'size-4 bg-accent' : mp.id === current ? 'size-2.5 bg-accent' : 'size-2.5 bg-bg/60',
            )}
          />
        </ScreenLabel>
      ))}
    </>
  )
}
