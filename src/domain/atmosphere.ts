/**
 * Air density for the flight model's body drag (Phase 4.6): the standard
 * atmosphere of the U.S. Standard Atmosphere 1976 below 11 km.
 *
 * The constants are not typed here: they come from the cited reference file
 * `database/reference/physics.v1.json` (set `isa`), through `isaConstants`.
 *
 * Model (USSA 1976, layer b = 0, H in geopotential metres from sea level):
 * - T(H) = T0 + L·H                                      (Table 4, L = −6.5 K/km′)
 * - P(H) = P0 · (T0 / T(H))^(g0·M0 / (R*·L))             (USSA 1976 eq. 33a, L ≠ 0)
 * - ρ = P·M0 / (R*·T)                                    (equation of state, eq. 1)
 * - g0′ (m²/(s²·m′)) is numerically g0, so g0 is used in the exponent.
 *
 * A non-standard day: `temperatureC` replaces T(H) in the equation of state
 * while the pressure stays the standard pressure at H (density at the
 * pressure altitude H, at the given air temperature). This is the usual
 * density-altitude convention, stated as an assumption.
 *
 * The altitude is geopotential. Below 11 km it differs from geometric height by
 * H = Z·r0/(r0 + Z) (r0 ≈ 6.357e6 m): under 0.2 % (19 m at 11 km), treated as
 * equal and stated. Valid for −5 km′ ≤ H ≤ 11 km′ (the tables start at −5 km′;
 * the next layer begins at 11 km′).
 */
import { toSI, type Unit } from './units'

export interface IsaConstants {
  /** m/s² */
  g0: number
  /** Pa */
  p0: number
  /** K */
  t0: number
  /** K/m (geopotential) */
  lapseRate: number
  /** J/(mol·K) */
  universalGasConstant: number
  /** kg/mol */
  molarMass: number
}

export const ISA_MIN_ALTITUDE_M = -5000
export const ISA_MAX_ALTITUDE_M = 11000

interface RefEntry {
  key: string
  value: number
  unit?: string
}
interface RefFile {
  sets: { id: string; values: RefEntry[] }[]
}

/** The ISA constants from the cited reference file, in SI. */
export function isaConstants(ref: RefFile): IsaConstants {
  const set = ref.sets.find((s) => s.id === 'isa')
  if (!set) throw new Error('The reference data has no "isa" set')
  const si = (key: string) => {
    const e = set.values.find((v) => v.key === key)
    if (!e || !e.unit) throw new Error(`The "isa" reference set has no ${key} with a unit`)
    return toSI(e.value, e.unit as Unit)
  }
  return {
    g0: si('standardGravity'),
    p0: si('seaLevelPressure'),
    t0: si('seaLevelTemperature'),
    lapseRate: si('troposphereLapseRate'),
    universalGasConstant: si('universalGasConstant'),
    molarMass: si('seaLevelMolarMass'),
  }
}

/** Standard temperature (K) and pressure (Pa) at geopotential altitude `h` (m). */
export function isaTemperaturePressure(c: IsaConstants, h: number): { temperatureK: number; pressurePa: number } {
  if (!Number.isFinite(h) || h < ISA_MIN_ALTITUDE_M || h > ISA_MAX_ALTITUDE_M) {
    throw new RangeError(`Altitude must be within ${ISA_MIN_ALTITUDE_M} and ${ISA_MAX_ALTITUDE_M} m (got ${h})`)
  }
  const temperatureK = c.t0 + c.lapseRate * h
  const exponent = (c.g0 * c.molarMass) / (c.universalGasConstant * c.lapseRate)
  return { temperatureK, pressurePa: c.p0 * (c.t0 / temperatureK) ** exponent }
}

/**
 * Air density (kg/m³) at geopotential altitude `h` (m), on a standard day, or
 * with the air at `temperatureC` (°C) at the standard pressure of `h`.
 */
export function airDensity(c: IsaConstants, h: number, temperatureC?: number): number {
  const { temperatureK, pressurePa } = isaTemperaturePressure(c, h)
  let t = temperatureK
  if (temperatureC !== undefined) {
    t = toSI(temperatureC, '°C')
    if (!Number.isFinite(t) || t <= 0) throw new RangeError(`Temperature must be above absolute zero (got ${temperatureC} °C)`)
  }
  return (pressurePa * c.molarMass) / (c.universalGasConstant * t)
}
