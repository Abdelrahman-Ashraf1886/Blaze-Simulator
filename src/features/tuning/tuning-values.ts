import { controllerParam, validateOverrides, type ControllerParam, type TuningOverrides } from '../../domain/controller-params'

export const tuningInputClass = 'num h-7 w-full min-w-0 rounded-sm border border-line-strong bg-bg px-2 text-right text-fg focus-visible:border-accent aria-invalid:border-fault disabled:opacity-50'

export function readNumber(text: string): number {
  const trimmed = text.trim()
  // Match the decimal separator handling in src/components/number-field.tsx:86–90.
  return trimmed === '' ? Number.NaN : Number(trimmed.replace(',', '.'))
}

export function readOverrides(draft: Record<string, string>, saved: TuningOverrides) {
  const entries = Object.entries(draft).map(([name, text]) => [name, readNumber(text)] as const)
  const overrides = Object.fromEntries(entries.filter(([name, value]) => value !== controllerParam(name)?.default))
  const dirty = Object.keys(saved).some((name) => !(name in draft))
    || entries.some(([name, value]) => value !== (saved[name] ?? controllerParam(name)?.default))
  return { overrides, dirty, validation: validateOverrides(overrides) }
}

export function documentedRange({ min, max }: ControllerParam): string {
  if (min === null) return max === null ? 'No documented bounds' : `≤ ${max}`
  return max === null ? `≥ ${min}` : `${min} to ${max}`
}
