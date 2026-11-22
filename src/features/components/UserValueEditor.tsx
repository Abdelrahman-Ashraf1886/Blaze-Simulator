import { useState } from 'react'
import { USER_SPEC_SOURCES, type FieldDef, type SpecValue, type UserSpecSource } from '../../../electron/ipc/component-fields'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { unitsOf, type Unit } from '@/domain/units'
import { SOURCE_LABELS } from './spec-format'

const control =
  'h-7 min-w-0 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-[12.5px] text-fg hover:border-fg-subtle/70 focus:border-accent focus:outline-none'

/**
 * Inline editor for a value the user enters for one quantity or integer field: a
 * catalog gap-fill (library) or a part override (workshop). The source is always
 * 'measured' or 'user', never 'manufacturer'; the condition is optional.
 */
export function UserValueEditor({
  field,
  initial,
  idPrefix,
  onSave,
  onCancel,
}: {
  field: FieldDef & { kind: 'quantity' | 'integer' }
  initial?: SpecValue | null
  idPrefix: string
  onSave: (spec: SpecValue) => void | Promise<void>
  onCancel: () => void
}) {
  const units = field.kind === 'quantity' ? unitsOf(field.dimension) : []
  const [text, setText] = useState(initial && typeof initial.value === 'number' ? String(initial.value) : '')
  const [unit, setUnit] = useState<Unit>(initial && 'unit' in initial ? (initial.unit as Unit) : field.kind === 'quantity' ? field.unit : ('1' as Unit))
  const [source, setSource] = useState<UserSpecSource>(initial?.source === 'user' ? 'user' : 'measured')
  const [condition, setCondition] = useState(initial?.condition ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const v = Number(text.trim().replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(v) || v < 0) return setError('Enter a number ≥ 0')
    if (field.kind === 'integer' && !Number.isInteger(v)) return setError('Enter a whole number')
    const spec = {
      value: v,
      ...(field.kind === 'quantity' ? { unit } : {}),
      source,
      ...(condition.trim() ? { condition: condition.trim() } : {}),
    } as SpecValue
    try {
      setError(null)
      await onSave(spec)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mt-1 space-y-1.5 rounded-[var(--radius-sm)] border border-line bg-hover/30 p-2" data-testid={`${idPrefix}-editor`}>
      <div className="flex items-center gap-1.5">
        <input
          id={`${idPrefix}-value`}
          data-testid={`${idPrefix}-value`}
          aria-label={`${field.label} value`}
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') onCancel()
          }}
          className={cn(control, 'num w-24 text-right')}
        />
        {units.length > 0 && (
          <select aria-label="Unit" data-testid={`${idPrefix}-unit`} value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={control}>
            {units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Source"
          data-testid={`${idPrefix}-source`}
          value={source}
          onChange={(e) => setSource(e.target.value as UserSpecSource)}
          className={control}
        >
          {USER_SPEC_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <input
        aria-label="Condition"
        data-testid={`${idPrefix}-condition`}
        placeholder="Condition or how it was measured (optional)"
        value={condition}
        maxLength={200}
        onChange={(e) => setCondition(e.target.value)}
        className={cn(control, 'w-full')}
      />
      {error && (
        <p role="alert" className="text-[11.5px] text-fault">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} data-testid={`${idPrefix}-save`}>
          Save
        </Button>
      </div>
    </div>
  )
}
