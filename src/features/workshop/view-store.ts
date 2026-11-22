import { create } from 'zustand'
import { readPref, writePref } from '@/lib/prefs'
import type { PartKind } from '../../../electron/ipc/contract'
import type { Projection, Vec3, ViewPreset } from '@/three/views'

/** A one-shot camera command; `n` makes repeated identical requests distinct. */
export type CameraRequest = { kind: 'preset'; preset: ViewPreset; n: number } | { kind: 'fit'; n: number }

interface ViewState {
  projection: Projection
  showGrid: boolean
  /** Last preset applied; shown in the status strip until the user orbits away. */
  preset: ViewPreset | null
  request: CameraRequest | null
  /** Single selection: a frame mounting point or a part. */
  selection: Selection
  /** Selected mounting point id, derived from `selection` for convenience. */
  selectedMount: string | null
  selectMount(id: string | null): void
  selectPart(id: string | null): void
  clearSelection(): void
  /** Gizmo mode for the selected part. */
  /** Scale resizes the envelope of a part that is not linked to a library component. */
  gizmo: 'translate' | 'rotate' | 'scale'
  setGizmo(mode: 'translate' | 'rotate' | 'scale'): void
  /** Snap gizmo moves to SNAP_MM and rotations to SNAP_DEG. */
  snap: boolean
  setSnap(on: boolean): void
  setProjection(p: Projection): void
  setShowGrid(v: boolean): void
  viewFrom(preset: ViewPreset): void
  fit(): void
  /** Called by the viewport when the user moves the camera by hand. */
  userMoved(): void
  /** Exploded view (display only, never saved; the gizmo is off while it is on). */
  exploded: boolean
  /** 0–1 share of the maximum spread. */
  spread: number
  setExploded(on: boolean): void
  setSpread(v: number): void
  /** Measure tool: clicks pick points instead of selecting. Display only, never saved. */
  measuring: boolean
  /** Picked points (world, metres): none, the first, or both. */
  measure: Vec3[]
  setMeasuring(on: boolean): void
  addMeasurePoint(p: Vec3): void
  clearMeasure(): void
  /** Detailed part models (true) or plain envelope shapes (false). Display only. */
  detail: boolean
  setDetail(on: boolean): void
  /** Mount a part being dragged would attach to if released now. */
  snapTarget: string | null
  setSnapTarget(id: string | null): void
  /** Kind being dragged from the part library (mount markers show while it is). */
  libraryDrag: PartKind | null
  setLibraryDrag(kind: PartKind | null): void
  /** Show the centre-of-mass marker in the viewport. */
  showCom: boolean
  setShowCom(on: boolean): void
  /** Debug view: draw every part's collision shape (what the interference check and the engine use). */
  showCollision: boolean
  setShowCollision(on: boolean): void
  /** Why the last part could not be placed (shown under "Add part"); null when it was. */
  placementNote: string | null
  setPlacementNote(note: string | null): void
  /**
   * Warn when a motor's hover share exceeds the mean by more than this many percent.
   * The user's own margin; 10 % is only the starting value.
   */
  balanceTolerance: number
  setBalanceTolerance(pct: number): void
  /** Pose of the part being dragged with the gizmo (not yet saved), so mass properties follow live. */
  dragPose: { id: string; position: [number, number, number]; rotation: [number, number, number, number] } | null
  setDragPose(pose: ViewState['dragPose']): void
}

export type Selection = { kind: 'mount'; id: string } | { kind: 'part'; id: string } | null

export const SNAP_MM = 5
export const SNAP_DEG = 15

let counter = 0

export const useWorkshopView = create<ViewState>((set) => ({
  projection: readPref<Projection>('workshop.projection', 'perspective'),
  showGrid: readPref('workshop.grid', true),
  preset: 'iso',
  request: null,
  selection: null,
  selectedMount: null,
  // A placement message belongs to the action that failed; a new selection clears it.
  selectMount(id) {
    set({ selection: id ? { kind: 'mount', id } : null, selectedMount: id, placementNote: null })
  },
  selectPart(id) {
    set({ selection: id ? { kind: 'part', id } : null, selectedMount: null, placementNote: null })
  },
  clearSelection() {
    set({ selection: null, selectedMount: null, placementNote: null })
  },
  gizmo: 'translate',
  setGizmo(gizmo) {
    set({ gizmo })
  },
  snap: readPref('workshop.snap', true),
  setSnap(snap) {
    writePref('workshop.snap', snap)
    set({ snap })
  },
  setProjection(projection) {
    writePref('workshop.projection', projection)
    set({ projection })
  },
  setShowGrid(showGrid) {
    writePref('workshop.grid', showGrid)
    set({ showGrid })
  },
  viewFrom(preset) {
    set({ preset, request: { kind: 'preset', preset, n: ++counter } })
  },
  fit() {
    set({ request: { kind: 'fit', n: ++counter } })
  },
  userMoved() {
    set({ preset: null })
  },
  exploded: false,
  spread: 0.5,
  setExploded(exploded) {
    set({ exploded })
  },
  detail: readPref('workshop.detail', true),
  setDetail(detail) {
    writePref('workshop.detail', detail)
    set({ detail })
  },
  measuring: false,
  measure: [],
  setMeasuring(measuring) {
    set({ measuring, measure: [] })
  },
  addMeasurePoint(p) {
    // A third click starts a new measurement.
    set((s) => ({ measure: s.measure.length >= 2 ? [p] : [...s.measure, p] }))
  },
  clearMeasure() {
    set({ measure: [] })
  },
  snapTarget: null,
  setSnapTarget(snapTarget) {
    set((s) => (s.snapTarget === snapTarget ? s : { snapTarget }))
  },
  libraryDrag: null,
  setLibraryDrag(libraryDrag) {
    set({ libraryDrag })
  },
  showCom: readPref('workshop.showCom', true),
  setShowCom(showCom) {
    writePref('workshop.showCom', showCom)
    set({ showCom })
  },
  placementNote: null,
  setPlacementNote(placementNote) {
    set((s) => (s.placementNote === placementNote ? s : { placementNote }))
  },
  showCollision: readPref('workshop.showCollision', false),
  setShowCollision(showCollision) {
    writePref('workshop.showCollision', showCollision)
    set({ showCollision })
  },
  balanceTolerance: readPref('workshop.balanceTolerance', 10),
  setBalanceTolerance(balanceTolerance) {
    writePref('workshop.balanceTolerance', balanceTolerance)
    set({ balanceTolerance })
  },
  dragPose: null,
  setDragPose(dragPose) {
    set({ dragPose })
  },
  setSpread(spread) {
    set({ spread: Math.min(1, Math.max(0, spread)) })
  },
}))
