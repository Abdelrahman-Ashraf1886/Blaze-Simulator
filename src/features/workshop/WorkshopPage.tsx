import { Camera, Expand, Grid3x3, Ruler, Magnet, Maximize, Move3d, PanelLeft, PanelRight, Redo2, Rotate3d, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type LayoutStorage,
  type PanelImperativeHandle,
} from 'react-resizable-panels'
import { FRAME_SPECS, type AssemblyDocument, type Project } from '../../../electron/ipc/contract'
import { FrameGlyph } from '@/components/frame-glyph'
import { PageHeader } from '@/components/page-header'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { Table, Td, Th } from '@/components/table'
import { cn, formatTimestamp } from '@/lib/utils'
import { useProjects } from '@/stores/projects'
import { buildFrame, type FrameGeometry } from '@/three/frame-geometry'
import { VIEW_LABELS, type ViewPreset } from '@/three/views'
import { CreateProjectDialog } from '../projects/CreateProjectDialog'
import { useAssembly, type SaveState } from './assembly-store'
import { useAssets } from './asset-store'
import { captureViewport } from './capture'
import { MeasureCapture, MeasureLabel, MeasureLine, measureStatus } from './Measure'
import { getApi, unwrap } from '@/services/api'
import { DimensionLabels, MountMarkers } from './InspectionOverlay'
import { assemblyBounds, assemblyStatus, explodedDoc, partBounds } from './inspection'
import { FrameEditor } from './FrameEditor'
import { FrameModel, MountLabels } from './FrameModel'
import { MotorInspector, MotorList } from './MotorPanels'
import { AssemblyTree, PartInspector, PartLibrary, deleteSelected, useComponentIndex } from './PartPanels'
import { effectiveMass, resolveLinks } from './links'
import { useComponents } from '@/stores/components'
import { PartsModel } from './PartsModel'
import { duplicatePart, subtreeIds, updatePart } from './assembly-ops'
import { SNAP_MM } from './view-store'
import { useWorkshopView } from './view-store'
import { Viewport } from './Viewport'

const PRESETS: ViewPreset[] = ['top', 'front', 'right', 'iso']

/** localStorage wrapper that never throws; the layout simply is not remembered. */
const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* not remembered */
    }
  },
}

export default function WorkshopPage() {
  const { projectId } = useParams()
  const projects = useProjects((s) => s.projects)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void useProjects
      .getState()
      .load()
      .then(() => setLoaded(true))
  }, [])

  if (!projectId) return <ProjectChooser projects={projects} loaded={loaded} />
  const project = projects.find((p) => p.id === projectId)
  if (!project) {
    return loaded ? (
      <>
        <PageHeader title="Drone Workshop" />
        <div className="px-6 pt-5">
          <EmptyState>
            This project no longer exists.{' '}
            <Link to="/workshop" className="text-accent hover:underline">
              Choose another project
            </Link>
          </EmptyState>
        </div>
      </>
    ) : null
  }
  return <Workshop project={project} />
}

function ProjectChooser({ projects, loaded }: { projects: Project[]; loaded: boolean }) {
  return (
    <>
      <PageHeader title="Drone Workshop" actions={<CreateProjectDialog />} />
      <div className="mx-auto w-full max-w-[1600px] px-6 pb-10 pt-5">
        <Section title="Open a project" count={projects.length} testId="workshop-chooser">
          {projects.length === 0 ? (
            <EmptyState>{loaded ? 'No projects yet. Create one to start building.' : 'Loading…'}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-full">Name</Th>
                  <Th className="hidden @min-[440px]:table-cell">Frame</Th>
                  <Th>Modified</Th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="hover:bg-hover/50">
                    <Td className="max-w-0">
                      <Link to={`/workshop/${p.id}`} className="flex min-w-0 items-center gap-2.5 hover:text-accent">
                        <FrameGlyph type={p.frameType} className="size-4 shrink-0 text-fg-subtle" />
                        <span className="truncate">{p.name}</span>
                      </Link>
                    </Td>
                    <Td className="hidden text-fg-muted @min-[440px]:table-cell">{FRAME_SPECS[p.frameType].name}</Td>
                    <Td className="num text-fg-muted">{formatTimestamp(p.updatedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
      </div>
    </>
  )
}

function Workshop({ project }: { project: Project }) {
  const layout = useDefaultLayout({ id: 'workshop-layout', storage: layoutStorage })
  const leftRef = useRef<PanelImperativeHandle | null>(null)
  const rightRef = useRef<PanelImperativeHandle | null>(null)
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const view = useWorkshopView()
  const undoLabel = useAssembly((s) => s.past.at(-1)?.label)
  const doc = useAssembly((s) => (s.projectId === project.id ? s.doc : null))
  const geo = useMemo(
    () => (doc ? buildFrame(project.frameType, doc.frame, doc.motors) : null),
    [doc, project.frameType],
  )
  const redoLabel = useAssembly((s) => s.future[0]?.label)
  const [imageNote, setImageNote] = useState<{ text: string; error: boolean; title?: string } | null>(null)
  const saveImage = async () => {
    try {
      const bytes = await captureViewport()
      const stamp = formatTimestamp(new Date().toISOString()).replace(':', '.')
      const saved = unwrap(await getApi().viewport.savePng({ bytes, name: `${project.name} ${stamp}` }))
      if (saved) setImageNote({ text: `Image saved: ${saved.path.split(/[\\/]/).pop()}`, error: false, title: saved.path })
    } catch (e) {
      setImageNote({ text: `Image not saved: ${(e as Error).message}`, error: true })
    }
  }
  useEffect(() => {
    if (!imageNote) return
    const t = setTimeout(() => setImageNote(null), 6000)
    return () => clearTimeout(t)
  }, [imageNote])
  const assets = useAssets((s) => s.assets)
  const components = useComponentIndex()
  // What is drawn: linked parts at their component's stated size, then the exploded
  // layout. Both are display only; `doc` (what is saved) is untouched.
  const display = useMemo(() => {
    if (!doc || !geo) return doc
    const resolved = resolveLinks(doc, components)
    return view.exploded ? explodedDoc(resolved, geo, view.spread) : resolved
  }, [doc, geo, components, view.exploded, view.spread])
  const bounds = useMemo(() => (display && geo ? assemblyBounds(display, geo, assets) : undefined), [display, geo, assets])
  const selectedId = view.selection?.kind === 'part' ? view.selection.id : null
  const focusBounds = useMemo(
    () => (display && geo && selectedId ? partBounds(display, geo, selectedId, assets) : null),
    [display, geo, selectedId, assets],
  )

  // Load this project's assembly; save pending edits when leaving the workshop,
  // and synchronously if the window is closed or reloaded.
  useEffect(() => {
    void useAssembly.getState().load(project.id)
    void useAssets
      .getState()
      .load()
      .catch((e: unknown) => console.warn('[assets] list failed', e))
    void useComponents.getState().load()
    useWorkshopView.getState().selectMount(null)
    const onUnload = () => useAssembly.getState().flushSync()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void useAssembly.getState().flush()
    }
  }, [project.id])

  const toggle = (ref: typeof leftRef) => {
    const p = ref.current
    if (!p) return
    if (p.isCollapsed()) p.expand()
    else p.collapse()
  }

  // Viewport shortcuts, ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // Text fields keep their own undo and typing.
      if (e.altKey || t.closest('input:not([type=range]), textarea, select, [contenteditable]')) return
      // A focused slider keeps its arrow keys.
      if (t.matches('input[type=range]') && /^(Arrow|Page|Home|End)/.test(e.key)) return
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase()
        const a = useAssembly.getState()
        if (k === 'z' && !e.shiftKey) a.undo()
        else if (k === 'y' || (k === 'z' && e.shiftKey)) a.redo()
        else if (k === 'd') duplicateSelected()
        else return
        e.preventDefault()
        return
      }
      const s = useWorkshopView.getState()
      const preset = PRESETS[Number(e.key) - 1]
      if (preset) s.viewFrom(preset)
      else if (e.key === 'f' || e.key === 'F') s.fit()
      else if (e.key === 'p' || e.key === 'P')
        s.setProjection(s.projection === 'perspective' ? 'orthographic' : 'perspective')
      else if (e.key === 'g' || e.key === 'G') s.setShowGrid(!s.showGrid)
      else if (e.key === 'x' || e.key === 'X') s.setExploded(!s.exploded)
      else if (e.key === 'm' || e.key === 'M') s.setMeasuring(!s.measuring)
      // Esc in measure mode: clear the measurement, then leave the tool.
      else if (e.key === 'Escape' && s.measuring && s.measure.length > 0) s.clearMeasure()
      else if (e.key === 'Escape' && s.measuring) s.setMeasuring(false)
      else if (e.key === 'Escape' && s.selection) s.clearSelection()
      else if (!partKeys(e)) return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workshop">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg px-2">
        <ToolButton
          label={leftOpen ? 'Hide project panel' : 'Show project panel'}
          pressed={leftOpen}
          onClick={() => toggle(leftRef)}
        >
          <PanelLeft />
        </ToolButton>
        <div className="flex min-w-0 items-center gap-2">
          <FrameGlyph type={project.frameType} className="size-4 shrink-0 text-fg-subtle" />
          <h1 className="truncate text-[13.5px] font-semibold" title={project.name}>
            {project.name}
          </h1>
          <span className="hidden shrink-0 text-[12.5px] text-fg-subtle @min-[640px]:inline">
            {FRAME_SPECS[project.frameType].name}
          </span>
        </div>

        <div className="flex shrink-0 items-center">
          <ToolButton
            label={undoLabel ? `Undo ${lowerFirst(undoLabel)} (Ctrl+Z)` : 'Nothing to undo'}
            disabled={!undoLabel}
            onClick={() => useAssembly.getState().undo()}
          >
            <Undo2 />
          </ToolButton>
          <ToolButton
            label={redoLabel ? `Redo ${lowerFirst(redoLabel)} (Ctrl+Y)` : 'Nothing to redo'}
            disabled={!redoLabel}
            onClick={() => useAssembly.getState().redo()}
          >
            <Redo2 />
          </ToolButton>
        </div>

        <div className="flex shrink-0 items-center">
          <ToolButton label="Move selected part (W)" pressed={view.gizmo === 'translate'} onClick={() => view.setGizmo('translate')}>
            <Move3d />
          </ToolButton>
          <ToolButton label="Rotate selected part (E)" pressed={view.gizmo === 'rotate'} onClick={() => view.setGizmo('rotate')}>
            <Rotate3d />
          </ToolButton>
          <ToolButton
            label={`Snap to ${SNAP_MM} mm and 15° (S)`}
            pressed={view.snap}
            onClick={() => view.setSnap(!view.snap)}
          >
            <Magnet />
          </ToolButton>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* On very narrow windows projection, presets and grid drop out; P, 1–4 and G still work. */}
          <Segmented label="Projection" className="hidden @min-[640px]:flex">
            {(['perspective', 'orthographic'] as const).map((p) => (
              <SegmentButton
                key={p}
                pressed={view.projection === p}
                onClick={() => view.setProjection(p)}
                title={`${p === 'perspective' ? 'Perspective' : 'Orthographic'} projection (P toggles)`}
              >
                {p === 'perspective' ? 'Persp' : 'Ortho'}
              </SegmentButton>
            ))}
          </Segmented>
          <Segmented label="View" className="hidden @min-[640px]:flex">
            {PRESETS.map((p, i) => (
              <SegmentButton
                key={p}
                pressed={view.preset === p}
                onClick={() => view.viewFrom(p)}
                title={`${VIEW_LABELS[p]} view (${i + 1})`}
              >
                {VIEW_LABELS[p]}
              </SegmentButton>
            ))}
          </Segmented>
          <div className="flex items-center gap-1.5">
            <ToolButton
              label={view.exploded ? 'Exploded view on: display only, gizmo off (X)' : 'Exploded view (X)'}
              pressed={view.exploded}
              onClick={() => view.setExploded(!view.exploded)}
            >
              <Expand />
            </ToolButton>
            {view.exploded && (
              <input
                type="range"
                aria-label="Explode spread"
                data-testid="explode-spread"
                min={0}
                max={100}
                value={Math.round(view.spread * 100)}
                onChange={(e) => view.setSpread(Number(e.target.value) / 100)}
                className="h-1 w-20 cursor-pointer accent-[var(--color-accent)]"
              />
            )}
          </div>
          <ToolButton label={selectedId ? 'Fit selected part (F)' : 'Fit view (F)'} onClick={view.fit}>
            <Maximize />
          </ToolButton>
          <ToolButton
            label={view.measuring ? 'Measuring: click two points; Esc clears (M)' : 'Measure distance (M)'}
            pressed={view.measuring}
            onClick={() => view.setMeasuring(!view.measuring)}
          >
            <Ruler />
          </ToolButton>
          <ToolButton label="Save image of the view (PNG)" onClick={() => void saveImage()}>
            <Camera />
          </ToolButton>
          <ToolButton
            label="Grid (G)"
            pressed={view.showGrid}
            onClick={() => view.setShowGrid(!view.showGrid)}
            className="hidden @min-[640px]:inline-flex"
          >
            <Grid3x3 />
          </ToolButton>
          <ToolButton
            label={rightOpen ? 'Hide view panel' : 'Show view panel'}
            pressed={rightOpen}
            onClick={() => toggle(rightRef)}
          >
            <PanelRight />
          </ToolButton>
        </div>
      </div>

      <Group
        id="workshop-layout"
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        // Fires for every change, including panels squeezed shut by a narrow window,
        // so the toolbar toggles always reflect the real panel state.
        onLayoutChange={(l) => {
          setLeftOpen((l.project ?? 0) > 0)
          setRightOpen((l.view ?? 0) > 0)
        }}
      >
        <Panel
          id="project"
          panelRef={leftRef}
          defaultSize="240px"
          minSize="200px"
          maxSize="420px"
          collapsible
          collapsedSize="0px"
          className="bg-chrome"
        >
          <SidePanel testId="project-panel">
            <ProjectPanel project={project} geo={geo} doc={doc} />
          </SidePanel>
        </Panel>
        <Separator className="w-px bg-line outline-none hover:bg-accent/70 focus-visible:bg-accent" />
        <Panel id="viewport" minSize="320px">
          <Viewport
            bounds={bounds}
            focusBounds={focusBounds}
            overlay={
              geo && doc && display ? (
                <>
                  <MountLabels geo={geo} armWidth={doc.frame.armWidth} />
                  <MountMarkers doc={doc} geo={geo} />
                  <DimensionLabels doc={display} geo={geo} />
                  <MeasureLabel />
                </>
              ) : null
            }
          >
            <MeasureCapture>
              {geo && doc && <FrameModel geo={geo} params={doc.frame} />}
              {geo && display && <PartsModel doc={display} geo={geo} editable={!view.exploded && !view.measuring} />}
            </MeasureCapture>
            <MeasureLine />
          </Viewport>
        </Panel>
        <Separator className="w-px bg-line outline-none hover:bg-accent/70 focus-visible:bg-accent" />
        <Panel
          id="view"
          panelRef={rightRef}
          defaultSize="260px"
          minSize="200px"
          maxSize="420px"
          collapsible
          collapsedSize="0px"
          className="bg-chrome"
        >
          <SidePanel testId="view-panel">
            {geo && <MotorInspector geo={geo} />}
            {geo && doc && <PartInspector doc={doc} geo={geo} />}
            <ViewPanel />
          </SidePanel>
        </Panel>
      </Group>

      {/* Status strip */}
      <div className="flex h-7 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-line bg-bg px-3 text-[12px] text-fg-muted">
        <span data-testid="view-status">
          {view.projection === 'perspective' ? 'Perspective' : 'Orthographic'} ·{' '}
          {view.preset ? `${VIEW_LABELS[view.preset]} view` : 'Free view'}
        </span>
        <span className="num text-[11.5px]">{view.showGrid ? 'Grid 10 mm' : 'Grid off'}</span>
        {view.exploded && <span className="text-warn">Exploded view · display only</span>}
        {view.measuring && (
          <span data-testid="measure-status" className="num text-[#f2c14e]">
            {measureStatus(view.measure)}
          </span>
        )}
        <SaveIndicator />
        {imageNote && (
          <span
            data-testid="image-status"
            title={imageNote.title}
            className={cn('truncate', imageNote.error ? 'text-fault' : 'text-ok')}
          >
            {imageNote.text}
          </span>
        )}
        {doc && geo && <AssemblyStatusStrip doc={doc} geo={geo} />}
        <span className="ml-auto text-fg-subtle">Z-up · millimetres</span>
      </div>
    </div>
  )
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'All changes saved',
  error: 'Could not save',
  conflict: 'Changed elsewhere',
}

function SaveIndicator() {
  const state = useAssembly((s) => s.saveState)
  const error = useAssembly((s) => s.error)
  const projectId = useAssembly((s) => s.projectId)
  if (state === 'idle') return null
  return (
    <span
      data-testid="save-state"
      data-state={state}
      title={error ?? undefined}
      className={cn('flex min-w-0 items-center gap-2', (state === 'error' || state === 'conflict') && 'text-fault')}
    >
      <span className="truncate">
        {SAVE_TEXT[state]}
        {state === 'error' && error ? `: ${error}` : ''}
      </span>
      {state === 'conflict' && projectId && (
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => void useAssembly.getState().load(projectId)}
        >
          Reload
        </button>
      )}
      {state === 'error' && (
        <button type="button" className="text-accent hover:underline" onClick={() => void useAssembly.getState().flush()}>
          Retry
        </button>
      )}
    </span>
  )
}

/** Part count, then each issue as a button that selects the first part it applies to. */
function AssemblyStatusStrip({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const assets = useAssets((s) => s.assets)
  const statusById = useAssets((s) => s.status)
  const failed = useMemo(
    () => new Set(Object.entries(statusById).filter(([, v]) => v.state === 'error').map(([k]) => k)),
    [statusById],
  )
  const components = useComponentIndex()
  const st = useMemo(
    () => assemblyStatus(doc, geo, assets, failed, (p) => effectiveMass(p, components) !== null),
    [doc, geo, assets, failed, components],
  )
  const items: { key: string; ids: string[]; text: string; tone: string }[] = [
    { key: 'unattached', ids: st.unattached, text: `${st.unattached.length} unattached`, tone: 'text-fg-muted' },
    { key: 'no-mass', ids: st.noMass, text: `${st.noMass.length} without mass`, tone: 'text-fg-muted' },
    {
      key: 'model-issues',
      ids: st.modelIssues,
      text: `${st.modelIssues.length} model warning${st.modelIssues.length === 1 ? '' : 's'}`,
      tone: 'text-warn',
    },
  ]
  return (
    <span className="flex min-w-0 items-center gap-3" data-testid="assembly-status">
      <span className="num" data-testid="status-parts">
        {st.parts} part{st.parts === 1 ? '' : 's'}
      </span>
      {items
        .filter((i) => i.ids.length > 0)
        .map((i) => (
          <button
            key={i.key}
            type="button"
            data-testid={`status-${i.key}`}
            title="Select the first one"
            onClick={() => useWorkshopView.getState().selectPart(i.ids[0]!)}
            className={cn('num hover:text-fg hover:underline', i.tone)}
          >
            {i.text}
          </button>
        ))}
    </span>
  )
}

function SidePanel({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="h-full min-w-[200px] space-y-6 overflow-y-auto px-4 py-3">
      {children}
    </div>
  )
}

function ProjectPanel({
  project,
  geo,
  doc,
}: {
  project: Project
  geo: FrameGeometry | null
  doc: AssemblyDocument | null
}) {
  const frame = FRAME_SPECS[project.frameType]
  return (
    <>
      <Section title="Project">
        <Readouts>
          <Readout label="Name" value={project.name} mono={false} title={project.name} />
          <Readout label="Frame layout" value={frame.name} mono={false} />
          <Readout label="Rotors" value={frame.rotors} />
          <Readout label="Created" value={formatTimestamp(project.createdAt)} />
        </Readouts>
      </Section>
      {geo && doc && (
        <>
          <Section title="Add part">
            <PartLibrary doc={doc} geo={geo} frameTop={doc.frame.armThickness} />
          </Section>
          <Section title="Assembly" count={doc.parts.length}>
            <AssemblyTree doc={doc} geo={geo} />
          </Section>
        </>
      )}
      <Section title="Frame">
        <FrameEditor />
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          New projects start with typical values for a {frame.name}; set them to match your frame.
        </p>
      </Section>
      {geo && (
        <Section title="Motors" count={geo.motors.length}>
          <MotorList geo={geo} />
          <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
            Numbering and default spin follow PX4&apos;s generic {frame.name} airframe.
          </p>
        </Section>
      )}
    </>
  )
}

function ViewPanel() {
  const projection = useWorkshopView((s) => s.projection)
  return (
    <>
      <Section title="View">
        <Readouts>
          <Readout label="Projection" value={projection === 'perspective' ? 'Perspective' : 'Orthographic'} mono={false} />
          <Readout
            label="Vertical field of view"
            value={projection === 'perspective' ? '35' : '—'}
            unit={projection === 'perspective' ? '°' : undefined}
          />
          <Readout label="Grid cell" value="10" unit="mm" />
          <Readout label="Major grid line" value="100" unit="mm" />
        </Readouts>
      </Section>
      <Section title="Axes">
        <Readouts>
          <Readout label="X · forward" value={<AxisSwatch color="#e0605a" />} mono={false} />
          <Readout label="Y · left" value={<AxisSwatch color="#6fc27a" />} mono={false} />
          <Readout label="Z · up" value={<AxisSwatch color="#5aa7e0" />} mono={false} />
        </Readouts>
      </Section>
      <Section title="Controls">
        <dl className="border-t border-line text-[12px]">
          {[
            ['Orbit', 'Left drag'],
            ['Pan', 'Right drag'],
            ['Zoom', 'Wheel'],
            ['Views', '1 – 4'],
            ['Fit', 'F'],
            ['Projection', 'P'],
            ['Grid', 'G'],
            ['Exploded view', 'X'],
            ['Measure', 'M'],
          ].map(([action, key]) => (
            <div key={action} className="flex justify-between border-b border-line/60 py-1.5">
              <dt className="text-fg-muted">{action}</dt>
              <dd className="num text-fg">{key}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  )
}

function AxisSwatch({ color }: { color: string }) {
  return <span className="inline-block h-0.5 w-5 rounded-full align-middle" style={{ background: color }} />
}

function ToolButton({
  label,
  pressed,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string
  className?: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
        className,
        pressed && 'text-fg',
      )}
    >
      {children}
    </button>
  )
}

function Segmented({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex rounded-[var(--radius-sm)] border border-line-strong p-px', className)}
    >
      {children}
    </div>
  )
}

function SegmentButton({
  pressed,
  onClick,
  title,
  children,
}: {
  pressed: boolean
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        'h-6 rounded-[2px] px-2 text-[12px] font-medium',
        pressed ? 'bg-hover text-accent' : 'text-fg-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}


/** Part shortcuts: W/E gizmo mode, S snap, Del delete, arrows/PgUp/PgDn nudge. Returns true if handled. */
function partKeys(e: KeyboardEvent): boolean {
  const v = useWorkshopView.getState()
  const a = useAssembly.getState()
  const k = e.key
  if (k === 'w' || k === 'W') return v.setGizmo('translate'), true
  if (k === 'e' || k === 'E') return v.setGizmo('rotate'), true
  if (k === 's' || k === 'S') return v.setSnap(!v.snap), true
  const sel = v.selection
  if (sel?.kind !== 'part' || !a.doc) return false
  const part = a.doc.parts.find((p) => p.id === sel.id)
  if (!part) return false
  if (k === 'Delete' || k === 'Backspace') {
    deleteSelected(part, subtreeIds(a.doc, part.id).size - 1)
    return true
  }
  // Nudge in the frame of whatever the part is attached to: arrows move in X (forward) / Y (left).
  const step = (v.snap ? SNAP_MM : 1) / 1000
  const deltas: Record<string, [number, number, number]> = {
    ArrowUp: [step, 0, 0],
    ArrowDown: [-step, 0, 0],
    ArrowLeft: [0, step, 0],
    ArrowRight: [0, -step, 0],
    PageUp: [0, 0, step],
    PageDown: [0, 0, -step],
  }
  const d = deltas[k]
  if (!d) return false
  const position = part.position.map((x, i) => Math.round((x + d[i]!) * 1e7) / 1e7) as [number, number, number]
  a.edit(`Nudge ${part.name}`, (doc) => updatePart(doc, part.id, { position }))
  return true
}

function duplicateSelected() {
  const v = useWorkshopView.getState()
  const a = useAssembly.getState()
  const sel = v.selection
  const part = sel?.kind === 'part' ? a.doc?.parts.find((p) => p.id === sel.id) : undefined
  if (!part) return
  let rootId: string | null = null
  a.edit(`Duplicate ${part.name}`, (d) => {
    const r = duplicatePart(d, part.id)
    rootId = r.rootId
    return r.doc
  })
  if (rootId) v.selectPart(rootId)
}
