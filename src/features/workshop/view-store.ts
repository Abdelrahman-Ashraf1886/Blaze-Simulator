import { create } from 'zustand'
import { readPref, writePref } from '@/lib/prefs'
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
  gizmo: 'translate' | 'rotate'
  setGizmo(mode: 'translate' | 'rotate'): void
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
  /** Mount a part being dragged would attach to if released now. */
  snapTarget: string | null
  setSnapTarget(id: string | null): void
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
  selectMount(id) {
    set({ selection: id ? { kind: 'mount', id } : null, selectedMount: id })
  },
  selectPart(id) {
    set({ selection: id ? { kind: 'part', id } : null, selectedMount: null })
  },
  clearSelection() {
    set({ selection: null, selectedMount: null })
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
  setSpread(spread) {
    set({ spread: Math.min(1, Math.max(0, spread)) })
  },
}))
