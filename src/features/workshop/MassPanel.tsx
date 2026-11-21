import { useMemo, useState } from 'react'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { Readout, Readouts } from '@/components/section'
import { cn } from '@/lib/utils'
import {
  STANDARD_GRAVITY,
  horizontalOffset,
  type HoverBalance,
  type MotorInput,
} from '@/domain/mass'
import type { FrameGeometry } from '@/three/frame-geometry'
import { updatePart } from './assembly-ops'
import { useAssets } from './asset-store'
import { useComponentIndex } from './component-index'
import { massState, type MassState } from './mass-input'
import { ScreenLabel } from './screen-labels'
import { useWorkshopView } from './view-store'

/**
 * Mass properties of the saved document, with the part being dragged at its live
 * gizmo pose, so the CoM marker and the readouts follow the drag.
 */
export function useMassState(doc: AssemblyDocument, geo: FrameGeometry): MassState {
  const components = useComponentIndex()
  const assets = useAssets((s) => s.assets)
  const drag = useWorkshopView((s) => s.dragPose)
  return useMemo(() => {
    const live = drag ? updatePart(doc, drag.id, { position: drag.position, rotation: drag.rotation }) : doc
    return massState(live, geo, components, assets)
  }, [doc, geo, components, assets, drag])
}

const mm = (m: number) => (m * 1000).toFixed(1)
const grams = (kg: number) => (kg * 1000).toFixed(1)
/** Inertia shown in g·m² (10⁻³ kg·m²), the scale of a small multirotor. */
const gm2 = (v: number) => (v * 1000).toFixed(3)

/** The "Mass" section of the workshop's left panel. */
export function MassPanel({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const { mp, motors, hover } = useMassState(doc, geo)
  const tolerance = useWorkshopView((s) => s.balanceTolerance)
  const select = (id: string) => {
    if (!id.startsWith('frame')) useWorkshopView.getState().selectPart(id)
  }
  return (
    <div data-testid="mass-panel">
      <Readouts>
        <Readout label="Total mass" value={<span data-testid="mass-total">{grams(mp.totalMassKg)}</span>} unit="g" />
        <Readout
          label="Weight"
          value={(mp.totalMassKg * STANDARD_GRAVITY).toFixed(2)}
          unit="N"
          title="m × 9.80665 m/s² (standard gravity)"
        />
      </Readouts>
      {mp.missingMass.length > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-warn" data-testid="mass-missing">
          Incomplete: no mass for{' '}
          {mp.missingMass.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <button type="button" className="underline hover:text-fg" onClick={() => select(m.id)}>
                {m.name}
              </button>
            </span>
          ))}
          . The centre of mass below leaves {mp.missingMass.length === 1 ? 'it' : 'them'} out.
        </p>
      )}

      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted">Centre of mass</h3>
      {mp.com ? (
        <Readouts>
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Readout key={axis} label={axis} value={<span data-testid={`com-${axis.toLowerCase()}`}>{mm(mp.com![i]!)}</span>} unit="mm" />
          ))}
          <Readout
            label="Horizontal offset"
            value={<span data-testid="com-offset">{mm(horizontalOffset(mp.com))}</span>}
            unit="mm"
            title="Distance from the frame's vertical axis: √(X² + Y²)"
          />
          <Readout
            label="From reference"
            value={<span data-testid="com-distance">{mm(Math.hypot(...mp.com))}</span>}
            unit="mm"
            title="Distance from the frame reference point (frame centre, bottom of the centre plate)"
          />
        </Readouts>
      ) : (
        <p className="text-[12px] text-fg-subtle" data-testid="com-none">
          No part has a mass yet.
        </p>
      )}

      {mp.inertia && (
        <>
          <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted" title="Inertia tensor about the centre of mass, body axes (X forward, Y left, Z up)">
            Inertia about CoM <span className="font-normal text-fg-subtle">g·m²</span>
          </h3>
          <table className="num w-full border-t border-line text-right text-[12px]" data-testid="inertia-tensor">
            <tbody>
              {[
                [mp.inertia[0], mp.inertia[3], mp.inertia[4]],
                [mp.inertia[3], mp.inertia[1], mp.inertia[5]],
                [mp.inertia[4], mp.inertia[5], mp.inertia[2]],
              ].map((row, r) => (
                <tr key={r} className="border-b border-line/60">
                  {row.map((v, c) => (
                    <td key={c} className={cn('py-1', r === c ? 'text-fg' : 'text-fg-muted')} data-testid={`inertia-${r}${c}`}>
                      {gm2(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {hover && <HoverShares hover={hover} motors={motors} tolerance={tolerance} />}
      <MassMethod />
    </div>
  )
}

function HoverShares({ hover, motors, tolerance }: { hover: HoverBalance; motors: MotorInput[]; tolerance: number }) {
  const limit = 1 + tolerance / 100
  return (
    <>
      <h3 className="mb-1 mt-4 text-[12px] font-medium text-fg-muted">Hover thrust per motor</h3>
      {!hover.feasible ? (
        <p className="text-[12px] leading-relaxed text-fault" data-testid="hover-infeasible">
          {hover.reason}
        </p>
      ) : (
        <table className="num w-full border-t border-line text-[12px]" data-testid="hover-table">
          <tbody>
            {motors.map((m, i) => (
              <tr key={m.partId} className="border-b border-line/60">
                <td className="py-1 text-fg-muted">{m.name}</td>
                <td className="py-1 text-right" data-testid={`hover-thrust-${i + 1}`}>
                  {((hover.thrustN[i]! / STANDARD_GRAVITY) * 1000).toFixed(0)} gf
                </td>
                <td
                  className={cn('py-1 text-right', hover.share[i]! > limit ? 'text-warn' : 'text-fg')}
                  data-testid={`hover-share-${i + 1}`}
                >
                  {(hover.share[i]! * 100).toFixed(1)} %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ToleranceField tolerance={tolerance} />
    </>
  )
}

function ToleranceField({ tolerance }: { tolerance: number }) {
  const [text, setText] = useState(String(tolerance))
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    const v = Number(text.trim().replace(',', '.'))
    if (!Number.isFinite(v) || v < 0 || v > 200) return setError('Enter 0 – 200 %')
    setError(null)
    useWorkshopView.getState().setBalanceTolerance(v)
  }
  return (
    <div className="mt-1 flex items-center justify-between gap-3 py-1">
      <label htmlFor="balance-tolerance" className="text-[12px] text-fg-muted" title="A motor whose hover share exceeds the mean by more than this is flagged">
        Max over mean
      </label>
      <div className={cn('flex h-7 w-[80px] items-center rounded-[var(--radius-sm)] border bg-chrome pr-2', error ? 'border-fault' : 'border-line-strong')}>
        <input
          id="balance-tolerance"
          data-testid="balance-tolerance"
          inputMode="decimal"
          value={text}
          aria-invalid={!!error}
          title={error ?? undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="num h-full w-full min-w-0 bg-transparent px-2 text-right text-fg outline-none"
        />
        <span className="num text-fg-subtle">%</span>
      </div>
    </div>
  )
}

function MassMethod() {
  return (
    <details className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
      <summary className="cursor-pointer text-fg-muted hover:text-fg">Method</summary>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li>CoM = Σ mᵢ rᵢ / Σ mᵢ over every part with a mass, at its position in the assembly.</li>
        <li>
          Each part&apos;s own inertia: a uniform solid of its size (box or cylinder); a propeller as thin blades to its tip,
          averaged over a turn (I = mR²/3 about the shaft). Imported models use their bounding box.
        </li>
        <li>The frame&apos;s entered mass is spread evenly over its plate and arms (holes and screws ignored).</li>
        <li>Totals about the CoM by the parallel axis theorem: I = Σ [Rᵢ Iᵢ Rᵢᵀ + mᵢ(|dᵢ|² E − dᵢ dᵢᵀ)].</li>
        <li>
          Hover thrust: the least-squares split that carries m·g with no roll or pitch moment about the CoM. Yaw balance
          needs each prop&apos;s drag torque and is not included yet.
        </li>
      </ul>
    </details>
  )
}

/** The CoM marker: a constant-size screen symbol at the CoM, with a drop line to the ground (in the scene). */
export function ComMarker({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const show = useWorkshopView((s) => s.showCom)
  const { mp } = useMassState(doc, geo)
  if (!show || !mp.com) return null
  return (
    <ScreenLabel id="com-marker" position={mp.com} interactive={false}>
      <span
        data-testid="com-marker"
        data-incomplete={mp.missingMass.length > 0 || undefined}
        title={mp.missingMass.length > 0 ? 'Centre of mass (incomplete: some parts have no mass)' : 'Centre of mass'}
        className="flex items-center gap-1"
      >
        {/* The usual CoM symbol: a circle with alternate quarters filled. */}
        <svg viewBox="0 0 16 16" className={cn('size-4 drop-shadow', mp.missingMass.length > 0 && 'opacity-60')} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="#f4f4f2" stroke="#111" strokeWidth="1.2" />
          <path d="M8 8 L8 1 A7 7 0 0 1 15 8 Z M8 8 L8 15 A7 7 0 0 1 1 8 Z" fill="#111" />
        </svg>
        <span className="rounded-[3px] bg-bg/85 px-1 text-[11px] leading-4 text-fg">CoM</span>
      </span>
    </ScreenLabel>
  )
}

/** A thin vertical line from the CoM to the ground plane, so its plan position reads in any view. */
export function ComDropLine({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const show = useWorkshopView((s) => s.showCom)
  const { mp } = useMassState(doc, geo)
  const positions = useMemo(
    () => (mp.com ? new Float32Array([mp.com[0], mp.com[1], mp.com[2], mp.com[0], mp.com[1], Math.min(0, mp.com[2])]) : null),
    [mp.com],
  )
  if (!show || !positions || mp.com![2] <= 0) return null
  return (
    <lineSegments renderOrder={10}>
      <bufferGeometry key={positions.join(',')}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color="#f4f4f2" depthTest={false} transparent opacity={0.7} />
    </lineSegments>
  )
}
