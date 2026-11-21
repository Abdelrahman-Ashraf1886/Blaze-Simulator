import '@xyflow/react/dist/style.css'
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Box, Cable, Calculator, Redo2, Trash2, Undo2, Wand2 } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { CATEGORY_LABELS } from '../../../electron/ipc/component-fields'
import { WIRE_COLORS, type AssemblyDocument, type Project, type Wire, type WireColor } from '../../../electron/ipc/contract'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useComponents } from '@/stores/components'
import { useProjects } from '@/stores/projects'
import { buildFrame, type FrameGeometry } from '@/three/frame-geometry'
import { PORT_KIND_LABELS, canConnect, portsOf, type Port, type PortKind, type WiringPart } from '@/domain/wiring'
import { useAssembly } from '../workshop/assembly-store'
import { SEVERITY } from '../workshop/ChecksPanel'
import { allFindings } from '../workshop/findings'
import { useComponentIndex } from '../workshop/component-index'
import { SaveIndicator } from '../workshop/save-indicator'
import { wiringParts } from '../workshop/wiring-input'
import { CalculationsPanel } from './CalculationsPanel'
import { addWire, applyAutoWire, movePort, placeNode, removeWire, updateWire } from './wiring-ops'

/** Cable colours in the schematic, by port kind (sRGB; React Flow draws SVG). */
const KIND_COLOR: Record<PortKind, string> = {
  power: '#e0605a',
  phases: '#d9a03f',
  signal: '#62d2e0',
  uart: '#9aa3ad',
  can: '#7ea7d8',
  i2c: '#a58fd0',
  rc: '#6fc27a',
  usb: '#9aa3ad',
  adc: '#e0605a',
}

const edit = (label: string, recipe: (d: AssemblyDocument) => AssemblyDocument) => useAssembly.getState().edit(label, recipe)

export default function ElectricalPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void useProjects
      .getState()
      .load()
      .then(() => setLoaded(true))
  }, [])
  if (!projectId) {
    return (
      <>
        <PageHeader title="Electrical Designer" />
        <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
          <Section title="Open a project" count={projects.length} testId="electrical-chooser">
            {projects.length === 0 ? (
              <EmptyState>{loaded ? 'No projects yet. Create one on the Dashboard.' : 'Loading…'}</EmptyState>
            ) : (
              <ul className="border-t border-line">
                {projects.map((p) => (
                  <li key={p.id} className="border-b border-line/60">
                    <Link to={`/electrical/${p.id}`} className="block py-2 text-[13px] hover:text-accent">
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </>
    )
  }
  const project = projects.find((p) => p.id === projectId)
  if (!project) return loaded ? <EmptyState>This project no longer exists.</EmptyState> : null
  return <Designer project={project} />
}

type Selection = { kind: 'wire'; id: string } | { kind: 'part'; id: string } | null

function Designer({ project }: { project: Project }) {
  const doc = useAssembly((s) => (s.projectId === project.id ? s.doc : null))
  const undoLabel = useAssembly((s) => s.past.at(-1)?.label)
  const redoLabel = useAssembly((s) => s.future[0]?.label)
  const components = useComponentIndex()
  const [selection, setSelection] = useState<Selection>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [showCalc, setShowCalc] = useState(false)

  useEffect(() => {
    void useAssembly.getState().load(project.id)
    void useComponents.getState().load()
    const onUnload = () => useAssembly.getState().flushSync()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void useAssembly.getState().flush()
    }
  }, [project.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) useAssembly.getState().undo()
      else if (k === 'y' || (k === 'z' && e.shiftKey)) useAssembly.getState().redo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const geo = useMemo(() => (doc ? buildFrame(project.frameType, doc.frame, doc.motors) : null), [doc, project.frameType])
  const parts = useMemo(() => (doc && geo ? wiringParts(doc, geo, components) : []), [doc, geo, components])
  const index = useMemo(() => portIndex(parts), [parts])
  const wires = doc?.wires ?? NO_WIRES
  // Stable callbacks, so the memoised drawer and checks list do not re-render on a selection.
  const selectWire = useCallback((id: string) => setSelection({ kind: 'wire', id }), [])
  const selectPart = useCallback((id: string) => setSelection({ kind: 'part', id }), [])

  const autoWire = () => {
    let result: string[] = []
    edit('Auto-wire', (d) => {
      const r = applyAutoWire(d, parts)
      result = r.notes
      return r.doc
    })
    setNotes(result)
    setSelection(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="electrical">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg px-3">
        <Cable className="size-4 text-fg-subtle" />
        <h1 className="truncate text-[13.5px] font-semibold">{project.name}</h1>
        <span className="text-[12.5px] text-fg-subtle">Electrical Designer</span>
        <div className="flex items-center">
          <IconButton label={undoLabel ? `Undo ${undoLabel.toLowerCase()} (Ctrl+Z)` : 'Nothing to undo'} disabled={!undoLabel} onClick={() => useAssembly.getState().undo()}>
            <Undo2 />
          </IconButton>
          <IconButton label={redoLabel ? `Redo ${redoLabel.toLowerCase()} (Ctrl+Y)` : 'Nothing to redo'} disabled={!redoLabel} onClick={() => useAssembly.getState().redo()}>
            <Redo2 />
          </IconButton>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" data-testid="toggle-calculations" aria-pressed={showCalc} onClick={() => setShowCalc((v) => !v)} className={cn(showCalc && 'border-accent text-accent')}>
            <Calculator /> Calculations
          </Button>
          <Button size="sm" variant="primary" data-testid="auto-wire" onClick={() => (wires.length > 0 ? setConfirmAuto(true) : autoWire())} disabled={!doc}>
            <Wand2 /> Auto-wire
          </Button>
          <Button size="sm" asChild>
            <Link to={`/workshop/${project.id}`}>
              <Box /> Workshop
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-[200px] flex-1" data-testid="schematic">
            {doc && geo && <Schematic doc={doc} parts={parts} index={index} selection={selection} onSelect={setSelection} />}
            {doc && parts.every((p) => index.ports(p.id).length === 0) && (
              <p className="pointer-events-none absolute inset-x-0 top-6 text-center text-[12.5px] text-fg-subtle">
                No electrical parts yet. Add a battery, ESCs, motors and a flight controller in the workshop.
              </p>
            )}
          </div>
          {doc && showCalc && (
            <div className="h-[45%] min-h-[220px] shrink-0 border-t border-line bg-chrome">
              <CalculationsPanel parts={parts} wires={wires} onSelectWire={selectWire} onSelectPart={selectPart} />
            </div>
          )}
        </div>
        <aside className="w-[300px] shrink-0 space-y-6 overflow-y-auto border-l border-line bg-chrome px-4 py-3" data-testid="electrical-panel">
          {notes.length > 0 && (
            <Section title="Auto-wire notes">
              <ul className="border-t border-line text-[12.5px] text-fg-muted" data-testid="autowire-notes">
                {notes.map((n) => (
                  <li key={n} className="border-b border-line/60 py-1.5">
                    {n}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {doc && selection?.kind === 'wire' && (
            <WireInspector key={selection.id} wire={wires.find((w) => w.id === selection.id)} index={index} onDone={() => setSelection(null)} />
          )}
          {doc && selection?.kind === 'part' && <PartPorts part={index.part(selection.id)} wires={wires} index={index} onSelectWire={selectWire} />}
          {doc && geo && <Diagnostics doc={doc} geo={geo} onSelect={selectPart} />}
          <Section title="Wires" count={wires.length}>
            <WireList wires={wires} index={index} selected={selection?.kind === 'wire' ? selection.id : null} onSelect={selectWire} />
          </Section>
        </aside>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-bg px-3 text-[12px] text-fg-muted">
        <span className="num">
          {wires.length} wire{wires.length === 1 ? '' : 's'}
        </span>
        <SaveIndicator />
      </div>

      {confirmAuto && (
        <Dialog open onOpenChange={(o) => !o && setConfirmAuto(false)}>
          <DialogContent title="Replace the wiring?" description={`Auto-wire replaces all ${wires.length} wires with the reference harness. You can undo it.`}>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmAuto(false)
                  autoWire()
                }}
              >
                Replace wiring
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ---- Schematic canvas ------------------------------------------------------------------------------------

type PartNodeData = { part: WiringPart; ports: Port[]; used: ReadonlySet<string> }

/** Default column per role, when the user has not placed the box. */
const COLUMN: Record<string, number> = { battery: 0, 'power-module': 260, esc: 540, motor: 840, 'flight-controller': 260, peripheral: 0 }

function defaultPosition(p: WiringPart, index: Record<string, number>): { x: number; y: number } {
  const role = p.component?.category ?? p.kind
  const i = (index[role] = (index[role] ?? -1) + 1)
  const x = COLUMN[role] ?? 0
  if (role === 'flight-controller') return { x, y: 260 + i * 420 }
  if (role === 'peripheral') return { x, y: 300 + i * 120 }
  return { x, y: i * (role === 'esc' ? 230 : 110) }
}

const NO_WIRES: Wire[] = []

/**
 * Parts and their ports by id, built once per parts list. The schematic, the wire
 * list and the inspectors look ports up here instead of rebuilding them per wire.
 */
interface PortIndex {
  part: (id: string) => WiringPart | undefined
  ports: (id: string) => Port[]
  port: (end: { partId: string; port: string }) => Port | undefined
  label: (end: { partId: string; port: string }) => string
}

function portIndex(parts: readonly WiringPart[]): PortIndex {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const ports = new Map(parts.map((p) => [p.id, portsOf(p)]))
  const port = (e: { partId: string; port: string }) => ports.get(e.partId)?.find((x) => x.id === e.port)
  return {
    part: (id) => byId.get(id),
    ports: (id) => ports.get(id) ?? [],
    port,
    label: (e) => `${byId.get(e.partId)?.name ?? 'removed part'} · ${port(e)?.label ?? e.port}`,
  }
}

/** Replaces only the items whose `selected` flag differs, so unchanged boxes and cables keep their identity and React Flow skips them. */
function withSelection<T extends { id: string; selected?: boolean }>(items: T[], selectedId: string | null, restyle?: (item: T, selected: boolean) => T): T[] {
  if (selectedId === null) return items
  return items.map((x) => (x.id === selectedId ? (restyle ? restyle(x, true) : { ...x, selected: true }) : x))
}

function Schematic({ doc, parts, index, selection, onSelect }: { doc: AssemblyDocument; parts: WiringPart[]; index: PortIndex; selection: Selection; onSelect: (s: Selection) => void }) {
  const wires = doc.wires ?? NO_WIRES
  // Boxes and cables are built from the document only; a selection change touches one item (see withSelection).
  const baseNodes = useMemo<Node<PartNodeData>[]>(() => {
    const column: Record<string, number> = {}
    const used = new Map<string, Set<string>>()
    for (const w of wires) {
      for (const e of [w.from, w.to]) {
        let s = used.get(e.partId)
        if (!s) used.set(e.partId, (s = new Set()))
        s.add(e.port)
      }
    }
    return parts.flatMap((part) => {
      const ports = index.ports(part.id)
      if (ports.length === 0) return []
      return [{ id: part.id, type: 'part', position: doc.schematic?.[part.id] ?? defaultPosition(part, column), data: { part, ports, used: used.get(part.id) ?? NO_PORTS }, selected: false }]
    })
  }, [parts, index, wires, doc.schematic])
  const nodes = useMemo(() => withSelection(baseNodes, selection?.kind === 'part' ? selection.id : null), [baseNodes, selection])

  const baseEdges = useMemo<Edge[]>(
    () =>
      wires.map((w) => {
        const kind = index.port(w.from)?.kind
        return {
          id: w.id,
          source: w.from.partId,
          sourceHandle: w.from.port,
          target: w.to.partId,
          targetHandle: w.to.port,
          selected: false,
          style: { stroke: kind ? KIND_COLOR[kind] : '#9aa3ad', strokeWidth: 1.6 },
        }
      }),
    [wires, index],
  )
  const edges = useMemo(
    () => withSelection(baseEdges, selection?.kind === 'wire' ? selection.id : null, (e, selected) => ({ ...e, selected, style: { ...e.style, strokeWidth: 3 } })),
    [baseEdges, selection],
  )

  const resolve = (c: Connection | Edge) => {
    const a = index.part(c.source)
    const b = index.part(c.target)
    const pa = a && c.sourceHandle ? index.port({ partId: a.id, port: c.sourceHandle }) : undefined
    const pb = b && c.targetHandle ? index.port({ partId: b.id, port: c.targetHandle }) : undefined
    return a && b && pa && pb && canConnect({ part: a, port: pa }, { part: b, port: pb }) ? { a, b, pa, pb } : null
  }
  const onConnect = (c: Connection) => {
    const r = resolve(c)
    if (!r) return
    const { a, b, pa, pb } = r
    edit(`Connect ${a.name} ${pa.label} to ${b.name} ${pb.label}`, (d) => addWire(d, { partId: a.id, port: pa.id }, { partId: b.id, port: pb.id }))
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      colorMode="dark"
      connectionMode={ConnectionMode.Loose}
      fitView
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      isValidConnection={(c) => resolve(c) !== null}
      onConnect={onConnect}
      onNodeDragStop={(_e, node) => {
        const name = index.part(node.id)?.name ?? 'part'
        edit(`Move ${name} in the schematic`, (d) => placeNode(d, node.id, node.position.x, node.position.y))
      }}
      onNodeClick={(_e, node) => onSelect({ kind: 'part', id: node.id })}
      onEdgeClick={(_e, edge) => onSelect({ kind: 'wire', id: edge.id })}
      onPaneClick={() => onSelect(null)}
      onEdgesDelete={(es) => es.forEach((e) => edit('Delete wire', (d) => removeWire(d, e.id)))}
      deleteKeyCode={['Delete', 'Backspace']}
      onNodesDelete={() => {}}
      nodesConnectable
      elementsSelectable
    >
      <Background gap={20} color="#22262c" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

const NO_PORTS: ReadonlySet<string> = new Set()

const PartNode = memo(function PartNode({ data, selected }: NodeProps<Node<PartNodeData>>) {
  const { part, ports, used } = data
  const left = ports.filter((p) => p.side === 'left')
  const right = ports.filter((p) => p.side === 'right')
  const rows = Math.max(left.length, right.length)
  return (
    <div
      data-testid="schematic-node"
      data-name={part.name}
      className={cn('min-w-[200px] rounded-[var(--radius-md)] border bg-raised text-[11.5px] shadow-md', selected ? 'border-accent' : 'border-line-strong')}
    >
      <div className="border-b border-line px-2.5 py-1.5">
        <div className="truncate text-[12.5px] font-semibold text-fg">{part.name}</div>
        <div className="truncate text-fg-subtle">{part.component ? `${part.component.name} · ${CATEGORY_LABELS[part.component.category]}` : 'Not linked to a component'}</div>
      </div>
      <div className="py-1">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-[22px] items-center justify-between gap-4">
            <PortCell port={left[i]} side="left" used={!!left[i] && used.has(left[i]!.id)} />
            <PortCell port={right[i]} side="right" used={!!right[i] && used.has(right[i]!.id)} />
          </div>
        ))}
      </div>
    </div>
  )
})
const NODE_TYPES = { part: PartNode }

function PortCell({ port, side, used }: { port?: Port; side: 'left' | 'right'; used: boolean }) {
  if (!port) return <span />
  return (
    <span className={cn('relative flex items-center px-2.5', side === 'right' && 'justify-end')} title={PORT_KIND_LABELS[port.kind]}>
      <Handle
        id={port.id}
        type="source"
        position={side === 'left' ? Position.Left : Position.Right}
        style={{ background: used ? KIND_COLOR[port.kind] : '#2a2f36', borderColor: KIND_COLOR[port.kind], width: 9, height: 9 }}
      />
      <span className={cn('truncate', used ? 'text-fg' : 'text-fg-muted')}>{port.label}</span>
    </span>
  )
}

// ---- Side panel --------------------------------------------------------------------------------------------

function WireList({ wires, index, selected, onSelect }: { wires: Wire[]; index: PortIndex; selected: string | null; onSelect: (id: string) => void }) {
  if (wires.length === 0) return <p className="border-t border-line py-3 text-[12.5px] text-fg-subtle">No wires. Use Auto-wire, or drag from one port to another.</p>
  return (
    <ul className="border-t border-line">
      {wires.map((w) => (
        <li key={w.id}>
          <button
            type="button"
            data-testid="wire-row"
            aria-pressed={w.id === selected}
            onClick={() => onSelect(w.id)}
            className={cn('w-full border-b border-line/60 py-1.5 text-left text-[12px] hover:bg-hover/50', w.id === selected ? 'text-fg' : 'text-fg-muted')}
          >
            {index.label(w.from)} → {index.label(w.to)}
          </button>
        </li>
      ))}
    </ul>
  )
}

function WireInspector({ wire, index, onDone }: { wire?: Wire; index: PortIndex; onDone: () => void }) {
  if (!wire) return null
  const ends = (['from', 'to'] as const).map((end) => {
    const p = index.part(wire[end].partId)
    const ports = p ? index.ports(p.id) : []
    const current = ports.find((x) => x.id === wire[end].port)
    return { end, part: p, ports: current ? ports.filter((x) => x.kind === current.kind) : ports, current }
  })
  const set = (label: string, patch: Partial<Wire>) => edit(label, (d) => updateWire(d, wire.id, patch))
  return (
    <Section title="Wire" testId="wire-inspector">
      <div className="border-t border-line">
        {ends.map(({ end, part, ports, current }) => (
          <Row key={end} label={part?.name ?? 'Removed part'}>
            <select
              aria-label={`${part?.name ?? 'part'} port`}
              data-testid={`wire-${end}-port`}
              value={wire[end].port}
              onChange={(e) => edit(`Move wire to ${part?.name} ${e.target.value}`, (d) => movePort(d, wire.id, end, e.target.value))}
              className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
            >
              {!current && <option value={wire[end].port}>{wire[end].port} (missing)</option>}
              {ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Row>
        ))}
        <Row label="Gauge (AWG)">
          <NumberInput
            label="Wire gauge in AWG"
            testId="wire-gauge"
            value={wire.gaugeAwg}
            min={0}
            max={40}
            onCommit={(v) => set('Set wire gauge', { gaugeAwg: v })}
          />
        </Row>
        <Row label="Length (mm)">
          <NumberInput label="Wire length in mm" testId="wire-length" value={wire.lengthMm} min={1} max={10000} onCommit={(v) => set('Set wire length', { lengthMm: v })} />
        </Row>
        <Row label="Colour">
          <select
            aria-label="Wire colour"
            value={wire.color ?? ''}
            onChange={(e) => set('Set wire colour', { color: (e.target.value || null) as WireColor | null })}
            className="h-7 w-[150px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-[12.5px] text-fg"
          >
            <option value="">Not set</option>
            {WIRE_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <p className="mt-1.5 text-[12px] text-fg-subtle">Gauge and length are used by the electrical calculations; leave them empty until you know them.</p>
      <Button
        size="sm"
        variant="danger"
        className="mt-2"
        onClick={() => {
          edit('Delete wire', (d) => removeWire(d, wire.id))
          onDone()
        }}
      >
        <Trash2 /> Delete wire
      </Button>
    </Section>
  )
}

function NumberInput({ label, testId, value, min, max, onCommit }: { label: string; testId: string; value: number | null; min: number; max: number; onCommit: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    const t = text.trim()
    if (t === (value === null ? '' : String(value))) return setError(null)
    if (t === '') return onCommit(null)
    const n = Number(t.replace(',', '.'))
    if (!Number.isFinite(n) || n < min || n > max) return setError(`${min}–${max}`)
    setError(null)
    onCommit(n)
  }
  return (
    <span className="flex flex-col items-end">
      <input
        aria-label={label}
        data-testid={testId}
        inputMode="decimal"
        value={text}
        placeholder="not set"
        aria-invalid={!!error}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={cn('num h-7 w-[90px] rounded-[var(--radius-sm)] border bg-chrome px-2 text-right text-[12.5px] text-fg outline-none focus:border-accent', error ? 'border-fault' : 'border-line-strong')}
      />
      {error && (
        <span role="alert" className="text-[11px] text-fault">
          {error}
        </span>
      )}
    </span>
  )
}

function PartPorts({ part, wires, index, onSelectWire }: { part?: WiringPart; wires: Wire[]; index: PortIndex; onSelectWire: (id: string) => void }) {
  if (!part) return null
  return (
    <Section title={part.name} testId="part-ports">
      <ul className="border-t border-line">
        {index.ports(part.id).map((port) => {
          const at = wires.filter((w) => (w.from.partId === part.id && w.from.port === port.id) || (w.to.partId === part.id && w.to.port === port.id))
          return (
            <li key={port.id} className="flex items-baseline justify-between gap-2 border-b border-line/60 py-1.5 text-[12px]">
              <span className="text-fg-muted">
                {port.label} <span className="text-fg-subtle">· {PORT_KIND_LABELS[port.kind]}</span>
              </span>
              <span className="min-w-0 truncate text-right">
                {at.length === 0 ? (
                  <span className="text-fg-subtle">free</span>
                ) : (
                  at.map((w) => {
                    const other = w.from.partId === part.id && w.from.port === port.id ? w.to : w.from
                    return (
                      <button key={w.id} type="button" className="block w-full truncate text-right hover:text-accent" onClick={() => onSelectWire(w.id)}>
                        {index.label(other)}
                      </button>
                    )
                  })
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

const Diagnostics = memo(function Diagnostics({ doc, geo, onSelect }: { doc: AssemblyDocument; geo: FrameGeometry; onSelect: (partId: string) => void }) {
  const components = useComponentIndex()
  const findings = useMemo(() => allFindings(doc, geo, components).filter((f) => f.severity !== 'cannot-check'), [doc, geo, components])
  return (
    <Section title="Checks" count={findings.length} testId="electrical-checks">
      {findings.length === 0 ? (
        <p className="border-t border-line py-3 text-[12.5px] text-fg-subtle">No errors or warnings.</p>
      ) : (
        <ul className="border-t border-line">
          {findings.map((f) => {
            const s = SEVERITY[f.severity]
            const Icon = s.icon
            return (
              <li key={f.id}>
                <button
                  type="button"
                  data-testid="finding"
                  data-severity={f.severity}
                  data-rule={f.rule}
                  onClick={() => f.partIds[0] && onSelect(f.partIds[0])}
                  className="flex w-full gap-2 border-b border-line/60 py-1.5 text-left text-[12px] leading-snug hover:bg-hover/50"
                >
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', s.tone)} aria-label={s.label} />
                  <span className="text-fg-muted">{f.message}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
})

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
      <span className="min-w-0 truncate text-[12.5px] text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-fg-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
