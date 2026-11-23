import { CircleAlert, CircleCheck } from 'lucide-react'
import { useNavigate } from 'react-router'
import { NumberField, numberParser } from '@/components/number-field'
import { Section } from '@/components/section'
import { ISA_MAX_ALTITUDE_M, ISA_MIN_ALTITUDE_M } from '@/domain/atmosphere'
import { cn } from '@/lib/utils'
import { useWorkshopView } from '../workshop/view-store'
import type { CutoffType, FlightBlocker, FlightConditions, FlightLink } from './readiness'

/** Empty text clears the value (not set); otherwise a number in [min, max]. */
const optional = (min: number, max: number, unit: string, step: number) => (text: string) => {
  if (text.trim() === '') return { ok: true as const, value: null }
  return numberParser(min, max, unit, step)(text)
}
const show = (v: number | null) => (v === null ? '' : String(v))

/** Focuses `id` once the page that holds it has rendered (a link into the workshop). */
export function focusWhenPresent(id: string, tries = 60) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ block: 'center' })
    el.focus()
  } else if (tries > 0) requestAnimationFrame(() => focusWhenPresent(id, tries - 1))
}

/** Follows a link to a field: on the flight page, in the workshop, on a part, or in the component library. Other pages share it. */
export function useFollow(projectId: string) {
  const navigate = useNavigate()
  return (link: FlightLink) => {
    if (link.to === 'flight-field') return focusWhenPresent(link.elementId)
    if (link.to === 'component') return void navigate(`/components?id=${encodeURIComponent(link.componentId)}&field=${encodeURIComponent(link.field)}`)
    if (link.to === 'part') useWorkshopView.getState().selectPart(link.partId)
    void navigate(`/workshop/${projectId}`)
    const id = link.to === 'frame-mass' ? 'frame-mass' : link.to === 'body-drag' ? `body-cd-${link.axis}` : link.to === 'environment' ? link.elementId : null
    if (id) focusWhenPresent(id)
  }
}

/**
 * The flight conditions the user enters (no defaults) and, until the build can fly, the checklist of everything
 * still missing, each item linked to its field.
 */
export function FlightSetup({ projectId, conditions: c, onChange, blockers, engineBlock, locked }: {
  projectId: string
  conditions: FlightConditions
  /** Saves the change with the project (an undo step, like the environment's values). */
  onChange: (label: string, patch: Partial<FlightConditions>) => void
  blockers: readonly FlightBlocker[]
  engineBlock: string | null
  locked: boolean
}) {
  const follow = useFollow(projectId)
  return (
    <Section title="Flight setup" count={blockers.length}>
      <div data-testid="flight-conditions">
        <NumberField key={`alt:${c.ambientAltitudeM}`} id="flight-altitude" label="Ambient altitude" unit="m" placeholder="not set" initial={show(c.ambientAltitudeM)} parse={optional(ISA_MIN_ALTITUDE_M, ISA_MAX_ALTITUDE_M, 'm', 1)} onCommit={(v) => onChange('Set ambient altitude', { ambientAltitudeM: v })} />
        <NumberField key={`temp:${c.temperatureC}`} id="flight-temperature" label="Air temperature (blank: standard atmosphere)" unit="°C" placeholder="standard" initial={show(c.temperatureC)} parse={optional(-273, 200, '°C', 0.1)} onCommit={(v) => onChange('Set air temperature', { temperatureC: v })} />
        <div className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
          <label htmlFor="flight-cutoff-type" className="text-[12.5px] text-fg-muted">Battery cut-off at</label>
          <select
            id="flight-cutoff-type"
            data-testid="flight-cutoff-type"
            value={c.cutoffType}
            onChange={(e) => onChange('Set battery cut-off type', { cutoffType: e.target.value as CutoffType, cutoffValue: null })}
            className="h-7 rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-[12.5px] text-fg"
          >
            <option value="voltageV">pack voltage</option>
            <option value="chargeMah">charge drawn</option>
          </select>
        </div>
        <NumberField
          key={`cut:${c.cutoffType}:${c.cutoffValue}`}
          id="flight-cutoff-value"
          label="Cut-off value"
          unit={c.cutoffType === 'voltageV' ? 'V' : 'mAh'}
          placeholder="not set"
          initial={show(c.cutoffValue)}
          parse={optional(0.001, 1e6, c.cutoffType === 'voltageV' ? 'V' : 'mAh', 0.001)}
          onCommit={(v) => onChange('Set battery cut-off', { cutoffValue: v })}
        />
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-fg-subtle">Saved with the project.</p>
      {locked && <p className="mt-1 text-[11.5px] text-fg-subtle">Conditions apply to the next start.</p>}
      {blockers.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-[12.5px] text-ok" data-testid="flight-ready">
          <CircleCheck className="size-3.5" /> Ready to fly: every value the simulation needs is stated or entered.
        </p>
      ) : (
        <div data-testid="flight-blockers" className="mt-2">
          <p className="text-[12px] leading-relaxed text-fg-subtle">No source states these for this build. The flight will not start until each is entered.</p>
          <ul className="mt-1 border-t border-line">
            {blockers.map((item) => {
              const body = (
                <>
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-fg">{item.label}</span>
                    <span className="block text-[12px] text-fg-subtle">{item.detail}</span>
                  </span>
                </>
              )
              const cls = 'flex w-full gap-2 py-1.5 text-left text-[12.5px] leading-snug'
              return (
                <li key={item.id} data-testid="flight-blocker" data-item={item.id} className="border-b border-line/60">
                  {item.link ? (
                    <button type="button" className={cn(cls, 'hover:bg-hover/50')} onClick={() => follow(item.link!)} title="Go to the field">{body}</button>
                  ) : (
                    <div className={cls}>{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {engineBlock && <p className="mt-2 text-[12.5px] text-warn" data-testid="flight-engine-block">{engineBlock}</p>}
    </Section>
  )
}
