import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Labelled numeric input that commits on Enter or blur and reverts on Escape.
 * `parse` turns the text into a value or an error message. Render it with a
 * `key` that includes the stored value, so outside changes (undo, reload) reset it.
 */
export function NumberField<T>({
  id,
  label,
  initial,
  unit,
  parse,
  onCommit,
  placeholder,
  width = 92,
}: {
  id: string
  label: string
  /** Text shown initially (the stored value, formatted). */
  initial: string
  unit?: string
  parse: (text: string) => { ok: true; value: T } | { ok: false; message: string }
  onCommit: (value: T) => void
  placeholder?: string
  width?: number
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    if (text.trim() === initial.trim()) return setError(null)
    const r = parse(text)
    if (!r.ok) return setError(r.message)
    setError(null)
    onCommit(r.value)
  }

  return (
    <div className="border-b border-line/60 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="min-w-0 truncate text-[12.5px] text-fg-muted">
          {label}
        </label>
        <div
          style={{ width }}
          className={cn(
            'flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] border bg-chrome focus-within:border-accent',
            unit ? 'pr-2' : '',
            error ? 'border-fault' : 'border-line-strong hover:border-fg-subtle/70',
          )}
        >
          <input
            id={id}
            data-testid={id}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder={placeholder}
            aria-invalid={!!error}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setText(initial)
                setError(null)
              }
            }}
            className="num h-full w-full min-w-0 bg-transparent px-2 text-right text-fg outline-none placeholder:text-fg-subtle"
          />
          {unit && <span className="num text-fg-subtle">{unit}</span>}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-right text-[11.5px] text-fault">
          {error}
        </p>
      )}
    </div>
  )
}

/** Parses a number (dot or comma decimal) within [min, max]; `step` rounds the result. */
export function numberParser(min: number, max: number, unit: string, step = 0.1) {
  return (text: string): { ok: true; value: number } | { ok: false; message: string } => {
    const v = Number(text.trim().replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(v)) return { ok: false, message: 'Enter a number' }
    const rounded = Math.round(v / step) * step
    if (rounded < min || rounded > max) return { ok: false, message: `Between ${min} and ${max} ${unit}` }
    return { ok: true, value: Math.round(rounded * 1e6) / 1e6 }
  }
}
