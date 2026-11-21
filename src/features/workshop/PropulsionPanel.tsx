import { CircleAlert, CircleCheck, ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { Readout, Readouts } from '@/components/section'
import { cn } from '@/lib/utils'
import type { MotorPropulsion, PairFit, ReadyItem, ReadyLink, SquareLawFit } from '@/domain/propulsion'
import type { FrameGeometry } from '@/three/frame-geometry'
import { useComponentIndex } from './component-index'
import { propulsionState, type PropulsionState } from './propulsion-input'
import { useWorkshopView } from './view-store'

export function usePropulsion(doc: AssemblyDocument, geo: FrameGeometry): PropulsionState {
  const components = useComponentIndex()
  return useMemo(() => propulsionState(doc, geo, components), [doc, geo, components])
}

const SUPERSCRIPT: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' }
/** 2.294e-5 → "2.294 × 10⁻⁵" */
export function sci(x: number, digits = 4): string {
  if (x === 0) return '0'
  const [m, e] = x.toExponential(digits - 1).split('e') as [string, string]
  return `${m} × 10${String(Number(e)).replace(/./g, (c) => SUPERSCRIPT[c] ?? c)}`
}
const pct = (e: number) => `${e >= 0 ? '+' : '−'}${Math.abs(e * 100).toFixed(1)} %`
const GF = 9.80665e-3

/** Follows a checklist link: a field on this page, a part, or a library component. */
function useFollow() {
  const navigate = useNavigate()
  return (link: ReadyLink) => {
    if (link.to === 'part') return useWorkshopView.getState().selectPart(link.partId)
    if (link.to === 'component') return void navigate(`/components?id=${encodeURIComponent(link.componentId)}&field=${encodeURIComponent(link.field)}`)
    const id = link.to === 'frame-mass' ? 'frame-mass' : link.to === 'body-drag' ? 'body-cd' : null
    const el = id ? document.getElementById(id) : null
    el?.scrollIntoView({ block: 'center' })
    el?.focus()
  }
}

/** The "Ready to fly" section: every value the simulation still needs, each linked to its field. */
export function ReadyPanel({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const { ready } = usePropulsion(doc, geo)
  const follow = useFollow()
  if (ready.length === 0) {
    return (
      <p className="flex items-center gap-2 border-t border-line py-3 text-[12.5px] text-ok" data-testid="ready-ok">
        <CircleCheck className="size-3.5" /> Every value the simulation needs is stated or entered.
      </p>
    )
  }
  return (
    <div data-testid="ready-panel">
      <p className="border-t border-line py-2 text-[12px] leading-relaxed text-fg-subtle">
        No source states these for this build. Flight stays blocked until each is entered.
      </p>
      <ul className="border-t border-line">
        {ready.map((item) => (
          <ReadyRow key={item.id} item={item} follow={follow} />
        ))}
      </ul>
    </div>
  )
}

function ReadyRow({ item, follow }: { item: ReadyItem; follow: (l: ReadyLink) => void }) {
  const body = (
    <>
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
      <span className="min-w-0">
        <span className="block text-fg">{item.label}</span>
        <span className="block text-[12px] text-fg-subtle">{item.detail}</span>
      </span>
      {item.link?.to === 'component' && <ExternalLink className="ml-auto mt-0.5 size-3 shrink-0 text-fg-subtle" aria-label="Opens the component library" />}
    </>
  )
  const cls = 'flex w-full gap-2 border-b border-line/60 py-1.5 text-left text-[12.5px] leading-snug'
  return (
    <li data-testid="ready-item" data-item={item.id}>
      {item.link ? (
        <button type="button" className={cn(cls, 'hover:bg-hover/50')} onClick={() => follow(item.link!)} title="Go to the field">
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  )
}

/** The "Propulsion" section: k_T and k_Q per motor–propeller pair, with their data and validation. */
export function PropulsionPanel({ doc, geo }: { doc: AssemblyDocument; geo: FrameGeometry }) {
  const { motors } = usePropulsion(doc, geo)
  const components = useComponentIndex()
  // One block per distinct linked motor + propeller pair, listing the mounts that use it.
  const pairs = new Map<string, { m: MotorPropulsion; mounts: string[] }>()
  for (const m of motors) {
    const mc = m.slot.motor?.component
    const pc = m.slot.prop?.component
    if (!mc || !pc) continue
    const key = `${mc.id}:${pc.id}`
    const had = pairs.get(key)
    if (had) had.mounts.push(m.slot.name.replace('Motor ', ''))
    else pairs.set(key, { m, mounts: [m.slot.name.replace('Motor ', '')] })
  }
  if (pairs.size === 0) {
    return (
      <p className="border-t border-line py-3 text-[12.5px] text-fg-subtle" data-testid="propulsion-empty">
        Link a library motor and a propeller on it to see its thrust and torque model.
      </p>
    )
  }
  return (
    <div className="space-y-4" data-testid="propulsion-panel">
      {[...pairs.values()].map(({ m, mounts }) => {
        const mc = m.slot.motor!.component!
        const pc = m.slot.prop!.component!
        return (
          <div key={`${mc.id}:${pc.id}`} data-testid="propulsion-pair">
            <h3 className="mb-1 text-[12.5px] font-medium text-fg">
              {mc.name} + {pc.name}
              <span className="ml-2 font-normal text-fg-subtle">
                motor{mounts.length === 1 ? '' : 's'} {mounts.join(', ')}
              </span>
            </h3>
            {m.fit ? (
              <PairDetails m={m} fit={m.fit} sourceName={components[m.fit.origin.componentId]?.name ?? ''} />
            ) : (
              <p className="border-t border-line py-2 text-[12px] leading-relaxed text-warn" data-testid="pair-no-data">
                No data for this pair: neither the motor’s test table nor the propeller states it. k_T and k_Q are user inputs
                (see Ready to fly).
              </p>
            )}
          </div>
        )
      })}
      <p className="text-[11.5px] leading-relaxed text-fg-subtle">
        T = k_T ω², Q = k_Q ω², least squares through the origin. Model: ideal BLDC motor (K_t = 60/(2π·KV), stated R and
        I₀) behind an ideal averaging ESC (V_m = throttle × V, I_supply = throttle × I_motor). Propeller inertia: blades as
        thin rods, J = m R²/3. Method: src/domain/propulsion.ts.
      </p>
    </div>
  )
}

function fitText(f: SquareLawFit) {
  return `fit error max ${(f.maxAbsError * 100).toFixed(1)} %, rms ${(f.rmsError * 100).toFixed(1)} %`
}

function PairDetails({ m, fit, sourceName }: { m: MotorPropulsion; fit: PairFit; sourceName: string }) {
  const o = fit.origin
  const source =
    o.kind === 'motor-table'
      ? `${sourceName} test table, ${o.labels.map((l) => `“${l}”`).join(', ')} (${fit.kT.rows.length} rows)`
      : `${sourceName} performance table (${fit.kT.rows.length} static rows)`
  return (
    <>
      <p className="border-t border-line py-1.5 text-[12px] leading-relaxed text-fg-muted" data-testid="pair-source" data-kind={o.kind}>
        From the {source}.
        {o.condition && <span className={cn('block', o.kind === 'prop-table' ? 'text-warn' : 'text-fg-subtle')}>{o.condition}</span>}
      </p>
      <Readouts>
        <Readout
          label="k_T (thrust)"
          value={<span data-testid="pair-kt">{sci(fit.kT.k)}</span>}
          unit="N·s²"
          title={fitText(fit.kT)}
        />
        <div className="-mt-1 border-b border-line/60 pb-1 text-right text-[11.5px] text-fg-subtle" data-testid="pair-kt-error">
          {fitText(fit.kT)}
        </div>
        {fit.kQ ? (
          <>
            <Readout label="k_Q (torque)" value={<span data-testid="pair-kq">{sci(fit.kQ.k)}</span>} unit="N·m·s²" />
            <div className="-mt-1 border-b border-line/60 pb-1 text-right text-[11.5px] text-fg-subtle">
              {fit.kQMethod === 'motor-current' ? 'from Q = K_t (I/throttle − I₀); ' : 'from the torque column; '}
              {fitText(fit.kQ)}
            </div>
          </>
        ) : (
          <Readout label="k_Q (torque)" value="no data" mono={false} />
        )}
        {m.electrical && (
          <Readout
            label="K_t"
            value={m.electrical.kt.toFixed(5)}
            unit="N·m/A"
            title={`60/(2π·KV); I₀ = ${m.electrical.noLoadCurrent} A${m.electrical.noLoadCondition ? ` (${m.electrical.noLoadCondition})` : ''}`}
          />
        )}
        <Readout
          label="J propeller"
          value={m.propInertia === null ? 'no mass or diameter' : sci(m.propInertia, 3)}
          unit={m.propInertia === null ? undefined : 'kg·m²'}
          mono={m.propInertia !== null}
          title="Blades as thin rods: J = m R²/3 (assumption)"
        />
        <Readout
          label="J rotor"
          value={
            m.rotor?.ok ? (
              sci(m.rotor.value, 3)
            ) : (
              <span className="text-warn" data-testid="rotor-missing">
                not stated
              </span>
            )
          }
          unit={m.rotor?.ok ? 'kg·m²' : undefined}
          mono={!!m.rotor?.ok}
          title={m.rotor?.ok ? (m.rotor.from === 'stated' ? 'Entered' : 'J = τm·Kt²/R from the mechanical time constant') : undefined}
        />
      </Readouts>
      {fit.validation && fit.validation.length > 0 && (
        <>
          <h4 className="mb-1 mt-3 text-[12px] font-medium text-fg-muted">Solver vs. the cited rows (model error)</h4>
          <table className="w-full border-collapse text-[11.5px]" data-testid="validation-table">
            <thead>
              <tr className="text-fg-subtle">
                <th className="border-y border-line py-1 pr-1 text-left font-medium">Point</th>
                <th className="border-y border-line px-1 py-1 text-right font-medium">Speed</th>
                <th className="border-y border-line px-1 py-1 text-right font-medium">Thrust</th>
                <th className="border-y border-line py-1 pl-1 text-right font-medium">Current</th>
              </tr>
            </thead>
            <tbody>
              {fit.validation.map((v, i) => (
                <tr key={i} data-testid="validation-row">
                  <td className="num whitespace-nowrap border-b border-line/60 py-1 pr-1 leading-tight text-fg-muted">
                    {v.voltage} V<br />
                    {Math.round(v.throttle * 100)} %
                  </td>
                  <Cell table={v.rpm.table.toFixed(0)} model={v.rpm.model.toFixed(0)} unit="rpm" error={v.rpm.error} />
                  <Cell table={(v.thrust.table / GF).toFixed(0)} model={(v.thrust.model / GF).toFixed(0)} unit="g" error={v.thrust.error} />
                  <Cell table={v.current.table.toFixed(1)} model={v.current.model.toFixed(1)} unit="A" error={v.current.error} />
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
            (model − cited) / cited at each row&apos;s voltage and throttle; hover a cell for both values.
          </p>
        </>
      )}
    </>
  )
}

function Cell({ table, model, unit, error }: { table: string; model: string; unit: string; error: number }) {
  return (
    <td
      className="num whitespace-nowrap border-b border-line/60 px-1 py-1 text-right last:pr-0"
      title={`Cited ${table} ${unit}, model ${model} ${unit}`}
      data-testid="validation-error"
    >
      <span className={cn(Math.abs(error) > 0.1 ? 'text-warn' : 'text-fg')}>{pct(error).replace(' ', '')}</span>
    </td>
  )
}
