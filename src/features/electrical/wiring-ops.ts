/**
 * Edits to a project's wiring. Pure: each returns a new document (or the same one
 * when nothing changes), so every edit is one undo step in the assembly store.
 */
import type { AssemblyDocument, Wire, WireEnd } from '../../../electron/ipc/contract'
import { autoWire, type WiringPart } from '../../domain/wiring'

export function addWire(doc: AssemblyDocument, from: WireEnd, to: WireEnd, id: string = crypto.randomUUID()): AssemblyDocument {
  const exists = (doc.wires ?? []).some(
    (w) =>
      (w.from.partId === from.partId && w.from.port === from.port && w.to.partId === to.partId && w.to.port === to.port) ||
      (w.from.partId === to.partId && w.from.port === to.port && w.to.partId === from.partId && w.to.port === from.port),
  )
  if (exists) return doc
  return { ...doc, wires: [...(doc.wires ?? []), { id, from, to, gaugeAwg: null, lengthMm: null, color: null }] }
}

export function removeWire(doc: AssemblyDocument, id: string): AssemblyDocument {
  return { ...doc, wires: (doc.wires ?? []).filter((w) => w.id !== id) }
}

export function updateWire(doc: AssemblyDocument, id: string, patch: Partial<Omit<Wire, 'id'>>): AssemblyDocument {
  return { ...doc, wires: (doc.wires ?? []).map((w) => (w.id === id ? { ...w, ...patch } : w)) }
}

/** Moves one end of a wire to another port of the same part. */
export function movePort(doc: AssemblyDocument, id: string, end: 'from' | 'to', port: string): AssemblyDocument {
  return { ...doc, wires: (doc.wires ?? []).map((w) => (w.id === id ? { ...w, [end]: { ...w[end], port } } : w)) }
}

export function placeNode(doc: AssemblyDocument, partId: string, x: number, y: number): AssemblyDocument {
  return { ...doc, schematic: { ...doc.schematic, [partId]: { x: Math.round(x), y: Math.round(y) } } }
}

/** Replaces all wires with the auto-wired harness. */
export function applyAutoWire(doc: AssemblyDocument, parts: readonly WiringPart[], newId?: () => string): { doc: AssemblyDocument; notes: string[] } {
  const { wires, notes } = autoWire(parts, newId)
  return { doc: { ...doc, wires }, notes }
}
