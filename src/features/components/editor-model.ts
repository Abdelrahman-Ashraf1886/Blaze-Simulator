/**
 * Form state for the component editor and its conversion to a `ComponentInput`.
 * Pure, so it is unit tested. Main validates again on save (the source of truth);
 * the checks here only catch what a form can see before sending: empty or
 * non-numeric values, and a value without a stated source.
 */
import {
  COMPONENT_FIELDS,
  componentFieldApplies,
  type Component,
  type ComponentCategory,
  type ComponentInput,
  type FieldDef,
  type Port,
  type SpecSource,
  type SpecValue,
} from '../../../electron/ipc/component-fields'
import type { Unit } from '../../domain/units'

export type DraftSource = SpecSource | 'none'

export interface FieldDraft {
  /** 'none' = no value; the field is omitted. */
  source: DraftSource
  value: string
  unit: Unit | null
  url: string
  document: string
  locator: string
  retrieved: string
  condition: string
  ports: Port[]
  units: Record<string, Unit>
  rows: Record<string, string>[]
}

export interface ComponentDraft {
  category: ComponentCategory
  name: string
  manufacturer: string
  notes: string
  fields: Record<string, FieldDraft>
  storedSpecs: Component['specs']
}

export const today = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function emptyField(f: FieldDef): FieldDraft {
  return {
    source: 'none',
    value: '',
    unit: f.kind === 'quantity' ? f.unit : null,
    url: '',
    document: '',
    locator: '',
    retrieved: '',
    condition: '',
    ports: [],
    units: f.kind === 'table' ? Object.fromEntries(f.columns.flatMap((c) => (c.kind === 'quantity' ? [[c.key, c.unit]] : []))) : {},
    rows: [],
  }
}

function fieldFrom(f: FieldDef, spec: SpecValue | undefined): FieldDraft {
  const d = emptyField(f)
  if (!spec) return d
  d.source = spec.source
  d.url = spec.reference?.url ?? ''
  d.document = spec.reference?.document ?? ''
  d.locator = spec.reference?.locator ?? ''
  d.retrieved = spec.reference?.retrieved ?? ''
  d.condition = spec.condition ?? ''
  if (f.kind === 'ports') d.ports = (spec.value as Port[]).map((p) => ({ ...p }))
  else if (f.kind === 'table') {
    const t = spec.value as { units: Record<string, Unit>; rows: Record<string, number | string>[] }
    d.units = { ...d.units, ...t.units }
    d.rows = t.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])))
  } else {
    d.value = String(spec.value)
    if ('unit' in spec && spec.unit) d.unit = spec.unit
  }
  return d
}

export function draftFrom(component: Component | null, category: ComponentCategory): ComponentDraft {
  const cat = component?.category ?? category
  return {
    category: cat,
    name: component?.name ?? '',
    manufacturer: component?.manufacturer ?? '',
    notes: component?.notes ?? '',
    storedSpecs: component?.specs ?? {},
    fields: Object.fromEntries(COMPONENT_FIELDS[cat].map((f) => [f.key, fieldFrom(f, component?.specs[f.key])])),
  }
}

/** Numbers as typed: "1,5" is accepted as 1.5; anything else non-numeric is refused. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function hasContent(d: FieldDraft, f: FieldDef): boolean {
  if (f.kind === 'ports') return d.ports.length > 0
  if (f.kind === 'table') return d.rows.some((r) => Object.values(r).some((v) => v.trim() !== ''))
  return d.value.trim() !== ''
}

/** Builds the IPC input, or lists what the form must fix first. */
export function toInput(draft: ComponentDraft): { ok: true; input: ComponentInput } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const specs: Record<string, SpecValue> = {}
  if (!draft.name.trim()) errors.push('Name is required')

  for (const f of COMPONENT_FIELDS[draft.category]) {
    if (!componentFieldApplies(draft.category, draft.fields.role?.value, f.key)) {
      const stored = draft.storedSpecs[f.key]
      if (stored) specs[f.key] = stored
      continue
    }
    const d = draft.fields[f.key]
    if (!d) continue
    const content = hasContent(d, f)
    if (d.source === 'none') {
      if (content) errors.push(`${f.label}: choose where this value comes from`)
      continue
    }
    if (!content) {
      errors.push(`${f.label}: enter a value or set its source to "Not specified"`)
      continue
    }
    const reference = Object.fromEntries(
      (['url', 'document', 'locator', 'retrieved'] as const).flatMap((k) => (d[k].trim() ? [[k, d[k].trim()]] : [])),
    )
    const base = {
      source: d.source,
      ...(Object.keys(reference).length > 0 ? { reference } : {}),
      ...(d.condition.trim() ? { condition: d.condition.trim() } : {}),
    }
    let value: SpecValue['value']
    if (f.kind === 'quantity' || f.kind === 'integer') {
      const n = parseNumber(d.value)
      if (n === null) {
        errors.push(`${f.label}: "${d.value}" is not a number`)
        continue
      }
      value = n
    } else if (f.kind === 'ports') {
      value = d.ports.map((p) => ({ name: p.name.trim(), type: p.type }))
    } else if (f.kind === 'table') {
      const rows: Record<string, number | string>[] = []
      let bad = false
      for (const [i, r] of d.rows.entries()) {
        if (!Object.values(r).some((v) => v.trim() !== '')) continue
        const row: Record<string, number | string> = {}
        for (const c of f.columns) {
          const v = (r[c.key] ?? '').trim()
          if (!v) continue
          if (c.kind === 'quantity') {
            const n = parseNumber(v)
            if (n === null) {
              errors.push(`${f.label}, row ${i + 1}: "${v}" is not a number`)
              bad = true
            } else row[c.key] = n
          } else row[c.key] = v
        }
        rows.push(row)
      }
      if (bad) continue
      const used = new Set(rows.flatMap((r) => Object.keys(r)))
      value = { units: Object.fromEntries(Object.entries(d.units).filter(([k]) => used.has(k))), rows }
    } else {
      value = d.value.trim()
    }
    specs[f.key] = (f.kind === 'quantity' ? { ...base, value, unit: d.unit! } : { ...base, value }) as SpecValue
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    input: {
      category: draft.category,
      name: draft.name.trim(),
      manufacturer: draft.manufacturer.trim() || null,
      notes: draft.notes.trim() || null,
      specs,
    },
  }
}
