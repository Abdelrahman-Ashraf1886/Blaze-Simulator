import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { Component } from '../../electron/ipc/component-fields'
import { fitPair } from '../../src/domain/propulsion'

const core = 'simulation-engine/engine-core/src'
const scenario = 'tests/unit/scenario-protocol.test.ts'
const propulsion = 'tests/unit/propulsion.test.ts'
const thrust = 'tests/unit/thrust-curve.test.ts'
type Locator = readonly [file: string, line: number]

function emit(model: string, [file, line]: Locator, metric: string, value: number, unit: string) {
  expect(Number.isFinite(value), metric).toBe(true)
  console.info('VALIDATION ' + JSON.stringify({ model, metric, value, unit, file, line }))
}

function transcript(name: string): string {
  const path = process.env['BLAZE_VALIDATION_' + name + '_LOG']
  if (!path) throw new Error('Run npm run validation-report to generate the input transcripts')
  return readFileSync(path, 'utf8')
}

function extract(output: string, pattern: RegExp): string[] {
  const match = pattern.exec(output)
  if (!match) throw new Error('Missing current-run output for ' + pattern.source)
  return match.slice(1)
}

function loggedJson<T>(output: string, prefix: string): T {
  const record = output.split(/\r?\n/).find((line) => line.startsWith(prefix))
  if (!record) throw new Error('Missing current-run output for ' + prefix)
  return JSON.parse(record.slice(prefix.length)) as T
}

it('emits the rigid-body errors and the printed K4 diagnostic as JSON', () => {
  const output = transcript('RUST')
  const rigid = 'Gravity, frame transforms and rigid-body integration'
  const [fall, fallBound] = extract(output, /free fall 1 s: .*mm?, \|error\| = (\S+) m, bound (\S+) m/)
  const [spin, spinBound] = extract(output, /spin-up 1 s: .*\|error\| = (\S+), bound (\S+)/)
  emit(rigid, [core + '/sim/tests.rs', 81], 'free-fall position absolute error', Number(fall), 'm')
  emit(rigid, [core + '/sim/tests.rs', 81], 'free-fall Euler term before roundoff allowance', Number(fallBound), 'm')
  emit(rigid, [core + '/sim/tests.rs', 127], 'spin-up absolute angle error', Number(spin), 'rad')
  emit(rigid, [core + '/sim/tests.rs', 127], 'spin-up Euler term before roundoff allowance', Number(spinBound), 'rad')

  const contact = 'Flat-box rebound'
  const source = [core + '/environment/spin_study.rs', 119] as const
  const [peak, box, pyramid, ideal] = extract(output, /SPIN default +corners .*?peak \|w\| e=0 (\S+) e=0\.5 \S+ \| rebound e=0\.5 brick (\S+) mm pyramid (\S+) mm \(expected (\S+)\)/)
  // spin_study.rs:119 prints both apexes to one decimal place.
  const shortfallMm = (measured: string) => Number((Number(ideal) - Number(measured)).toFixed(1))
  emit(contact, source, 'box rebound apex at e=0.5', Number(box), 'mm')
  emit(contact, source, 'box apex shortfall (from rounded diagnostic)', shortfallMm(box!), 'mm')
  emit(contact, source, 'box transient peak at e=0', Number(peak), 'rad/s')
  emit('Friction, single-point rebound and resting contact timing', source, 'diagnostic pyramid apex shortfall at e=0.5', shortfallMm(pyramid!), 'mm')

  const hover = 'Integrated hover, payload and trim scenarios'
  const hoverSource = [core + '/scenario/tests.rs', 134] as const
  const entries = [...output.matchAll(/(\w+): altitude error m, off (?:Some\(([^)]+)\)|None) on (?:Some\(([^)]+)\)|None); max attitude error deg, off (\S+) on ([^;]+);/g)]
  expect(entries.some(([, name]) => name === 'balanced_hover')).toBe(true)
  for (const [, name, off, on, offAttitude, onAttitude] of entries) {
    if (off !== undefined) emit(hover, hoverSource, name + ' final altitude error with estimator off', Number(off), 'm')
    if (on !== undefined) emit(hover, hoverSource, name + ' final altitude error with estimator on', Number(on), 'm')
    emit(hover, hoverSource, name + ' max attitude error with estimator off', Number(offAttitude), '°')
    emit(hover, hoverSource, name + ' max attitude error with estimator on', Number(onAttitude), '°')
  }

  const landing = 'Integrated takeoff/hold/land behavior'
  const landSource = [core + '/flight_loop/tests.rs', 355] as const
  const [holdXy, holdZ, landXy, landZ] = extract(output, /quad errors \[XY, Z\] m: hold=\[([^,]+), ([^\]]+)\], land=\[([^,]+), ([^\]]+)\]/)
  emit(landing, landSource, 'flat engine fixture hold XY error', Number(holdXy), 'm')
  emit(landing, landSource, 'flat engine fixture hold Z error', Number(holdZ), 'm')
  emit(landing, landSource, 'flat engine fixture resting XY error', Number(landXy), 'm')
  emit(landing, landSource, 'flat engine fixture resting Z error', Number(landZ), 'm')
})

it('emits the printed thrust-curve and closed-loop gyro measurements as JSON', () => {
  const output = transcript('UNIT')
  const fit = loggedJson<{ rmsError: number; maxAbsError: number; factor: number }>(
    output, 'MN3110 KV470 / P13*4.4, nominal 4S, four motors: ',
  )
  const build = 'Build thrust-curve fit and residual'
  emit(build, [thrust, 93], 'fitted factor', fit.factor, 'fraction')
  emit(build, [thrust, 93], 'RMS normalized thrust residual', fit.rmsError, 'fraction')
  emit(build, [thrust, 93], 'max absolute normalized thrust residual', fit.maxAbsError, 'fraction')

  const perfect = loggedJson<{ riseS: number; overshootPct: number }>(output, 'GYRO step, perfect state ')
  const gyro = loggedJson<typeof perfect & { nominal: { tiltRmsRad: number; rateRmsRadps: number } }>(output, 'GYRO catalogue ')
  const noisy = 'Noisy gyro closed-loop hover and roll-rate response'
  emit(noisy, [scenario, 843], 'perfect-state rise time', perfect.riseS, 's')
  emit(noisy, [scenario, 843], 'perfect-state overshoot', perfect.overshootPct, '%')
  emit(noisy, [scenario, 844], 'gyro rise time', gyro.riseS, 's')
  emit(noisy, [scenario, 844], 'gyro overshoot', gyro.overshootPct, '%')
  emit(noisy, [scenario, 844], 'nominal true tilt RMS', gyro.nominal.tiltRmsRad, 'rad')
  emit(noisy, [scenario, 844], 'nominal true rate RMS', gyro.nominal.rateRmsRadps, 'rad/s')
})

it('emits current-run wind, gust, terrain, landing and return measurements as JSON', () => {
  const output = transcript('ACCEPTANCE')
  interface Flight {
    type: string
    horizontalErrorM: number
    verticalErrorM: number
    tiltDeg: number
    expectedTiltDeg: number
    peakDisplacementM: number
    recoveryS: number
    holdHorizontalErrorM: number
    holdVerticalErrorM: number
    touchdownSpeedMps: number
    positionLimitM: number
    speedLimitMps: number
  }
  const reports = output.split(/\r?\n/).filter((line) => line.startsWith('ACCEPTANCE ')).map((line) =>
    JSON.parse(line.slice('ACCEPTANCE '.length)) as { name: string; passed: boolean; flight: Flight },
  )
  const primary = [scenario, 662] as const
  const wind = reports.find(({ flight }) => flight.type === 'windHold')!.flight
  const windModel = 'Constant mean velocity and drift'
  emit(windModel, primary, 'catalogue hold XY error', wind.horizontalErrorM, 'm')
  emit(windModel, primary, 'catalogue hold Z error', wind.verticalErrorM, 'm')
  emit(windModel, primary, 'catalogue tilt error versus force balance', Math.abs(wind.tiltDeg - wind.expectedTiltDeg), '°')
  const gust = reports.find(({ flight }) => flight.type === 'gust')!.flight
  const gustModel = 'Cosine ramp and convected distance'
  emit(gustModel, primary, 'catalogue peak drift', gust.peakDisplacementM, 'm')
  emit(gustModel, primary, 'catalogue recovery after full strength', gust.recoveryS, 's')

  const landing = (model: string, label: string, flight: Flight, source: Locator) => {
    emit(model, source, label + ' hold XY error', flight.holdHorizontalErrorM, 'm')
    emit(model, source, label + ' hold Z error', flight.holdVerticalErrorM, 'm')
    emit(model, source, label + ' touchdown speed', flight.touchdownSpeedMps, 'm/s')
    emit(model, source, label + ' hold position limit', flight.positionLimitM, 'm')
    emit(model, source, label + ' touchdown speed limit', flight.speedLimitMps, 'm/s')
  }
  const terrain = 'Integrated terrain landing'
  const steep = reports.find(({ name }) => name === 'terrain')!
  const gentle = loggedJson<{ passed: boolean; flight: Flight }>(output, 'GENTLE ')
  expect(steep.passed).toBe(false)
  expect(gentle.passed).toBe(true)
  landing(terrain, '45° (acceptance failed)', steep.flight, primary)
  landing(terrain, '5° (acceptance passed)', gentle.flight, [scenario, 670])
  landing('Integrated takeoff/hold/land behavior', 'flat catalogue fixture', reports.find(({ name }) => name === 'takeoff_hold_land')!.flight, primary)
  const [returnXy, returnZ] = extract(output, /RETURN landing errors \[XY, Z\] m: ([^,]+),([^\r\n]+)/)
  const rtl = 'Integrated return-to-start guidance'
  emit(rtl, [scenario, 733], 'landing XY error', Number(returnXy), 'm')
  emit(rtl, [scenario, 733], 'absolute landing Z error', Number(returnZ), 'm')
})

it('emits fresh in-sample and leave-one-prop-out fit residuals from the inventory bench fixtures', () => {
  // Component names and nominal capped APC voltage from propulsion.test.ts:37–50,335–338.
  const { components } = JSON.parse(readFileSync('database/seed/components.v1.json', 'utf8')) as { components: Component[] }
  const component = (name: string) => components.find((entry) => entry.name === name)!
  const kv470 = component('MN3110 KV470')
  const p13 = component('P13*4.4 CF propeller')
  const first = fitPair(kv470, p13)!
  emit('Static thrust fit, T-Motor source', [propulsion, 233], 'max absolute thrust residual', first.kT.maxAbsError, 'fraction')

  const torque = 'Torque inferred from motor current'
  emit(torque, [propulsion, 257], 'KV470 P13×4.4 ideal duty max absolute torque residual', first.kQIdealDuty!.maxAbsError, 'fraction')
  emit(torque, [propulsion, 258], 'KV470 P13×4.4 effective duty max absolute torque residual', first.kQ!.maxAbsError, 'fraction')

  const pairs = [
    [kv470, p13],
    [kv470, component('P15*5 CF propeller')],
    [component('MN3110 KV700'), p13],
  ] as const
  const bench = 'Bench effective duty map'
  for (const [motor, prop] of pairs) {
    const rows = fitPair(motor, prop)!.validation!.rows
    const full = rows.find(({ throttle }) => throttle === 1)!
    const label = motor.name + ' / ' + prop.name
    for (const key of ['rpm', 'thrust', 'current'] as const) {
      emit(bench, [propulsion, 305], label + ' max absolute ' + key + ' error', Math.max(...rows.map((row) => Math.abs(row[key].error))), 'fraction')
    }
    emit(bench, [propulsion, 305], label + ' full-throttle RPM signed error', full.rpm.error, 'fraction')
    emit(bench, [propulsion, 305], label + ' full-throttle thrust signed error', full.thrust.error, 'fraction')
  }

  const apc = 'APC fallback thrust/torque fit'
  const apcProp = component('10x4.5MR')
  for (const [label, fit] of [['whole table', fitPair(kv470, apcProp)!], ['capped', fitPair(kv470, apcProp, 14.8)!]] as const) {
    emit(apc, [propulsion, 324], label + ' max absolute thrust residual', fit.kT.maxAbsError, 'fraction')
    emit(apc, [propulsion, 324], label + ' max absolute torque residual', fit.kQ!.maxAbsError, 'fraction')
  }
})
