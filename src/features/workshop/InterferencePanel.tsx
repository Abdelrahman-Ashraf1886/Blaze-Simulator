import { useEffect, useMemo, useState } from 'react'
import { FRAME_PART_ID, MAX_INTERFERENCE_TOLERANCE_M, type AssemblyDocument } from '../../../electron/ipc/contract'
import { NumberField, numberParser } from '@/components/number-field'
import type { Overlap } from '@/domain/collisions'
import type { FrameGeometry } from '@/three/frame-geometry'
import { updatePart } from './assembly-ops'
import { useAssembly } from './assembly-store'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
import { assemblyOverlaps, interferenceSettings, setInterferenceTolerance, setPairAllowed } from './interference-input'
import { useWorkshopView } from './view-store'

/** Delay before the checks follow a gizmo drag (they run once per pause, not per mouse move). */
export const LIVE_CHECK_DEBOUNCE_MS = 80

/**
 * The document with the part being dragged at its live gizmo pose, updated at most
 * once per LIVE_CHECK_DEBOUNCE_MS while dragging. Releasing the drag applies at once.
 */
export function useLiveDoc(doc: AssemblyDocument): AssemblyDocument {
  const drag = useWorkshopView((s) => s.dragPose)
  const [settled, setSettled] = useState(drag)
  useEffect(() => {
    if (!drag) return
    const t = setTimeout(() => setSettled(drag), LIVE_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [drag])
  // Between drags the last settled pose is stale; it is only used while that part is dragged.
  const pose = drag && settled?.id === drag.id ? settled : null
  return useMemo(
    () => (pose && doc.parts.some((p) => p.id === pose.id) ? updatePart(doc, pose.id, { position: pose.position, rotation: pose.rotation }) : doc),
    [doc, pose],
  )
}

/** Overlaps deeper than the tolerance, following a drag (debounced). */
export function useOverlaps(doc: AssemblyDocument, geo: FrameGeometry): Overlap[] {
  const live = useLiveDoc(doc)
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  return useMemo(() => assemblyOverlaps(live, geo, components, assets), [live, geo, components, assets])
}

const edit = (label: string, recipe: (d: AssemblyDocument) => AssemblyDocument) => useAssembly.getState().edit(label, recipe)

export function allowOverlap(o: Pick<Overlap, 'a' | 'b' | 'aName' | 'bName'>, allowed: boolean) {
  edit(`${allowed ? 'Allow' : 'Stop allowing'} overlap of ${o.aName} and ${o.bName}`, (d) => setPairAllowed(d, o.a, o.b, allowed))
}

const mm = (m: number) => String(Math.round(m * 1e5) / 100)

/** Interference settings: the tolerance and the pairs the user allowed. */
export function InterferencePanel({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const s = interferenceSettings(doc)
  const overlaps = useOverlaps(doc, geo)
  const names = new Map([[FRAME_PART_ID, 'Frame'], ...doc.parts.map((p) => [p.id, p.name] as [string, string])])
  const depthOf = (a: string, b: string) => overlaps.find((o) => o.a === a && o.b === b)?.depthM
  const accepted = overlaps.filter((o) => o.status === 'attached')
  return (
    <div data-testid="interference-panel">
      <NumberField
        key={`interference-tolerance:${s.toleranceM}`}
        id="interference-tolerance"
        label="Overlap tolerance"
        initial={mm(s.toleranceM)}
        unit="mm"
        parse={numberParser(0, MAX_INTERFERENCE_TOLERANCE_M * 1000, 'mm', 0.01)}
        onCommit={(v) => edit('Change overlap tolerance', (d) => setInterferenceTolerance(d, v / 1000))}
      />
      <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
        Parts whose collision shapes overlap by more than this are an error. Your own margin; {mm(0.0005)} mm is only the
        starting value. A part may always touch what it is mounted on.
      </p>
      {accepted.length > 0 && (
        <p className="mt-1 text-[12px] leading-relaxed text-fg-subtle" data-testid="interference-attached">
          Mounted contact: {accepted.map((o) => `${o.aName} on ${o.bName} (${mm(o.depthM)} mm)`).join(', ')}.
        </p>
      )}
      <h3 className="mb-1 mt-3 text-[12px] font-medium text-fg-muted">Allowed overlaps</h3>
      {s.allowedPairs.length === 0 ? (
        <p className="border-t border-line py-1.5 text-[12px] text-fg-subtle" data-testid="allowed-none">
          None. Allow a pair from its finding under Checks.
        </p>
      ) : (
        <ul className="border-t border-line" data-testid="allowed-pairs">
          {s.allowedPairs.map(([a, b]) => {
            const depth = depthOf(a, b)
            const o = { a, b, aName: names.get(a) ?? a, bName: names.get(b) ?? b }
            const [first, second] = [o.aName, o.bName].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
            return (
              <li key={`${a},${b}`} className="flex items-center justify-between gap-2 border-b border-line/60 py-1.5 text-[12.5px]" data-testid="allowed-pair">
                <span className="min-w-0 truncate text-fg-muted">
                  {first} · {second}{' '}
                  <span className="num ml-1 text-fg-subtle">{depth === undefined ? 'no overlap now' : `${mm(depth)} mm`}</span>
                </span>
                <button type="button" className="shrink-0 text-[12px] text-fg-subtle underline hover:text-fg" onClick={() => allowOverlap(o, false)}>
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
