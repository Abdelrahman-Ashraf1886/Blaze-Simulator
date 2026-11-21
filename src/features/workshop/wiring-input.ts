import type { AssemblyDocument, AssemblyPart } from '../../../electron/ipc/contract'
import type { WiringPart } from '../../domain/wiring'
import type { FrameGeometry } from '../../three/frame-geometry'
import { linkedComponent, type ComponentIndex } from './links'

/** Parts as the wiring sees them: linked component and, for motors, the motor-mount number. */
export function wiringParts(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex): WiringPart[] {
  const byId = new Map(doc.parts.map((p) => [p.id, p]))
  const rootMount = (p: AssemblyPart) => {
    let r = p
    for (let i = 0; r.parentId && byId.has(r.parentId) && i < doc.parts.length; i++) r = byId.get(r.parentId)!
    return r.mountId
  }
  return doc.parts.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    component: linkedComponent(p, components),
    motorNumber: p.kind === 'motor' ? (geo.motors.find((m) => m.id === rootMount(p))?.number ?? null) : null,
  }))
}
