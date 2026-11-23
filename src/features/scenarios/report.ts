/**
 * The engine's scenario report (engine-core `scenario.rs`, camelCase) as the rows the page shows: each check with
 * its measured value, its limit and its verdict, the run's summary metrics, and what the scenario changed on the
 * build. Conversions and wording only; every number is the engine's.
 */
import type { Scenario, ScenarioCheck, ScenarioReport } from '../../../electron/main/engine/protocol'

/** Four significant digits without trailing zeros or an exponent where one is not needed. */
export function fmt(v: number, digits = 4): string {
  if (v === 0) return '0'
  const s = v.toPrecision(digits)
  if (s.includes('e')) return String(Number(s))
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

const AXES = ['roll', 'pitch', 'yaw'] as const
const percent = (v: number) => `${fmt(v * 100)} %`
const range = (lo: number, hi: number, unit: string) => `${fmt(lo)} to ${fmt(hi)}${unit}`

export interface CheckRow {
  /** Plain wording of what is measured and when. */
  label: string
  /** The measured value with its unit, or why there is none. */
  measured: string
  /** What the value must be. */
  limit: string
  passed: boolean
  /** False when the check's observation window was never reached (no value). */
  reached: boolean
}

type Described = { label: string; measure: (v: number) => string; limit: (limits: readonly [number, number]) => string; unreached: string }

function describe(check: ScenarioCheck): Described {
  const after = `after ${fmt(check.afterS)} s`
  const window = `no sample ${after}: the run ended first`
  switch (check.type) {
    case 'altitude':
      return { label: `Altitude error, largest ${after}`, measure: (v) => `${fmt(v)} m`, limit: ([, hi]) => `at most ${fmt(hi)} m`, unreached: window }
    case 'attitude':
      return { label: `Tilt error, largest ${after}`, measure: (v) => `${fmt(v)}°`, limit: ([, hi]) => `at most ${fmt(hi)}°`, unreached: window }
    case 'noSustainedSaturation':
      return {
        label: `Longest time with a motor command at its limit ${after}`,
        measure: (v) => `${fmt(v)} s`,
        limit: ([, hi]) => `at most ${fmt(hi)} s`,
        unreached: window,
      }
    case 'saturationObserved':
      return { label: `Motor command reached its limit ${after}`, measure: (v) => (v >= 1 ? 'yes' : 'no'), limit: () => 'yes', unreached: window }
    case 'attitudeLost':
      return { label: `Tilt error, largest ${after}`, measure: (v) => `${fmt(v)}°`, limit: ([lo]) => `more than ${fmt(lo)}°`, unreached: window }
    case 'cannotClimb':
      return {
        label: `Best climb rate with every motor at ${percent(check.minThrottle)} throttle or more, ${after}`,
        measure: (v) => `${fmt(v)} m/s`,
        limit: ([, hi]) => `at most ${fmt(hi)} m/s`,
        unreached: `no sample ${after} had every motor at ${percent(check.minThrottle)} or more`,
      }
    case 'hoverThrottle':
      return {
        label: `Mean throttle ${after}`,
        measure: (v) => percent(v),
        limit: ([lo, hi]) => range(lo * 100, hi * 100, ' %'),
        unreached: window,
      }
    case 'rateTrim':
      return {
        label: `Rate controller trim, ${AXES[check.axis]} axis, mean ${after}`,
        measure: (v) => fmt(v),
        limit: ([lo, hi]) => range(lo, hi, ''),
        unreached: window,
      }
    case 'thrustBalance':
      return {
        label: `Weighted thrust balance, mean ${after}`,
        measure: (v) => `${fmt(v)} N`,
        limit: ([lo, hi]) => range(lo, hi, ' N'),
        unreached: window,
      }
  }
}

export function checkRows(report: ScenarioReport): CheckRow[] {
  return report.checks.map((r) => {
    const d = describe(r.check)
    const reached = r.measured !== null
    return { label: d.label, measured: reached ? d.measure(r.measured!) : `none (${d.unreached})`, limit: d.limit(r.limits), passed: r.passed, reached }
  })
}

export const END_REASONS: Record<ScenarioReport['endReason'], string> = {
  duration: 'Flew the full duration',
  voltageCutoff: 'Stopped at the battery voltage cut-off',
  chargeCutoff: 'Stopped at the battery charge cut-off',
}

export interface SummaryRow {
  label: string
  value: string
}

export function summaryRows(report: ScenarioReport): SummaryRow[] {
  const perMotor = (values: readonly number[]) => values.map((v) => fmt(v * 100)).join(' / ') + ' %'
  return [
    { label: 'Time flown', value: `${fmt(report.elapsedS)} s` },
    { label: 'How it ended', value: END_REASONS[report.endReason] },
    { label: 'Largest tilt error', value: `${fmt(report.maxAttitudeErrorDeg)}°` },
    { label: 'Altitude error at the end', value: report.finalAltitudeErrorM === null ? 'no altitude target' : `${fmt(report.finalAltitudeErrorM)} m` },
    { label: 'Mean throttle per motor', value: perMotor(report.meanThrottle) },
    { label: 'Largest throttle per motor', value: perMotor(report.maxThrottle) },
    { label: 'Time with a motor command at its limit', value: percent(report.saturatedFraction) },
    { label: 'Charge used', value: `${fmt(report.chargeUsedMah)} mAh` },
    { label: 'Final state hash', value: report.finalStateHash },
  ]
}

const mm = (v: number) => fmt(v * 1000)

/** What the scenario changed on the build, in plain words (derived values included). */
export function modificationRows(scenario: Scenario): string[] {
  return scenario.modifications.map((m) =>
    m.type === 'payload'
      ? `Added ${fmt(m.massKg * 1000)} g at (${m.positionM.map(mm).join(', ')}) mm in the body frame.`
      : `Moved part ${m.partId} by (${m.deltaM.map(mm).join(', ')}) mm.`,
  )
}
