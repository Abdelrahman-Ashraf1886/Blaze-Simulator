import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { runChecks, type Finding } from '../../domain/checks'
import { massFindings } from '../../domain/mass'
import { escOfMotor, wiringFindings } from '../../domain/wiring'
import type { FrameGeometry } from '../../three/frame-geometry'
import { checkInput } from './check-input'
import type { ComponentIndex } from './links'
import { massState } from './mass-input'
import { wiringParts } from './wiring-input'

const ORDER = { error: 0, warning: 1, 'cannot-check': 2 } as const

/**
 * Last result per document. The checks panel, the status strip and the Electrical
 * Designer all ask for the same document's findings; documents are immutable, so the
 * checks run once per edit instead of once per caller.
 */
const lastFindings = new WeakMap<
  AssemblyDocument,
  { geo: FrameGeometry; components: ComponentIndex; balanceTolerance: number; findings: Finding[] }
>()

/**
 * Findings for an assembly, most severe first: the assembly checks, the wiring rules
 * and the hover balance. `balanceTolerance` is the user's hover-share margin in
 * percent (view settings).
 */
export function allFindings(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  components: ComponentIndex,
  balanceTolerance: number,
): Finding[] {
  const hit = lastFindings.get(doc)
  if (hit && hit.geo === geo && hit.components === components && hit.balanceTolerance === balanceTolerance) return hit.findings
  const findings = computeFindings(doc, geo, components, balanceTolerance)
  lastFindings.set(doc, { geo, components, balanceTolerance, findings })
  return findings
}

function computeFindings(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex, balanceTolerance: number): Finding[] {
  const parts = wiringParts(doc, geo, components)
  const wires = doc.wires ?? []
  const assembly = runChecks({ ...checkInput(doc, geo, components), escOfMotor: escOfMotor(parts, wires) })
  // The CoM depends only on positions and masses, so model bounds are not needed here.
  // A bare frame has nothing to balance yet, so the hover check starts with the first part.
  const { mp, motors, hover } = massState(doc, geo, components)
  const mass = doc.parts.length > 0 ? massFindings(mp, motors, hover, balanceTolerance) : []
  return [...assembly, ...wiringFindings(parts, wires), ...mass].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
}
