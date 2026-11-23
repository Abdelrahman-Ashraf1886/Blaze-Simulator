import { CircleAlert, CircleCheck, ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { AssemblyDocument } from '../../../electron/ipc/contract'
import { Readout, Readouts } from '@/components/section'
import { cn } from '@/lib/utils'
import { otherTablesKT, type MotorPropulsion, type PairFit, type ReadyItem, type ReadyLink, type SquareLawFit, type ThrottleMap } from '@/domain/propulsion'
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
    const id = link.to === 'frame-mass' ? 'frame-mass' : link.to === 'body-drag' ? `body-cd-${link.axis}` : link.elementId
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
        No source states these for this build. The flight simulation (4.6) will refuse to start until each is entered.
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
  const cls = 'flex w-full gap-2 py-1.5 text-left text-[12.5px] leading-snug'
  return (
    <li data-testid="ready-item" data-item={item.id} className="border-b border-line/60">
      {item.link ? (
        <button
          type="button"
          className={cn(cls, 'hover:bg-hover/50')}
          onClick={() => follow(item.link!)}
          title={item.link.to === 'component' ? 'Enter it in the library (every part using this component)' : 'Go to the field'}
        >
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
      {item.link?.to === 'component' && item.parts && item.parts.length > 0 && (
        <p className="pb-1.5 pl-5.5 text-[11.5px] text-fg-subtle" data-testid="ready-override">
          or override on one part:{' '}
          {item.parts.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <button type="button" className="underline hover:text-fg" onClick={() => useWorkshopView.getState().selectPart(p.id)}>
                {p.name}
              </button>
            </span>
          ))}
        </p>
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
  const library = Object.values(components)
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
              <PairDetails
                m={m}
                fit={m.fit}
                sourceName={components[m.fit.origin.componentId]?.name ?? ''}
                others={m.fit.origin.kind === 'motor-table' ? otherTablesKT(pc, mc, library) : []}
              />
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
        T = k_T ω², Q = k_Q ω², least squares through the origin (in-sample fits). Model: ideal BLDC motor (K_t = 60/(2π·KV),
        stated R and I₀) behind an ideal, lossless averaging ESC (V_m = e·V, I_supply = e·I_motor), where e is the effective
        duty from the bench throttle map: an empirical ratio of the manufacturer’s test bench, not an ESC efficiency.
        Propeller inertia: blades as thin rods, J = m R²/3. Method: src/domain/propulsion.ts.
      </p>
    </div>
  )
}

function fitText(f: SquareLawFit) {
  return `in-sample fit error max ${(f.maxAbsError * 100).toFixed(1)} %, rms ${(f.rmsError * 100).toFixed(1)} %`
}

const rpmOf = (omega: number) => ((omega * 30) / Math.PI).toFixed(0)

function MapLine({ map }: { map: ThrottleMap }) {
  if (map.origin === 'ideal') return <span>ideal ESC (no bench data): effective duty = throttle</span>
  return (
    <span>
      {map.points.map((p) => `${Math.round(p.throttle * 100)} % → ${(p.effectiveDuty * 100).toFixed(1)} %`).join(', ')}
      <span className="block text-fg-subtle">
        Median over {map.rows} bench rows{map.excluded.length ? ` (without ${map.excluded.join(', ')})` : ''}
        {map.adjusted ? '; made monotone' : ''}. Outside these steps the nearest ratio is held (extrapolated).
      </span>
    </span>
  )
}

function PairDetails({
  m,
  fit,
  sourceName,
  others,
}: {
  m: MotorPropulsion
  fit: PairFit
  sourceName: string
  others: ReturnType<typeof otherTablesKT>
}) {
  const o = fit.origin
  const source =
    o.kind === 'motor-table'
      ? `${sourceName} test table, ${o.labels.map((l) => `“${l}”`).join(', ')} (${fit.kT.rows.length} rows)`
      : `${sourceName} performance table (${fit.domain.rowsUsed} of ${fit.domain.rowsTotal} static rows)`
  const d = fit.domain
  const v = fit.validation
  const i0Outside = v ? v.rows.filter((r) => r.noLoadOutsideStated).length : 0
  return (
    <>
      <p className="border-t border-line py-1.5 text-[12px] leading-relaxed text-fg-muted" data-testid="pair-source" data-kind={o.kind}>
        From the {source}.
        {o.condition && <span className={cn('block', o.kind === 'prop-table' ? 'text-warn' : 'text-fg-subtle')}>{o.condition}</span>}
      </p>
      <p className="border-b border-line/60 py-1.5 text-[12px] leading-relaxed text-fg-muted" data-testid="pair-density" data-from={fit.referenceDensity?.from ?? 'missing'}>
        {fit.referenceDensity
          ? `Data taken at ${fit.referenceDensity.kgM3.toPrecision(4)} kg/m³ (${fit.referenceDensity.from === 'condition' ? 'named in the condition above' : `entered for ${fit.referenceDensity.source}`}); a flight scales thrust and torque by its own air density relative to it.`
          : 'No air density is stated for this data: enter it (see Ready to fly); a flight scales thrust and torque by its own air density relative to it.'}
      </p>
      <Readouts>
        <Readout label="k_T (thrust)" value={<span data-testid="pair-kt">{sci(fit.kT.k)}</span>} unit="N·s²" title={fitText(fit.kT)} />
        <div className="-mt-1 border-b border-line/60 pb-1 text-right text-[11.5px] text-fg-subtle" data-testid="pair-kt-error">
          {fitText(fit.kT)}
        </div>
        {fit.kQ ? (
          <>
            <Readout label="k_Q (torque)" value={<span data-testid="pair-kq">{sci(fit.kQ.k)}</span>} unit="N·m·s²" />
            <div className="-mt-1 border-b border-line/60 pb-1 text-right text-[11.5px] text-fg-subtle" data-testid="pair-kq-error">
              {fit.kQMethod === 'motor-current' ? 'from Q = K_t (I/e − I₀) with each row’s effective duty; ' : 'from the torque column; '}
              {fitText(fit.kQ)}
              {fit.kQIdealDuty && <span className="block">with e = throttle (4.5): max {(fit.kQIdealDuty.maxAbsError * 100).toFixed(1)} %</span>}
            </div>
          </>
        ) : (
          <Readout label="k_Q (torque)" value="no data" mono={false} />
        )}
        <div className="border-b border-line/60 py-1.5 text-[12px] leading-relaxed" data-testid="pair-domain">
          <span className="text-fg-muted">Supported speeds </span>
          <span className="num text-fg">
            {rpmOf(d.minOmega)}–{rpmOf(d.maxOmega)} rpm
          </span>
          <span className="block text-[11.5px] text-fg-subtle">
            {d.cappedBy === 'motor-speed'
              ? `${d.rowsUsed} of ${d.rowsTotal} rows: up to the motor’s no-load speed at the pack voltage. Outside this range thrust is an estimate.`
              : 'The rows used. Outside this range thrust is an estimate.'}
          </span>
        </div>
        {others.length > 0 && (
          <div className="border-b border-line/60 py-1.5 text-[12px]" data-testid="pair-other-tables">
            <span className="text-fg-muted">Same propeller in other tables</span>
            {others.map((x) => (
              <span key={x.motor.id} className="num block text-right text-fg">
                {x.motor.name}: {sci(x.kT)} ({pct(x.kT / fit.kT.k - 1)})
              </span>
            ))}
            <span className="block text-right text-[11.5px] text-fg-subtle">Shown for comparison; not pooled.</span>
          </div>
        )}
        <div className="border-b border-line/60 py-1.5 text-[12px] leading-relaxed" data-testid="pair-map">
          <span className="block text-fg-muted">Effective duty (bench throttle map)</span>
          <span className="num block text-[11.5px] text-fg">
            <MapLine map={fit.map} />
          </span>
        </div>
        {m.electrical && (
          <Readout
            label="K_t"
            value={m.electrical.kt.toFixed(5)}
            unit="N·m/A"
            title="60/(2π·KV)"
          />
        )}
        {m.electrical && (
          <div className="border-b border-line/60 py-1.5 text-[12px] leading-relaxed" data-testid="pair-i0">
            <span className="text-fg-muted">No-load current I₀ </span>
            <span className="num ml-1 text-fg">{m.electrical.noLoadCurrent} A</span>
            <span className="block text-[11.5px] text-fg-subtle">
              Stated once{m.electrical.noLoadCondition ? ` (${m.electrical.noLoadCondition})` : ''} and held constant.
              {v ? ` ${i0Outside} of ${v.rows.length} rows use it away from that voltage (unvalidated there).` : ''}
            </span>
          </div>
        )}
        <Readout
          label="J propeller"
          value={m.propInertia === null ? 'no mass or diameter' : sci(m.propInertia, 3)}
          unit={m.propInertia === null ? undefined : 'kg·m²'}
          mono={m.propInertia !== null}
          title="Blades as thin rods: J = m R²/3 (assumption), with the stated mass taken as the whole propeller (see the mass condition)"
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
      {v && v.rows.length > 0 && (
        <>
          <h4 className="mb-1 mt-3 text-[12px] font-medium text-fg-muted">Prediction of the cited rows (model error)</h4>
          <p className="mb-1 text-[11px] leading-relaxed text-fg-subtle" data-testid="validation-kind">
            {v.mapIndependent
              ? 'Throttle map from the other propellers’ rows (held out); k_T and k_Q are fitted on these rows. Grey: ideal ESC (before).'
              : 'Throttle map in-sample (no other propeller in the table). Grey: ideal ESC (before).'}
          </p>
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
              {v.rows.map((r, i) => {
                const b = fit.validationIdeal?.[i]
                return (
                  <tr key={i} data-testid="validation-row">
                    <td className="num whitespace-nowrap border-b border-line/60 py-1 pr-1 leading-tight text-fg-muted">
                      {r.voltage} V<br />
                      {Math.round(r.throttle * 100)} %{r.extrapolated ? '*' : ''}
                    </td>
                    <Cell table={r.rpm.table.toFixed(0)} model={r.rpm.model.toFixed(0)} unit="rpm" error={r.rpm.error} before={b?.rpm.error} />
                    <Cell table={(r.thrust.table / GF).toFixed(0)} model={(r.thrust.model / GF).toFixed(0)} unit="g" error={r.thrust.error} before={b?.thrust.error} />
                    <Cell table={r.current.table.toFixed(1)} model={r.current.model.toFixed(1)} unit="A" error={r.current.error} before={b?.current.error} />
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
            (model − cited) / cited at each row’s voltage and throttle; hover a cell for both values.
            {v.rows.some((r) => r.extrapolated) ? ' * outside the map’s steps.' : ''}
          </p>
        </>
      )}
    </>
  )
}

function Cell({ table, model, unit, error, before }: { table: string; model: string; unit: string; error: number; before?: number }) {
  return (
    <td
      className="num whitespace-nowrap border-b border-line/60 px-1 py-1 text-right leading-tight last:pr-0"
      title={`Cited ${table} ${unit}, model ${model} ${unit}`}
      data-testid="validation-error"
    >
      <span className={cn(Math.abs(error) > 0.1 ? 'text-warn' : 'text-fg')}>{pct(error).replace(' ', '')}</span>
      {before !== undefined && (
        <span className="block text-[10.5px] text-fg-subtle" data-testid="validation-before">
          {pct(before).replace(' ', '')}
        </span>
      )}
    </td>
  )
}
