/**
 * The assembly as the body-drag area calculation (src/domain/aero.ts) sees it: the
 * frame's plate and arms (always, whether or not the frame mass is set) and every
 * part's collision shape at its placement, with propellers marked for exclusion.
 */
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { projectedAreas, type AreaInput, type ProjectedAreas } from '../../domain/aero'
import type { Quat } from '../../domain/mass'
import type { FrameGeometry } from '../../three/frame-geometry'
import type { AssetBounds } from './assembly-ops'
import type { ComponentIndex } from './links'
import { FRAME_BODY_ID, frameBoxes, massBodies } from './mass-input'

const quatZ = (angle: number): Quat => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]

export function areaInputs(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds = {}): AreaInput[] {
  const { plateSize, armWidth, armThickness } = doc.frame
  const frame: AreaInput[] = frameBoxes(geo, plateSize, armWidth, armThickness).map((b) => ({
    id: b.id,
    shape: { type: 'box', halfExtents: [b.size[0] / 2, b.size[1] / 2, b.size[2] / 2] },
    position: b.center,
    quaternion: quatZ(b.angle),
  }))
  const parts: AreaInput[] = massBodies(doc, geo, components, assets)
    .filter((b) => !b.id.startsWith(FRAME_BODY_ID))
    .map((b) => ({ id: b.id, shape: b.shape, position: b.position, quaternion: b.quaternion, propeller: b.model === 'propeller' }))
  return [...frame, ...parts]
}

export const bodyAreas = (doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds = {}): ProjectedAreas =>
  projectedAreas(areaInputs(doc, geo, components, assets))
