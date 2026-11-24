import { NumberField } from '@/components/number-field'

export function optionalNumber(text: string, constraint?: { accepts: (value: number) => boolean; message: string }) {
  if (!text.trim()) return { ok: true as const, value: null }
  const value = Number(text.trim().replace(',', '.'))
  if (!Number.isFinite(value)) return { ok: false as const, message: 'Enter a finite number.' }
  if (constraint && !constraint.accepts(value)) return { ok: false as const, message: constraint.message }
  return { ok: true as const, value }
}

export function OptionalNumberField({ id, label, value, unit, constraint, hint, onCommit }: {
  id: string
  label: string
  value: number | null
  unit?: string
  constraint?: Parameters<typeof optionalNumber>[1]
  hint?: string
  onCommit: (value: number | null) => void
}) {
  return <div>
    <NumberField key={value} id={id} label={label} initial={value === null ? '' : String(value)} unit={unit}
      placeholder="not set" parse={(text) => optionalNumber(text, constraint)} onCommit={onCommit} />
    {hint && <p className="text-right text-[11.5px] text-warn">{hint}</p>}
  </div>
}

export function ChoiceField({ id, label, value, options, onChange, hint, disabled }: {
  id: string
  label: string
  value: string
  options: ReadonlyArray<readonly [value: string, label: string]>
  onChange: (value: string) => void
  hint?: string
  disabled?: boolean
}) {
  return <div className="border-b border-line/60 py-1.5">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <label className="text-[12.5px] text-fg-muted" htmlFor={id}>{label}</label>
      <select id={id} data-testid={id} value={value} disabled={disabled} aria-describedby={hint ? id + '-hint' : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-7 min-w-0 max-w-full rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-[12.5px] text-fg">
        {options.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select>
    </div>
    {hint && <p id={id + '-hint'} className="mt-1 text-[11.5px] text-warn">{hint}</p>}
  </div>
}
