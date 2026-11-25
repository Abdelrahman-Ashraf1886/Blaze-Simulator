import { z } from 'zod'
import {
  EnvironmentSchema, FlightSessionStartParamsSchema, ScenarioRequestSchema, SensorsSchema,
  StepTestRunParamsSchema, WindSchema,
} from '../../../../electron/main/engine/protocol'
import type { ReportData } from './report-data'
import { Facts, quantity, reportNumber, vector, type Fact } from './ReportFacts'

type Recorded = ReportData['recorded']
type Sensors = z.infer<typeof SensorsSchema>
const { cutoff, groundEffect, startPositionM, startClearanceM } = FlightSessionStartParamsSchema.shape
const missing = 'Missing from request'

function environmentFacts(recorded: Recorded): Fact[] {
  const value = recorded.environment
  // scenario_run.rs:201–214,384–409 and step_test.rs:264–278 select free space without an environment.
  if (value === undefined && recorded.requestKind !== 'flight') return [['Environment', 'Free space']]
  const environment = EnvironmentSchema.safeParse(value).data
  // engine.rs:462–473 requires an environment for live sessions.
  if (!environment) return [['Environment', value === undefined ? missing : value]]
  const { ground, terrain, obstacles } = environment
  const surface = terrain ?? ground
  return [
    ['Ground', terrain ? 'Terrain' : ground ? 'Plane' : 'None'],
    ...(surface ? [['Ground friction', surface.friction], ['Ground restitution', surface.restitution]] satisfies Fact[] : []),
    ['Obstacles', obstacles.length],
    // protocol.ts:114–124 and environment.rs:240–245 describe the sample grid.
    ['Terrain size', terrain ? reportNumber((terrain.columns - 1) * terrain.cellSizeM) + ' × ' +
      quantity((terrain.rows - 1) * terrain.cellSizeM, 'm') + ' sampled extent (' + terrain.columns + ' × ' +
      terrain.rows + ' samples, ' + quantity(terrain.cellSizeM, 'm') + ' spacing)' : 'None'],
  ]
}

function windFacts(value: unknown): Fact[] {
  // flight_environment.rs:23–40 leaves omitted/null wind off. wind.rs:166–199
  // leaves an omitted/null turbulence input off, with null mean or gust off too.
  if (value == null) return [['Wind', 'None']]
  const wind = WindSchema.safeParse(value).data
  if (!wind) return [['Wind', value]]
  const { mean, gust, turbulence } = wind
  const roughness = mean?.kind === 'shear' ? mean.roughness : undefined
  const roughnessLabel = roughness?.kind === 'custom' ? quantity(roughness.lengthM, 'm')
    : roughness?.kind === 'categoryC' ? 'Category C' : 'Other flight phases'
  return [
    ['Wind direction', 'From ' + reportNumber(wind.fromDeg) + '° clockwise from world +X'],
    ['Mean wind', mean?.kind === 'constant' ? quantity(mean.speedMps, 'm/s') + ' (constant)'
      : mean?.kind === 'shear' ? quantity(mean.speedAt20FtMps, 'm/s') + ' at 20 ft (shear, roughness ' + roughnessLabel + ')'
        : 'None'],
    ['Gust', gust ? quantity(gust.amplitudeMps, 'm/s') + ', length ' +
      quantity(gust.lengthM, 'm') + ', starts at ' + quantity(gust.startS, 's') : 'None'],
    ['Turbulence', turbulence ? 'Dryden, seed ' + turbulence.seed : 'None'],
  ]
}

function runFacts(recorded: Recorded): Fact[] {
  if (recorded.requestKind === 'scenario') {
    const scenario = ScenarioRequestSchema.safeParse(recorded.scenarioRequest).data
    if (!scenario) return [['Scenario request', recorded.scenarioRequest ?? missing]]
    return scenario.type === 'builtin' ? [
      ['Scenario', scenario.name.replaceAll('_', ' ')],
      ...(scenario.massKg === undefined ? [] : [['Added payload', quantity(scenario.massKg, 'kg')]] satisfies Fact[]),
      ...(scenario.offsetM === undefined ? [] : [['Centre of mass offset', quantity(scenario.offsetM, 'm')]] satisfies Fact[]),
    ] : [
      ['Scenario', scenario.scenario.name], ['Requested duration', quantity(scenario.scenario.durationS, 's')],
      ['Build modifications', scenario.scenario.modifications.length], ['Acceptance checks', scenario.scenario.checks.length],
    ]
  }
  if (recorded.requestKind === 'step-test') {
    const test = StepTestRunParamsSchema.shape.test.safeParse(recorded.test).data
    if (!test) return [['Step test request', recorded.test ?? missing]]
    const { step } = test
    const amplitude = step.type === 'rate' ? quantity(step.amplitudeRadps, 'rad/s')
      : step.type === 'attitude' ? quantity(step.amplitudeRad, 'rad') : quantity(step.amplitudeM, 'm')
    return [
      ['Step test', step.type + ('axis' in step ? ' (' + step.axis + ')' : '')],
      ['Step amplitude', amplitude], ['Pre-step hold', quantity(test.holdS, 's')],
      ['Requested duration', quantity(test.durationS, 's')], ['Sample stride', quantity(test.decimationSteps, 'steps')],
    ]
  }
  return []
}

export function ReportConditions({ recorded }: { recorded: Recorded }) {
  const { config } = recorded
  if (!config) return <Facts rows={[['Conditions', recorded.startLine || undefined]]} />
  const threshold = cutoff.safeParse(config.cutoff).data
  const radii = groundEffect.safeParse(config.groundEffect).data
  const position = startPositionM.safeParse(config.startPositionM).data
  const clearance = startClearanceM.safeParse(config.startClearanceM).data
  // flight.rs:114–118,606–607 uses pack terminal voltage or charge used since start.
  const cutoffLabel = threshold?.type === 'voltageV' ? quantity(threshold.value, 'V') + ' per pack (voltage)'
    : threshold?.type === 'chargeMah' ? quantity(threshold.value, 'mAh') + ' used from pack (charge)'
      : config.cutoff === undefined ? missing : config.cutoff
  // flight_session.rs:264–265 uses world origin if omitted. scenario_run.rs:204–214,
  // 389–409, scenario.rs:492 and sim.rs:92–105 use free-space origin without an
  // environment. Step tests use hover trim at the origin (step_test.rs:275–279).
  const omittedPosition = recorded.requestKind === 'step-test' ? '(0, 0, 0) m (hover start)'
    : recorded.requestKind === 'scenario' && recorded.environment !== undefined ? missing : '(0, 0, 0) m (world origin)'
  return <>
    <Facts rows={[
      ['Air density', typeof config.airDensityKgM3 === 'number' ? quantity(config.airDensityKgM3, 'kg/m³')
        : config.airDensityKgM3 === undefined ? missing : config.airDensityKgM3],
      ['Battery cut-off', cutoffLabel],
      ...environmentFacts(recorded),
      ['Requested start position', position ? vector(position, 'm') : config.startPositionM === undefined ? omittedPosition : config.startPositionM],
      ['Start clearance', clearance === undefined ? config.startClearanceM ?? 'None' : quantity(clearance, 'm')],
      ...windFacts(config.wind),
      // flight_session.rs:72 and flight_environment.rs:33–40 leave omitted/null ground effect off.
      ['Ground effect', radii ? 'Rotor radii ' + vector(radii, 'm') : config.groundEffect ?? 'None'],
      ...runFacts(recorded),
    ]} />
    <SensorFacts value={recorded.sensors} />
  </>
}

function sensorSetting(value: number | number[] | null, unit: string, off = 'None') {
  return value === null ? off : Array.isArray(value) ? vector(value, unit) : quantity(value, unit)
}

function imuFacts(sensor: NonNullable<Sensors['gyro']>, unit: string) {
  // sensor_request.rs:76–84,126–139 maps null terms to zero or no range limit.
  // domain/sensors.ts:176–185 supplies the units for each IMU setting.
  return [
    'Noise σ ' + sensorSetting(sensor.noiseSigma, unit),
    'Vibration σ ' + sensorSetting(sensor.vibrationSigma, unit),
    'Bias ' + sensorSetting(sensor.bias, unit),
    'Random walk ' + sensorSetting(sensor.randomWalk, unit + '/√s'),
    'Delay ' + sensorSetting(sensor.delaySteps, 'steps'),
    'Range ' + sensorSetting(sensor.range, unit, 'Unlimited'),
  ].join(' · ')
}

function SensorFacts({ value }: { value: unknown }) {
  // sensor_request.rs:12–25,47–55,111–116 treats omitted/null sensors or
  // gyro feedback as off. Each individual sensor group is nullable.
  const sensors = SensorsSchema.safeParse(value).data
  if (!sensors) return <Facts rows={[['Sensors', value ?? 'None']]} />
  const { gyro, accelerometer, barometer, gps, flyOnGyro } = sensors
  if (!gyro && !accelerometer && !barometer && !gps) return <Facts rows={[['Sensors', 'None']]} />
  const rows: Fact[] = [['Sensor seed', String(sensors.seed)]]
  if (gyro) rows.push(['Gyroscope', imuFacts(gyro, 'rad/s')])
  if (accelerometer) rows.push(['Accelerometer', imuFacts(accelerometer, 'm/s²') +
    ' · Mount position ' + vector(accelerometer.mountPositionM, 'm')])
  if (barometer) rows.push(['Barometer', [
    'Pressure noise σ ' + sensorSetting(barometer.sigmaPa, 'Pa'), 'Pressure bias ' + sensorSetting(barometer.biasPa, 'Pa'),
    'Period ' + quantity(barometer.periodSteps, 'steps'), 'Delay ' + sensorSetting(barometer.delaySteps, 'steps'),
    'Reference altitude ' + quantity(barometer.referenceAltitudeM, 'm'),
    'Reference temperature ' + sensorSetting(barometer.referenceTemperatureK, 'K', 'Standard atmosphere'),
  ].join(' · ')])
  if (gps) rows.push(['GPS', [
    'Horizontal position σ ' + sensorSetting(gps.positionSigmaHorizontalM, 'm'),
    'Vertical position σ ' + sensorSetting(gps.positionSigmaVerticalM, 'm'),
    'Velocity σ ' + sensorSetting(gps.velocitySigmaMps, 'm/s'),
    'Period ' + quantity(gps.periodSteps, 'steps'), 'Delay ' + sensorSetting(gps.delaySteps, 'steps'),
  ].join(' · ')])
  if (flyOnGyro) {
    const notch = (filter: typeof flyOnGyro.notch0) => filter
      ? quantity(filter.frequencyHz, 'Hz') + ' centre, ' + quantity(filter.bandwidthHz, 'Hz') + ' bandwidth' : 'None'
    rows.push(['Gyroscope filters', [
      'Rate low-pass ' + quantity(flyOnGyro.gyroCutoffHz, 'Hz'),
      'Rate derivative low-pass ' + quantity(flyOnGyro.dgyroCutoffHz, 'Hz'),
      'Notch 0 ' + notch(flyOnGyro.notch0), 'Notch 1 ' + notch(flyOnGyro.notch1),
    ].join(' · ')])
  }
  return <Facts rows={rows} />
}

export function ReportModelLimits({ recorded }: { recorded: Recorded }) {
  const { config } = recorded
  const sensors = SensorsSchema.safeParse(recorded.sensors).data
  const wind = WindSchema.safeParse(config?.wind).data
  const imuWithoutVibration = [
    ...(sensors?.gyro?.vibrationSigma === null ? ['gyroscope'] : []),
    ...(sensors?.accelerometer?.vibrationSigma === null ? ['accelerometer'] : []),
  ]
  // flight_session.rs:396,419, scenario_run.rs:248–250,371–373 and
  // step_test.rs:296–298 feed only the optional gyro feedback to rate control.
  // sensors.rs:210–230 starts from exact state and switches after a gyro sample is available.
  const feedback = !config ? 'The start request is needed to identify the feedback model.'
    : recorded.sensors != null && !sensors ? 'The recorded sensor settings could not be interpreted.'
      : sensors?.flyOnGyro ? 'The rate loop uses the modelled gyroscope once its first sample is available. Other feedback uses exact simulated state.'
        : sensors && (sensors.gyro || sensors.accelerometer || sensors.barometer || sensors.gps)
          ? 'Modelled sensor outputs are recorded only. The controller uses exact simulated state.'
          : 'The controller uses exact simulated state.'
  return <ul>
    {/* ADR 0010:11–17 and ADR 0009:20–24,30–37 describe the load model limits. */}
    {wind && <li>Wind acts directly on body drag only. The model omits rotor inflow and rotor drag from wind.</li>}
    {groundEffect.safeParse(config?.groundEffect).data?.length
      ? <li>Ground effect uses an independent single-rotor thrust correction. Multirotor interaction error is unknown.</li> : null}
    {wind?.turbulence && <li>Dryden turbulence uses a frozen field and needs mean wind. It does not apply to hovering flight.</li>}
    <li>{feedback}</li>
    {imuWithoutVibration.length > 0 && <li>Motor and propeller vibration is omitted from the {imuWithoutVibration.join(' and ')} model, so the simulated response can look better than the real vehicle’s.</li>}
  </ul>
}
