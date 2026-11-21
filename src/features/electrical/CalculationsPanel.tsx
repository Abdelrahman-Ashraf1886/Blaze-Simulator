import { memo, useMemo, useState, type ReactNode } from 'react'
import type { Wire } from '../../../electron/ipc/contract'
import { cn } from '@/lib/utils'
import { COPPER_ALPHA_20C, COPPER_RESISTIVITY_20C, DEFAULT_LOAD_CASE, calculate, type Calc, type LoadCase } from '@/domain/electrical'
import type { WiringPart } from '@/domain/wiring'

/** "15.86" with its unit, or a dash whose tooltip says what is missing. */
function Value({ c, unit, scale = 1, digits = 3, testId }: { c: Calc; unit: string; scale?: number; digits?: number; testId?: string }) {
  if (c.value === null) {
    return (
      <span className="text-fg-subtle" title={c.reason} data-testid={testId} data-missing="true">
        —
      </span>
    )
  }
  return (
    <span className="num" title={c.formula} data-testid={testId}>
      {(c.value * scale).toFixed(digits)} <span className="text-fg-subtle">{unit}</span>
    </span>
  )
}

const reasons = (cs: Calc[]) => [...new Set(cs.flatMap((c) => (c.value === null && c.reason ? [c.reason] : [])))]

/** Memoised: it re-renders when the wiring or the load case changes, not on every selection in the designer. */
export const CalculationsPanel = memo(function CalculationsPanel({ parts, wires, onSelectWire, onSelectPart }: { parts: WiringPart[]; wires: Wire[]; onSelectWire: (id: string) => void; onSelectPart: (id: string) => void }) {
  const [load, setLoad] = useState<LoadCase>(DEFAULT_LOAD_CASE)
  const [currentText, setCurrentText] = useState('10')
  const r = useMemo(() => calculate(parts, wires, load), [parts, wires, load])
  const name = (id: string) => parts.find((p) => p.id === id)?.name ?? 'removed part'
  const byWire = new Map(wires.map((w) => [w.id, w]))

  const all: Calc[] = r.battery
    ? [
        r.battery.openCircuit,
        r.battery.terminal,
        r.totalLoss,
        ...r.cables.flatMap((c) => [c.current, c.drop]),
        ...r.escs.flatMap((e) => [e.current, e.voltage]),
        ...r.ratings.flatMap((x) => [x.current, x.rated]),
      ]
    : []

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="calculations">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-1.5 text-fg-muted">
          Load case
          <select
            aria-label="Load case"
            data-testid="load-mode"
            value={load.mode}
            onChange={(e) =>
              setLoad({
                ...load,
                mode: e.target.value as LoadCase['mode'],
                motorCurrentA: e.target.value === 'fixed' ? Number(currentText) : undefined,
              })
            }
            className="h-7 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-fg"
          >
            <option value="max">Each motor at its stated maximum current</option>
            <option value="fixed">Each motor at a current I enter</option>
          </select>
        </label>
        {load.mode === 'fixed' && (
          <label className="flex items-center gap-1.5 text-fg-muted">
            <input
              aria-label="Current per motor in A"
              data-testid="load-current"
              inputMode="decimal"
              value={currentText}
              onChange={(e) => {
                setCurrentText(e.target.value)
                const v = Number(e.target.value.replace(',', '.'))
                setLoad({
                  ...load,
                  motorCurrentA: e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 500 ? v : undefined,
                })
              }}
              className="num h-7 w-[70px] rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-right text-fg outline-none focus:border-accent"
            />
            A per motor
          </label>
        )}
        <label className="flex items-center gap-1.5 text-fg-muted">
          Battery
          <select
            aria-label="Battery state"
            data-testid="load-battery"
            value={load.battery}
            onChange={(e) =>
              setLoad({
                ...load,
                battery: e.target.value as LoadCase['battery'],
              })
            }
            className="h-7 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-fg"
          >
            <option value="nominal">Nominal voltage</option>
            <option value="full">Full charge</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-fg-muted">
          Conductor
          <select
            aria-label="Conductor temperature"
            data-testid="load-temp"
            value={load.conductorTempC}
            onChange={(e) => setLoad({ ...load, conductorTempC: Number(e.target.value) })}
            className="h-7 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-1.5 text-fg"
          >
            {[20, 40, 60, 80].map((t) => (
              <option key={t} value={t}>
                {t} °C
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {r.problem ? (
          <p className="py-3 text-[12.5px] text-fg-subtle" data-testid="calc-problem">
            {r.problem}
          </p>
        ) : (
          r.battery && (
            <div className="grid gap-x-8 gap-y-4 pt-2 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
              <Block title="Battery">
                <KV label={`${r.battery.name}, open circuit`}>
                  <Value c={r.battery.openCircuit} unit="V" digits={2} testId="calc-voc" />
                </KV>
                <KV label="Current drawn">
                  <Value c={r.battery.current} unit="A" digits={1} testId="calc-battery-current" />
                </KV>
                <KV label="Internal resistance">
                  <Value c={r.battery.internalResistance} unit="mΩ" scale={1000} digits={1} />
                </KV>
                <KV label="Terminal voltage under load">
                  <Value c={r.battery.terminal} unit="V" digits={2} testId="calc-terminal" />
                </KV>
                <KV label="Total loss (battery and power cables)">
                  <Value c={r.totalLoss} unit="W" digits={1} testId="calc-total-loss" />
                </KV>
              </Block>

              <Block title="Ratings for this load case">
                {r.ratings.map((x, i) => (
                  <button
                    key={`${x.partId}-${i}`}
                    type="button"
                    onClick={() => onSelectPart(x.partId)}
                    data-testid="calc-rating"
                    data-within={String(x.within)}
                    className="flex w-full items-baseline justify-between gap-2 border-b border-line/60 py-1 text-left text-[12px] hover:bg-hover/50"
                  >
                    <span className="min-w-0 truncate text-fg-muted">
                      {x.name} · {x.what}
                    </span>
                    <span className={cn('shrink-0', x.within === false && 'text-fault')}>
                      <Value c={x.current} unit="A" digits={1} /> <span className="text-fg-subtle">of</span> <Value c={x.rated} unit="A" digits={1} />
                    </span>
                  </button>
                ))}
              </Block>

              <Block title="Supply at each ESC (motor through its ESC)">
                <Table head={['ESC', 'Current', 'Drop', 'Voltage']}>
                  {r.escs.map((e) => (
                    <tr key={e.partId} data-testid="calc-esc" className="border-b border-line/60">
                      <td className="py-1 pr-2 text-fg-muted">{e.name}</td>
                      <td className="text-right">
                        <Value c={e.current} unit="A" digits={1} />
                      </td>
                      <td className="text-right">
                        <Value c={e.drop} unit="mV" scale={1000} digits={1} />
                      </td>
                      <td className="text-right">
                        <Value c={e.voltage} unit="V" digits={2} />
                      </td>
                    </tr>
                  ))}
                </Table>
              </Block>

              <Block title="Power cables" wide>
                <Table head={['Cable', 'Size', 'Current', 'R', 'Drop', 'Loss']}>
                  {r.cables.map((c) => {
                    const w = byWire.get(c.wireId)
                    return (
                      <tr key={c.wireId} data-testid="calc-cable" className="cursor-pointer border-b border-line/60 hover:bg-hover/50" onClick={() => onSelectWire(c.wireId)}>
                        <td className="max-w-[240px] truncate py-1 pr-2 text-fg-muted">
                          {name(c.from.partId)} → {name(c.to.partId)}
                        </td>
                        <td className="num pr-2 text-right text-fg-subtle">{w?.gaugeAwg != null && w.lengthMm != null ? `${w.gaugeAwg} AWG · ${w.lengthMm} mm` : 'not set'}</td>
                        <td className="text-right">
                          <Value c={c.current} unit="A" digits={1} />
                        </td>
                        <td className="text-right">
                          <Value c={c.resistance} unit="mΩ" scale={1000} digits={2} />
                        </td>
                        <td className="text-right">
                          <Value c={c.drop} unit="mV" scale={1000} digits={1} testId="calc-cable-drop" />
                        </td>
                        <td className="text-right">
                          <Value c={c.loss} unit="W" digits={2} />
                        </td>
                      </tr>
                    )
                  })}
                </Table>
              </Block>

              {reasons(all).length > 0 && (
                <Block title="Not calculated">
                  <ul className="text-[12px] text-fg-muted" data-testid="calc-missing">
                    {reasons(all).map((x) => (
                      <li key={x} className="border-b border-line/60 py-1">
                        {x}
                      </li>
                    ))}
                  </ul>
                </Block>
              )}

              <Block title="Method">
                <div className="space-y-1.5 text-[12px] leading-snug text-fg-muted" data-testid="calc-method">
                  <p>Steady state. Motor currents are DC supply currents; ESC losses and the avionics are not included. The current in a cable is the sum of the loads downstream.</p>
                  <p>
                    Cable: <span className="num text-fg">R = ρ(T)·2L/A</span> (both conductors), <span className="num text-fg">ρ(T) = ρ₂₀·(1 + α₂₀·(T − 20 °C))</span>, copper{' '}
                    <span className="num text-fg">ρ₂₀ = {(COPPER_RESISTIVITY_20C * 1e8).toFixed(4)}×10⁻⁸ Ω·m</span>, <span className="num text-fg">α₂₀ = {COPPER_ALPHA_20C} K⁻¹</span> (IEC 60028,
                    annealed copper). A from AWG per ASTM B258. <span className="num text-fg">ΔV = I·R</span>, <span className="num text-fg">P = I²·R</span>.
                  </p>
                  <p>
                    Battery: <span className="num text-fg">V = V_oc − I·R_int</span>, loss <span className="num text-fg">I²·R_int</span>, with the pack&apos;s stated internal resistance. Motor-phase
                    and signal cables are not calculated: phase currents depend on commutation (Phase 4).
                  </p>
                </div>
              </Block>
            </div>
          )
        )}
      </div>
    </div>
  )
})

function Block({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={cn('min-w-0', wide && 'col-span-full')}>
      <h3 className="mb-1 border-b border-line pb-1 text-[12.5px] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1 text-[12px]">
      <span className="min-w-0 truncate text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] [&_td]:whitespace-nowrap [&_td+td]:pl-2">
        <thead>
          <tr className="border-b border-line text-fg-subtle">
            {head.map((h, i) => (
              <th key={h} className={cn('py-1 font-normal', i === 0 ? 'text-left' : 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
