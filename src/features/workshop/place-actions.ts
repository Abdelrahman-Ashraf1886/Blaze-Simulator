/**
 * Editing actions that create parts or change their size, with placement (placement.ts):
 * each is one undo step, and a part that cannot be placed is not added: the reason is
 * shown under "Add part" instead (`placementNote` in the view store).
 */
import type { AssemblyDocument, AssemblyPart } from '../../../electron/ipc/contract'
import { useComponents } from '@/stores/components'
import type { FrameGeometry } from '@/three/frame-geometry'
import { updatePart, type AssetBounds } from './assembly-ops'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { componentIndex } from './component-index'
import type { ComponentIndex } from './links'
import { partErrors, placeClear, reseat } from './placement'
import { useWorkshopView } from './view-store'

const context = () => ({ components: componentIndex(useComponents.getState().components), assets: useAssets.getState().assets as AssetBounds })

/**
 * Creates parts with `create` (on the current document), places each created root clear
 * of the other parts on its support, and commits it all as one undo step. If any root
 * cannot be placed, nothing changes and the reason is shown. Returns the first root id.
 */
export function addPlaced(
  label: string,
  geo: FrameGeometry,
  create: (doc: AssemblyDocument, components: ComponentIndex, assets: AssetBounds) => { doc: AssemblyDocument; roots: string[] },
): string | null {
  const store = useAssembly.getState()
  const view = useWorkshopView.getState()
  if (!store.doc) return null
  const { components, assets } = context()
  const created = create(store.doc, components, assets)
  if (created.roots.length === 0) return null
  let doc = created.doc
  for (const id of created.roots) {
    const placed = placeClear(doc, geo, id, components, assets)
    if (!placed.ok) {
      view.setPlacementNote(placed.reason)
      return null
    }
    doc = placed.doc
  }
  view.setPlacementNote(null)
  store.edit(label, () => doc)
  view.selectPart(created.roots[0]!)
  return created.roots[0]!
}

/**
 * Changes a part's size-giving fields (component link, shape) and keeps it, and what rests
 * on it, on their supports. If the new size overlaps another part, the part moves to the
 * nearest free spot on its support; if there is none it stays, the overlap shows in
 * Checks, and the reason is shown.
 */
export function editSize(label: string, geo: FrameGeometry, part: AssemblyPart, patch: Partial<Omit<AssemblyPart, 'id'>>) {
  const { components, assets } = context()
  const view = useWorkshopView.getState()
  let note: string | null = null
  useAssembly.getState().edit(label, (d) => {
    const resized = reseat(d, updatePart(d, part.id, patch), geo, part.id, components, assets)
    if (partErrors(resized, geo, part.id, components, assets).length === 0) return resized
    const placed = placeClear(resized, geo, part.id, components, assets)
    if (placed.ok) return placed.doc
    note = placed.reason
    return resized
  })
  view.setPlacementNote(note)
}
