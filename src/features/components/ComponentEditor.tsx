import { Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  CATEGORY_LABELS,
  COMPONENT_CATEGORIES,
  COMPONENT_FIELDS,
  PORT_TYPES,
  type Component,
  type ComponentCategory,
  type FieldDef,
  type PortType,
} from '../../../electron/ipc/component-fields'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { unitsOf, type Unit } from '@/domain/units'
import { useComponents } from '@/stores/components'
import { draftFrom, today, toInput, type ComponentDraft, type DraftSource, type FieldDraft } from './editor-model'

const SOURCE_OPTIONS: { value: DraftSource; label: string }[] = [
  { value: 'none', label: 'Not specified' },
  { value: 'manufacturer', label: 'Manufacturer document' },
  { value: 'measured', label: 'Measured by me' },
  { value: 'user', label: 'Entered without a document' },
]

const select =
  'h-8 min-w-0 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg focus:border-accent focus:outline-none'

/**
 * Create or edit a component. Every value needs a source; manufacturer values
 * need a URL or document and the date it was read (main enforces the same).
 */
export function ComponentEditor({
  component,
  initialCategory = 'motor',
  onClose,
  onSaved,
}: {
  /** null: create a new component. */
  component: Component | null
  initialCategory?: ComponentCategory
  onClose: () => void
  onSaved: (c: Component) => void
}) {
  const [draft, setDraft] = useState<ComponentDraft>(() => draftFrom(component, initialCategory))
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const setField = (key: string, patch: Partial<FieldDraft>) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: { ...d.fields[key]!, ...patch } } }))

  const save = async () => {
    const r = toInput(draft)
    if (!r.ok) return setErrors(r.errors)
    setBusy(true)
    setErrors([])
    try {
      const store = useComponents.getState()
      const saved = component ? await store.update(component.id, component.revision, r.input) : await store.create(r.input)
      onSaved(saved)
    } catch (e) {
      // Main's messages name the field, joined with "; ".
      setErrors((e as Error).message.split('; '))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        wide
        title={component ? `Edit ${component.name}` : 'New component'}
        description="Fill in what the datasheet states. Every value needs its source; leave the rest as “Not specified”."
      >
        <form
          data-testid="component-editor"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          className="space-y-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {!component && (
              <div>
                <Label htmlFor="component-category">Category</Label>
                <select
                  id="component-category"
                  value={draft.category}
                  onChange={(e) => setDraft(draftFrom(null, e.target.value as ComponentCategory))}
                  className={cn(select, 'w-full')}
                >
                  {COMPONENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <Label htmlFor="component-name">Name</Label>
              <Input
                id="component-name"
                autoFocus
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Model as the manufacturer names it"
              />
            </div>
            <div>
              <Label htmlFor="component-manufacturer">Manufacturer</Label>
              <Input
                id="component-manufacturer"
                maxLength={80}
                value={draft.manufacturer}
                onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="component-notes">Notes</Label>
              <textarea
                id="component-notes"
                rows={2}
                maxLength={2000}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                className="w-full rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2.5 py-1.5 text-[13px] text-fg focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <fieldset className="min-w-0 border-t border-line">
            <legend className="sr-only">Specifications</legend>
            {COMPONENT_FIELDS[draft.category].map((f) => (
              <FieldRow key={`${draft.category}:${f.key}`} field={f} draft={draft.fields[f.key]!} set={(p) => setField(f.key, p)} />
            ))}
          </fieldset>

          {errors.length > 0 && (
            <ul role="alert" data-testid="editor-errors" className="space-y-0.5 text-[12.5px] text-fault">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              {component ? 'Save changes' : 'Add to library'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FieldRow({ field: f, draft: d, set }: { field: FieldDef; draft: FieldDraft; set: (p: Partial<FieldDraft>) => void }) {
  const id = `spec-${f.key}`
  const off = d.source === 'none'
  const cited = d.source === 'manufacturer' || d.source === 'measured'
  return (
    <div className="border-b border-line/60 py-2" data-testid={`field-${f.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="w-[170px] shrink-0 text-[12.5px] text-fg-muted">
          {f.label}
          {f.help && <span className="block text-[11px] leading-tight text-fg-subtle">{f.help}</span>}
        </label>
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5', off && 'opacity-60')}>
          <ValueInput id={id} field={f} draft={d} set={set} />
        </div>
        <select
          aria-label={`${f.label} source`}
          value={d.source}
          onChange={(e) => {
            const source = e.target.value as DraftSource
            set({ source, ...(source === 'manufacturer' && !d.retrieved ? { retrieved: today() } : {}) })
          }}
          className={cn(select, 'w-[190px]')}
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {f.kind === 'ports' && !off && <PortsEditor draft={d} set={set} />}
      {f.kind === 'table' && !off && <TableEditor field={f} draft={d} set={set} />}
      {!off && (
        <div className="mt-1.5 grid gap-1.5 pl-0 sm:grid-cols-2 sm:pl-[178px]">
          {cited && (
            <>
              <SmallInput label="Source URL" value={d.url} onChange={(url) => set({ url })} placeholder="https://…" />
              <SmallInput label="Or document title" value={d.document} onChange={(document) => set({ document })} />
              <SmallInput label="Page, table or section" value={d.locator} onChange={(locator) => set({ locator })} />
              <SmallInput label="Read on" type="date" value={d.retrieved} onChange={(retrieved) => set({ retrieved })} />
            </>
          )}
          <SmallInput label="Condition" value={d.condition} onChange={(condition) => set({ condition })} placeholder="e.g. 10 s burst, at 25 °C" />
        </div>
      )}
    </div>
  )
}

function ValueInput({ id, field: f, draft: d, set }: { id: string; field: FieldDef; draft: FieldDraft; set: (p: Partial<FieldDraft>) => void }) {
  if (f.kind === 'choice') {
    return (
      <select id={id} value={d.value} onChange={(e) => set({ value: e.target.value })} className={cn(select, 'w-full max-w-[220px]')}>
        <option value="">—</option>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (f.kind === 'ports' || f.kind === 'table') {
    const n = f.kind === 'ports' ? d.ports.length : d.rows.length
    return (
      <span id={id} className="text-[12.5px] text-fg-subtle">
        {d.source === 'none' ? 'Choose a source to add entries' : `${n} ${f.kind === 'ports' ? 'port' : 'row'}${n === 1 ? '' : 's'}`}
      </span>
    )
  }
  return (
    <>
      <Input
        id={id}
        className="h-8 w-full max-w-[160px] text-right num"
        inputMode={f.kind === 'text' ? 'text' : 'decimal'}
        maxLength={f.kind === 'text' ? f.maxLength : 40}
        value={d.value}
        onChange={(e) => set({ value: e.target.value })}
      />
      {f.kind === 'quantity' && (
        <select aria-label={`${f.label} unit`} value={d.unit ?? f.unit} onChange={(e) => set({ unit: e.target.value as Unit })} className={select}>
          {unitsOf(f.dimension).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

function PortsEditor({ draft: d, set }: { draft: FieldDraft; set: (p: Partial<FieldDraft>) => void }) {
  const update = (i: number, patch: Partial<{ name: string; type: PortType }>) =>
    set({ ports: d.ports.map((p, j) => (j === i ? { ...p, ...patch } : p)) })
  return (
    <div className="mt-1.5 space-y-1 sm:pl-[178px]">
      {d.ports.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input aria-label={`Port ${i + 1} name`} className="h-7 max-w-[140px]" value={p.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} />
          <select aria-label={`Port ${i + 1} type`} value={p.type} onChange={(e) => update(i, { type: e.target.value as PortType })} className={cn(select, 'h-7')}>
            {PORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()}
              </option>
            ))}
          </select>
          <IconButton label={`Remove port ${i + 1}`} onClick={() => set({ ports: d.ports.filter((_, j) => j !== i) })}>
            <X />
          </IconButton>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" onClick={() => set({ ports: [...d.ports, { name: '', type: 'uart' }] })}>
        <Plus /> Add port
      </Button>
    </div>
  )
}

function TableEditor({ field: f, draft: d, set }: { field: Extract<FieldDef, { kind: 'table' }>; draft: FieldDraft; set: (p: Partial<FieldDraft>) => void }) {
  const update = (i: number, key: string, v: string) => set({ rows: d.rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)) })
  return (
    <div className="mt-1.5 overflow-x-auto sm:pl-[178px]">
      <table className="text-[12px]">
        <thead>
          <tr>
            {f.columns.map((c) => (
              <th key={c.key} className="px-1 pb-1 text-left font-medium text-fg-muted">
                {c.label}
                {c.kind === 'quantity' && (
                  <select
                    aria-label={`${c.label} unit`}
                    value={d.units[c.key] ?? c.unit}
                    onChange={(e) => set({ units: { ...d.units, [c.key]: e.target.value as Unit } })}
                    className={cn(select, 'ml-1 h-6 px-1 text-[11.5px]')}
                  >
                    {unitsOf(c.dimension).map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                )}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={i}>
              {f.columns.map((c) => (
                <td key={c.key} className="px-1 py-0.5">
                  <Input aria-label={`Row ${i + 1} ${c.label}`} className="h-7 w-[84px] num" value={r[c.key] ?? ''} onChange={(e) => update(i, c.key, e.target.value)} />
                </td>
              ))}
              <td>
                <IconButton label={`Remove row ${i + 1}`} onClick={() => set({ rows: d.rows.filter((_, j) => j !== i) })}>
                  <X />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button type="button" size="sm" variant="ghost" onClick={() => set({ rows: [...d.rows, {}] })}>
        <Plus /> Add row
      </Button>
    </div>
  )
}

function SmallInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-[11.5px] text-fg-subtle">
      <span className="w-[92px] shrink-0">{label}</span>
      <Input type={type} className="h-7 text-[12px]" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}
