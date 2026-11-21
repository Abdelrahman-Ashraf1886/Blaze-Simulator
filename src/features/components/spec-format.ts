/**
 * Display helpers for component specifications. Pure (no React), so they are
 * unit tested.
 */
import {
  COMPONENT_FIELDS,
  type Component,
  type FieldDef,
  type SpecReference,
  type SpecSource,
  type SpecValue,
} from '../../../electron/ipc/component-fields'

export const SOURCE_LABELS: Record<SpecSource, string> = {
  manufacturer: 'Manufacturer',
  measured: 'Measured',
  user: 'Entered by you',
}

/** Numbers as people write them on datasheets: no trailing zeros, up to 4 significant decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Number(n.toPrecision(6)))
}

/** One value as text, e.g. "1750 rpm/V", "LiPo", "TELEM1 (UART), GPS1 (UART)". */
export function formatValue(field: FieldDef, spec: SpecValue): string {
  switch (field.kind) {
    case 'quantity': {
      const s = spec as { value: number; unit: string }
      return `${formatNumber(s.value)} ${s.unit}`
    }
    case 'integer':
      return formatNumber(spec.value as number)
    case 'text':
      return spec.value as string
    case 'choice':
      return field.options.find((o) => o.value === spec.value)?.label ?? String(spec.value)
    case 'ports': {
      const ports = spec.value as { name: string; type: string }[]
      return ports.length === 0 ? 'none listed' : ports.map((p) => `${p.name} (${p.type.toUpperCase()})`).join(', ')
    }
    case 'table': {
      const rows = (spec.value as { rows: unknown[] }).rows.length
      return `${rows} row${rows === 1 ? '' : 's'}`
    }
  }
}

/** Short citation, e.g. "example.com · p. 2 · read 2026-11-21". */
export function formatReference(ref: SpecReference | undefined): string | null {
  if (!ref) return null
  const where = ref.url ? hostOf(ref.url) : ref.document
  const parts = [where, ref.locator, ref.retrieved ? `read ${ref.retrieved}` : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** How many values a component has, and how many cite a manufacturer document. */
export function provenanceSummary(c: Component): { values: number; cited: number } {
  const values = Object.values(c.specs)
  return { values: values.length, cited: values.filter((v) => v.source === 'manufacturer').length }
}

/** Fields of the component's category that have a value, in display order. */
export function filledFields(c: Component): { field: FieldDef; spec: SpecValue }[] {
  return COMPONENT_FIELDS[c.category].flatMap((field) => {
    const spec = c.specs[field.key]
    return spec ? [{ field, spec }] : []
  })
}

/** Case-insensitive match on name, manufacturer, category label and notes. */
export function matches(c: Component, query: string, categoryLabel: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [c.name, c.manufacturer ?? '', categoryLabel, c.notes ?? ''].some((s) => s.toLowerCase().includes(q))
}
