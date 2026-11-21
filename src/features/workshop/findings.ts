import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { runChecks, type Finding } from '../../domain/checks'
import { escOfMotor, wiringFindings } from '../../domain/wiring'
import type { FrameGeometry } from '../../three/frame-geometry'
import { checkInput } from './check-input'
import type { ComponentIndex } from './links'
import { wiringParts } from './wiring-input'

const ORDER = { error: 0, warning: 1, 'cannot-check': 2 } as const

/**
 * Last result per document. The checks panel, the status strip and the Electrical
 * Designer all ask for the same document's findings; documents are immutable, so the
 * checks run once per edit instead of once per caller.
 */
const lastFindings = new WeakMap<AssemblyDocument, { geo: FrameGeometry; components: ComponentIndex; findings: Finding[] }>()

/** Findings for an assembly, wiring included, most severe first. */
export function allFindings(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex): Finding[] {
  const hit = lastFindings.get(doc)
  if (hit && hit.geo === geo && hit.components === components) return hit.findings
  const findings = computeFindings(doc, geo, components)
  lastFindings.set(doc, { geo, components, findings })
  return findings
}

function computeFindings(doc: AssemblyDocument, geo: FrameGeometry, components: ComponentIndex): Finding[] {
  const parts = wiringParts(doc, geo, components)
  const wires = doc.wires ?? []
  const assembly = runChecks({ ...checkInput(doc, geo, components), escOfMotor: escOfMotor(parts, wires) })
  return [...assembly, ...wiringFindings(parts, wires)].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
}
