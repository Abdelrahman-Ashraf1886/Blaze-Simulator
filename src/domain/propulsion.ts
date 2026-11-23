/**
 * Motor, propeller and battery models (Phase 4.5). Pure: no React, three.js, zod
 * or IPC (ADR 0008). Every coefficient comes from cited data or from the user;
 * where neither exists the value is reported missing, never assumed.
 *
 * Units: SI throughout. ω in rad/s, thrust T in N, torque Q in N·m, current I in A,
 * voltage V in V, resistance R in Ω, inertia J in kg·m².
 *
 * Model (documentation/plans/phase-4-physics.md, "Motor and propeller", "Battery")
 *
 * Propeller
 * - Thrust T = k_T ω², drag torque Q = k_Q ω² (static, zero airspeed).
 * - k_T, k_Q are least-squares fits through the origin in ω²: minimising
 *   Σ (yᵢ − k ωᵢ²)² gives  k = Σ yᵢ ωᵢ² / Σ ωᵢ⁴.
 * - Data, in order of preference:
 *   1. the motor's cited test table, rows for this propeller (`motor-table`):
 *      k_T from thrust; k_Q from the current (below);
 *   2. the propeller's own performance table (`prop-table`): k_T from the thrust
 *      column, k_Q from the torque column. The table's provenance (e.g. APC's
 *      "computed, not measured") is carried with the fit and shown;
 *   3. nothing: k_T / k_Q are user inputs (enter static test rows in the
 *      propeller's performance table), and the build is not ready to fly.
 * - Matching a test-table row to a propeller: a motor maker's table names the
 *   props it was tested with ("T-MOTOR15*5CF"). A propeller of the same
 *   manufacturer whose stated diameter × pitch (inches) equals the D × P in the
 *   row's name is taken as that prop. Spelling differences ("T-MOTO13*4.4CF")
 *   do not matter; another maker's prop of the same size does not match.
 *
 * Motor (ideal brushless DC motor, `MotorElectrical`)
 * - Speed constant K_v = KV · 2π/60  [rad/(s·V)], from the stated KV.
 * - Torque constant K_t = 1/K_v = 60/(2π·KV)  [N·m/A]. In SI units the back-EMF
 *   constant and the torque constant of an ideal motor are equal (power balance
 *   E·I = Q·ω with E = ω/K_v).
 * - Shaft torque K_t (I_m − I₀), with I₀ the stated no-load current (its stated test
 *   voltage is shown with it; I₀ is taken as constant).
 * - Winding: V_m = ω/K_v + R·I_m, with R the stated internal resistance.
 * - ESC (labelled assumption: ideal, lossless averaging converter): the motor sees
 *   V_m = d_eff·V, where d_eff is the effective duty, and the power balance
 *   V·I_s = V_m·I_m gives the supply current I_s = d_eff·I_m. Test tables state the
 *   supply current I_s (their power column is V × I_s; checked per row).
 * - Effective duty: the throttle command d does not give d_eff = d on the
 *   manufacturer's bench. From a row's own speed and current, V·d_eff = E + R·I_s/d_eff
 *   with E = ω/K_v, so
 *     d_eff = [E + √(E² + 4·V·R·I_s)] / (2V)                       (`rowDuty`)
 *   The throttle map (`benchThrottleMap`) is the median of d_eff/d over a table's
 *   rows at each throttle step. It is an EMPIRICAL EFFECTIVE CONTROL RATIO of that
 *   bench (its ESC's command curve, supply and wiring together); it is not an ESC
 *   efficiency, and the voltage deficit it shows is not claimed to be dissipated in
 *   the ESC. Rules:
 *   - effective duty e = η·d is made non-decreasing in d (pool-adjacent-violators
 *     on the medians; `adjusted` says when that changed anything) and bounded to
 *     (0, 1];
 *   - between steps e is interpolated linearly; below the lowest step and above the
 *     highest, the ratio of the nearest step is held (`extrapolated`, labelled);
 *   - without a table the map is ideal, e = d (labelled).
 * - k_Q from a test-table row: in steady state the shaft torque equals the prop's
 *   drag torque, Q = K_t (I_s/d_eff − I₀), with the row's own d_eff.
 * - I₀ is a single stated point (e.g. "at 10 V"). It is held constant; rows whose
 *   motor voltage is away from that point use it outside its stated domain, and
 *   are flagged so (no I₀(ω) is assumed).
 *
 * Steady state (`steadyState`)
 * - V_m = ω/K_v + R·I_m and K_t (I_m − I₀) = k_Q ω². Eliminating I_m with K_t = 1/K_v:
 *     a ω² + b ω − c = 0,  a = R·k_Q·K_v,  b = 1/K_v,  c = V_m − R·I₀
 *   whose non-negative root is ω = 2c / (b + √(b² + 4ac)) (the cancellation-free form
 *   of (−b + √(b² + 4ac)) / 2a, valid for a = 0 too). For c ≤ 0 the motor does not
 *   turn (ω = 0).
 * - A source resistance R_s (battery internal resistance) in series with the ESC
 *   input: V = V_oc − R_s·I_s and I_s = e·I_m give V_m = e·V_oc − e²·R_s·I_m, i.e. the
 *   same equation with V_m = e·V_oc and R replaced by R + e²·R_s.
 * - Energy check: V_m·I_m = Q·ω + K_t·I₀·ω + R·I_m² (electrical in = shaft + no-load
 *   + copper) holds exactly in this model and is tested.
 *
 * Validation (`fitPair`)
 * - In-sample: k_T and k_Q are fitted on the pair's own rows; their fit errors are
 *   reported as fit errors, never as validation.
 * - Leave-one-prop-out: the speed, thrust, current and power at each row's voltage
 *   and throttle are predicted with a throttle map built from the OTHER propellers'
 *   rows of the same table, so the map is independent of the rows it predicts.
 *   When a table has no other propeller the map is in-sample and says so.
 * - The ideal-ESC prediction (e = d) is kept alongside, as the "before" reference.
 *
 * Domain
 * - A fit is supported over the speed range of the rows it used. For a propeller
 *   table, rows above the motor's no-load speed at the build's supply voltage
 *   (KV·V, plus the first row above it) are left out when that voltage is known.
 *   A steady state outside the domain is marked `outsideDomain` (an estimate).
 *
 * Response (simulated in engine-core/src/propulsion.rs, 4.6 wires it in)
 * - J dω/dt = K_t (I_m − I₀) − k_Q ω², J = J_rotor + J_prop.
 * - Propeller inertia, blade-as-rod (labelled, the same model as mass.ts): each blade
 *   a thin uniform rod from the axis to the tip, J_prop = m R²/3 with m the stated
 *   propeller mass and R half the stated diameter. The hub is ignored.
 * - Rotor inertia: stated (`rotorInertia`), or derived from a stated mechanical time
 *   constant τ_m = J·R/K_t² (the datasheet definition for a bare motor):
 *   J_rotor = τ_m·K_t²/R. No source states either for the built-in motors.
 *
 * Battery (`batteryModel`)
 * - Terminal voltage V = V_oc − I·R_int; charge used = ∫ I dt.
 * - R_int is the stated or entered pack internal resistance (no default).
 * - V_oc is the stated nominal pack voltage (else series × nominal cell voltage),
 *   held constant: no source states a discharge curve (labelled assumption).
 */
import type { Component, QuantityValue, SpecReference, SpecValue, TableValue } from '../../electron/ipc/component-fields'
import { toSI, type Unit } from './units'

// ---- Spec access -------------------------------------------------------------------------

const quantity = (spec: SpecValue | undefined): QuantityValue | null =>
  spec && typeof spec.value === 'number' && 'unit' in spec ? (spec as QuantityValue) : null

const si = (c: Component, key: string): number | null => {
  const q = quantity(c.specs[key])
  return q ? toSI(q.value, q.unit) : null
}

const table = (c: Component, key: string): TableValue | null => {
  const t = c.specs[key]
  return t && typeof t.value === 'object' && t.value !== null && 'rows' in t.value ? (t as TableValue) : null
}

/** A numeric cell in SI, or null when the row has no number or the column no unit. */
const cell = (t: TableValue, row: Record<string, number | string>, key: string): number | null => {
  const v = row[key]
  const unit = t.value.units[key] as Unit | undefined
  return typeof v === 'number' && unit ? toSI(v, unit) : null
}

const normalise = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// ---- Square-law fit ------------------------------------------------------------------------

export interface FitRow {
  /** rad/s */
  omega: number
  /** The source's value (N or N·m). */
  source: number
  /** k ω² */
  fitted: number
  /** (fitted − source) / source */
  error: number
}

export interface SquareLawFit {
  /** N·s² (k_T) or N·m·s² (k_Q). */
  k: number
  rows: FitRow[]
  /** Root mean square of the relative errors. */
  rmsError: number
  /** Largest |relative error|. */
  maxAbsError: number
}

/**
 * y = k ω², least squares through the origin: k = Σ yω² / Σ ω⁴. Points with ω ≤ 0 or
 * y ≤ 0 carry no information about k (and no relative error), so they are skipped.
 * Null when no point remains.
 */
export function fitSquareLaw(points: readonly { omega: number; y: number }[]): SquareLawFit | null {
  const used = points.filter((p) => p.omega > 0 && p.y > 0 && Number.isFinite(p.omega) && Number.isFinite(p.y))
  if (used.length === 0) return null
  let num = 0
  let den = 0
  for (const p of used) {
    num += p.y * p.omega ** 2
    den += p.omega ** 4
  }
  const k = num / den
  const rows = used.map((p) => {
    const fitted = k * p.omega ** 2
    return { omega: p.omega, source: p.y, fitted, error: (fitted - p.y) / p.y }
  })
  const rmsError = Math.sqrt(rows.reduce((s, r) => s + r.error ** 2, 0) / rows.length)
  const maxAbsError = Math.max(...rows.map((r) => Math.abs(r.error)))
  return { k, rows, rmsError, maxAbsError }
}

// ---- Motor -----------------------------------------------------------------------------------

export interface MotorElectrical {
  /** Speed constant K_v, rad/(s·V). */
  kv: number
  /** Torque constant K_t = 1/K_v, N·m/A. */
  kt: number
  /** Winding resistance, Ω. */
  resistance: number
  /** No-load current I₀, A. */
  noLoadCurrent: number
  /** The no-load current's stated condition (its test voltage), shown with it. */
  noLoadCondition: string | null
}

/** Motor spec keys the electrical model needs. */
export const MOTOR_ELECTRICAL_KEYS = ['kv', 'internalResistance', 'noLoadCurrent'] as const

export function motorElectrical(c: Component): { ok: true; value: MotorElectrical } | { ok: false; missing: string[] } {
  const kv = si(c, 'kv')
  const r = si(c, 'internalResistance')
  const i0 = si(c, 'noLoadCurrent')
  const missing = MOTOR_ELECTRICAL_KEYS.filter((k, i) => {
    const v = [kv, r, i0][i]
    // KV and R must be positive to define the model; I₀ may be zero if stated so.
    return v == null || (k === 'noLoadCurrent' ? v < 0 : v <= 0)
  })
  if (missing.length > 0) return { ok: false, missing: [...missing] }
  return {
    ok: true,
    value: { kv: kv!, kt: 1 / kv!, resistance: r!, noLoadCurrent: i0!, noLoadCondition: c.specs.noLoadCurrent?.condition ?? null },
  }
}

export interface SteadyState {
  /** rad/s */
  omega: number
  motorCurrent: number
  supplyCurrent: number
  /** Voltage applied to the motor, e·V (after the source drop). */
  motorVoltage: number
  /** e = η(d)·d, the duty the motor sees. */
  effectiveDuty: number
  /** The throttle is outside the map's measured steps (its ratio is held). */
  extrapolated: boolean
}

// ---- Throttle map (effective control ratio) ------------------------------------------------

/** Throttle command → effective duty e (header: an empirical bench ratio, not an efficiency). */
export interface ThrottleMap {
  /** Sorted by throttle; effective duty non-decreasing, in (0, 1]. */
  points: { throttle: number; effectiveDuty: number }[]
  origin: 'bench' | 'ideal'
  /** Component whose test rows define it (bench only). */
  componentId: string | null
  /** Propeller labels left out (leave-one-prop-out). */
  excluded: string[]
  /** Rows the medians were taken over. */
  rows: number
  /** The monotone fit changed at least one median. */
  adjusted: boolean
}

export const IDEAL_MAP: ThrottleMap = { points: [], origin: 'ideal', componentId: null, excluded: [], rows: 0, adjusted: false }

/** Effective duty for throttle d (header rules). The ideal map gives e = d. */
export function effectiveDuty(map: ThrottleMap, d: number): { duty: number; extrapolated: boolean } {
  const t = Math.min(Math.max(d, 0), 1)
  const p = map.points
  if (t === 0 || p.length === 0) return { duty: t, extrapolated: false }
  const first = p[0]!
  const last = p[p.length - 1]!
  if (t <= first.throttle) return { duty: Math.min(1, (first.effectiveDuty / first.throttle) * t), extrapolated: t < first.throttle }
  if (t >= last.throttle) return { duty: Math.min(1, (last.effectiveDuty / last.throttle) * t), extrapolated: t > last.throttle }
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!
    const b = p[i]!
    if (t <= b.throttle) {
      const f = (t - a.throttle) / (b.throttle - a.throttle)
      return { duty: a.effectiveDuty + f * (b.effectiveDuty - a.effectiveDuty), extrapolated: false }
    }
  }
  return { duty: last.effectiveDuty, extrapolated: false }
}

/** d_eff = [E + √(E² + 4·V·R·I_s)] / (2V), E = ω/K_v (header). */
export function rowDuty(m: MotorElectrical, voltage: number, omega: number, supplyCurrent: number): number {
  const e = omega / m.kv
  return (e + Math.sqrt(e * e + 4 * voltage * m.resistance * supplyCurrent)) / (2 * voltage)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/** Pool-adjacent-violators: the closest non-decreasing sequence (equal weights). */
export function monotone(values: readonly number[]): number[] {
  const blocks: { sum: number; n: number }[] = []
  for (const v of values) {
    blocks.push({ sum: v, n: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.n) {
      const b = blocks.pop()!
      blocks[blocks.length - 1]!.sum += b.sum
      blocks[blocks.length - 1]!.n += b.n
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.sum / b.n))
}

/**
 * The bench throttle map of a motor's test table: at each throttle step, the median of
 * d_eff/d over the rows (all props and voltages, minus `exclude`d labels' sizes), then
 * the monotone, bounded effective duty. Null without usable rows.
 */
export function benchThrottleMap(motor: Component, exclude: (label: string) => boolean = () => false): ThrottleMap | null {
  const e = motorElectrical(motor)
  const t = table(motor, 'thrustTable')
  if (!e.ok || !t) return null
  const steps = new Map<number, number[]>()
  const excluded = new Set<string>()
  let rows = 0
  for (const row of t.value.rows) {
    const label = typeof row.prop === 'string' ? row.prop : ''
    if (exclude(label)) {
      excluded.add(label)
      continue
    }
    const v = cell(t, row, 'voltage')
    const d = cell(t, row, 'throttle')
    const w = cell(t, row, 'rpm')
    const i = cell(t, row, 'current')
    if (v === null || d === null || w === null || i === null || v <= 0 || d <= 0 || w <= 0) continue
    const key = Math.round(d * 1e9) / 1e9
    steps.set(key, [...(steps.get(key) ?? []), rowDuty(e.value, v, w, i) / d])
    rows++
  }
  if (steps.size === 0) return null
  const throttles = [...steps.keys()].sort((a, b) => a - b)
  const raw = throttles.map((d) => median(steps.get(d)!) * d)
  const fitted = monotone(raw).map((x) => Math.min(1, Math.max(x, Number.MIN_VALUE)))
  return {
    points: throttles.map((throttle, i) => ({ throttle, effectiveDuty: fitted[i]! })),
    origin: 'bench',
    componentId: motor.id,
    excluded: [...excluded],
    rows,
    adjusted: fitted.some((x, i) => Math.abs(x - raw[i]!) > 1e-12),
  }
}

/**
 * Steady speed and currents at supply voltage `supplyV` (V_oc when `sourceResistance`
 * is the battery's R_int) and throttle d ∈ [0, 1], through `map` (ideal by default).
 */
export function steadyState(
  m: MotorElectrical,
  kQ: number,
  supplyV: number,
  throttle: number,
  sourceResistance = 0,
  map: ThrottleMap = IDEAL_MAP,
): SteadyState {
  const { duty: e, extrapolated } = effectiveDuty(map, throttle)
  const r = m.resistance + e * e * sourceResistance
  const vm0 = e * supplyV
  const a = r * kQ * m.kv
  const b = 1 / m.kv
  const c = vm0 - r * m.noLoadCurrent
  const out = (omega: number, motorCurrent: number): SteadyState => ({
    omega,
    motorCurrent,
    supplyCurrent: e * motorCurrent,
    motorVoltage: vm0 - e * e * sourceResistance * motorCurrent,
    effectiveDuty: e,
    extrapolated,
  })
  if (c <= 0) return out(0, r > 0 ? vm0 / r : 0)
  const omega = (2 * c) / (b + Math.sqrt(b * b + 4 * a * c))
  return out(omega, m.noLoadCurrent + (kQ * omega * omega) / m.kt)
}

// ---- Propeller data and fits -------------------------------------------------------------------

/** "T-MOTOR15*5CF" → 15 × 5; "10x4.5MR" → 10 × 4.5. Null when the label has no D × P. */
export function parsePropSize(label: string): { diameterIn: number; pitchIn: number } | null {
  const m = /(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)/.exec(label)
  return m ? { diameterIn: Number(m[1]), pitchIn: Number(m[2]) } : null
}

const INCH = 0.0254
const sameInches = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** Whether a test-table propeller label names this propeller component (see the header). */
export function labelMatchesProp(label: string, prop: Component, motor: Component): boolean {
  const size = parsePropSize(label)
  const d = si(prop, 'diameter')
  const p = si(prop, 'pitch')
  if (!size || d === null || p === null) return false
  const maker = normalise(prop.manufacturer)
  if (!maker || maker !== normalise(motor.manufacturer)) return false
  return sameInches(d / INCH, size.diameterIn) && sameInches(p / INCH, size.pitchIn)
}

export interface ValidationRow {
  /** Supply voltage, V. */
  voltage: number
  /** Throttle command, 0…1. */
  throttle: number
  /** Effective duty the model used. */
  effectiveDuty: number
  /** The throttle is outside the map's measured steps. */
  extrapolated: boolean
  rpm: { table: number; model: number; error: number }
  thrust: { table: number; model: number; error: number }
  current: { table: number; model: number; error: number }
  /** Electrical input power: the table's power column, and V·I_s of the model. */
  power: { table: number | null; model: number; error: number | null }
  /** (table power − V × table current) / (V × table current): the row's own consistency. */
  tablePowerConsistency: number | null
  /** I₀ / I_m at the model point. */
  noLoadShare: number
  /** The motor voltage is away from I₀'s stated test voltage (I₀ used outside its stated point). */
  noLoadOutsideStated: boolean
}

export interface DataOrigin {
  kind: 'motor-table' | 'prop-table'
  /** Component the table belongs to. */
  componentId: string
  /** The table's stated condition, shown verbatim (APC: computed at sea-level ISA). */
  condition: string | null
  reference: SpecReference | null
  /** Propeller names as printed in the motor table (motor-table only). */
  labels: string[]
}

/** Speed range a fit is supported over (rad/s), and how it was set. */
export interface FitDomain {
  minOmega: number
  maxOmega: number
  rowsUsed: number
  rowsTotal: number
  /** 'motor-speed': rows above the motor's no-load speed at the build's voltage were left out. */
  cappedBy: 'table' | 'motor-speed'
}

export interface Validation {
  rows: ValidationRow[]
  map: ThrottleMap
  /** The map came from other propellers' rows (independent of these rows). */
  mapIndependent: boolean
}

/**
 * The air density the pair's k_T and k_Q data was measured or computed at. A property of the data's source,
 * never assumed: a value entered or stated on the table's component (field `referenceDensity`, by the
 * source, a catalog fill or the user), else the one density the table's condition text names (APC's
 * "sea-level Standard Atmosphere, 1.225 kg/m³", cited from its FAQ in the seed), else missing.
 */
export interface ReferenceDensity {
  kgM3: number
  from: 'field' | 'condition'
  /** What the value comes from, to show with it: the component's name, or the condition text verbatim. */
  source: string
}

export interface PairFit {
  /** Null when no source states the density: it is then the user's entry for the table's component. */
  referenceDensity: ReferenceDensity | null
  origin: DataOrigin
  /** In-sample fit. */
  kT: SquareLawFit
  /** In-sample fit; null when the data has no torque or current. */
  kQ: SquareLawFit | null
  kQMethod: 'motor-current' | 'prop-torque'
  /** k_Q with the ideal duty e = d (the 4.5 "before" reference; motor-table only). */
  kQIdealDuty: SquareLawFit | null
  domain: FitDomain
  /** Throttle map the simulation should use with this pair (bench of the motor if it has a table). */
  map: ThrottleMap
  /** Leave-one-prop-out prediction of the test rows (motor-table only). */
  validation: Validation | null
  /** The same rows with the ideal ESC, e = d ("before"). */
  validationIdeal: ValidationRow[] | null
}

const rel = (model: number, table: number) => (model - table) / table
const RPM = (2 * Math.PI) / 60

/** Motor test-table rows for this propeller, in SI. */
function motorTableRows(motor: Component, prop: Component) {
  const t = table(motor, 'thrustTable')
  if (!t) return null
  const rows = t.value.rows.flatMap((row) => {
    const label = typeof row.prop === 'string' ? row.prop : ''
    if (!labelMatchesProp(label, prop, motor)) return []
    const omega = cell(t, row, 'rpm')
    const thrust = cell(t, row, 'thrust')
    if (omega === null || thrust === null) return []
    return [
      {
        label,
        omega,
        thrust,
        voltage: cell(t, row, 'voltage'),
        throttle: cell(t, row, 'throttle'),
        current: cell(t, row, 'current'),
        power: cell(t, row, 'power'),
      },
    ]
  })
  return rows.length > 0 ? { t, rows } : null
}

/** Static rows (no airspeed, or zero) of the propeller's performance table, in SI, by speed. */
function propTableRows(prop: Component) {
  const t = table(prop, 'performanceTable')
  if (!t) return null
  const rows = t.value.rows
    .flatMap((row) => {
      const airspeed = cell(t, row, 'airspeed')
      const omega = cell(t, row, 'rpm')
      const thrust = cell(t, row, 'thrust') ?? cell(t, row, 'thrustImperial')
      if ((airspeed !== null && airspeed !== 0) || omega === null || thrust === null) return []
      return [{ omega, thrust, torque: cell(t, row, 'torque') ?? cell(t, row, 'torqueImperial') }]
    })
    .sort((a, b) => a.omega - b.omega)
  return rows.length > 0 ? { t, rows } : null
}

/** The voltage a no-load current's condition states ("Idle current at 10 V" → 10), or null. */
export function statedTestVoltage(condition: string | null): number | null {
  const m = condition ? /(\d+(?:\.\d+)?)\s*V\b/.exec(condition) : null
  return m ? Number(m[1]) : null
}

type TableRow = NonNullable<ReturnType<typeof motorTableRows>>['rows'][number]

function validate(
  rows: TableRow[],
  m: MotorElectrical,
  kT: number,
  kQ: number,
  map: ThrottleMap,
): ValidationRow[] {
  const vTest = statedTestVoltage(m.noLoadCondition)
  return rows.flatMap((r) => {
    if (r.voltage === null || r.throttle === null || r.current === null) return []
    const s = steadyState(m, kQ, r.voltage, r.throttle, 0, map)
    const thrust = kT * s.omega ** 2
    const vi = r.voltage * r.current
    const modelPower = r.voltage * s.supplyCurrent
    return [
      {
        voltage: r.voltage,
        throttle: r.throttle,
        effectiveDuty: s.effectiveDuty,
        extrapolated: s.extrapolated,
        rpm: { table: r.omega / RPM, model: s.omega / RPM, error: rel(s.omega, r.omega) },
        thrust: { table: r.thrust, model: thrust, error: rel(thrust, r.thrust) },
        current: { table: r.current, model: s.supplyCurrent, error: rel(s.supplyCurrent, r.current) },
        power: { table: r.power, model: modelPower, error: r.power === null ? null : rel(modelPower, r.power) },
        tablePowerConsistency: r.power === null || vi === 0 ? null : (r.power - vi) / vi,
        noLoadShare: s.motorCurrent > 0 ? m.noLoadCurrent / s.motorCurrent : 1,
        noLoadOutsideStated: vTest === null || Math.abs(s.motorVoltage - vTest) > 0.05 * vTest,
      },
    ]
  })
}

/**
 * k_T and k_Q for a motor and propeller, from the best data available (header), with
 * the leave-one-prop-out validation against the motor's test rows. `supplyVoltage`
 * (the build's battery) bounds a propeller table's fit to reachable speeds. Null when
 * neither component has data for the pair: k_T is then a user input.
 */
export function fitPair(motor: Component, prop: Component, supplyVoltage: number | null = null): PairFit | null {
  const fit = fitPairData(motor, prop, supplyVoltage)
  if (!fit) return null
  const owner = fit.origin.kind === 'motor-table' ? motor : prop
  return { ...fit, referenceDensity: referenceDensity(fit.origin, owner) }
}

/** Densities named in a table condition, as in "1.225 kg/m³" or "1.2 kg/m3". */
const DENSITY_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*kg\s*\/\s*m(?:³|3)/gi

/** The reference density of a table: the owner component's field, else the single density its condition names. */
export function referenceDensity(origin: DataOrigin, owner: Component): ReferenceDensity | null {
  const stated = si(owner, 'referenceDensity')
  if (stated !== null && stated > 0) return { kgM3: stated, from: 'field', source: owner.name }
  const named = [...new Set([...(origin.condition ?? '').matchAll(DENSITY_IN_TEXT)].map((m) => Number(m[1]!.replace(',', '.'))))]
  if (named.length === 1 && named[0]! > 0) return { kgM3: named[0]!, from: 'condition', source: origin.condition! }
  return null
}

function fitPairData(motor: Component, prop: Component, supplyVoltage: number | null): Omit<PairFit, 'referenceDensity'> | null {
  const elec = motorElectrical(motor)
  const mt = motorTableRows(motor, prop)
  const motorMap = benchThrottleMap(motor) ?? IDEAL_MAP
  if (mt) {
    const kT = fitSquareLaw(mt.rows.map((r) => ({ omega: r.omega, y: r.thrust })))
    if (kT) {
      const torque = (duty: (r: TableRow) => number | null) =>
        elec.ok
          ? fitSquareLaw(
              mt.rows.map((r) => {
                const d = duty(r)
                return { omega: r.omega, y: r.current !== null && d ? elec.value.kt * (r.current / d - elec.value.noLoadCurrent) : 0 }
              }),
            )
          : null
      // Q = K_t (I_s/d_eff − I₀) with each row's own effective duty.
      const kQ = torque((r) => (elec.ok && r.voltage && r.current !== null ? rowDuty(elec.value, r.voltage, r.omega, r.current) : null))
      const kQIdealDuty = torque((r) => r.throttle)
      const sameSize = (label: string) => mt.rows.some((r) => r.label === label) || labelMatchesProp(label, prop, motor)
      const lopo = benchThrottleMap(motor, sameSize)
      const independent = !!lopo && lopo.rows > 0
      const map = independent ? lopo : motorMap
      const omegas = mt.rows.map((r) => r.omega)
      return {
        origin: {
          kind: 'motor-table',
          componentId: motor.id,
          condition: mt.t.condition ?? null,
          reference: mt.t.reference ?? null,
          labels: [...new Set(mt.rows.map((r) => r.label))],
        },
        kT,
        kQ,
        kQMethod: 'motor-current',
        kQIdealDuty,
        domain: { minOmega: Math.min(...omegas), maxOmega: Math.max(...omegas), rowsUsed: mt.rows.length, rowsTotal: mt.rows.length, cappedBy: 'table' },
        map: motorMap,
        validation: elec.ok && kQ ? { rows: validate(mt.rows, elec.value, kT.k, kQ.k, map), map, mapIndependent: independent } : null,
        validationIdeal: elec.ok && kQIdealDuty ? validate(mt.rows, elec.value, kT.k, kQIdealDuty.k, IDEAL_MAP) : null,
      }
    }
  }
  const pt = propTableRows(prop)
  if (pt) {
    // Reachable speeds: up to the motor's no-load speed K_v·V, plus the first row above it.
    const limit = elec.ok && supplyVoltage !== null && supplyVoltage > 0 ? elec.value.kv * supplyVoltage : null
    const firstAbove = limit === null ? -1 : pt.rows.findIndex((r) => r.omega > limit)
    const used = limit === null || firstAbove === -1 ? pt.rows : pt.rows.slice(0, firstAbove + 1)
    const kT = fitSquareLaw(used.map((r) => ({ omega: r.omega, y: r.thrust })))
    if (kT) {
      const kQ = fitSquareLaw(used.map((r) => ({ omega: r.omega, y: r.torque ?? 0 })))
      const omegas = used.map((r) => r.omega)
      return {
        origin: { kind: 'prop-table', componentId: prop.id, condition: pt.t.condition ?? null, reference: pt.t.reference ?? null, labels: [] },
        kT,
        kQ,
        kQMethod: 'prop-torque',
        kQIdealDuty: null,
        domain: {
          minOmega: Math.min(...omegas),
          maxOmega: Math.max(...omegas),
          rowsUsed: used.length,
          rowsTotal: pt.rows.length,
          cappedBy: used.length < pt.rows.length ? 'motor-speed' : 'table',
        },
        map: motorMap,
        validation: null,
        validationIdeal: null,
      }
    }
  }
  return null
}

/** Whether a speed lies outside the fit's supported domain (the result is then an estimate). */
export const outsideDomain = (fit: PairFit, omega: number) => omega < fit.domain.minOmega * (1 - 1e-9) || omega > fit.domain.maxOmega * (1 + 1e-9)

/**
 * k_T for the same propeller in every OTHER motor table of the library (same-maker size
 * match), for showing how far the tables agree. Display only: nothing is pooled.
 */
export function otherTablesKT(prop: Component, motor: Component, library: readonly Component[]): { motor: Component; kT: number; rows: number }[] {
  return library.flatMap((m) => {
    if (m.category !== 'motor' || m.id === motor.id) return []
    const rows = motorTableRows(m, prop)
    const f = rows ? fitSquareLaw(rows.rows.map((r) => ({ omega: r.omega, y: r.thrust }))) : null
    return f ? [{ motor: m, kT: f.k, rows: rows!.rows.length }] : []
  })
}

// ---- Inertia -----------------------------------------------------------------------------------------

/** Blade-as-rod propeller inertia about its axis, J = m R²/3 (header; same model as mass.ts). */
export const propInertia = (massKg: number, diameterM: number) => (massKg * (diameterM / 2) ** 2) / 3

export type RotorInertia =
  | { ok: true; value: number; from: 'stated' | 'time-constant' }
  | { ok: false; missing: 'rotorInertia' | 'electrical' }

/** Stated rotor inertia, or J = τ_m K_t²/R from the stated mechanical time constant. */
export function rotorInertia(motor: Component): RotorInertia {
  const j = si(motor, 'rotorInertia')
  if (j !== null && j > 0) return { ok: true, value: j, from: 'stated' }
  const tau = si(motor, 'mechanicalTimeConstant')
  if (tau !== null && tau > 0) {
    const e = motorElectrical(motor)
    if (!e.ok) return { ok: false, missing: 'electrical' }
    return { ok: true, value: (tau * e.value.kt ** 2) / e.value.resistance, from: 'time-constant' }
  }
  return { ok: false, missing: 'rotorInertia' }
}

// ---- Battery -----------------------------------------------------------------------------------------

export interface BatteryModel {
  /** Open-circuit voltage V_oc, V (stated nominal, constant: header). */
  openCircuitVoltage: number
  /** Internal resistance R_int, Ω. */
  internalResistance: number
  /** Capacity, C (coulombs). */
  capacity: number
}

export const BATTERY_KEYS = ['packVoltageNominal', 'internalResistance', 'capacity'] as const

export function batteryModel(c: Component): { ok: true; value: BatteryModel } | { ok: false; missing: string[] } {
  const series = c.specs.series && typeof c.specs.series.value === 'number' ? c.specs.series.value : null
  const cellV = si(c, 'cellVoltageNominal')
  const v = si(c, 'packVoltageNominal') ?? (series !== null && cellV !== null ? series * cellV : null)
  const r = si(c, 'internalResistance')
  const q = si(c, 'capacity')
  const missing = BATTERY_KEYS.filter((_, i) => {
    const x = [v, r, q][i]
    return x == null || x <= 0
  })
  if (missing.length > 0) return { ok: false, missing: [...missing] }
  return { ok: true, value: { openCircuitVoltage: v!, internalResistance: r!, capacity: q! } }
}

/** V = V_oc − I·R_int */
export const terminalVoltage = (b: BatteryModel, current: number) => b.openCircuitVoltage - current * b.internalResistance

// ---- Build-level analysis -------------------------------------------------------------------------------

/** One motor mount of the build, as the workshop sees it. */
export interface MotorSlot {
  /** The motor part (or the empty mount's id), as in the VehicleDefinition's motors. */
  partId: string
  name: string
  motor: { partId: string; name: string; component: Component | null } | null
  prop: { partId: string; name: string; component: Component | null } | null
}

export interface MotorPropulsion {
  slot: MotorSlot
  electrical: MotorElectrical | null
  fit: PairFit | null
  propInertia: number | null
  rotor: RotorInertia | null
}

/** `supplyVoltage`: the build battery's V_oc when known (bounds a propeller-table fit). */
export function analyseMotor(slot: MotorSlot, supplyVoltage: number | null = null): MotorPropulsion {
  const m = slot.motor?.component ?? null
  const p = slot.prop?.component ?? null
  const e = m ? motorElectrical(m) : null
  const mass = p ? si(p, 'mass') : null
  const dia = p ? si(p, 'diameter') : null
  return {
    slot,
    electrical: e?.ok ? e.value : null,
    fit: m && p ? fitPair(m, p, supplyVoltage) : null,
    propInertia: mass !== null && dia !== null && mass > 0 && dia > 0 ? propInertia(mass, dia) : null,
    rotor: m ? rotorInertia(m) : null,
  }
}

// ---- Ready-to-fly checklist ------------------------------------------------------------------------------

export type ReadyLink =
  | { to: 'frame-mass' }
  /** The body C_d field of `axis` (the first one missing). */
  | { to: 'body-drag'; axis: 'x' | 'y' | 'z' }
  | { to: 'part'; partId: string }
  | { to: 'component'; componentId: string; field: string }
  /** A field of the workshop's Environment section, by its element id (e.g. `ground-friction`, `obstacle-2-restitution`). */
  | { to: 'environment'; elementId: string }

export interface ReadyItem {
  /** Stable, unique: the same missing value on four motors is one item. */
  id: string
  /** What is missing, e.g. "Battery internal resistance". */
  label: string
  /** Which component or part, and why. */
  detail: string
  link: ReadyLink | null
  /**
   * For a component value: the parts it is missing on. The value can be entered once
   * in the library (catalog fill, every project) or on one of these parts (override).
   */
  parts?: { id: string; name: string }[]
}

export interface ReadyInput {
  frameMassSet: boolean
  /** Parts (not the frame) without a mass. */
  partsWithoutMass: { id: string; name: string }[]
  motors: readonly MotorSlot[]
  battery: { partId: string; name: string; component: Component | null } | null
  /** The build's body drag coefficient; null = not entered. */
  /** Body C_d per axis [x, y, z]; null = that axis not entered. */
  bodyCd: readonly [number | null, number | null, number | null]
  /**
   * Environment values still missing (`simEnvironment(doc.environment).missing`, from
   * `src/domain/environment.ts`): ground and obstacle friction and restitution.
   * `undefined` is a project without environment settings, so both ground values are missing.
   */
  environmentMissing?: readonly { field: string; message: string }[]
}

const FIELD_LABELS: Record<string, string> = {
  kv: 'KV',
  internalResistance: 'internal resistance',
  noLoadCurrent: 'no-load current',
  packVoltageNominal: 'nominal pack voltage',
  capacity: 'capacity',
}

/**
 * Everything the build still needs before it can fly, in a fixed order. Empty = ready.
 * Each item names one value and links to the field where it is entered.
 */
export function readyToFly(input: ReadyInput): ReadyItem[] {
  const items = new Map<string, ReadyItem>()
  const add = (item: ReadyItem) => {
    const had = items.get(item.id)
    if (!had) items.set(item.id, item)
    else if (item.parts) had.parts = [...(had.parts ?? []), ...item.parts.filter((p) => !had.parts?.some((q) => q.id === p.id))]
  }


  if (!input.frameMassSet) {
    add({
      id: 'frame-mass',
      label: 'Frame mass',
      detail: 'Weigh the frame, or enter its mass from a cited plate density × volume.',
      link: { to: 'frame-mass' },
    })
  }
  for (const p of input.partsWithoutMass) {
    add({ id: `part-mass:${p.id}`, label: `Mass of ${p.name}`, detail: 'Enter its mass, or link a library component that states one.', link: { to: 'part', partId: p.id } })
  }

  for (const slot of input.motors) {
    if (!slot.motor) {
      add({ id: `mount:${slot.partId}`, label: `Motor on ${slot.name}`, detail: 'This mount has no motor.', link: null })
      continue
    }
    const mc = slot.motor.component
    if (!mc) {
      add({
        id: `link:${slot.motor.partId}`,
        label: `Library motor for ${slot.motor.name}`,
        detail: 'Link a motor component: its KV, resistance and no-load current define the motor model.',
        link: { to: 'part', partId: slot.motor.partId },
      })
    } else {
      const e = motorElectrical(mc)
      if (!e.ok) {
        for (const key of e.missing) {
          add({
            id: `component:${mc.id}:${key}`,
            label: `Motor ${FIELD_LABELS[key] ?? key}`,
            detail: `${mc.name} states no ${FIELD_LABELS[key] ?? key}.`,
            link: { to: 'component', componentId: mc.id, field: key },
            parts: [{ id: slot.motor.partId, name: slot.motor.name }],
          })
        }
      }
      const r = rotorInertia(mc)
      if (!r.ok && r.missing === 'rotorInertia') {
        add({
          id: `component:${mc.id}:rotorInertia`,
          label: 'Motor rotor inertia',
          detail: `${mc.name} states no rotor inertia or mechanical time constant; enter one (measured or from the maker).`,
          link: { to: 'component', componentId: mc.id, field: 'rotorInertia' },
          parts: [{ id: slot.motor.partId, name: slot.motor.name }],
        })
      }
    }
    if (!slot.prop) {
      add({ id: `prop:${slot.motor.partId}`, label: `Propeller on ${slot.motor.name}`, detail: 'This motor has no propeller.', link: { to: 'part', partId: slot.motor.partId } })
      continue
    }
    const pc = slot.prop.component
    if (!pc) {
      add({
        id: `link:${slot.prop.partId}`,
        label: `Library propeller for ${slot.prop.name}`,
        detail: 'Link a propeller component: its data gives thrust and torque.',
        link: { to: 'part', partId: slot.prop.partId },
      })
      continue
    }
    if (si(pc, 'mass') === null) {
      add({ id: `component:${pc.id}:mass`, label: 'Propeller mass', detail: `${pc.name} states no mass (needed for its inertia).`, link: { to: 'component', componentId: pc.id, field: 'mass' }, parts: [{ id: slot.prop.partId, name: slot.prop.name }] })
    }
    if (si(pc, 'diameter') === null) {
      add({ id: `component:${pc.id}:diameter`, label: 'Propeller diameter', detail: `${pc.name} states no diameter.`, link: { to: 'component', componentId: pc.id, field: 'diameter' }, parts: [{ id: slot.prop.partId, name: slot.prop.name }] })
    }
    if (mc) {
      const fit = fitPair(mc, pc)
      if (!fit) {
        add({
          id: `pair:${mc.id}:${pc.id}`,
          label: `Thrust coefficient k_T for ${mc.name} + ${pc.name}`,
          detail: 'Neither the motor test table nor the propeller states data for this pair. Enter static test rows (speed, thrust, torque) in the propeller’s performance table.',
          link: { to: 'component', componentId: pc.id, field: 'performanceTable' },
        })
      } else if (!fit.kQ) {
        add({
          id: `pair-q:${mc.id}:${pc.id}`,
          label: `Torque coefficient k_Q for ${mc.name} + ${pc.name}`,
          detail:
            fit.origin.kind === 'motor-table'
              ? 'The test rows give no usable current (or the motor model is incomplete).'
              : 'The propeller’s performance table has no torque column.',
          link: { to: 'component', componentId: fit.origin.componentId, field: fit.origin.kind === 'motor-table' ? 'thrustTable' : 'performanceTable' },
        })
      }
      if (fit && !fit.referenceDensity) {
        const owner = fit.origin.kind === 'motor-table' ? mc : pc
        add({
          id: `reference-density:${fit.origin.componentId}`,
          label: `Air density of the ${fit.origin.kind === 'motor-table' ? 'test data' : 'performance data'} of ${owner.name}`,
          detail: `${owner.name}'s k_T and k_Q come from data taken at one air density, and its condition text names none. The flight scales thrust and torque by its own air density relative to it: state it from the source, or enter yours (for APC data it is 1.225 kg/m³).`,
          link: { to: 'component', componentId: fit.origin.componentId, field: 'referenceDensity' },
          parts: [{ id: slot.motor.partId, name: slot.motor.name }],
        })
      }
    }
  }

  if (!input.battery) {
    add({ id: 'battery', label: 'Battery', detail: 'The build has no battery.', link: null })
  } else if (!input.battery.component) {
    add({
      id: `link:${input.battery.partId}`,
      label: `Library battery for ${input.battery.name}`,
      detail: 'Link a battery component: its voltage, capacity and internal resistance define the pack.',
      link: { to: 'part', partId: input.battery.partId },
    })
  } else {
    const bc = input.battery.component
    const b = batteryModel(bc)
    if (!b.ok) {
      for (const key of b.missing) {
        add({
          id: `component:${bc.id}:${key}`,
          label: `Battery ${FIELD_LABELS[key] ?? key}`,
          detail: `${bc.name} states no ${FIELD_LABELS[key] ?? key}${key === 'internalResistance' ? ' (needed for the voltage sag V = V_oc − I·R_int)' : ''}.`,
          link: { to: 'component', componentId: bc.id, field: key },
          parts: [{ id: input.battery.partId, name: input.battery.name }],
        })
      }
    }
  }

  const axes = (['x', 'y', 'z'] as const).filter((_, i) => input.bodyCd[i] === null)
  if (axes.length > 0) {
    add({
      id: 'body-cd',
      label: `Body drag coefficient C_d (${axes.join(', ')})`,
      detail: 'No source states it for this build; enter it per axis (F = ½ ρ C_d A v|v|, A derived).',
      link: { to: 'body-drag', axis: axes[0]! },
    })
  }
  const envMissing = input.environmentMissing ?? [
    { field: 'ground.friction', message: 'Ground friction is not set.' },
    { field: 'ground.restitution', message: 'Ground restitution is not set.' },
  ]
  for (const m of envMissing) {
    // `ground.friction` → `ground-friction`; `obstacles[1].restitution` → `obstacle-2-restitution`
    // (the element ids of the Environment section's fields).
    const obstacle = m.field.match(/^obstacles\[(\d+)\]\.(\w+)$/)
    const elementId = obstacle ? `obstacle-${Number(obstacle[1]) + 1}-${obstacle[2]}` : m.field.replace('.', '-')
    const what = m.field.endsWith('friction') ? 'friction' : 'restitution'
    add({
      id: elementId,
      label: obstacle ? `Obstacle ${Number(obstacle[1]) + 1} ${what} coefficient` : `Ground ${what} coefficient`,
      detail: 'No source states it for a given surface; enter it under Environment.',
      link: { to: 'environment', elementId },
    })
  }
  return [...items.values()]
}

// ---- Engine definition (protocol, additive to vehicle.load) -----------------------------------------------

/**
 * Per-motor propulsion coefficients and the battery, sent with `vehicle.load` as the
 * optional `propulsion` structure (separate from the pinned VehicleDefinition).
 * SI units; `partId` matches a VehicleDefinition motor.
 */
export interface PropulsionDefinition {
  version: 1
  motors: {
    partId: string
    /** K_v, rad/(s·V); the engine derives K_t = 1/K_v. */
    kvRadPerSV: number
    resistanceOhm: number
    noLoadCurrentA: number
    /** k_T, N·s² (T = k_T ω²). */
    thrustCoefNs2: number
    /** k_Q, N·m·s² (Q = k_Q ω²). */
    torqueCoefNms2: number
    /** J_rotor + J_prop, kg·m². */
    inertiaKgM2: number
    /**
     * The air density (kg/m³) the k_T and k_Q data was measured or computed at (`ReferenceDensity`):
     * a flight scales both by its own air density relative to it, per motor.
     */
    referenceDensityKgM3: number
    /**
     * Throttle → effective duty pairs [d, e] (sorted, e non-decreasing, in (0, 1]); the
     * engine interpolates like `effectiveDuty`. Absent = ideal ESC (e = d).
     */
    throttleMap?: [number, number][]
  }[]
  battery: {
    openCircuitVoltageV: number
    internalResistanceOhm: number
    capacityC: number
  }
}

/** The engine definition, or null while anything it needs is missing (see `readyToFly`). */
export function propulsionDefinition(motors: readonly MotorPropulsion[], battery: Component | null): PropulsionDefinition | null {
  const b = battery ? batteryModel(battery) : null
  if (!b?.ok || motors.length === 0) return null
  const out: PropulsionDefinition['motors'] = []
  for (const m of motors) {
    if (!m.electrical || !m.fit?.kQ || !m.fit.referenceDensity || m.propInertia === null || !m.rotor?.ok || !m.slot.motor) return null
    out.push({
      partId: m.slot.partId,
      kvRadPerSV: m.electrical.kv,
      resistanceOhm: m.electrical.resistance,
      noLoadCurrentA: m.electrical.noLoadCurrent,
      thrustCoefNs2: m.fit.kT.k,
      torqueCoefNms2: m.fit.kQ.k,
      inertiaKgM2: m.rotor.value + m.propInertia,
      referenceDensityKgM3: m.fit.referenceDensity.kgM3,
      ...(m.fit.map.points.length > 0 ? { throttleMap: m.fit.map.points.map((x): [number, number] => [x.throttle, x.effectiveDuty]) } : {}),
    })
  }
  return {
    version: 1,
    motors: out,
    battery: {
      openCircuitVoltageV: b.value.openCircuitVoltage,
      internalResistanceOhm: b.value.internalResistance,
      capacityC: b.value.capacity,
    },
  }
}
