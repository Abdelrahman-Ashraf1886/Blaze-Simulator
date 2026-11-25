/**
 * Units for component specifications. Pure, no dependencies; shared by main
 * (validation) and the renderer (display, checks).
 *
 * Values are stored as the source states them (e.g. "1300 mAh", "5 in"), so they
 * can be compared with the datasheet. Checks and calculations convert to SI with
 * `toSI` first.
 *
 * Exact definitions used:
 * - inch = 0.0254 m and avoirdupois ounce = 28.349523125 g (international yard and
 *   pound agreement, 1959);
 * - 1 Ah = 3600 C;
 * - Kv in rpm/V → rad/(s·V): × 2π/60;
 * - C rating: a current of n·C draws the full capacity in 1/n hours, so its SI
 *   factor is 1/3600 s⁻¹ (current = rate × charge);
 * - gram-force = 9.80665 × 10⁻³ N (standard gravity, exact), used by thrust tables;
 * - pound-force = 0.45359237 kg × 9.80665 m/s² = 4.4482216152605 N (exact);
 * - horsepower (mechanical) = 550 ft·lbf/s = 745.69987158227022 W (exact; ft = 0.3048 m);
 * - mile per hour = 1609.344 m / 3600 s = 0.44704 m/s (exact);
 * - "1" is the unit of a dimensionless number (coefficients, ratios, Mach, Reynolds);
 * - kmol = 1000 mol, so kg/kmol and N·m/(kmol·K) carry a factor 10⁻³ to SI;
 * - g·cm² = 10⁻³ kg × 10⁻⁴ m² = 10⁻⁷ kg·m² (moment of inertia);
 * - AWG → cross-section (ASTM B258): d = 0.127 mm × 92^((36 − n)/39), A = π·d²/4.
 */

import { STANDARD_GRAVITY } from './mass'

export type Dimension =
  | 'length'
  | 'mass'
  | 'current'
  | 'voltage'
  | 'power'
  | 'resistance'
  | 'charge'
  | 'kv'
  | 'crate'
  | 'temperature'
  | 'area'
  | 'force'
  | 'ratio'
  | 'angularSpeed'
  | 'torque'
  | 'speed'
  | 'acceleration'
  | 'thrustPerPower'
  | 'dimensionless'
  | 'density'
  | 'pressure'
  | 'temperatureGradient'
  | 'molarMass'
  | 'molarGasConstant'
  | 'specificGasConstant'
  | 'inertia'
  | 'time'
  | 'frequency'
  | 'angularSpeedNoiseDensity'
  | 'accelerationNoiseDensity'

interface UnitDef {
  dimension: Dimension
  /** SI value = value × factor + offset (linear units). */
  factor?: number
  offset?: number
  /** Non-linear units (AWG). */
  toSI?: (v: number) => number
  fromSI?: (si: number) => number
}

const LBF_N = 0.45359237 * 9.80665
const RAD_PER_DEG = Math.PI / 180

const awgDiameterM = (n: number) => 0.127e-3 * 92 ** ((36 - n) / 39)

export const UNITS = {
  m: { dimension: 'length', factor: 1 },
  cm: { dimension: 'length', factor: 0.01 },
  mm: { dimension: 'length', factor: 0.001 },
  in: { dimension: 'length', factor: 0.0254 },
  kg: { dimension: 'mass', factor: 1 },
  g: { dimension: 'mass', factor: 0.001 },
  oz: { dimension: 'mass', factor: 0.028349523125 },
  A: { dimension: 'current', factor: 1 },
  mA: { dimension: 'current', factor: 0.001 },
  V: { dimension: 'voltage', factor: 1 },
  mV: { dimension: 'voltage', factor: 0.001 },
  W: { dimension: 'power', factor: 1 },
  kW: { dimension: 'power', factor: 1000 },
  'Ω': { dimension: 'resistance', factor: 1 },
  'mΩ': { dimension: 'resistance', factor: 0.001 },
  Ah: { dimension: 'charge', factor: 3600 },
  mAh: { dimension: 'charge', factor: 3.6 },
  'rpm/V': { dimension: 'kv', factor: (2 * Math.PI) / 60 },
  C: { dimension: 'crate', factor: 1 / 3600 },
  '°C': { dimension: 'temperature', factor: 1, offset: 273.15 },
  N: { dimension: 'force', factor: 1 },
  // Gram- and kilogram-force, as motor thrust tables state thrust (standard gravity 9.80665 m/s², exact).
  gf: { dimension: 'force', factor: 0.00980665 },
  kgf: { dimension: 'force', factor: 9.80665 },
  lbf: { dimension: 'force', factor: LBF_N },
  hp: { dimension: 'power', factor: 550 * 0.3048 * LBF_N },
  'N·m': { dimension: 'torque', factor: 1 },
  'in·lbf': { dimension: 'torque', factor: 0.0254 * LBF_N },
  'm/s': { dimension: 'speed', factor: 1 },
  mph: { dimension: 'speed', factor: 0.44704 },
  'm/s²': { dimension: 'acceleration', factor: 1 },
  // Standard gravity uses g₀ here because g already denotes gram.
  'g₀': { dimension: 'acceleration', factor: STANDARD_GRAVITY },
  'm/s²/√Hz': { dimension: 'accelerationNoiseDensity', factor: 1 },
  'µg/√Hz': { dimension: 'accelerationNoiseDensity', factor: 1e-6 * STANDARD_GRAVITY },
  // Gram-force of thrust per watt, as propeller and motor tables state efficiency.
  'g/W': { dimension: 'thrustPerPower', factor: 0.00980665 },
  '1': { dimension: 'dimensionless', factor: 1 },
  'kg/m³': { dimension: 'density', factor: 1 },
  'g/cm³': { dimension: 'density', factor: 1000 },
  Pa: { dimension: 'pressure', factor: 1 },
  mbar: { dimension: 'pressure', factor: 100 }, // 1 bar = 100,000 Pa
  K: { dimension: 'temperature', factor: 1 },
  'K/km': { dimension: 'temperatureGradient', factor: 0.001 },
  'kg/kmol': { dimension: 'molarMass', factor: 0.001 },
  'N·m/(kmol·K)': { dimension: 'molarGasConstant', factor: 0.001 },
  'J/(kg·K)': { dimension: 'specificGasConstant', factor: 1 },
  '%': { dimension: 'ratio', factor: 0.01 },
  rpm: { dimension: 'angularSpeed', factor: (2 * Math.PI) / 60 },
  'deg/s': { dimension: 'angularSpeed', factor: RAD_PER_DEG },
  'rad/s/√Hz': { dimension: 'angularSpeedNoiseDensity', factor: 1 },
  'deg/s/√Hz': { dimension: 'angularSpeedNoiseDensity', factor: RAD_PER_DEG },
  'mdps/√Hz': { dimension: 'angularSpeedNoiseDensity', factor: 1e-3 * RAD_PER_DEG },
  'mm²': { dimension: 'area', factor: 1e-6 },
  'kg·m²': { dimension: 'inertia', factor: 1 },
  'g·cm²': { dimension: 'inertia', factor: 1e-7 },
  s: { dimension: 'time', factor: 1 },
  ms: { dimension: 'time', factor: 0.001 },
  Hz: { dimension: 'frequency', factor: 1 },
  AWG: {
    dimension: 'area',
    toSI: (n) => (Math.PI * awgDiameterM(n) ** 2) / 4,
    fromSI: (a) => 36 - 39 * (Math.log(Math.sqrt((4 * a) / Math.PI) / 0.127e-3) / Math.log(92)),
  },
} as const satisfies Record<string, UnitDef>

export type Unit = keyof typeof UNITS

export const isUnit = (u: string): u is Unit => Object.hasOwn(UNITS, u)

export function dimensionOf(unit: Unit): Dimension {
  return UNITS[unit].dimension
}

/** Units of one dimension, in declaration order. */
export function unitsOf(dimension: Dimension): Unit[] {
  return (Object.keys(UNITS) as Unit[]).filter((u) => UNITS[u].dimension === dimension)
}

export function toSI(value: number, unit: Unit): number {
  const u: UnitDef = UNITS[unit]
  if (u.toSI) return u.toSI(value)
  return value * u.factor! + (u.offset ?? 0)
}

export function fromSI(si: number, unit: Unit): number {
  const u: UnitDef = UNITS[unit]
  if (u.fromSI) return u.fromSI(si)
  return (si - (u.offset ?? 0)) / u.factor!
}

/** Converts between two units of the same dimension; throws on a mismatch. */
export function convert(value: number, from: Unit, to: Unit): number {
  if (UNITS[from].dimension !== UNITS[to].dimension) {
    throw new Error(`Cannot convert ${from} (${UNITS[from].dimension}) to ${to} (${UNITS[to].dimension})`)
  }
  return fromSI(toSI(value, from), to)
}
