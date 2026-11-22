/**
 * Effective specification of a linked component. Pure (ADR 0008): the one place
 * that decides which value a calculation sees. Every workshop calculation reads a
 * linked component through `effectiveComponent` (via links.ts `linkedComponent`),
 * so mass, inertia, shapes, checks, wiring/electrical, propulsion and rendering all
 * follow the same layers.
 *
 * Layers, highest first:
 *   1. instance  — the part's own override (`AssemblyPart.overrides`), this part only;
 *   2. catalog   — the library's gap-fill on a built-in record (`Component.fills`);
 *   3. manufacturer — the record's own value (`Component.specs`; for user records,
 *      whatever source the user recorded there);
 *   4. missing.
 * Every layer is kept with its value and provenance (`resolveSpec`), so the UI can
 * say which one is used and what it hides. Nothing is copied into documents: a fill
 * or a seed update reaches every linked part unless that part overrides the field.
 *
 * Caching: `effectiveComponent` is memoized on the identity of the component object
 * (a new object whenever the record or its fills change: the store replaces it) and
 * of the part's overrides object (a new object whenever the part's overrides
 * change: documents are immutable). A change to either gives a new result.
 */
import type { Component, SpecValue } from '../../electron/ipc/component-fields'

export type SpecLayer = 'instance' | 'catalog' | 'manufacturer'

export interface ResolvedSpec {
  key: string
  /** The value calculations use, or null when no layer has one. */
  value: SpecValue | null
  layer: SpecLayer | 'missing'
  /** Every layer that has a value, including the ones it hides. */
  layers: Partial<Record<SpecLayer, SpecValue>>
}

export type Overrides = Readonly<Record<string, SpecValue>> | undefined

export function resolveSpec(component: Component, overrides: Overrides, key: string): ResolvedSpec {
  const layers: Partial<Record<SpecLayer, SpecValue>> = {}
  if (overrides?.[key]) layers.instance = overrides[key]
  if (component.fills?.[key]) layers.catalog = component.fills[key]
  if (component.specs[key]) layers.manufacturer = component.specs[key]
  const layer = (['instance', 'catalog', 'manufacturer'] as const).find((l) => layers[l]) ?? 'missing'
  return { key, value: layer === 'missing' ? null : layers[layer]!, layer, layers }
}

const NO_OVERRIDES = {}
const cache = new WeakMap<Component, WeakMap<object, Component>>()

/** The component with every layer applied to `specs` (memoized, see the header). */
export function effectiveComponent(component: Component, overrides: Overrides): Component {
  const key = overrides && Object.keys(overrides).length > 0 ? overrides : NO_OVERRIDES
  let byOverrides = cache.get(component)
  if (!byOverrides) cache.set(component, (byOverrides = new WeakMap()))
  const hit = byOverrides.get(key)
  if (hit) return hit
  const merged: Component =
    key === NO_OVERRIDES && !component.fills ? component : { ...component, specs: { ...component.specs, ...component.fills, ...(key as Record<string, SpecValue>) } }
  byOverrides.set(key, merged)
  return merged
}
