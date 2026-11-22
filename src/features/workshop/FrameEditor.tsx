import { useMemo, useState } from 'react'
import type { AssemblyDocument, BodyDragInput, FrameParams } from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import { cn } from '@/lib/utils'
import type { FrameGeometry } from '@/three/frame-geometry'
import { bodyAreas } from './aero-input'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
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

export function FrameEditor({ geo }: { geo?: FrameGeometry | null }) {
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
      <div data-testid="body-drag" title="Body drag per axis F = ½ ρ C_d A v|v|, A from the parts' collision shapes. No source states C_d for a build.">
        {AXES.map((axis, i) => {
          const cd = bodyDrag?.cd ?? [null, null, null]
          return (
            <NumberField
              key={`body-cd-${axis.key}:${cd[i] ?? 'none'}`}
              id={`body-cd-${axis.key}`}
              label={`Body C_d ${axis.label}`}
              initial={cd[i] === null ? '' : String(cd[i])}
              placeholder="not set"
              parse={bodyCd}
              onCommit={(v) => useAssembly.getState().edit(v === null ? `Clear body C_d ${axis.key}` : `Set body C_d ${axis.key}`, (d) => setAxis(d.bodyDrag?.cd, i, v, d))}
            />
          )
        })}
        <p className="py-1.5 text-[11.5px] leading-relaxed text-fg-subtle">
          The first value entered is copied to the axes still empty; change any axis afterwards.
        </p>
        {geo && <DragAreas geo={geo} />}
      </div>
    </div>
  )
}

const AXES = [
  { key: 'x', label: 'X (forward)' },
  { key: 'y', label: 'Y (left)' },
  { key: 'z', label: 'Z (up)' },
] as const

/** Sets one axis; when every axis was empty, the value fills all three (stated in the UI). */
function setAxis(cd: BodyDragInput['cd'] | undefined, i: number, v: number | null, d: AssemblyDocument): AssemblyDocument {
  const cur: BodyDragInput['cd'] = cd ? [...cd] : [null, null, null]
  const empty = cur.every((x) => x === null)
  const next: BodyDragInput['cd'] = empty && v !== null ? [v, v, v] : (cur.map((x, k) => (k === i ? v : x)) as typeof cur)
  return { ...d, bodyDrag: next.every((x) => x === null) ? null : { cd: next, source: 'user' } }
}

/** Derived projected areas A_x, A_y, A_z (src/domain/aero.ts), with their resolution error. */
function DragAreas({ geo }: { geo: FrameGeometry }) {
  const doc = useAssembly((s) => s.doc)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const a = useMemo(() => (doc ? bodyAreas(doc, geo, components, assets) : null), [doc, geo, components, assets])
  if (!a) return null
  const cm2 = (m2: number) => (m2 * 1e4).toFixed(1)
  return (
    <div className="border-t border-line/60 py-1.5 text-[12px]" data-testid="drag-areas">
      <span className="text-fg-muted">Projected areas (derived)</span>
      <span className="num block text-right text-fg">
        A_x {cm2(a.area[0])} · A_y {cm2(a.area[1])} · A_z {cm2(a.area[2])} cm²
      </span>
      <span className="block text-right text-[11.5px] text-fg-subtle">
        Union of the collision shapes on each body plane, {a.cell * 1000} mm grid (± {cm2(Math.max(...a.error))} cm²); propeller
        discs left out.
      </span>
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
