/**
 * zod validation for components, generated from `component-fields.ts`. Main only.
 *
 * The provenance rule is enforced here: a `manufacturer` value must cite where it
 * came from (a URL or document title) and when it was read. Unknown fields,
 * wrong units, and impossible ranges are refused with messages that name the field.
 */
import { z } from 'zod'
import { dimensionOf, isUnit, toSI, unitsOf, type Dimension, type Unit } from '../../src/domain/units'
import {
  COMPONENT_CATEGORIES,
  COMPONENT_FIELDS,
  PORT_TYPES,
  SPEC_SOURCES,
  type ComponentCategory,
  type ComponentInput,
  type FieldDef,
} from './component-fields'

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const referenceSchema = z
  .object({
    url: z
      .string()
      .max(2000)
      .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'Reference URL must start with http:// or https://')
      .optional(),
    document: z.string().trim().min(1).max(300).optional(),
    locator: z.string().trim().min(1).max(200).optional(),
    retrieved: z.string().regex(ISO_DATE, 'Retrieved date must be YYYY-MM-DD').optional(),
  })
  .strict()

const provenance = {
  source: z.enum(SPEC_SOURCES),
  reference: referenceSchema.optional(),
  condition: z.string().trim().min(1).max(200).optional(),
}

/** A manufacturer value without a citation is refused: this is the "no invented specs" rule. */
function citeManufacturer(value: unknown, ctx: z.RefinementCtx) {
  const v = value as { source: string; reference?: { url?: string; document?: string; retrieved?: string } }
  if (v.source !== 'manufacturer') return
  if (!v.reference?.url && !v.reference?.document) {
    ctx.addIssue({ code: 'custom', message: 'A manufacturer value needs its source (URL or document title)' })
  }
  if (!v.reference?.retrieved) {
    ctx.addIssue({ code: 'custom', message: 'A manufacturer value needs the date its source was read' })
  }
}

const unitFor = (dimension: Dimension) =>
  z
    .string()
    .refine((u): u is Unit => isUnit(u) && dimensionOf(u) === dimension, {
      message: `Unit must be one of ${unitsOf(dimension).join(', ')}`,
    })
    .transform((u) => u as Unit)

const quantityNumber = (dimension: Dimension) => {
  const n = z.number({ message: 'Value must be a number' })
  // Temperatures in °C may be below zero; every other stated quantity is non-negative.
  return dimension === 'temperature' ? n.min(-273.15) : n.min(0, 'Value cannot be negative')
}

function valueSchema(f: FieldDef): z.ZodType {
  switch (f.kind) {
    case 'quantity':
      return z.object({ value: quantityNumber(f.dimension), unit: unitFor(f.dimension), ...provenance }).strict()
    case 'integer':
      return z
        .object({
          value: z.int('Value must be a whole number').min(f.min, `At least ${f.min}`).max(f.max, `At most ${f.max}`),
          ...provenance,
        })
        .strict()
    case 'text':
      return z
        .object({ value: z.string().trim().min(1, 'Value is empty').max(f.maxLength), ...provenance })
        .strict()
    case 'choice':
      return z
        .object({
          value: z.enum(f.options.map((o) => o.value) as [string, ...string[]], {
            message: `Must be one of: ${f.options.map((o) => o.label).join(', ')}`,
          }),
          ...provenance,
        })
        .strict()
    case 'ports':
      return z
        .object({
          value: z
            .array(z.object({ name: z.string().trim().min(1).max(40), type: z.enum(PORT_TYPES) }).strict())
            .max(64)
            .refine((ports) => new Set(ports.map((p) => p.name)).size === ports.length, 'Port names must be unique'),
          ...provenance,
        })
        .strict()
    case 'table': {
      const cols = new Map(f.columns.map((c) => [c.key, c]))
      return z
        .object({
          value: z
            .object({
              units: z.record(z.string(), z.string()),
              rows: z.array(z.record(z.string(), z.union([z.number(), z.string().max(60)]))).max(200),
            })
            .strict()
            .superRefine((t, ctx) => {
              for (const [key, unit] of Object.entries(t.units)) {
                const c = cols.get(key)
                if (!c || c.kind !== 'quantity') ctx.addIssue({ code: 'custom', message: `Unknown numeric column "${key}"` })
                else if (!isUnit(unit) || dimensionOf(unit) !== c.dimension) {
                  ctx.addIssue({ code: 'custom', message: `Column "${c.label}" needs a ${c.dimension} unit` })
                }
              }
              t.rows.forEach((row, i) => {
                for (const [key, v] of Object.entries(row)) {
                  const c = cols.get(key)
                  if (!c) ctx.addIssue({ code: 'custom', message: `Row ${i + 1}: unknown column "${key}"` })
                  else if (c.kind === 'quantity' && (typeof v !== 'number' || v < 0 || !t.units[key])) {
                    ctx.addIssue({ code: 'custom', message: `Row ${i + 1}: "${c.label}" needs a non-negative number and a column unit` })
                  } else if (c.kind === 'text' && typeof v !== 'string') {
                    ctx.addIssue({ code: 'custom', message: `Row ${i + 1}: "${c.label}" must be text` })
                  }
                }
              })
            }),
          ...provenance,
        })
        .strict()
    }
  }
}

type Spec = { value: unknown; unit?: Unit }
const si = (s: Spec | undefined) => (s && typeof s.value === 'number' && s.unit ? toSI(s.value, s.unit) : undefined)
const num = (s: Spec | undefined) => (s && typeof s.value === 'number' ? s.value : undefined)

/** min ≤ max pairs, compared in SI so differing units are handled. */
const RANGES: [string, string, string][] = [
  ['cellsMin', 'cellsMax', 'Minimum cells exceed maximum cells'],
  ['inputVoltageMin', 'inputVoltageMax', 'Minimum input voltage exceeds the maximum'],
  ['supplyVoltageMin', 'supplyVoltageMax', 'Minimum supply voltage exceeds the maximum'],
]

function specsSchema(category: ComponentCategory) {
  const fields = COMPONENT_FIELDS[category]
  const shape = Object.fromEntries(fields.map((f) => [f.key, valueSchema(f).superRefine(citeManufacturer).optional()]))
  return z
    .object(shape)
    .strict()
    .superRefine((specs, ctx) => {
      const s = specs as Record<string, Spec | undefined>
      for (const [lo, hi, message] of RANGES) {
        const a = si(s[lo]) ?? num(s[lo])
        const b = si(s[hi]) ?? num(s[hi])
        if (a !== undefined && b !== undefined && a > b) ctx.addIssue({ code: 'custom', message, path: [lo] })
      }
    })
}

const nameSchema = z.string().trim().min(1, 'Name is required').max(120, 'Name must be 120 characters or fewer')
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' ? null : v))

/**
 * Typed as `ComponentInput`: the union is generated from the field table, which
 * zod cannot infer precisely; the per-category schemas enforce the real shape.
 */
export const componentInputSchema: z.ZodType<ComponentInput> = z.discriminatedUnion(
  'category',
  COMPONENT_CATEGORIES.map((category) =>
    z
      .object({
        category: z.literal(category),
        name: nameSchema,
        manufacturer: optionalText(80),
        notes: optionalText(2000),
        specs: specsSchema(category),
      })
      .strict(),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<ComponentInput>

export const componentIdSchema = z.object({ id: z.uuid() })
export const updateComponentSchema = z.object({ id: z.uuid(), baseRevision: z.int().min(0), input: componentInputSchema })
export const listComponentsSchema = z.object({ category: z.enum(COMPONENT_CATEGORIES).optional() })

/** Issues as messages that name the field, e.g. "Kv: Unit must be one of rpm/V". */
export function describeIssues(issues: readonly z.core.$ZodIssue[], input: unknown): string {
  const category = (input as { category?: ComponentCategory; input?: { category?: ComponentCategory } } | null)?.category
    ?? (input as { input?: { category?: ComponentCategory } } | null)?.input?.category
  const fields = category && COMPONENT_FIELDS[category] ? COMPONENT_FIELDS[category] : []
  return issues
    .map((i) => {
      const path = i.path.map(String)
      const at = path.indexOf('specs')
      if (at >= 0 && path[at + 1]) {
        const key = path[at + 1]!
        const label = fields.find((f) => f.key === key)?.label
        if (i.code === 'unrecognized_keys') return `Unknown field(s): ${(i as { keys: string[] }).keys.join(', ')}`
        return `${label ?? key}: ${i.message}`
      }
      if (i.code === 'unrecognized_keys' && path.at(-1) === 'specs') {
        return `Unknown field(s) for this category: ${(i as { keys: string[] }).keys.join(', ')}`
      }
      return i.message
    })
    .join('; ')
}
