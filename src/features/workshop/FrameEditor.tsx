import { useState } from 'react'
import type { FrameParams } from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import { cn } from '@/lib/utils'
import { useAssembly } from './assembly-store'
import { parseFrameValue, toMm } from './frame-values'

const FIELDS: { key: keyof FrameParams; label: string; edit: string }[] = [
  { key: 'motorDiagonal', label: 'Motor-to-motor diagonal', edit: 'Change motor-to-motor diagonal' },
  { key: 'plateSize', label: 'Centre plate', edit: 'Change centre plate size' },
  { key: 'armWidth', label: 'Arm width', edit: 'Change arm width' },
  { key: 'armThickness', label: 'Arm thickness', edit: 'Change arm thickness' },
]

const bodyCd = (text: string): { ok: true; value: number | null } | { ok: false; message: string } => {
  if (text.trim() === '') return { ok: true, value: null }
  return numberParser(0.01, 10, '', 0.01)(text)
}

const frameMassG = (text: string): { ok: true; value: number | null } | { ok: false; message: string } => {
  if (text.trim() === '') return { ok: true, value: null }
  const r = numberParser(0.1, 100_000, 'g')(text)
  return r.ok ? { ok: true, value: r.value } : r
}

export function FrameEditor() {
  const frame = useAssembly((s) => s.doc?.frame)
  const frameMass = useAssembly((s) => s.doc?.frameMass ?? null)
  const bodyDrag = useAssembly((s) => s.doc?.bodyDrag ?? null)
  if (!frame) return null
  return (
    <div className="border-t border-line" data-testid="frame-editor">
      {FIELDS.map((f) => (
        // Keyed by the stored value: undo/redo or a reload resets the field to it.
        <FrameField key={`${f.key}:${frame[f.key]}`} field={f} frame={frame} />
      ))}
      <div className="border-b border-line/60">
        <NumberField
          key={`frame-mass:${frameMass?.valueKg ?? 'none'}`}
          id="frame-mass"
          label="Frame mass"
          initial={frameMass ? String(Math.round(frameMass.valueKg * 1e4) / 10) : ''}
          placeholder="not set"
          unit="g"
          parse={frameMassG}
          onCommit={(g) =>
            useAssembly
              .getState()
              .edit(g === null ? 'Clear frame mass' : 'Set frame mass', (d) => ({
                ...d,
                frameMass: g === null ? null : { valueKg: g / 1000, source: 'user' },
              }))
          }
        />
      </div>
      <div title="Body drag per axis F = ½ ρ C_d A v², A from the parts' collision shapes. No source states C_d for a build.">
        <NumberField
          key={`body-cd:${bodyDrag?.value ?? 'none'}`}
          id="body-cd"
          label="Body drag coefficient C_d"
          initial={bodyDrag ? String(bodyDrag.value) : ''}
          placeholder="not set"
          parse={bodyCd}
          onCommit={(v) =>
            useAssembly
              .getState()
              .edit(v === null ? 'Clear body drag coefficient' : 'Set body drag coefficient', (d) => ({
                ...d,
                bodyDrag: v === null ? null : { value: v, source: 'user' },
              }))
          }
        />
      </div>
    </div>
  )
}

function FrameField({ field, frame }: { field: (typeof FIELDS)[number]; frame: FrameParams }) {
  const stored = toMm(frame[field.key])
  const [text, setText] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const id = `frame-${field.key}`

  const commit = () => {
    if (text.trim() === stored) return setError(null)
    const r = parseFrameValue(field.key, text, frame)
    if (!r.ok) return setError(r.message)
    setError(null)
    setText(toMm(r.metres))
    if (r.metres !== frame[field.key]) {
      useAssembly.getState().edit(field.edit, (d) => ({ ...d, frame: { ...d.frame, [field.key]: r.metres } }))
    }
  }

  return (
    <div className="border-b border-line/60 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="min-w-0 text-[12.5px] text-fg-muted">
          {field.label}
        </label>
        <div
          className={cn(
            'flex h-7 w-[92px] shrink-0 items-center rounded-[var(--radius-sm)] border bg-chrome pr-2 focus-within:border-accent',
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
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setText(stored)
                setError(null)
              }
            }}
            className="num h-full w-full min-w-0 bg-transparent px-2 text-right text-fg outline-none"
          />
          <span className="num text-fg-subtle">mm</span>
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-right text-[11.5px] text-fault">
          {error}
        </p>
      )}
    </div>
  )
}
