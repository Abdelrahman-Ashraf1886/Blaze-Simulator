import type { FlightConditionsDoc, WindRoughnessDoc } from '../../electron/ipc/contract'
import type { MissingValue } from './environment'

type Roughness = Exclude<WindRoughnessDoc, { kind: 'custom' }> | { kind: 'custom'; lengthM: number }
type Mean = { kind: 'constant'; speedMps: number } | { kind: 'shear'; speedAt20FtMps: number; roughness: Roughness }
type Gust = { amplitudeMps: number; lengthM: number; startS: number }

/** engine-core/src/wind.rs:128–137. Direction is already in the engine's input frame. */
export type SimWind = { fromDeg: number; mean: Mean | null; gust: Gust | null } | null
export type WindResult = { ok: true; wind?: SimWind } | { ok: false; missing: MissingValue[] }

export function simWind(wind: FlightConditionsDoc['wind']): WindResult {
  // An omitted setting preserves the payload of a legacy document.
  if (wind === undefined) return { ok: true }
  if (wind?.kind === 'none') return { ok: true, wind: null }

  const missing: MissingValue[] = []
  const need = (value: unknown, field: string, instruction: string) => {
    if (value === null) missing.push({ field, message: `${instruction} under Wind in Flight Conditions.` })
  }
  if (wind === null) {
    need(wind, 'wind', 'Select a wind setting')
    return { ok: false, missing }
  }

  need(wind.fromDeg, 'wind.fromDeg', 'Enter the direction the wind comes from')
  need(wind.mean, 'wind.mean', 'Select a mean wind setting')
  need(wind.gust, 'wind.gust', 'Select a gust setting')
  let mean: Mean | null = null
  if (wind.mean?.kind === 'constant') {
    need(wind.mean.speedMps, 'wind.mean.speedMps', 'Enter the constant wind speed')
    mean = { kind: 'constant', speedMps: wind.mean.speedMps! }
  }
  if (wind.mean?.kind === 'shear') {
    const { roughness, speedAt20FtMps } = wind.mean
    need(speedAt20FtMps, 'wind.mean.speedAt20FtMps', 'Enter the wind speed at 20 ft')
    need(roughness, 'wind.mean.roughness', 'Select the shear roughness')
    if (roughness?.kind === 'custom') {
      need(roughness.lengthM, 'wind.mean.roughness.lengthM', 'Enter the custom roughness length')
    }
    mean = { kind: 'shear', speedAt20FtMps: speedAt20FtMps!, roughness: roughness as Roughness }
  }
  let gust: Gust | null = null
  if (wind.gust?.kind === 'discrete') {
    const { amplitudeMps, lengthM, startS } = wind.gust
    need(amplitudeMps, 'wind.gust.amplitudeMps', 'Enter the gust amplitude')
    need(lengthM, 'wind.gust.lengthM', 'Enter the gust length')
    need(startS, 'wind.gust.startS', 'Enter the gust start time')
    gust = { amplitudeMps: amplitudeMps!, lengthM: lengthM!, startS: startS! }
  }
  if (missing.length) return { ok: false, missing }
  return { ok: true, wind: { fromDeg: wind.fromDeg!, mean, gust } }
}
