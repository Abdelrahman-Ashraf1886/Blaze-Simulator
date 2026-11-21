import {
  BatteryFull,
  Box,
  Camera,
  CircuitBoard,
  Cog,
  Copy,
  Cpu,
  Fan,
  Footprints,
  Gauge,
  Package,
  Satellite,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  MODEL_UNITS,
  PART_KINDS,
  type AssemblyDocument,
  type AssemblyPart,
  type PartKind,
  type PartShape,
} from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FrameGeometry } from '@/three/frame-geometry'
import {
  PART_LABELS,
  addPart,
  attach,
  attachableParts,
  copyToMotorMounts,
  deletePart,
  freeMotorMounts,
  duplicatePart,
  fromEulerDeg,
  shapeExtent,
  subtreeIds,
  toEulerDeg,
  updatePart,
  type AttachTarget,
} from './assembly-ops'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { toMm } from './frame-values'
import { ModelImport, Segmented, formatSize } from './ModelImport'
import { UNIT_LABELS } from '@/three/model-units'
import { useComponents } from '@/stores/components'
import { CATEGORY_LABELS, type Component, type SpecReference, type SpecSource } from '../../../electron/ipc/component-fields'
import { SOURCE_LABELS, formatNumber, formatReference } from '../components/spec-format'
import {
  KIND_CATEGORIES,
  effectiveMass,
  effectiveShape,
  linkableComponents,
  linkedComponent,
  linkedShape,
  type ComponentIndex,
} from './links'

import { componentIndex, useComponentIndex } from './component-index'
import { addPlaced, editSize } from './place-actions'
export { useComponentIndex }
const shapeOfFor = (components: ComponentIndex) => (p: AssemblyPart) => effectiveShape(p, components)
import { InertiaEditor } from './InertiaEditor'
import { useWorkshopView, type Selection } from './view-store'

const KIND_ICON: Record<PartKind, LucideIcon> = {
  motor: Cog,
  propeller: Fan,
  battery: BatteryFull,
  'flight-controller': Cpu,
  esc: CircuitBoard,
  gps: Satellite,
  camera: Camera,
  sensor: Gauge,
  'landing-gear': Footprints,
  payload: Package,
  custom: Box,
}

const edit = (label: string, recipe: (d: AssemblyDocument) => AssemblyDocument) =>
  useAssembly.getState().edit(label, recipe)

/** Where a new part goes, given the current selection. */
export function targetFor(selection: Selection): AttachTarget {
  if (selection?.kind === 'mount') return { kind: 'mount', id: selection.id }
  if (selection?.kind === 'part') return { kind: 'part', id: selection.id }
  return { kind: 'none' }
}

function mountLabel(geo: FrameGeometry, id: string): string {
  const m = geo.motors.find((x) => x.id === id)
  if (m) return `Motor ${m.number} mount`
  return geo.plates.find((p) => p.id === id)?.name ?? id
}

function targetLabel(geo: FrameGeometry, doc: AssemblyDocument, t: AttachTarget): string {
  if (t.kind === 'mount') return mountLabel(geo, t.id)
  if (t.kind === 'part') return doc.parts.find((p) => p.id === t.id)?.name ?? 'part'
  return 'top of the frame (free)'
}

// ---- Library ------------------------------------------------------------------

/** MIME type of a part kind dragged from the library onto the viewport. */
export const PART_DRAG_TYPE = 'application/x-blaze-part-kind'

/**
 * Adds a new part of `kind` to `target`, placed clear of the other parts on what it rests
 * on (placement.ts), as one undo step, and selects it. If there is no free spot, nothing is
 * added and the reason is shown under "Add part".
 */
export function addLibraryPart(kind: PartKind, target: AttachTarget, frameTop: number, geo: FrameGeometry) {
  // Landing gear belongs under the frame: with nothing selected it goes on the bottom plate.
  const to: AttachTarget = kind === 'landing-gear' && target.kind === 'none' ? { kind: 'mount', id: 'plate-bottom' } : target
  addPlaced(`Add ${PART_LABELS[kind].toLowerCase()}`, geo, (d, index, assets) => {
    const r = addPart(d, kind, to, frameTop, undefined, assets, shapeOfFor(index))
    return { doc: r.doc, roots: [r.part.id] }
  })
}

export function PartLibrary({ doc, geo, frameTop }: { doc: AssemblyDocument; geo: FrameGeometry; frameTop: number }) {
  const selection = useWorkshopView((s) => s.selection)
  const target = targetFor(selection)
  const add = (kind: PartKind) => addLibraryPart(kind, target, frameTop, geo)
  const note = useWorkshopView((s) => s.placementNote)
  return (
    <div data-testid="part-library">
      <div className="grid grid-cols-2 gap-1 border-t border-line pt-2">
        {PART_KINDS.map((kind) => {
          const Icon = KIND_ICON[kind]
          return (
            <button
              key={kind}
              type="button"
              onClick={() => add(kind)}
              draggable
              title={`Add a ${PART_LABELS[kind].toLowerCase()}, or drag it onto a mount in the viewport`}
              onDragStart={(e) => {
                e.dataTransfer.setData(PART_DRAG_TYPE, kind)
                e.dataTransfer.effectAllowed = 'copy'
                useWorkshopView.getState().setLibraryDrag(kind)
              }}
              onDragEnd={() => {
                useWorkshopView.getState().setLibraryDrag(null)
                useWorkshopView.getState().setSnapTarget(null)
              }}
              className="flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-line px-2 text-left text-[12.5px] text-fg-muted hover:border-line-strong hover:bg-hover hover:text-fg"
            >
              <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{PART_LABELS[kind]}</span>
            </button>
          )
        })}
      </div>
      {note && (
        <p role="alert" data-testid="placement-error" className="mt-1.5 text-[12px] leading-relaxed text-fault">
          {note}
        </p>
      )}
      <ModelImport target={target} frameTop={frameTop} geo={geo} />
      <p className="mt-2 text-[12px] text-fg-subtle" data-testid="add-target">
        Adds to {targetLabel(geo, doc, target)}, or drag onto a mount. New parts start with a placeholder shape and no mass.
      </p>
    </div>
  )
}

// ---- Assembly tree --------------------------------------------------------------

export function AssemblyTree({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const selection = useWorkshopView((s) => s.selection)
  const components = useComponentIndex()
  if (doc.parts.length === 0) {
    return <p className="border-t border-line py-3 text-[12.5px] text-fg-subtle">No parts yet.</p>
  }
  const mountIds = new Set([...geo.motors.map((m) => m.id), ...geo.plates.map((p) => p.id)])
  const childrenOf = (parentId: string) => doc.parts.filter((p) => p.parentId === parentId)
  // Roots of one mount group, or (mountId = null) the free parts.
  const roots = (mountId: string | null) =>
    doc.parts.filter((p) => p.parentId === null && (mountId === null ? !mountIds.has(p.mountId ?? '') : p.mountId === mountId))

  const rows = (parts: AssemblyPart[], depth: number): ReactNode =>
    parts.map((p) => (
      <li key={p.id}>
        <button
          type="button"
          data-testid="part-row"
          data-name={p.name}
          aria-pressed={selection?.kind === 'part' && selection.id === p.id}
          onClick={() => useWorkshopView.getState().selectPart(p.id)}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            'flex w-full items-center gap-2 rounded-[var(--radius-sm)] py-1 pr-2 text-left text-[12.5px] hover:bg-hover/60',
            selection?.kind === 'part' && selection.id === p.id ? 'bg-hover text-fg' : 'text-fg-muted',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          {effectiveMass(p, components) === null && <span className="shrink-0 text-[11px] text-fg-subtle">no mass</span>}
        </button>
        {childrenOf(p.id).length > 0 && <ul>{rows(childrenOf(p.id), depth + 1)}</ul>}
      </li>
    ))

  const groups = [
    ...geo.motors.map((m) => ({ id: m.id, label: `Motor ${m.number} · ${m.name}` })),
    ...geo.plates.map((p) => ({ id: p.id, label: p.name })),
  ]
  return (
    <div className="border-t border-line pt-1" data-testid="assembly-tree">
      {groups.map((g) => {
        const parts = roots(g.id)
        if (parts.length === 0) return null
        return (
          <div key={g.id} className="py-1">
            <div className="px-2 py-0.5 text-[11.5px] text-fg-subtle">{g.label}</div>
            <ul>{rows(parts, 0)}</ul>
          </div>
        )
      })}
      {roots(null).length > 0 && (
        <div className="py-1">
          <div className="px-2 py-0.5 text-[11.5px] text-fg-subtle">Free</div>
          <ul>{rows(roots(null), 0)}</ul>
        </div>
      )}
    </div>
  )
}

// ---- Inspector -------------------------------------------------------------------

const lengthMm = numberParser(0.1, 3000, 'mm')
const coordMm = numberParser(-10000, 10000, 'mm')
const angleDeg = numberParser(-360, 360, '°')
const massG = (text: string): { ok: true; value: number | null } | { ok: false; message: string } => {
  if (text.trim() === '') return { ok: true, value: null }
  const r = numberParser(0.1, 1_000_000, 'g')(text)
  return r.ok ? { ok: true, value: r.value } : r
}

export function PartInspector({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const selection = useWorkshopView((s) => s.selection)
  const part = selection?.kind === 'part' ? doc.parts.find((p) => p.id === selection.id) : undefined
  const assets = useAssets((s) => s.assets)
  const library = useComponents((s) => s.components)
  const components = componentIndex(library)
  if (!part) return null
  const id = part.id
  const linked = linkedComponent(part, components)
  const linkedSize = linked ? linkedShape(part, linked) : null
  const mass = effectiveMass(part, components)
  const shapeOf = shapeOfFor(components)
  const set = (label: string, patch: Partial<AssemblyPart>) => edit(label, (d) => updatePart(d, id, patch))
  const isMount = (m: string | null) => !!m && (geo.motors.some((x) => x.id === m) || geo.plates.some((x) => x.id === m))
  const attachedTo = part.parentId !== null ? `part:${part.parentId}` : isMount(part.mountId) ? `mount:${part.mountId}` : 'none'
  const relativeTo =
    attachedTo === 'none'
      ? 'world'
      : attachedTo.startsWith('mount:')
        ? mountLabel(geo, part.mountId!)
        : (doc.parts.find((p) => p.id === part.parentId)?.name ?? 'parent')
  const euler = toEulerDeg(part.rotation)
  const attached = subtreeIds(doc, id).size - 1

  return (
    <Section
      title={part.name}
      testId="part-inspector"
      actions={
        <button
          type="button"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={() => useWorkshopView.getState().clearSelection()}
          className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      }
    >
      <div className="border-t border-line">
        <NameField key={`name:${part.name}`} part={part} />
        <Row label="Kind">
          <select
            aria-label="Kind"
            value={part.kind}
            onChange={(e) => {
              const kind = e.target.value as PartKind
              // A link that does not fit the new kind is removed in the same step.
              const keep = !!linked && KIND_CATEGORIES[kind].includes(linked.category)
              set(`Change ${part.name} kind`, { kind, ...(part.componentId && !keep ? { componentId: null } : {}) })
            }}
            className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
          >
            {PART_KINDS.map((k) => (
              <option key={k} value={k}>
                {PART_LABELS[k]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Attached to">
          <select
            aria-label="Attached to"
            value={attachedTo}
            onChange={(e) => {
              const v = e.target.value
              const target: AttachTarget =
                v === 'none' ? { kind: 'none' } : v.startsWith('mount:') ? { kind: 'mount', id: v.slice(6) } : { kind: 'part', id: v.slice(5) }
              edit(`Attach ${part.name}`, (d) => attach(d, geo, id, target, assets, shapeOf))
            }}
            className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
          >
            <option value="none">Nothing (free)</option>
            <optgroup label="Frame">
              {geo.motors.map((m) => (
                <option key={m.id} value={`mount:${m.id}`}>
                  Motor {m.number} mount
                </option>
              ))}
              {geo.plates.map((p) => (
                <option key={p.id} value={`mount:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {attachableParts(doc, id).length > 0 && (
              <optgroup label="Parts">
                {attachableParts(doc, id).map((p) => (
                  <option key={p.id} value={`part:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Row>
        <ComponentRow part={part} linked={linked} options={linkableComponents(part.kind, library)} geo={geo} />
      </div>

      <SubHeading>Shape</SubHeading>
      <div className="border-t border-line">
        {part.shape.type === 'model' ? (
          <ModelFields part={part} shape={part.shape} />
        ) : linked && linkedSize ? (
          <LinkedSize component={linked} shape={linkedSize} />
        ) : (
          <>
            <Row label="Type">
              <Segmented
                label="Shape type"
                value={part.shape.type}
                options={[
                  { value: 'box', label: 'Box' },
                  { value: 'cylinder', label: 'Cylinder' },
                ]}
                onChange={(t) => set(`Change ${part.name} shape`, { shape: convertShape(part.shape, t) })}
              />
            </Row>
            <ShapeFields part={part} geo={geo} />
          </>
        )}
        <Row label="Size X × Y × Z">
          <span className="num text-[12.5px]" data-testid="part-size">
            {(() => {
              const e = shapeExtent(effectiveShape(part, components), assets)
              return e ? `${formatSize(e)} mm` : 'unknown'
            })()}
          </span>
        </Row>
      </div>

      <SubHeading>Placement · relative to {relativeTo}</SubHeading>
      <div className="border-t border-line">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <NumberField
            key={`pos${axis}:${part.position[i]}`}
            id={`part-pos-${axis.toLowerCase()}`}
            label={`Position ${axis}`}
            initial={toMm(part.position[i]!)}
            unit="mm"
            parse={coordMm}
            onCommit={(mm) => {
              const position = [...part.position] as [number, number, number]
              position[i] = mm / 1000
              set(`Move ${part.name}`, { position })
            }}
          />
        ))}
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <NumberField
            key={`rot${axis}:${part.rotation.join(',')}`}
            id={`part-rot-${axis.toLowerCase()}`}
            label={`Rotation ${axis}`}
            initial={String(Math.round(euler[i]! * 10) / 10)}
            unit="°"
            parse={angleDeg}
            onCommit={(deg) => {
              const next = [...euler] as [number, number, number]
              next[i] = deg
              set(`Rotate ${part.name}`, { rotation: fromEulerDeg(next) })
            }}
          />
        ))}
      </div>

      <SubHeading>Mass</SubHeading>
      <div className="border-t border-line">
        {mass?.from === 'component' && linked && mass.spec ? (
          <LinkedMass component={linked} massKg={mass.valueKg} own={part.mass?.valueKg ?? null} spec={mass.spec} />
        ) : (
          <>
        <NumberField
          key={`mass:${part.mass?.valueKg ?? 'none'}`}
          id="part-mass"
          label="Mass"
          initial={part.mass ? String(Math.round(part.mass.valueKg * 1e4) / 10) : ''}
          placeholder="not set"
          unit="g"
          parse={massG}
          onCommit={(g) =>
            set(g === null ? `Clear ${part.name} mass` : `Set ${part.name} mass`, {
              mass: g === null ? null : { valueKg: g / 1000, source: 'user' },
            })
          }
        />
        <p className="mt-1.5 text-[12px] text-fg-subtle">
          {part.mass
            ? 'Entered by you.'
            : linked
              ? 'The linked component states no mass. Enter a measured value here.'
              : 'Not set. Leave empty until you have a measured or datasheet value.'}
        </p>
          </>
        )}
      </div>

      <SubHeading>Inertia</SubHeading>
      <InertiaEditor part={part} components={components} />

      <CopyToMounts doc={doc} geo={geo} part={part} />

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            addPlaced(`Duplicate ${part.name}`, geo, (d) => {
              const r = duplicatePart(d, id)
              return { doc: r.doc, roots: r.rootId ? [r.rootId] : [] }
            })
          }}
          title="Duplicate (Ctrl+D)"
        >
          <Copy /> Duplicate
        </Button>
        <Button
          size="sm"
          variant="danger"
          title="Delete (Del)"
          onClick={() => deleteSelected(part, attached)}
        >
          <Trash2 /> Delete{attached > 0 ? ` (+${attached})` : ''}
        </Button>
      </div>
    </Section>
  )
}

/** "Copy to N more motor mounts", for a part sitting on a motor mount. */
function CopyToMounts({ doc, geo, part }: { doc: AssemblyDocument; geo: FrameGeometry; part: AssemblyPart }) {
  const onMotor = part.parentId === null && geo.motors.some((m) => m.id === part.mountId)
  if (!onMotor) return null
  const free = freeMotorMounts(doc, geo, part.id).length
  const extra = subtreeIds(doc, part.id).size - 1
  return (
    <div className="mt-3">
      <Button
        size="sm"
        className="w-full"
        data-testid="copy-to-mounts"
        disabled={free === 0}
        onClick={() =>
          addPlaced(`Copy ${part.name} to ${free} motor mount${free === 1 ? '' : 's'}`, geo, (d) => {
            const before = new Set(d.parts.map((p) => p.id))
            const next = copyToMotorMounts(d, geo, part.id).doc
            // Each copy must fit on its mount; if one does not, nothing is copied.
            return { doc: next, roots: next.parts.filter((p) => !before.has(p.id) && p.parentId === null).map((p) => p.id) }
          })
        }
      >
        <Copy /> {free === 0 ? 'Every motor mount has one' : `Copy to ${free} more motor mount${free === 1 ? '' : 's'}`}
      </Button>
      <p className="mt-1 text-[12px] text-fg-subtle">
        {free === 0
          ? `Each motor mount already holds a ${PART_LABELS[part.kind].toLowerCase()}.`
          : `Same placement on each free mount${extra > 0 ? `, with the ${extra} part${extra === 1 ? '' : 's'} attached to it` : ''}.`}
      </p>
    </div>
  )
}

/** Link to a library component of a fitting category, or unlink. Undoable like any edit. */
function ComponentRow({ part, linked, options, geo }: { part: AssemblyPart; linked: Component | null; options: Component[]; geo: FrameGeometry }) {
  const missing = !!part.componentId && !linked
  const groups = KIND_CATEGORIES[part.kind]
    .map((cat) => ({ cat, items: options.filter((c) => c.category === cat) }))
    .filter((g) => g.items.length > 0)
  return (
    <div className="border-b border-line/60 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="part-component" className="text-[12.5px] text-fg-muted">
          Component
        </label>
        <select
          id="part-component"
          data-testid="part-component"
          value={part.componentId ?? ''}
          onChange={(e) => {
            const v = e.target.value
            const target = options.find((c) => c.id === v)
            // The component's stated size replaces the envelope: keep the part on its support.
            editSize(v ? `Link ${part.name} to ${target?.name ?? 'component'}` : `Unlink ${part.name}`, geo, part, { componentId: v || null })
          }}
          className="h-7 w-[150px] min-w-0 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
        >
          <option value="">Not linked</option>
          {missing && <option value={part.componentId!}>Missing from library</option>}
          {groups.map((g) => (
            <optgroup key={g.cat} label={CATEGORY_LABELS[g.cat]}>
              {g.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.manufacturer ? `${c.manufacturer} ` : ''}
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <p className="mt-1 text-[12px] text-fg-subtle" data-testid="part-component-note">
        {missing
          ? 'The linked component is no longer in the library.'
          : linked
            ? 'Stated size and mass come from this component. Your own values are kept for when you unlink.'
            : options.length === 0
              ? `No ${KIND_CATEGORIES[part.kind].map((c) => CATEGORY_LABELS[c].toLowerCase()).join(' or ')} in the library yet.`
              : 'Link a library component to use its stated size and mass.'}
      </p>
    </div>
  )
}

type CitedSpec = { value: number; unit: string; source: SpecSource; reference?: SpecReference; condition?: string }

function SourceLine({ spec }: { spec: CitedSpec }) {
  const ref = formatReference(spec.reference)
  return (
    <span className="text-[11.5px]">
      {spec.condition && <span className="text-fg-subtle">{spec.condition} · </span>}
      <span className={spec.source === 'manufacturer' ? 'text-accent' : 'text-fg-muted'} data-testid="linked-source">
        {SOURCE_LABELS[spec.source]}
      </span>
      {ref &&
        (spec.reference?.url ? (
          <a href={spec.reference.url} target="_blank" rel="noreferrer" className="ml-1 text-fg-subtle hover:text-accent hover:underline">
            {ref}
          </a>
        ) : (
          <span className="ml-1 text-fg-subtle">{ref}</span>
        ))}
    </span>
  )
}

const LINK_SIZE_LABELS: Record<string, string> = {
  bodyDiameter: 'Diameter',
  bodyLength: 'Length (Z)',
  diameter: 'Diameter',
  length: 'Length X',
  width: 'Width Y',
  height: 'Height Z',
}

function LinkedSize({ component: c, shape }: { component: Component; shape: PartShape }) {
  const keys = c.category === 'motor' ? ['bodyDiameter', 'bodyLength'] : c.category === 'propeller' ? ['diameter'] : ['length', 'width', 'height']
  return (
    <div data-testid="linked-size">
      <Row label="Shape">
        <span className="text-[12.5px] text-fg-muted">{shape.type === 'box' ? 'Box' : 'Cylinder'} · from the component</span>
      </Row>
      {keys.map((k) => {
        const spec = c.specs[k] as CitedSpec | undefined
        if (!spec) return null
        return (
          <div key={k} className="border-b border-line/60 py-1.5" data-testid={`linked-${k}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] text-fg-muted">{LINK_SIZE_LABELS[k]}</span>
              <span className="num text-[12.5px]">
                {formatNumber(spec.value)} {spec.unit}
              </span>
            </div>
            <div className="text-right">
              <SourceLine spec={spec} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LinkedMass({ component, massKg, own, spec }: { component: Component; massKg: number; own: number | null; spec: CitedSpec }) {
  const g = (kg: number) => `${formatNumber(Math.round(kg * 1e5) / 100)} g`
  return (
    <div className="py-1.5" data-testid="linked-mass">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-fg-muted">Mass</span>
        <span className="num text-[12.5px]" data-testid="part-mass-linked">
          {g(massKg)}
        </span>
      </div>
      <div className="text-right">
        <SourceLine spec={spec} />
      </div>
      <p className="mt-1.5 text-[12px] text-fg-subtle">
        From {component.name}. Your own value ({own === null ? 'not set' : g(own)}) is kept for when you unlink.
      </p>
    </div>
  )
}

export function deleteSelected(part: AssemblyPart, attached: number) {
  edit(
    attached > 0 ? `Delete ${part.name} and ${attached} attached part${attached > 1 ? 's' : ''}` : `Delete ${part.name}`,
    (d) => deletePart(d, part.id),
  )
  useWorkshopView.getState().clearSelection()
}

function convertShape(shape: PartShape, to: string): PartShape {
  if (to === 'cylinder' && shape.type === 'box') {
    return { type: 'cylinder', radius: Math.max(shape.size[0], shape.size[1]) / 2, height: shape.size[2] }
  }
  if (to === 'box' && shape.type === 'cylinder') {
    return { type: 'box', size: [shape.radius * 2, shape.radius * 2, shape.height] }
  }
  return shape
}

function ShapeFields({ part, geo }: { part: AssemblyPart; geo: FrameGeometry }) {
  const s = part.shape
  const set = (shape: PartShape) => editSize(`Resize ${part.name}`, geo, part, { shape })
  if (s.type === 'box') {
    return (
      <>
        {(['Length X', 'Width Y', 'Height Z'] as const).map((label, i) => (
          <NumberField
            key={`box${i}:${s.size[i]}`}
            id={`part-size-${i}`}
            label={label}
            initial={toMm(s.size[i]!)}
            unit="mm"
            parse={lengthMm}
            onCommit={(mm) => {
              const size = [...s.size] as [number, number, number]
              size[i] = mm / 1000
              set({ type: 'box', size })
            }}
          />
        ))}
      </>
    )
  }
  if (s.type === 'cylinder') {
    return (
      <>
        <NumberField
          key={`dia:${s.radius}`}
          id="part-diameter"
          label="Diameter"
          initial={toMm(s.radius * 2)}
          unit="mm"
          parse={lengthMm}
          onCommit={(mm) => set({ ...s, radius: mm / 2000 })}
        />
        <NumberField
          key={`h:${s.height}`}
          id="part-height"
          label="Height Z"
          initial={toMm(s.height)}
          unit="mm"
          parse={lengthMm}
          onCommit={(mm) => set({ ...s, height: mm / 1000 })}
        />
      </>
    )
  }
  return null
}

function ModelFields({ part, shape }: { part: AssemblyPart; shape: Extract<PartShape, { type: 'model' }> }) {
  const asset = useAssets((s) => s.assets[shape.assetId])
  const status = useAssets((s) => s.status[shape.assetId])
  const set = (label: string, next: Partial<typeof shape>) =>
    edit(label, (d) => updatePart(d, part.id, { shape: { ...shape, ...next } }))
  return (
    <>
      <Row label="File">
        <span className="min-w-0 truncate text-[12.5px]" title={asset?.filename}>
          {asset?.filename ?? 'missing from the asset store'}
        </span>
      </Row>
      <Row label="Units in file">
        <select
          aria-label="Units in file"
          value={shape.units}
          onChange={(e) => set(`Change ${part.name} units`, { units: e.target.value as typeof shape.units })}
          className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
        >
          {MODEL_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Up axis in file">
        <Segmented
          label="Up axis in file"
          value={shape.upAxis}
          options={[
            { value: 'y', label: '+Y' },
            { value: 'z', label: '+Z' },
          ]}
          onChange={(upAxis) => set(`Change ${part.name} up axis`, { upAxis })}
        />
      </Row>
      <Row label="Display">
        <span
          data-testid="model-status"
          data-state={status?.state ?? 'loading'}
          className={cn('text-[12.5px]', status?.state === 'error' ? 'text-fault' : 'text-fg-muted')}
          title={status?.state === 'error' ? status.message : undefined}
        >
          {!status || status.state === 'loading'
            ? 'Loading…'
            : status.state === 'loaded'
              ? `Shown · ${status.triangles.toLocaleString('en-US')} triangles`
              : 'Could not display; showing its bounds'}
        </span>
      </Row>
    </>
  )
}

function NameField({ part }: { part: AssemblyPart }) {
  const [text, setText] = useState(part.name)
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    const name = text.trim()
    if (name === part.name) return setError(null)
    if (!name) return setError('Name is required')
    if (name.length > 80) return setError('80 characters at most')
    setError(null)
    edit(`Rename ${part.name}`, (d) => updatePart(d, part.id, { name }))
  }
  return (
    <div className="border-b border-line/60 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="part-name" className="text-[12.5px] text-fg-muted">
          Name
        </label>
        <input
          id="part-name"
          data-testid="part-name"
          value={text}
          maxLength={80}
          aria-invalid={!!error}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setText(part.name)
          }}
          className={cn(
            'h-7 w-[150px] min-w-0 rounded-[var(--radius-sm)] border bg-chrome px-2 text-[12.5px] text-fg outline-none focus:border-accent',
            error ? 'border-fault' : 'border-line-strong',
          )}
        />
      </div>
      {error && (
        <p role="alert" className="mt-1 text-right text-[11.5px] text-fault">
          {error}
        </p>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
      <span className="text-[12.5px] text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 truncate pb-1 text-[12px] font-medium text-fg-subtle">{children}</h3>
}
