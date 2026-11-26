/**
 * The controller parameters a user may override (Phase 5.5, storage half): the table,
 * its validation and the effective values.
 *
 * Nothing numeric is typed here. The names, defaults, units, documented ranges and
 * citations come from the sets `px4`, `px4Position`, `px4Allocation`, `px4ThrustModel`,
 * `px4HoverThrust` and `returnPx4` of `database/reference/physics.v1.json`
 * (PX4-Autopilot v1.13.3), read the way `isaConstants` reads its set.
 *
 * Validation (plan decision D11):
 * - A parameter with a documented `@min` and/or `@max` is refused outside it.
 * - A side with no documented bound keeps the engine's existing check: the value must
 *   be finite, and the lower side must not be negative. No bound is invented.
 * - A parameter whose source definition is `PARAM_DEFINE_INT32` must be a whole number.
 * - Relations, checked on the effective values (defaults with the overrides applied):
 *   the ones of `Gains::validate` in `engine-core/src/controller.rs`
 *   (`0 < MPC_THR_HOVER`, `MPC_THR_MIN ≤ MPC_THR_HOVER ≤ MPC_THR_MAX ≤ 1`,
 *   `MC_YAW_WEIGHT ≤ 1`) and the one PX4 states in the doc comments of
 *   `MPC_LAND_ALT1`/`MPC_LAND_ALT2` (ALT1 higher than ALT2).
 *
 * Only overrides are stored (plan decision D9): the PX4 defaults stay in the table, so
 * the UI shows them beside every value and "reset" is an empty set.
 */

import physics from '../../database/reference/physics.v1.json'

interface RefReference {
  url: string
  locator: string
  retrieved: string
}
interface RefEntry {
  key: string
  value: number
  unit?: string
  min?: number
  max?: number
  condition?: string
  reference: RefReference
}
interface RefFile {
  sets: { id: string; values: RefEntry[] }[]
}

export type ControllerParamGroup =
  | 'attitude'
  | 'rate'
  | 'vertical'
  | 'position'
  | 'allocation'
  | 'thrustModel'
  | 'hoverEstimator'
  | 'return'

/** The groups in the order the UI lists them. */
export const CONTROLLER_PARAM_GROUPS: readonly { id: ControllerParamGroup; label: string }[] = [
  { id: 'attitude', label: 'Attitude' },
  { id: 'rate', label: 'Rate' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'position', label: 'Position' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'thrustModel', label: 'Thrust model' },
  { id: 'hoverEstimator', label: 'Hover estimator' },
  { id: 'return', label: 'Return' },
]

export interface ControllerParam {
  /** The exact PX4 parameter name. */
  name: string
  group: ControllerParamGroup
  /** The unit the source states (`@unit`); "1" is dimensionless; null when it states none. */
  unit: string | null
  /** The PX4 default. */
  default: number
  /** The documented `@min`, or null when PX4 states none. */
  min: number | null
  /** The documented `@max`, or null when PX4 states none. */
  max: number | null
  /** True when the source defines it as `PARAM_DEFINE_INT32`: only whole numbers are valid. */
  integer: boolean
  /** PX4's own description, as recorded in the reference data. */
  description: string
  /** The reference set the entry came from. */
  set: string
  /** Where the default (and any range) is cited. */
  source: RefReference
}

/** Parameter name → value. Only the parameters the user changed. */
export type TuningOverrides = Record<string, number>

export interface ParamError {
  /** The parameter the error is about; '' when the whole input is not an object. */
  name: string
  message: string
  /** For a relation: the other parameters it involves. */
  related?: string[]
}

export type ValidationResult = { ok: true } | { ok: false; errors: ParamError[] }

// Where the UI lists each parameter. The attitude loop is the angle gains and the rate
// limits; the rate loop is the rate PID and the acro scaling; the thrust limits and the
// hover thrust go with the vertical loop that uses them.
const ATTITUDE = ['MC_ROLL_P', 'MC_PITCH_P', 'MC_YAW_P', 'MC_YAW_WEIGHT', 'MC_ROLLRATE_MAX', 'MC_PITCHRATE_MAX', 'MC_YAWRATE_MAX']
const VERTICAL = [
  'MPC_Z_P',
  'MPC_Z_VEL_P_ACC',
  'MPC_Z_VEL_I_ACC',
  'MPC_Z_VEL_D_ACC',
  'MPC_THR_HOVER',
  'MPC_THR_MIN',
  'MPC_THR_MAX',
  'MPC_Z_VEL_MAX_UP',
  'MPC_Z_VEL_MAX_DN',
]
const HOVER_ESTIMATOR = ['MPC_USE_HTE']
const RATE = /^MC_(ROLLRATE|PITCHRATE|YAWRATE)_(P|I|D|FF|K)$|^MC_(RR|PR|YR)_INT_LIM$|^MC_ACRO_[RPY]_MAX$/

function groupOf(setId: string, name: string): ControllerParamGroup {
  if (setId === 'px4') {
    if (ATTITUDE.includes(name)) return 'attitude'
    if (VERTICAL.includes(name)) return 'vertical'
    if (HOVER_ESTIMATOR.includes(name)) return 'hoverEstimator'
    if (RATE.test(name)) return 'rate'
  }
  if (setId === 'px4Position') return 'position'
  if (setId === 'px4Allocation') return 'allocation'
  if (setId === 'px4ThrustModel') return 'thrustModel'
  if (setId === 'px4HoverThrust') return 'hoverEstimator'
  if (setId === 'returnPx4') return 'return'
  throw new Error(`The controller parameter ${name} (set ${setId}) has no group`)
}

/**
 * The parameter table from the cited controller and return sets, in file order.
 * Throws on a duplicate name or an entry with no group,
 * so a new reference entry cannot be added without deciding where it is listed.
 */
export function controllerParams(ref: RefFile): ControllerParam[] {
  const sets = ref.sets.filter((s) => /^px4/.test(s.id) || s.id === 'returnPx4')
  if (sets.length === 0) throw new Error('The reference data has no controller or return sets')
  const seen = new Set<string>()
  const out: ControllerParam[] = []
  for (const set of sets) {
    for (const e of set.values) {
      // engine-core/src/auto_modes.rs:125-130 fixes the heading mode.
      if (set.id === 'returnPx4' && e.key === 'RTL_HDG_MD') continue
      if (seen.has(e.key)) throw new Error(`The reference data lists ${e.key} twice`)
      seen.add(e.key)
      out.push({
        name: e.key,
        group: groupOf(set.id, e.key),
        unit: e.unit ?? null,
        default: e.value,
        min: e.min ?? null,
        max: e.max ?? null,
        integer: /PARAM_DEFINE_INT32/.test(e.reference.locator),
        description: e.condition ?? '',
        set: set.id,
        source: { url: e.reference.url, locator: e.reference.locator, retrieved: e.reference.retrieved },
      })
    }
  }
  return out
}

/** The table from the bundled reference data. */
export const CONTROLLER_PARAMS: readonly ControllerParam[] = controllerParams(physics as unknown as RefFile)

/** PX4 v1.13.3 sensor references, separate from the controller tuning table. */
export const SENSOR_FILTERS_PX4: readonly RefEntry[] =
  (physics as unknown as RefFile).sets.find(({ id }) => id === 'sensorFiltersPx4')!.values

const BY_NAME: ReadonlyMap<string, ControllerParam> = new Map(CONTROLLER_PARAMS.map((p) => [p.name, p]))

export const controllerParam = (name: string): ControllerParam | undefined => BY_NAME.get(name)

const unitSuffix = (p: ControllerParam) => (p.unit && p.unit !== '1' ? ` ${p.unit}` : '')

/** The error for one value against its own parameter, or null when it is valid. */
function checkValue(p: ControllerParam, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${p.name} must be a finite number`
  if (p.integer && !Number.isInteger(v)) return `${p.name} must be a whole number (PX4 defines it as an integer)`
  const u = unitSuffix(p)
  // A side with no documented bound: no upper limit; the lower limit is "not negative".
  if (p.min !== null && v < p.min) {
    return p.max !== null
      ? `${p.name} must be between ${p.min} and ${p.max}${u} (PX4's documented range); got ${v}`
      : `${p.name} must be at least ${p.min}${u} (PX4's documented minimum); got ${v}`
  }
  if (p.min === null && v < 0) return `${p.name} must not be negative (PX4 documents no minimum for it); got ${v}`
  if (p.max !== null && v > p.max) {
    return p.min !== null
      ? `${p.name} must be between ${p.min} and ${p.max}${u} (PX4's documented range); got ${v}`
      : `${p.name} must be at most ${p.max}${u} (PX4's documented maximum); got ${v}`
  }
  return null
}

interface Relation {
  /** Every parameter the relation reads. */
  members: string[]
  holds: (v: Record<string, number>) => boolean
  message: string
}

const RELATIONS: Relation[] = [
  // Gains::validate in engine-core/src/controller.rs.
  {
    members: ['MPC_THR_HOVER'],
    holds: (v) => v.MPC_THR_HOVER! > 0,
    message: 'MPC_THR_HOVER must be greater than 0',
  },
  {
    members: ['MPC_THR_MIN', 'MPC_THR_HOVER', 'MPC_THR_MAX'],
    holds: (v) => v.MPC_THR_MIN! <= v.MPC_THR_HOVER! && v.MPC_THR_HOVER! <= v.MPC_THR_MAX! && v.MPC_THR_MAX! <= 1,
    message: 'The thrust limits must satisfy MPC_THR_MIN ≤ MPC_THR_HOVER ≤ MPC_THR_MAX ≤ 1',
  },
  {
    members: ['MC_YAW_WEIGHT'],
    holds: (v) => v.MC_YAW_WEIGHT! <= 1,
    message: 'MC_YAW_WEIGHT must be at most 1 (PX4: a fraction [0,1])',
  },
  // The doc comments of MPC_LAND_ALT1 and MPC_LAND_ALT2 (PX4 v1.13.3).
  {
    members: ['MPC_LAND_ALT1', 'MPC_LAND_ALT2'],
    holds: (v) => v.MPC_LAND_ALT1! > v.MPC_LAND_ALT2!,
    message: 'MPC_LAND_ALT1 must be higher than MPC_LAND_ALT2 (PX4: "needs to be higher")',
  },
]

/** The PX4 defaults plus the overrides (names the table does not know are ignored). */
export function effectiveParams(overrides: TuningOverrides = {}): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of CONTROLLER_PARAMS) out[p.name] = p.default
  for (const [name, value] of Object.entries(overrides)) if (BY_NAME.has(name)) out[name] = value
  return out
}

/** The overrides after "reset to PX4 defaults": none. */
export const resetToDefaults = (): TuningOverrides => ({})

/** The overrides without one parameter (reset a single value). */
export function resetParam(overrides: TuningOverrides, name: string): TuningOverrides {
  return Object.fromEntries(Object.entries(overrides).filter(([n]) => n !== name))
}

/**
 * Checks a set of overrides: every name is a known PX4 parameter, every value is within
 * PX4's documented range, and the relations hold on the effective values. Returns every
 * error, each with the parameter it is about.
 */
export function validateOverrides(overrides: unknown): ValidationResult {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return { ok: false, errors: [{ name: '', message: 'The overrides must be an object of parameter names to numbers' }] }
  }
  const errors: ParamError[] = []
  const bad = new Set<string>()
  const entries = Object.entries(overrides as Record<string, unknown>)
  for (const [name, value] of entries) {
    const p = BY_NAME.get(name)
    if (!p) {
      errors.push({ name, message: `${name} is not a controller parameter this app knows` })
      bad.add(name)
      continue
    }
    const message = checkValue(p, value)
    if (message) {
      errors.push({ name, message })
      bad.add(name)
    }
  }
  // Relations read the effective values; one with a refused member is skipped, because the
  // member's own error is already reported.
  const good = Object.fromEntries(entries.filter(([n]) => !bad.has(n)))
  const eff = effectiveParams(good as TuningOverrides)
  for (const r of RELATIONS) {
    if (r.members.some((m) => bad.has(m))) continue
    const changed = r.members.filter((m) => m in good)
    if (changed.length === 0 || r.holds(eff)) continue
    const related = r.members.filter((m) => m !== changed[0])
    errors.push(related.length > 0 ? { name: changed[0]!, message: r.message, related } : { name: changed[0]!, message: r.message })
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
