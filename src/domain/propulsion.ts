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
 * - ESC, averaged and lossless (labelled assumption): the motor sees V_m = d·V for a
 *   throttle d ∈ [0, 1] of the supply voltage V; the power balance V·I_s = V_m·I_m
 *   gives the supply current I_s = d·I_m. Test tables state the supply current I_s
 *   (their power column is V × I_s), so a row's motor current is I_m = I_s / d.
 * - k_Q from a test-table row: in steady state the shaft torque equals the prop's
 *   drag torque, Q = K_t (I_s/d − I₀).
 *
 * Steady state (`steadyState`)
 * - V_m = ω/K_v + R·I_m and K_t (I_m − I₀) = k_Q ω². Eliminating I_m with K_t = 1/K_v:
 *     a ω² + b ω − c = 0,  a = R·k_Q·K_v,  b = 1/K_v,  c = V_m − R·I₀
 *   whose non-negative root is ω = 2c / (b + √(b² + 4ac)) (the cancellation-free form
 *   of (−b + √(b² + 4ac)) / 2a, valid for a = 0 too). For c ≤ 0 the motor does not
 *   turn (ω = 0).
 * - A source resistance R_s (battery internal resistance) in series with the ESC
 *   input: V = V_oc − R_s·I_s and I_s = d·I_m give V_m = d·V_oc − d²·R_s·I_m, i.e. the
 *   same equation with V_m = d·V_oc and R replaced by R + d²·R_s.
 * - Validation: the solved speed, thrust and supply current at each test-table row's
 *   voltage and throttle are compared with the row; the relative errors are reported.
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
  /** Voltage applied to the motor, d·V (after the source drop). */
  motorVoltage: number
}

/**
 * Steady speed and currents at supply voltage `supplyV` (V_oc when `sourceResistance`
 * is the battery's R_int) and throttle d ∈ [0, 1]. See the header for the derivation.
 */
export function steadyState(m: MotorElectrical, kQ: number, supplyV: number, throttle: number, sourceResistance = 0): SteadyState {
  const d = throttle
  const r = m.resistance + d * d * sourceResistance
  const vm0 = d * supplyV
  const a = r * kQ * m.kv
  const b = 1 / m.kv
  const c = vm0 - r * m.noLoadCurrent
  if (c <= 0) {
    const motorCurrent = r > 0 ? vm0 / r : 0
    return { omega: 0, motorCurrent, supplyCurrent: d * motorCurrent, motorVoltage: vm0 - d * d * sourceResistance * motorCurrent }
  }
  const omega = (2 * c) / (b + Math.sqrt(b * b + 4 * a * c))
  const motorCurrent = m.noLoadCurrent + (kQ * omega * omega) / m.kt
  return { omega, motorCurrent, supplyCurrent: d * motorCurrent, motorVoltage: vm0 - d * d * sourceResistance * motorCurrent }
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
  /** 0…1 */
  throttle: number
  rpm: { table: number; model: number; error: number }
  thrust: { table: number; model: number; error: number }
  current: { table: number; model: number; error: number }
}

export interface DataOrigin {
  kind: 'motor-table' | 'prop-table'
  /** Component the table belongs to. */
  componentId: string
  /** The table's stated condition, shown verbatim (APC: computed, not measured). */
  condition: string | null
  reference: SpecReference | null
  /** Propeller names as printed in the motor table (motor-table only). */
  labels: string[]
}

export interface PairFit {
  origin: DataOrigin
  kT: SquareLawFit
  /** null when the data has no torque or current. */
  kQ: SquareLawFit | null
  kQMethod: 'motor-current' | 'prop-torque'
  /** Steady-state solver against each test-table row (motor-table only; needs k_Q and the motor model). */
  validation: ValidationRow[] | null
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
    return [{ label, omega, thrust, voltage: cell(t, row, 'voltage'), throttle: cell(t, row, 'throttle'), current: cell(t, row, 'current') }]
  })
  return rows.length > 0 ? { t, rows } : null
}

/** Static rows (no airspeed, or zero) of the propeller's performance table, in SI. */
function propTableRows(prop: Component) {
  const t = table(prop, 'performanceTable')
  if (!t) return null
  const rows = t.value.rows.flatMap((row) => {
    const airspeed = cell(t, row, 'airspeed')
    const omega = cell(t, row, 'rpm')
    const thrust = cell(t, row, 'thrust') ?? cell(t, row, 'thrustImperial')
    if ((airspeed !== null && airspeed !== 0) || omega === null || thrust === null) return []
    return [{ omega, thrust, torque: cell(t, row, 'torque') ?? cell(t, row, 'torqueImperial') }]
  })
  return rows.length > 0 ? { t, rows } : null
}

/**
 * k_T and k_Q for a motor and propeller, from the best data available (header), with
 * the solver's validation against the motor's test rows. Null when neither component
 * has data for the pair: k_T is then a user input.
 */
export function fitPair(motor: Component, prop: Component): PairFit | null {
  const elec = motorElectrical(motor)
  const mt = motorTableRows(motor, prop)
  if (mt) {
    const kT = fitSquareLaw(mt.rows.map((r) => ({ omega: r.omega, y: r.thrust })))
    if (kT) {
      // Q = K_t (I_s/d − I₀) needs the motor model and the row's throttle and current.
      const kQ = elec.ok
        ? fitSquareLaw(
            mt.rows.map((r) => ({
              omega: r.omega,
              y: r.current !== null && r.throttle ? elec.value.kt * (r.current / r.throttle - elec.value.noLoadCurrent) : 0,
            })),
          )
        : null
      const validation =
        elec.ok && kQ
          ? mt.rows.flatMap((r) => {
              if (r.voltage === null || r.throttle === null || r.current === null) return []
              const s = steadyState(elec.value, kQ.k, r.voltage, r.throttle)
              const thrust = kT.k * s.omega ** 2
              return [
                {
                  voltage: r.voltage,
                  throttle: r.throttle,
                  rpm: { table: r.omega / RPM, model: s.omega / RPM, error: rel(s.omega, r.omega) },
                  thrust: { table: r.thrust, model: thrust, error: rel(thrust, r.thrust) },
                  current: { table: r.current, model: s.supplyCurrent, error: rel(s.supplyCurrent, r.current) },
                },
              ]
            })
          : null
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
        validation,
      }
    }
  }
  const pt = propTableRows(prop)
  if (pt) {
    const kT = fitSquareLaw(pt.rows.map((r) => ({ omega: r.omega, y: r.thrust })))
    if (kT) {
      const kQ = fitSquareLaw(pt.rows.map((r) => ({ omega: r.omega, y: r.torque ?? 0 })))
      return {
        origin: { kind: 'prop-table', componentId: prop.id, condition: pt.t.condition ?? null, reference: pt.t.reference ?? null, labels: [] },
        kT,
        kQ,
        kQMethod: 'prop-torque',
        validation: null,
      }
    }
  }
  return null
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

export function analyseMotor(slot: MotorSlot): MotorPropulsion {
  const m = slot.motor?.component ?? null
  const p = slot.prop?.component ?? null
  const e = m ? motorElectrical(m) : null
  const mass = p ? si(p, 'mass') : null
  const dia = p ? si(p, 'diameter') : null
  return {
    slot,
    electrical: e?.ok ? e.value : null,
    fit: m && p ? fitPair(m, p) : null,
    propInertia: mass !== null && dia !== null && mass > 0 && dia > 0 ? propInertia(mass, dia) : null,
    rotor: m ? rotorInertia(m) : null,
  }
}

// ---- Ready-to-fly checklist ------------------------------------------------------------------------------

export type ReadyLink =
  | { to: 'frame-mass' }
  | { to: 'body-drag' }
  | { to: 'part'; partId: string }
  | { to: 'component'; componentId: string; field: string }
  /** The environment settings (ground contact); null target until they exist in this build. */
  | { to: 'environment' }

export interface ReadyItem {
  /** Stable, unique: the same missing value on four motors is one item. */
  id: string
  /** What is missing, e.g. "Battery internal resistance". */
  label: string
  /** Which component or part, and why. */
  detail: string
  link: ReadyLink | null
}

export interface ReadyInput {
  frameMassSet: boolean
  /** Parts (not the frame) without a mass. */
  partsWithoutMass: { id: string; name: string }[]
  motors: readonly MotorSlot[]
  battery: { partId: string; name: string; component: Component | null } | null
  /** The build's body drag coefficient; null = not entered. */
  bodyCd: number | null
  /**
   * Ground contact settings. `undefined`: this build has no environment settings yet
   * (they come with 4.4), so they are listed as missing without a link.
   */
  ground?: { friction: number | null; restitution: number | null }
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
      add({ id: `component:${pc.id}:mass`, label: 'Propeller mass', detail: `${pc.name} states no mass (needed for its inertia).`, link: { to: 'component', componentId: pc.id, field: 'mass' } })
    }
    if (si(pc, 'diameter') === null) {
      add({ id: `component:${pc.id}:diameter`, label: 'Propeller diameter', detail: `${pc.name} states no diameter.`, link: { to: 'component', componentId: pc.id, field: 'diameter' } })
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
        })
      }
    }
  }

  if (input.bodyCd === null) {
    add({ id: 'body-cd', label: 'Body drag coefficient C_d', detail: 'No source states it for this build; enter it (F = ½ ρ C_d A v² per axis).', link: { to: 'body-drag' } })
  }
  const g = input.ground
  if (!g || g.friction === null) {
    add({
      id: 'ground-friction',
      label: 'Ground friction coefficient',
      detail: g ? 'Enter it in the environment settings.' : 'Set in the environment settings, which arrive with collisions (4.4).',
      link: g ? { to: 'environment' } : null,
    })
  }
  if (!g || g.restitution === null) {
    add({
      id: 'ground-restitution',
      label: 'Ground restitution coefficient',
      detail: g ? 'Enter it in the environment settings.' : 'Set in the environment settings, which arrive with collisions (4.4).',
      link: g ? { to: 'environment' } : null,
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
    if (!m.electrical || !m.fit?.kQ || m.propInertia === null || !m.rotor?.ok || !m.slot.motor) return null
    out.push({
      partId: m.slot.partId,
      kvRadPerSV: m.electrical.kv,
      resistanceOhm: m.electrical.resistance,
      noLoadCurrentA: m.electrical.noLoadCurrent,
      thrustCoefNs2: m.fit.kT.k,
      torqueCoefNms2: m.fit.kQ.k,
      inertiaKgM2: m.rotor.value + m.propInertia,
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
