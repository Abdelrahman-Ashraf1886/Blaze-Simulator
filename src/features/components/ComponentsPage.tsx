import { Copy, Download, ExternalLink, FileUp, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  CATEGORY_LABELS,
  COMPONENT_CATEGORIES,
  COMPONENT_FIELDS,
  type Component,
  type ComponentCategory,
  isOverridable,
  type FieldDef,
  type SpecValue,
} from '../../../electron/ipc/component-fields'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Section } from '@/components/section'
import { Table, Td, Th } from '@/components/table'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/field'
import { cn, formatTimestamp } from '@/lib/utils'
import { useComponents } from '@/stores/components'
import { ComponentEditor } from './ComponentEditor'
import { UserValueEditor } from './UserValueEditor'
import { SOURCE_LABELS, formatNumber, formatReference, formatValue, matches, provenanceSummary } from './spec-format'

type Filter = ComponentCategory | 'all'
const ORIGIN_LABELS = { 'built-in': 'Built-in', user: 'Yours', imported: 'Imported' } as const

export function ComponentsPage() {
  const { components, loading, error } = useComponents()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  // `#/components?id=…&field=…` (e.g. from the workshop's Ready-to-fly checklist) selects a
  // component and highlights one of its fields.
  const [params] = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'))
  const highlight = selectedId !== null && selectedId === params.get('id') ? params.get('field') : null
  const [editing, setEditing] = useState<{ component: Component | null } | null>(null)
  const [deleting, setDeleting] = useState<Component | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    void useComponents.getState().load()
  }, [])

  const counts = useMemo(() => {
    const c = Object.fromEntries(COMPONENT_CATEGORIES.map((k) => [k, 0])) as Record<ComponentCategory, number>
    for (const x of components) c[x.category]++
    return c
  }, [components])
  const shown = components.filter(
    (c) => (filter === 'all' || c.category === filter) && matches(c, query, CATEGORY_LABELS[c.category]),
  )
  const selected = components.find((c) => c.id === selectedId) ?? null

  const act = async (fn: () => Promise<string | null>) => {
    setNote(null)
    try {
      const text = await fn()
      if (text) setNote({ text, error: false })
    } catch (e) {
      setNote({ text: (e as Error).message, error: true })
    }
  }
  const exportPack = (list: Component[], name: string) =>
    act(async () => {
      const r = await useComponents.getState().exportPack(list.map((c) => c.id), name)
      return r ? `Exported ${r.count} component${r.count === 1 ? '' : 's'} to ${r.path.split(/[\\/]/).pop()}` : null
    })

  return (
    <>
      <PageHeader
        title="Components"
        count={components.length}
        actions={
          <div className="flex gap-2">
            <Button
              data-testid="import-pack"
              onClick={() =>
                void act(async () => {
                  const r = await useComponents.getState().importPack()
                  return r ? `Imported ${r.imported}${r.skipped ? `, skipped ${r.skipped} already in the library` : ''}` : null
                })
              }
            >
              <FileUp /> Import pack…
            </Button>
            <Button data-testid="new-component" variant="primary" onClick={() => setEditing({ component: null })}>
              <Plus /> New component
            </Button>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
        {note && (
          <p
            role={note.error ? 'alert' : 'status'}
            data-testid="library-note"
            className={cn('mb-3 whitespace-pre-line text-[12.5px]', note.error ? 'text-fault' : 'text-ok')}
          >
            {note.text}
          </p>
        )}
        <div className="@container">
          <div className="grid gap-8 @min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Section
              title="Library"
              count={shown.length}
              testId="component-list"
              actions={
                shown.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => void exportPack(shown, filter === 'all' ? 'Components' : `${CATEGORY_LABELS[filter]} components`)}>
                    <Download /> Export {shown.length === components.length ? 'all' : 'shown'}…
                  </Button>
                )
              }
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label className="relative min-w-[180px] flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                  <span className="sr-only">Search components</span>
                  <Input className="pl-7" placeholder="Search name, manufacturer, notes" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
              </div>
              <div role="group" aria-label="Category" className="mb-3 flex flex-wrap gap-1">
                {(['all', ...COMPONENT_CATEGORIES] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={filter === k}
                    onClick={() => setFilter(k)}
                    className={cn(
                      'h-6 rounded-[var(--radius-sm)] border px-2 text-[12px]',
                      filter === k ? 'border-accent text-accent' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg',
                    )}
                  >
                    {k === 'all' ? 'All' : CATEGORY_LABELS[k]}
                    <span className="num ml-1 text-fg-subtle">{k === 'all' ? components.length : counts[k]}</span>
                  </button>
                ))}
              </div>
              {error ? (
                <EmptyState>Could not load the library: {error}</EmptyState>
              ) : shown.length === 0 ? (
                <EmptyState>
                  {loading
                    ? 'Loading…'
                    : components.length === 0
                      ? 'No components yet. Add one, or import a pack.'
                      : 'Nothing matches this search.'}
                </EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-full">Name</Th>
                      <Th className="hidden @min-[520px]:table-cell">Category</Th>
                      <Th>Values</Th>
                      <Th className="hidden @min-[640px]:table-cell">Origin</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => {
                      const p = provenanceSummary(c)
                      return (
                        <tr key={c.id} className={cn('hover:bg-hover/50', c.id === selectedId && 'bg-hover')}>
                          <Td className="max-w-0">
                            <button
                              type="button"
                              data-testid="component-row"
                              data-name={c.name}
                              aria-pressed={c.id === selectedId}
                              onClick={() => setSelectedId(c.id)}
                              className="block w-full min-w-0 text-left"
                            >
                              <span className="block truncate hover:text-accent">{c.name}</span>
                              {c.manufacturer && <span className="block truncate text-[11.5px] text-fg-subtle">{c.manufacturer}</span>}
                            </button>
                          </Td>
                          <Td className="hidden text-fg-muted @min-[520px]:table-cell">{CATEGORY_LABELS[c.category]}</Td>
                          <Td className="num whitespace-nowrap text-fg-muted" title={`${p.values} values, ${p.cited} from manufacturer documents`}>
                            {p.values}
                            <span className="text-fg-subtle"> · {p.cited} cited</span>
                          </Td>
                          <Td className="hidden text-fg-muted @min-[640px]:table-cell">{ORIGIN_LABELS[c.origin]}</Td>
                        </tr>
                      )
                    })}
                  </tbody>
                </Table>
              )}
            </Section>

            {selected ? (
              <ComponentDetail
                key={selected.id}
                component={selected}
                highlight={highlight}
                onEdit={() => setEditing({ component: selected })}
                onDuplicate={() =>
                  void act(async () => {
                    const copy = await useComponents.getState().duplicate(selected.id)
                    setSelectedId(copy.id)
                    return `Created ${copy.name}`
                  })
                }
                onDelete={() => setDeleting(selected)}
                onExport={() => void exportPack([selected], selected.name)}
              />
            ) : (
              <Section title="Details">
                <EmptyState>Select a component to see its values and where each one comes from.</EmptyState>
              </Section>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <ComponentEditor
          component={editing.component}
          initialCategory={filter === 'all' ? 'motor' : filter}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null)
            setSelectedId(c.id)
          }}
        />
      )}
      {deleting && (
        <Dialog open onOpenChange={(o) => !o && setDeleting(null)}>
          <DialogContent title={`Delete ${deleting.name}?`} description="It is removed from the library. This cannot be undone.">
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                onClick={() => {
                  const target = deleting
                  setDeleting(null) // a refusal (e.g. "used by 2 parts") shows in the note, not behind the dialog
                  void act(async () => {
                    await useComponents.getState().remove(target.id)
                    setSelectedId(null)
                    return null
                  })
                }}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function ComponentDetail({
  component: c,
  highlight,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
}: {
  component: Component
  /** Field to scroll to and mark (a value the workshop asks for). */
  highlight?: string | null
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onExport: () => void
}) {
  const builtIn = c.origin === 'built-in'
  const lockedNote = 'Built-in components are read-only. Duplicate it to make your own version.'
  return (
    <Section
      title={c.name}
      testId="component-detail"
      actions={
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={builtIn} title={builtIn ? lockedNote : 'Edit'}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate} title="Make an editable copy">
            <Copy /> Duplicate
          </Button>
          <Button size="sm" variant="ghost" onClick={onExport} title="Export as a JSON pack">
            <Download /> Export…
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={builtIn} title={builtIn ? lockedNote : 'Delete'}>
            <Trash2 /> Delete
          </Button>
        </div>
      }
    >
      <dl className="border-t border-line text-[12.5px]">
        <Meta label="Category" value={CATEGORY_LABELS[c.category]} />
        <Meta label="Manufacturer" value={c.manufacturer ?? 'not specified'} muted={!c.manufacturer} />
        <Meta label="Origin" value={`${ORIGIN_LABELS[c.origin]} · updated ${formatTimestamp(c.updatedAt)}`} />
        {c.notes && <Meta label="Notes" value={c.notes} />}
      </dl>
      <h3 className="mt-4 pb-1 text-[12px] font-medium text-fg-subtle">Specifications</h3>
      <dl className="border-t border-line" data-testid="spec-list">
        {COMPONENT_FIELDS[c.category].map((f) => (
          <SpecRow
            key={f.key}
            field={f}
            spec={c.specs[f.key]}
            fill={c.fills?.[f.key]}
            fillable={builtIn && isOverridable(f)}
            componentId={c.id}
            highlight={f.key === highlight}
          />
        ))}
      </dl>
      {highlight && builtIn && (
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle" data-testid="highlight-note">
          {isOverridable(COMPONENT_FIELDS[c.category].find((f) => f.key === highlight))
            ? 'Enter the value above: it fills this gap wherever the component is linked, in every project, and stays apart from the manufacturer data. For one part only, override it in the workshop inspector.'
            : `${lockedNote} Then enter the value in the copy and link the copy in the workshop.`}
        </p>
      )}
    </Section>
  )
}

function Meta({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className={cn('min-w-0 text-right', muted ? 'text-fg-subtle' : 'text-fg')}>{value}</dd>
    </div>
  )
}

const SOURCE_TONE = { manufacturer: 'text-accent', measured: 'text-ok', user: 'text-fg-muted' } as const

function SpecRow({
  field,
  spec: stated,
  fill,
  fillable = false,
  componentId,
  highlight = false,
}: {
  field: FieldDef
  spec: SpecValue | undefined
  /** Catalog gap-fill (wins over the stated value, src/domain/spec-resolution.ts). */
  fill?: SpecValue
  /** A built-in record's single-value field: the user may fill it when empty. */
  fillable?: boolean
  componentId?: string
  highlight?: boolean
}) {
  const spec = fill ?? stated
  const ref = formatReference(spec?.reference)
  const row = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(highlight && fillable && !spec)
  useEffect(() => {
    if (highlight) row.current?.scrollIntoView({ block: 'center' })
  }, [highlight])
  const setFill = (v: SpecValue | null) => useComponents.getState().setFill(componentId!, field.key, v)
  return (
    <div
      ref={row}
      className={cn('border-b border-line/60 py-1.5', highlight && '-mx-2 rounded-[var(--radius-sm)] bg-warn/10 px-2 ring-1 ring-warn/60')}
      data-testid={`spec-${field.key}`}
      data-highlight={highlight || undefined}
    >
      <div className="flex items-baseline justify-between gap-4">
        <dt className="shrink-0 text-[12.5px] text-fg-muted">{field.label}</dt>
        <dd className={cn('min-w-0 text-right', spec ? 'num text-fg' : 'text-[12.5px] text-fg-subtle')}>
          {spec ? formatValue(field, spec) : 'not specified'}
        </dd>
      </div>
      {fill && (
        <div className="mt-0.5 flex flex-wrap items-baseline justify-end gap-x-2 text-right text-[11.5px]" data-testid="spec-fill">
          <span className="text-fg-subtle">Gap-fill in your library (not from the manufacturer)</span>
          <button type="button" className="text-fg-subtle underline hover:text-fault" onClick={() => void setFill(null)} data-testid="fill-remove">
            Remove
          </button>
          {stated && <span className="w-full text-warn">Manufacturer now states {formatValue(field, stated)}; your value is still used.</span>}
        </div>
      )}
      {!spec && fillable && !editing && (
        <div className="text-right">
          <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => setEditing(true)} data-testid="fill-enter">
            Enter value
          </button>
        </div>
      )}
      {editing && isOverridable(field) && (
        <UserValueEditor
          field={field}
          idPrefix="fill"
          onCancel={() => setEditing(false)}
          onSave={async (v) => {
            await setFill(v)
            setEditing(false)
          }}
        />
      )}
      {spec && (
        <div className="mt-0.5 flex flex-wrap items-baseline justify-end gap-x-2 text-right text-[11.5px]">
          {spec.condition && <span className="text-fg-subtle">{spec.condition}</span>}
          <span className={SOURCE_TONE[spec.source]} data-testid="spec-source">
            {SOURCE_LABELS[spec.source]}
          </span>
          {ref &&
            (spec.reference?.url ? (
              <a
                href={spec.reference.url}
                target="_blank"
                rel="noreferrer"
                title={spec.reference.url}
                className="inline-flex items-center gap-1 text-fg-subtle hover:text-accent hover:underline"
              >
                {ref} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="text-fg-subtle">{ref}</span>
            ))}
        </div>
      )}
      {spec && field.kind === 'table' && <TablePreview field={field} spec={spec} />}
    </div>
  )
}

function TablePreview({ field, spec }: { field: Extract<FieldDef, { kind: 'table' }>; spec: SpecValue }) {
  const t = spec.value as { units: Record<string, string>; rows: Record<string, number | string>[] }
  const cols = field.columns.filter((c) => t.rows.some((r) => r[c.key] !== undefined))
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className="px-1 text-right font-medium text-fg-muted first:text-left">
                {c.label}
                {t.units[c.key] && t.units[c.key] !== '1' ? ` (${t.units[c.key]})` : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i} className="border-t border-line/40">
              {cols.map((c) => (
                <td key={c.key} className="num px-1 text-right first:text-left">
                  {typeof r[c.key] === 'number' ? formatNumber(r[c.key] as number) : (r[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
