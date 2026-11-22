/**
 * Parts linked to library components. Pure, so it is unit tested.
 *
 * A part stores only `componentId`; its own shape and mass stay in the document.
 * While linked, the component's stated values are used instead, worked out here
 * whenever they are needed (never copied into the document), so:
 * - unlinking (or undo) restores the part's own values exactly;
 * - a corrected built-in record shows up in every project that uses it.
 *
 * Size rules (only when the component states every dimension needed):
 * - motor: body diameter and body length → cylinder along the part's Z;
 * - propeller: diameter → the swept disc (cylinder), keeping the part's own disc thickness;
 * - battery, ESC, flight controller, power module, peripheral: length × width × height
 *   → box along the part's X, Y, Z.
 * Imported models keep their mesh; only the mass comes from the component.
 */
import {
  CATEGORY_LABELS,
  COMPONENT_CATEGORIES,
  type Component,
  type ComponentCategory,
  type QuantityValue,
  type SpecValue,
} from '../../../electron/ipc/component-fields'
import type { AssemblyDocument, AssemblyPart, PartKind, PartShape } from '../../../electron/ipc/contract'
import { effectiveComponent } from '../../domain/spec-resolution'
import { toSI } from '../../domain/units'

export type ComponentIndex = Readonly<Record<string, Component>>

/** Library categories a part of each kind may be linked to. */
export const KIND_CATEGORIES: Record<PartKind, readonly ComponentCategory[]> = {
  motor: ['motor'],
  propeller: ['propeller'],
  battery: ['battery'],
  esc: ['esc'],
  'flight-controller': ['flight-controller'],
  gps: ['peripheral'],
  camera: ['peripheral'],
  sensor: ['peripheral'],
  // No library category describes landing gear yet: its size and mass are the user's.
  'landing-gear': [],
  payload: ['peripheral', 'power-module'],
  custom: COMPONENT_CATEGORIES,
}

export const linkableComponents = (kind: PartKind, all: readonly Component[]) =>
  all.filter((c) => KIND_CATEGORIES[kind].includes(c.category))

/** The library record as stored (its own values and gap-fills, without this part's overrides). */
export function libraryComponent(part: AssemblyPart, components: ComponentIndex): Component | null {
  return part.componentId ? (components[part.componentId] ?? null) : null
}

/**
 * The linked component as calculations see it: part override > catalog gap-fill >
 * stated value (src/domain/spec-resolution.ts). Every consumer reads through this.
 */
export function linkedComponent(part: AssemblyPart, components: ComponentIndex): Component | null {
  const c = libraryComponent(part, components)
  return c ? effectiveComponent(c, part.overrides) : null
}

const quantity = (spec: SpecValue | undefined): QuantityValue | null =>
  spec && typeof spec.value === 'number' && 'unit' in spec ? (spec as QuantityValue) : null

/** A stated length in metres, or null. */
const metres = (c: Component, key: string) => {
  const q = quantity(c.specs[key])
  return q ? toSI(q.value, q.unit) : null
}

/** Default thickness of a propeller disc when the part has none of its own (display only). */
const PROP_DISC = 0.008

/** The shape a component's stated size gives the part, or null when it does not state enough. */
export function linkedShape(part: AssemblyPart, c: Component): PartShape | null {
  if (part.shape.type === 'model') return null
  if (c.category === 'motor') {
    const d = metres(c, 'bodyDiameter')
    const h = metres(c, 'bodyLength')
    return d && h ? { type: 'cylinder', radius: d / 2, height: h } : null
  }
  if (c.category === 'propeller') {
    const d = metres(c, 'diameter')
    const own = part.shape.type === 'cylinder' ? part.shape.height : PROP_DISC
    return d ? { type: 'cylinder', radius: d / 2, height: own } : null
  }
  const l = metres(c, 'length')
  const w = metres(c, 'width')
  const h = metres(c, 'height')
  return l && w && h ? { type: 'box', size: [l, w, h] } : null
}

/** The shape to draw and measure: the linked component's size if it states one, else the part's own. */
export function effectiveShape(part: AssemblyPart, components: ComponentIndex): PartShape {
  const c = linkedComponent(part, components)
  return (c && linkedShape(part, c)) ?? part.shape
}

export interface EffectiveMass {
  valueKg: number
  /** Where the value comes from: the component's stated mass, or the part's own entry. */
  from: 'component' | 'part'
  spec?: QuantityValue
}

/** The component's stated mass while linked (if it states one), otherwise the part's own value. */
export function effectiveMass(part: AssemblyPart, components: ComponentIndex): EffectiveMass | null {
  const c = linkedComponent(part, components)
  const q = c ? quantity(c.specs.mass) : null
  if (q) return { valueKg: toSI(q.value, q.unit), from: 'component', spec: q }
  return part.mass ? { valueKg: part.mass.valueKg, from: 'part' } : null
}

/**
 * The document as drawn: linked parts take their component's size. Display only;
 * edits always go to the stored document.
 */
export function resolveLinks(doc: AssemblyDocument, components: ComponentIndex): AssemblyDocument {
  if (!doc.parts.some((p) => p.componentId)) return doc
  return { ...doc, parts: doc.parts.map((p) => (p.componentId ? { ...p, shape: effectiveShape(p, components) } : p)) }
}

export const componentLabel = (c: Component) =>
  `${c.manufacturer ? `${c.manufacturer} ` : ''}${c.name} (${CATEGORY_LABELS[c.category]})`
