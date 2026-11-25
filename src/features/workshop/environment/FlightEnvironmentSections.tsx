import type { FlightConditionsDoc, WindDoc } from '../../../../electron/ipc/contract'
import { simWind, validTurbulenceSeed } from '@/domain/wind'
import { ChoiceField, OptionalNumberField } from './fields'

type Wind = Extract<WindDoc, { kind: 'wind' }>

// Bounds from electron/ipc/schemas.ts:205–227.
const nonnegative = { accepts: (v: number) => v >= 0, message: 'Enter a value of zero or more.' }
const positive = { accepts: (v: number) => v > 0, message: 'Enter a value greater than zero.' }
const roughness = {
  accepts: (v: number) => v > 0 && v < 3 * 0.3048,
  message: 'Enter a length greater than zero and below 3 ft (0.9144 m).',
}
const unset = ['', 'Unset'] as const
const none = ['none', 'None'] as const
const seedConstraint = { accepts: validTurbulenceSeed, message: `Enter a whole number from 0 to ${Number.MAX_SAFE_INTEGER}.` }

export function WindSection({ wind, onChange }: { wind: FlightConditionsDoc['wind']; onChange: (wind: WindDoc | null) => void }) {
  return <section aria-labelledby="wind-heading" className="mt-3" data-testid="wind-section">
    <h3 id="wind-heading" className="text-[12px] font-medium text-fg-muted">Wind</h3>
    <p className="text-[11.5px] text-fg-subtle">Wind directly affects body drag only. Ground effect uses the local wind to estimate airspeed.</p>
    <ChoiceField id="wind-setting" label="Wind setting" value={wind?.kind ?? ''} options={[unset, none, ['wind', 'Set']]}
      onChange={(kind) => onChange(kind === 'wind' ? { kind, fromDeg: null, mean: null, gust: null } : kind === 'none' ? { kind } : null)} />
    {wind?.kind === 'wind' && <WindFields wind={wind} onChange={onChange} />}
  </section>
}

function WindFields({ wind, onChange }: { wind: Wind; onChange: (wind: Wind) => void }) {
  const { mean, gust, turbulence } = wind
  const set = (patch: Partial<Wind>) => onChange({ ...wind, ...patch })
  const validation = simWind(wind)
  const hint = (path: string) => !validation.ok && validation.missing.some(({ field }) => field === path) ? 'Required' : undefined
  return <>
    <p className="mt-1 text-[11.5px] text-fg-subtle">Degrees clockwise from world +X, seen from above. The project has no north.</p>
    <OptionalNumberField id="wind-from" label="Direction the wind comes from" unit="°" value={wind.fromDeg}
      hint={hint('wind.fromDeg')} onCommit={(fromDeg) => set({ fromDeg })} />
    <ChoiceField id="wind-mean" label="Mean wind" value={mean?.kind ?? ''} hint={hint('wind.mean')}
      options={[unset, none, ['constant', 'Constant'], ['shear', 'Shear']]}
      onChange={(kind) => {
        if (kind === 'constant') set({ mean: { kind, speedMps: null } })
        else if (kind === 'shear') set({ mean: { kind, speedAt20FtMps: null, roughness: null } })
        else set({ mean: kind === 'none' ? { kind } : null })
      }} />
    {mean?.kind === 'constant' && <OptionalNumberField id="wind-speed" label="Constant wind speed" unit="m/s" value={mean.speedMps}
      hint={hint('wind.mean.speedMps')} constraint={nonnegative} onCommit={(speedMps) => set({ mean: { ...mean, speedMps } })} />}
    {mean?.kind === 'shear' && <>
      <OptionalNumberField id="wind-speed-20ft" label="Wind speed at 20 ft" unit="m/s" value={mean.speedAt20FtMps}
        hint={hint('wind.mean.speedAt20FtMps')} constraint={nonnegative} onCommit={(speedAt20FtMps) => set({ mean: { ...mean, speedAt20FtMps } })} />
      <ChoiceField id="wind-roughness" label="Shear roughness (MIL-F-8785C)" value={mean.roughness?.kind ?? ''} hint={hint('wind.mean.roughness')}
        options={[unset, ['categoryC', 'Category C (terminal phases)'], ['otherPhases', 'Other phases'], ['custom', 'Custom']]}
        onChange={(kind) => {
          if (kind === 'custom') set({ mean: { ...mean, roughness: { kind, lengthM: null } } })
          else set({ mean: { ...mean, roughness: kind === 'categoryC' || kind === 'otherPhases' ? { kind } : null } })
        }} />
      {mean.roughness?.kind === 'custom' && <OptionalNumberField id="wind-roughness-length" label="Roughness length" unit="m"
        value={mean.roughness.lengthM} hint={hint('wind.mean.roughness.lengthM')} constraint={roughness}
        onCommit={(lengthM) => set({ mean: { ...mean, roughness: { kind: 'custom', lengthM } } })} />}
    </>}
    <ChoiceField id="wind-gust" label="Gust" value={gust?.kind ?? ''} hint={hint('wind.gust')}
      options={[unset, none, ['discrete', 'Discrete gust']]}
      onChange={(kind) => onChange({ ...wind, gust: kind === 'discrete'
        ? { kind, amplitudeMps: null, lengthM: null, startS: null }
        : kind === 'none' ? { kind } : null })} />
    {gust?.kind === 'discrete' && <>
      <OptionalNumberField id="wind-gust-amplitude" label="Gust amplitude" unit="m/s" value={gust.amplitudeMps}
        hint={hint('wind.gust.amplitudeMps')} constraint={nonnegative} onCommit={(amplitudeMps) => set({ gust: { ...gust, amplitudeMps } })} />
      <OptionalNumberField id="wind-gust-length" label="Gust length" unit="m" value={gust.lengthM}
        hint={hint('wind.gust.lengthM')} constraint={positive} onCommit={(lengthM) => set({ gust: { ...gust, lengthM } })} />
      <OptionalNumberField id="wind-gust-start" label="Gust start time" unit="s" value={gust.startS}
        hint={hint('wind.gust.startS')} constraint={nonnegative} onCommit={(startS) => set({ gust: { ...gust, startS } })} />
    </>}
    <ChoiceField id="wind-turbulence" label="Turbulence" value={turbulence?.kind ?? 'off'}
      options={[[ 'off', 'Off'], ['dryden', 'Dryden']]}
      hint={hint('wind.turbulence') && 'Dryden requires a positive mean wind speed.'}
      onChange={(kind) => set({ turbulence: kind === 'dryden' ? { kind, seed: null } : null })} />
    {turbulence?.kind === 'dryden' && <>
      <OptionalNumberField id="wind-turbulence-seed" label="Dryden seed" value={turbulence.seed}
        hint={hint('wind.turbulence.seed')} constraint={seedConstraint}
        onCommit={(seed) => set({ turbulence: { kind: 'dryden', seed } })} />
      <p className="mt-1 text-[11.5px] text-fg-subtle" data-testid="wind-turbulence-limits">
        Dryden does not model hovering flight (Juhasz et al., 2017). It treats gusts as fixed in space.
        The gust stops changing at zero airspeed relative to the mean wind.
      </p>
    </>}
  </>
}

export function GroundEffectSection({ value, onChange }: { value: FlightConditionsDoc['groundEffect']; onChange: (value: boolean | null) => void }) {
  return <section aria-labelledby="ground-effect-heading" className="mt-3">
    <h3 id="ground-effect-heading" className="text-[12px] font-medium text-fg-muted">Ground effect</h3>
    <p className="text-[11.5px] text-fg-subtle">Single-rotor model; interaction between rotors is not modelled. Applies to ground and terrain only, not obstacles.</p>
    <ChoiceField id="ground-effect" label="Ground-effect setting" value={value == null ? '' : String(value)}
      options={[unset, ['true', 'On'], ['false', 'Off']]} onChange={(next) => onChange(next === '' ? null : next === 'true')} />
  </section>
}
