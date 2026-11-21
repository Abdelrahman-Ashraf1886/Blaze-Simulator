/**
 * The assembly as the interference check (src/domain/collisions.ts) sees it: every
 * part's collision shape at its workshop pose, the frame as its plate and arms, and
 * which parts are attached to which.
 *
 * Shapes and poses are the ones the mass calculation uses (`collisionShape`, the
 * attachment chain through `worldMatrix`), so the check and the engine agree on
 * where each part is. The frame's boxes come from the frame parameters and are
 * checked whether or not the frame's mass is set.
 */
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  DEFAULT_INTERFERENCE_TOLERANCE_M,
  FRAME_PART_ID,
  type AssemblyDocument,
  type InterferenceSettingsDoc,
} from '../../../electron/ipc/contract'
import type { Finding } from '../../domain/checks'
import { interferenceFindings, interferences, type CollisionBody, type InterferenceSettings, type Overlap } from '../../domain/collisions'
import type { Quat, Vec3 } from '../../domain/mass'
import type { FrameGeometry } from '../../three/frame-geometry'
import { worldMatrix, type AssetBounds } from './assembly-ops'
import { effectiveShape, type ComponentIndex } from './links'
import { collisionShape, frameBoxes } from './mass-input'

/** The document's settings, or the starting values. */
export function interferenceSettings(doc: AssemblyDocument): InterferenceSettingsDoc {
  return doc.interference ?? { toleranceM: DEFAULT_INTERFERENCE_TOLERANCE_M, allowedPairs: [] }
}

export const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** Allows (or stops allowing) the overlap of two parts; keeps the pairs sorted and unique. */
export function setPairAllowed(doc: AssemblyDocument, a: string, b: string, allowed: boolean): AssemblyDocument {
  const s = interferenceSettings(doc)
  const [x, y] = pairKey(a, b)
  const rest = s.allowedPairs.filter(([p, q]) => !(p === x && q === y))
  const allowedPairs: [string, string][] = allowed ? [...rest, [x, y]] : rest
  allowedPairs.sort((p, q) => p[0].localeCompare(q[0]) || p[1].localeCompare(q[1]))
  return { ...doc, interference: { ...s, allowedPairs } }
}

export function setInterferenceTolerance(doc: AssemblyDocument, toleranceM: number): AssemblyDocument {
  return { ...doc, interference: { ...interferenceSettings(doc), toleranceM } }
}


function pose(m: Matrix4): { position: Vec3; quaternion: Quat } {
  const p = new Vector3()
  const q = new Quaternion()
  m.decompose(p, q, new Vector3())
  q.normalize()
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] }
}

export interface InterferenceInput {
  bodies: CollisionBody[]
  /** (child, parent) owner ids: a part and its parent part, or a part on a frame mount and the frame. */
  attached: [string, string][]
  /** Imported-model parts whose size is not known yet (their file's bounds are not loaded). */
  unknownSize: { id: string; name: string }[]
}

export function interferenceInput(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds): InterferenceInput {
  const { plateSize, armWidth, armThickness: t } = doc.frame
  const bodies: CollisionBody[] = frameBoxes(geo, plateSize, armWidth, t).map((b) => ({
    id: b.id,
    ownerId: FRAME_PART_ID,
    name: 'Frame',
    propeller: false,
    shape: { type: 'box', halfExtents: b.size.map((v) => v / 2) as Vec3 },
    position: b.center,
    quaternion: [0, 0, Math.sin(b.angle / 2), Math.cos(b.angle / 2)],
  }))
  const attached: [string, string][] = []
  const unknownSize: { id: string; name: string }[] = []
  const mountIds = new Set(geo.motors.map((m) => m.id).concat(geo.plates.map((p) => p.id)))
  for (const p of doc.parts) {
    if (p.parentId) attached.push([p.id, p.parentId])
    else if (p.mountId && mountIds.has(p.mountId)) attached.push([p.id, FRAME_PART_ID])
    const shape = effectiveShape(p, components)
    if (shape.type === 'model' && !assets[shape.assetId]) {
      unknownSize.push({ id: p.id, name: p.name })
      continue
    }
    bodies.push({
      id: p.id,
      ownerId: p.id,
      name: p.name,
      propeller: p.kind === 'propeller',
      shape: collisionShape(shape, assets),
      ...pose(worldMatrix(doc, geo, p.id)),
    })
  }
  return { bodies, attached, unknownSize }
}

/** Every overlap deeper than the tolerance, with its status. */
export function assemblyOverlaps(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds): Overlap[] {
  const input = interferenceInput(doc, geo, components, assets)
  const s = interferenceSettings(doc)
  const settings: InterferenceSettings = { toleranceM: s.toleranceM, attached: input.attached, allowed: s.allowedPairs }
  return interferences(input.bodies, settings)
}

/** Checks findings: interference errors, and cannot-check for models whose size is not loaded. */
export function assemblyInterferenceFindings(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, assets: AssetBounds): Finding[] {
  const input = interferenceInput(doc, geo, components, assets)
  const s = interferenceSettings(doc)
  const overlaps = interferences(input.bodies, { toleranceM: s.toleranceM, attached: input.attached, allowed: s.allowedPairs })
  const out = interferenceFindings(overlaps, s.toleranceM, FRAME_PART_ID)
  if (input.unknownSize.length > 0) {
    out.push({
      id: `interference:unknown:${input.unknownSize.map((u) => u.id).join(',')}`,
      rule: 'interference',
      severity: 'cannot-check',
      message: `Overlaps cannot be checked for ${input.unknownSize.map((u) => u.name).join(', ')} until ${input.unknownSize.length === 1 ? 'its model is' : 'their models are'} loaded.`,
      partIds: input.unknownSize.map((u) => u.id),
    })
  }
  return out
}
