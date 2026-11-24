import { controllerParam, type TuningOverrides } from './controller-params'
import { steadyState, type MotorElectrical, type MotorPropulsion, type PropulsionDefinition, type ThrottleMap } from './propulsion'

export interface ThrustSample {
  throttle: number
  /** Thrust divided by thrust at FULL throttle, not the sampled range maximum. */
  relativeThrust: number
}

export interface ThrustCurveFit {
  factor: number
  unconstrainedFactor: number
  clamped: boolean
  /** Errors of the returned (bounded) factor, in relative thrust units. */
  rmsError: number
  maxAbsError: number
  sampleCount: number
}

/**
 * Equal-weight least squares for y = x + f(x²-x):
 * f = sum((x²-x)(y-x)) / sum((x²-x)²), bounded to THR_MDL_FAC's [0,1].
 * PX4 v1.13.3 src/lib/mixer_module/motor_params.c lines 58-73:
 * https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/src/lib/mixer_module/motor_params.c#L58-L73
 * Null when no interior throttle identifies the factor. Invalid data throws.
 */
export function fitThrustSamples(samples: readonly ThrustSample[]): ThrustCurveFit | null {
  let numerator = 0
  let denominator = 0
  for (const { throttle: x, relativeThrust: y } of samples) {
    if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0) {
      throw new RangeError('Expected throttle in [0,1] and finite nonnegative relative thrust')
    }
    const basis = x * x - x
    numerator += basis * (y - x)
    denominator += basis * basis
  }
  if (denominator === 0) return null
  const unconstrainedFactor = numerator / denominator
  const factor = Math.min(1, Math.max(0, unconstrainedFactor))
  return {
    factor,
    unconstrainedFactor,
    clamped: factor !== unconstrainedFactor,
    ...fitErrors(samples, factor),
    sampleCount: samples.length,
  }
}

function fitErrors(samples: readonly ThrustSample[], factor: number) {
  const errors = samples.map(({ throttle: x, relativeThrust: y }) => factor * x * x + (1 - factor) * x - y)
  return {
    rmsError: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
    maxAbsError: errors.reduce((max, e) => Math.max(max, Math.abs(e)), 0),
  }
}

export interface ThrustCurveInput {
  motor: MotorElectrical
  kQ: number
  map: ThrottleMap
  /** Explicit pack open-circuit voltage (e.g. nominal), held constant. */
  supplyVoltage: number
  /** Source resistance seen by this motor; pass 0 for fixed terminal voltage.
   * For N identical motors sharing a pack, use N * pack resistance. */
  sourceResistance: number
  throttleMin: number
  throttleMax: number
  /** Equally spaced samples including both range endpoints; at least 3. */
  sampleCount: number
}

export interface PropulsionThrustCurveFit extends ThrustCurveFit {
  supplyVoltage: number
  sourceResistance: number
  throttleMin: number
  throttleMax: number
  fullThrottleOmega: number
  /** Number of sampled throttles outside the bench map's measured range. */
  extrapolatedSamples: number
}

/** Fit to Phase 4.5's steady kT*omega² model, normalized at full throttle.
 * kT cancels in the ratio. Pack state and sampling choices are returned so the
 * caller can state the fit conditions. No store access or flight application.
 */
export function fitThrustCurve(input: ThrustCurveInput): PropulsionThrustCurveFit | null {
  const { motor, kQ, map, supplyVoltage, sourceResistance, throttleMin, throttleMax, sampleCount } = input
  if (![motor.kv, motor.kt, motor.resistance, supplyVoltage].every((v) => Number.isFinite(v) && v > 0)
    || ![motor.noLoadCurrent, kQ, sourceResistance].every((v) => Number.isFinite(v) && v >= 0)
    || !Number.isFinite(throttleMin) || !Number.isFinite(throttleMax)
    || throttleMin < 0 || throttleMax > 1 || throttleMin >= throttleMax
    || !Number.isInteger(sampleCount) || sampleCount < 3) {
    throw new RangeError('Invalid propulsion model, pack state or throttle sampling range')
  }
  if (map.points.some((p, i) => !Number.isFinite(p.throttle) || p.throttle <= 0 || p.throttle > 1
    || !Number.isFinite(p.effectiveDuty) || p.effectiveDuty <= 0 || p.effectiveDuty > 1
    || (i > 0 && (p.throttle <= map.points[i - 1]!.throttle || p.effectiveDuty < map.points[i - 1]!.effectiveDuty)))) {
    throw new RangeError('Invalid throttle map')
  }
  const solve = (throttle: number) => steadyState(motor, kQ, supplyVoltage, throttle, sourceResistance, map)
  const fullThrottleOmega = solve(1).omega
  if (!Number.isFinite(fullThrottleOmega) || fullThrottleOmega <= 0) return null
  let extrapolatedSamples = 0
  const samples = Array.from({ length: sampleCount }, (_, i) => {
    const throttle = throttleMin + (throttleMax - throttleMin) * i / (sampleCount - 1)
    const state = solve(throttle)
    if (state.extrapolated) extrapolatedSamples++
    return { throttle, relativeThrust: (state.omega / fullThrottleOmega) ** 2 }
  })
  const fit = fitThrustSamples(samples)
  return fit && { ...fit, supplyVoltage, sourceResistance, throttleMin, throttleMax, fullThrottleOmega, extrapolatedSamples }
}

export interface BuildThrustCurveFit extends ThrustCurveFit {
  samples: readonly ThrustSample[]
  supplyVoltage: number
  packResistance: number
  airDensityKgM3: number
}

/** One collective curve for the build, with all motors at equal throttle and
 * the nominal open-circuit voltage (propulsion.ts:700–713) subject to pack sag.
 * The 4.9 shared-voltage solve is in scenario/builtins.rs:21–51. */
export function fitBuildThrustCurve(
  motors: readonly MotorPropulsion[],
  battery: PropulsionDefinition['battery'],
  airDensityKgM3: number,
): BuildThrustCurveFit | null {
  const models = motors.flatMap(({ electrical, fit }) => {
    if (!electrical || !fit?.kQ || !fit.referenceDensity) return []
    const ratio = airDensityKgM3 / fit.referenceDensity.kgM3
    return [{ electrical, map: fit.map, kT: fit.kT.k * ratio, kQ: fit.kQ.k * ratio }]
  })
  if (models.length === 0 || models.length !== motors.length) return null
  const { openCircuitVoltageV: supplyVoltage, internalResistanceOhm: packResistance } = battery
  const solve = (throttle: number) => {
    let lo = 0
    let hi = supplyVoltage
    const statesAt = (voltage: number) => models.map(({ electrical, kQ, map }) => steadyState(electrical, kQ, voltage, throttle, 0, map))
    for (let i = 0; i < 80; i++) {
      const voltage = (lo + hi) / 2
      const current = statesAt(voltage).reduce((sum, state) => sum + state.supplyCurrent, 0)
      if (voltage + packResistance * current > supplyVoltage) hi = voltage
      else lo = voltage
    }
    return statesAt((lo + hi) / 2).reduce((sum, state, i) => sum + models[i]!.kT * state.omega ** 2, 0)
  }
  const fullThrust = solve(1)
  if (!Number.isFinite(fullThrust) || fullThrust <= 0) return null
  // 5.2's sampling grid (tests/unit/thrust-curve.test.ts:65–70), with the
  // throttle endpoints read from the cited PX4 controller reference.
  const min = controllerParam('MPC_THR_MIN')!.default
  const max = controllerParam('MPC_THR_MAX')!.default
  const sampleCount = 101
  const samples = Array.from({ length: sampleCount }, (_, i) => {
    const throttle = min + (max - min) * i / (sampleCount - 1)
    return { throttle, relativeThrust: solve(throttle) / fullThrust }
  })
  if (samples.some(({ relativeThrust }) => !Number.isFinite(relativeThrust) || relativeThrust < 0)) return null
  const fit = fitThrustSamples(samples)
  return fit && { ...fit, samples, supplyVoltage, packResistance, airDensityKgM3 }
}

export function thrustFactor(fit: BuildThrustCurveFit | null, saved?: TuningOverrides | null) {
  return saved?.THR_MDL_FAC ?? fit?.factor ?? controllerParam('THR_MDL_FAC')!.default
}

export function thrustFactorReadout(fit: BuildThrustCurveFit | null, saved: TuningOverrides): string {
  const factor = thrustFactor(fit, saved)
  const source = saved.THR_MDL_FAC !== undefined ? 'user override' : fit ? 'derived' : 'fit unavailable'
  const label = `THR_MDL_FAC ${factor.toPrecision(6)} (${source})`
  if (!fit) return `${label} · Fit error and pack state unavailable`
  const { rmsError, maxAbsError } = fitErrors(fit.samples, factor)
  return `${label} · Fit error ${(100 * rmsError).toPrecision(3)}% RMS, ${(100 * maxAbsError).toPrecision(3)}% max relative thrust · Nominal pack ${fit.supplyVoltage} V with sag (${fit.packResistance} Ω), ISA sea level`
}
