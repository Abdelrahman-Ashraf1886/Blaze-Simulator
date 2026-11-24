/**
 * 4.9 part B: the scenarios page's pure parts. The engine's report becomes the rows the page shows (each check with
 * its measured value, limit and verdict; the summary; what the scenario changed), the built-ins match the engine's,
 * and the engine request is built from the flight gate and the user's entries with nothing filled in.
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_SCENARIO_NAMES, type ScenarioReport } from '../../electron/main/engine/protocol'
import { NAV_ITEMS, isAvailable } from '../../src/app/nav'
import type { FlightGate } from '../../src/features/flight/readiness'
import { checkRows, END_REASONS, fmt, modificationRows, summaryRows } from '../../src/features/scenarios/report'
import { BUILTINS, missingEntry, NO_ENTRIES, scenarioRunInput } from '../../src/features/scenarios/scenarios'

const after = 19
const result = (check: ScenarioReport['checks'][number]['check'], measured: number | null, limits: [number, number], passed: boolean) => ({ check, measured, limits, passed, samples: measured === null ? 0 : 1000 })
const report = (over: Partial<ScenarioReport> = {}): ScenarioReport => ({
  name: 'balanced_hover', passed: true,
  checks: [
    result({ type: 'altitude', afterS: after, toleranceM: 0.02 }, 0.00123456, [0, 0.02], true),
    result({ type: 'attitude', afterS: after, maxDeg: 0.5730 }, 0.0021, [0, 0.573], true),
    result({ type: 'noSustainedSaturation', afterS: after, maxDurationS: 0.01 }, 0, [0, 0.01], true),
    result({ type: 'hoverThrottle', afterS: after, min: 0.5, max: 0.51 }, 0.5049, [0.5, 0.51], true),
  ],
  elapsedS: 20, maxAttitudeErrorDeg: 12.3456, finalAltitudeErrorM: -0.0004, meanThrottle: [0.5, 0.51], maxThrottle: [0.6, 0.62], firstThrottle: [0.5, 0.5],
  saturatedFraction: 0.0012, chargeUsedMah: 45.678, endReason: 'duration', finalStateHash: '0123456789abcdef', ...over,
})

describe('number formatting', () => {
  it('keeps four significant digits, drops trailing zeros and never shows an exponent that a plain number can carry', () => {
    expect(fmt(0)).toBe('0')
    expect(fmt(0.02)).toBe('0.02')
    expect(fmt(0.00123456)).toBe('0.001235')
    expect(fmt(1.3076000001)).toBe('1.308')
    expect(fmt(20)).toBe('20')
    expect(fmt(-0.0004)).toBe('-0.0004')
    expect(fmt(1234.5678)).toBe('1235')
    expect(fmt(1e-7)).toBe('1e-7')
  })
})

describe('check rows', () => {
  it('give each check its wording, measured value with unit, limit and verdict', () => {
    const rows = checkRows(report())
    expect(rows).toEqual([
      { label: 'Altitude error, largest after 19 s', measured: '0.001235 m', limit: 'at most 0.02 m', passed: true, reached: true },
      { label: 'Tilt error, largest after 19 s', measured: '0.0021°', limit: 'at most 0.573°', passed: true, reached: true },
      { label: 'Longest time with a motor command at its limit after 19 s', measured: '0 s', limit: 'at most 0.01 s', passed: true, reached: true },
      { label: 'Mean throttle after 19 s', measured: '50.49 %', limit: '50 to 51 %', passed: true, reached: true },
    ])
  })
  it('words every check kind, with the limit the engine reports', () => {
    const rows = checkRows(report({
      checks: [
        result({ type: 'saturationObserved', afterS: 0 }, 1, [1, 1], true),
        result({ type: 'attitudeLost', afterS: 0, aboveDeg: 30 }, 41.5, [30, 180], true),
        result({ type: 'cannotClimb', afterS: 1, minThrottle: 0.9 }, -0.2, [-1.7976931348623157e308, 0], true),
        result({ type: 'rateTrim', afterS: after, axis: 1, expected: 0.0123, tolerance: 0.001 }, 0.0125, [0.0113, 0.0133], true),
        result({ type: 'thrustBalance', afterS: after, weights: [1, -1], expectedN: 1.3076, toleranceN: 0.02 }, 1.3101, [1.2876, 1.3276], true),
      ],
    }))
    expect(rows.map((r) => [r.label, r.measured, r.limit])).toEqual([
      ['Motor command reached its limit after 0 s', 'yes', 'yes'],
      ['Tilt error, largest after 0 s', '41.5°', 'more than 30°'],
      ['Best climb rate with every motor at 90 % throttle or more, after 1 s', '-0.2 m/s', 'at most 0 m/s'],
      ['Rate controller trim, pitch axis, mean after 19 s', '0.0125', '0.0113 to 0.0133'],
      ['Weighted thrust balance, mean after 19 s', '1.31 N', '1.288 to 1.328 N'],
    ])
    expect(checkRows(report({ checks: [result({ type: 'saturationObserved', afterS: 0 }, 0, [1, 1], false)] }))[0]).toMatchObject({ measured: 'no', passed: false })
  })
  it('says why a check has no value and does not count it as passed', () => {
    const rows = checkRows(report({
      passed: false,
      checks: [
        result({ type: 'altitude', afterS: after, toleranceM: 0.02 }, null, [0, 0.02], false),
        result({ type: 'cannotClimb', afterS: 1, minThrottle: 0.9 }, null, [-1.7976931348623157e308, 0], false),
      ],
    }))
    expect(rows[0]).toMatchObject({ reached: false, passed: false, measured: 'none (no sample after 19 s: the run ended first)' })
    expect(rows[1]).toMatchObject({ reached: false, passed: false })
    expect(rows[1]!.measured).toContain('every motor at 90 %')
  })
})

describe('summary rows', () => {
  it('lists the run’s metrics with units, throttle per motor in percent, and the hash', () => {
    const rows = Object.fromEntries(summaryRows(report()).map((r) => [r.label, r.value]))
    expect(rows).toEqual({
      'Time flown': '20 s',
      'How it ended': END_REASONS.duration,
      'Largest tilt error': '12.35°',
      'Altitude error at the end': '-0.0004 m',
      'Mean throttle per motor': '50 / 51 %',
      'Largest throttle per motor': '60 / 62 %',
      'Time with a motor command at its limit': '0.12 %',
      'Charge used': '45.68 mAh',
      'Final state hash': '0123456789abcdef',
    })
  })
  it('names a cut-off and a missing altitude target', () => {
    const rows = Object.fromEntries(summaryRows(report({ endReason: 'voltageCutoff', finalAltitudeErrorM: null })).map((r) => [r.label, r.value]))
    expect(rows['How it ended']).toBe('Stopped at the battery voltage cut-off')
    expect(rows['Altitude error at the end']).toBe('no altitude target')
    expect(END_REASONS.chargeCutoff).toBe('Stopped at the battery charge cut-off')
  })
})

describe('what the scenario changed', () => {
  it('describes a payload and a part shift in grams and millimetres', () => {
    const scenario = {
      name: 'x', durationS: 1, script: [], checks: [],
      modifications: [
        { type: 'payload' as const, partId: 'scenario:payload', massKg: 0.5, positionM: [0, 0.001, -0.01] as [number, number, number], boxSizeM: null },
        { type: 'shiftPart' as const, partId: 'frame', deltaM: [0.0412, 0, 0] as [number, number, number] },
      ],
    }
    expect(modificationRows(scenario)).toEqual(['Added 500 g at (0, 1, -10) mm in the body frame.', 'Moved part frame by (41.2, 0, 0) mm.'])
  })
})

describe('the built-ins', () => {
  it('are the engine’s five, each once, with a plain description', () => {
    expect(BUILTINS.map((b) => b.name)).toEqual([...BUILTIN_SCENARIO_NAMES])
    for (const b of BUILTINS) {
      expect(b.title.length).toBeGreaterThan(3)
      expect(b.tests.length).toBeGreaterThan(60)
    }
  })
  it('ask for an entry only where the engine takes a parameter, and flag the two that pass by failing', () => {
    expect(Object.fromEntries(BUILTINS.map((b) => [b.name, b.entry]))).toEqual({
      balanced_hover: null, payload: 'payloadMassKg', overweight_payload: null, com_offset: 'comOffsetM', com_offset_beyond_authority: null,
    })
    expect(BUILTINS.filter((b) => b.expectsFailure).map((b) => b.name)).toEqual(['overweight_payload', 'com_offset_beyond_authority'])
  })
  it('say what is missing before an entered scenario can run', () => {
    const [hover, payload, , offset] = BUILTINS
    expect(missingEntry(hover!, NO_ENTRIES)).toBeNull()
    expect(missingEntry(payload!, NO_ENTRIES)).toMatch(/payload mass/)
    expect(missingEntry(payload!, { ...NO_ENTRIES, payloadMassKg: 0.5 })).toBeNull()
    expect(missingEntry(offset!, NO_ENTRIES)).toMatch(/offset/)
    expect(missingEntry(offset!, { ...NO_ENTRIES, comOffsetM: 0 })).toBeNull() // zero is an entry
  })
})

describe('the engine request', () => {
  const input = {
    vehicle: { v: 1 }, propulsion: { p: 1 }, aero: { a: 1 }, environment: { ground: null, obstacles: [] },
    airDensityKgM3: 1.1, cutoff: { type: 'voltageV' as const, value: 14.2 }, startPositionM: [0, 0, 0.1] as [number, number, number],
  }
  const ready: FlightGate = { ok: true, input, thrustFit: null }
  const blocked: FlightGate = { ok: false, blockers: [{ id: 'flight-cutoff', label: 'Battery cut-off', detail: '', link: null }] }
  const by = (name: string) => BUILTINS.find((b) => b.name === name)!

  it('sends flight conditions and the effective factor, including an explicit saved override', () => {
    expect(scenarioRunInput(ready, by('balanced_hover'), NO_ENTRIES)).toEqual({
      vehicle: input.vehicle, propulsion: input.propulsion, aero: input.aero,
      scenario: { type: 'builtin', name: 'balanced_hover' },
      config: { airDensityKgM3: 1.1, cutoff: { type: 'voltageV', value: 14.2 }, thrustModelFactor: 0 },
    })
    expect(scenarioRunInput(ready, by('balanced_hover'), NO_ENTRIES, { THR_MDL_FAC: 0.5 })?.config.thrustModelFactor).toBe(0.5)
  })
  it('carries the entered parameter of the scenario that takes one, and no other', () => {
    const entries = { payloadMassKg: 0.25, comOffsetM: 0.02 }
    expect(scenarioRunInput(ready, by('payload'), entries)?.scenario).toEqual({ type: 'builtin', name: 'payload', massKg: 0.25 })
    expect(scenarioRunInput(ready, by('com_offset'), entries)?.scenario).toEqual({ type: 'builtin', name: 'com_offset', offsetM: 0.02 })
    expect(scenarioRunInput(ready, by('overweight_payload'), entries)?.scenario).toEqual({ type: 'builtin', name: 'overweight_payload' })
  })
  it('is none while the build or the conditions are not ready, or an entry is missing', () => {
    expect(scenarioRunInput(blocked, by('balanced_hover'), NO_ENTRIES)).toBeNull()
    expect(scenarioRunInput(ready, by('payload'), NO_ENTRIES)).toBeNull()
    expect(scenarioRunInput(ready, by('com_offset'), { ...NO_ENTRIES, payloadMassKg: 1 })).toBeNull()
  })
})

describe('the navigation', () => {
  it('lists the scenarios page under Flight, available now', () => {
    const item = NAV_ITEMS.find((n) => n.path === '/scenarios')
    expect(item).toMatchObject({ label: 'Scenarios', group: 'flight' })
    expect(isAvailable(item!)).toBe(true)
  })
})
