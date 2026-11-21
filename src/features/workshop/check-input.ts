/**
 * Builds the input of the compatibility checks (src/domain/checks.ts) from the
 * stored assembly: linked components, sizes as drawn, and world placement.
 * Uses the stored document, never the exploded view.
 */
import { Quaternion, Vector3 } from 'three'
import type { AssemblyDocument, AssemblyPart } from '../../../electron/ipc/contract'
import type { CheckInput, CheckPart, Vec3 } from '../../domain/checks'
import type { FrameGeometry } from '../../three/frame-geometry'
import { worldMatrices } from './inspection'
import { linkedComponent, resolveLinks, type ComponentIndex } from './links'

export function checkInput(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex): CheckInput {
  const shown = resolveLinks(doc, components)
  const matrices = worldMatrices(shown, geo)
  const byId = new Map(shown.parts.map((p) => [p.id, p]))
  const rootOf = (p: AssemblyPart) => {
    let r = p
    for (let i = 0; r.parentId && byId.has(r.parentId) && i < shown.parts.length; i++) r = byId.get(r.parentId)!
    return r
  }
  const pos = new Vector3()
  const rot = new Quaternion()
  const scale = new Vector3()
  const parts: CheckPart[] = shown.parts.map((p) => {
    const m = matrices.get(p.id)!
    m.decompose(pos, rot, scale)
    const axis = new Vector3(0, 0, 1).applyQuaternion(rot)
    const mount = geo.motors.find((x) => x.id === rootOf(p).mountId)
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      component: linkedComponent(p, components),
      motorMount: mount ? { id: mount.id, number: mount.number, spin: mount.spin } : null,
      parentId: p.parentId,
      shape: p.shape,
      center: [pos.x, pos.y, pos.z] as Vec3,
      axis: [axis.x, axis.y, axis.z] as Vec3,
    }
  })
  return {
    rotors: geo.motors.length,
    motorMounts: geo.motors.map((m) => ({ id: m.id, number: m.number })),
    frameTop: doc.frame.armThickness,
    parts,
  }
}
