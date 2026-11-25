/** The column order mirrors engine-host/src/telemetry.rs. Enum codes are zero-based indices in values. */
export type TelemetryControllerKind = 'attitudeHold' | 'flightLoop'

type Group = 'time' | 'state' | 'motor' | 'battery' | 'loads' | 'controller' | 'input' | 'sensor'
type ChannelKind = { kind: 'number' } | { kind: 'flag' } | { kind: 'enum'; values: readonly string[] }

export type TelemetryChannel = {
  name: string
  label: string
  unit: string
  group: Group
  frame: string
} & ChannelKind

const xyz = ['x', 'y', 'z']
const xyzw = [...xyz, 'w']
const world = 'World Z-up'
const body = 'Body FLU (forward, left, up)'
const attitude = 'Body to world, quaternion XYZW'
const motorOrder = 'Vehicle motor order (zero-based)'
const dimensionless = '1'
const numeric = { kind: 'number' } as const
const flag = { kind: 'flag' } as const
const enumeration = (...values: string[]): ChannelKind => ({ kind: 'enum', values })

export function telemetryChannels(
  motorCount: number, controller: TelemetryControllerKind, sensors = false, flyOnGyro = false,
): TelemetryChannel[] {
  const columns: TelemetryChannel[] = []
  const add = (
    name: string, label: string, unit: string, group: Group, frame: string, kind: ChannelKind = numeric,
  ) => columns.push({ name, label, unit, group, frame, ...kind })
  const vector = (name: string, label: string, unit: string, group: Group, frame: string, axes = xyz) => {
    for (const axis of axes) add(`${name}.${axis}`, `${label} ${axis.toUpperCase()}`, unit, group, frame)
  }

  // SimState (engine-core/src/sim.rs:62-78).
  add('time', 'Simulated time', 's', 'time', 'Since run start')
  add('step', 'Simulation step', dimensionless, 'time', 'Absolute index, zero before stepping')
  vector('state.position', 'Body origin', 'm', 'state', world)
  vector('state.com', 'Centre of mass', 'm', 'state', world)
  vector('state.quaternion', 'Attitude', dimensionless, 'state', attitude, xyzw)
  vector('state.velocity', 'CoM velocity', 'm/s', 'state', world)
  vector('state.bodyRates', 'Body rate', 'rad/s', 'state', body)
  add('state.groundContact', 'Physical ground contact', dimensionless, 'state', 'Physics contact at the end of the step', flag)

  // MotorReading and BatteryReading (flight.rs:65-86). RotorGroundEffect (flight.rs:180-203).
  for (let i = 0; i < motorCount; i++) {
    const motor = (field: string, label: string, unit = dimensionless, kind: ChannelKind = numeric) =>
      add(`motor.${i}.${field}`, `Motor ${i + 1} ${label}`, unit, 'motor', motorOrder, kind)
    motor('throttle', 'throttle command')
    motor('speed', 'angular speed', 'rad/s')
    motor('thrust', 'free-air thrust', 'N')
    motor('dragTorque', 'drag torque', 'N·m')
    motor('current', 'winding current', 'A')
    motor('groundEffectStatus', 'ground effect status', dimensionless,
      enumeration('inactive', 'applied', 'invalidInput', 'invalidWind', 'nonFiniteThrust'))
    motor('groundEffectBelowTestedRange', 'ground effect below tested range', dimensionless, flag)
    motor('groundEffectInvalidReason', 'ground effect invalid input', dimensionless,
      enumeration('hubHeight', 'radius', 'airspeed', 'thrust', 'airDensity'))
  }
  add('pack.voltage', 'Pack terminal voltage', 'V', 'battery', 'Held throttle')
  add('pack.current', 'Pack current', 'A', 'battery', 'Held throttle')
  add('pack.chargeUsed', 'Pack charge used', 'C', 'battery', 'Integrated from run start')

  // StepLoads (flight.rs:128-178).
  vector('loads.thrust', 'Applied rotor thrust', 'N', 'loads', body)
  vector('loads.drag', 'Body drag', 'N', 'loads', body)
  const torqueFrame = `${body}, about the CoM`
  vector('loads.armTorque', 'Thrust arm torque', 'N·m', 'loads', torqueFrame)
  vector('loads.dragReactionTorque', 'Rotor drag reaction torque', 'N·m', 'loads', torqueFrame)
  vector('loads.spinUpReactionTorque', 'Rotor spin-up reaction torque', 'N·m', 'loads', torqueFrame)
  vector('loads.rotorGyroTorque', 'Rotor gyroscopic torque', 'N·m', 'loads', torqueFrame)
  vector('loads.totalTorque', 'Total applied torque', 'N·m', 'loads', torqueFrame)
  vector('loads.wind', 'Wind at the CoM', 'm/s', 'loads', world)
  vector('loads.turbulence', 'Turbulence at the CoM', 'm/s', 'loads', world)
  add('loads.turbulenceBelowRange', 'Turbulence below range', dimensionless, 'loads', 'CoM or sampled rotor hub', flag)
  add('loads.turbulenceAboveRange', 'Turbulence above range', dimensionless, 'loads', 'CoM or sampled rotor hub', flag)
  add('loads.groundEffectAddedThrust', 'Ground effect thrust increase', 'N', 'loads', 'Sum along rotor axes before projection')
  add('loads.windAboveRange', 'Wind above shear range', dimensionless, 'loads', 'CoM or sampled rotor hub', flag)
  add('loads.windInvalid', 'Wind sample invalid', dimensionless, 'loads', 'CoM, rotor hub or time update', flag)

  // FlightLoopSnapshot (flight_loop.rs:34-51), and ControlDiagnostic (closed_loop.rs:50-60).
  const flightLoop = controller === 'flightLoop'
  add('controller.mode', 'Controller mode', dimensionless, 'controller', 'Active controller', enumeration('attitudeHold', 'rates', 'stabilized', 'altitude', 'position'))
  if (flightLoop) {
    add('controller.autoMode', 'Auto mode', dimensionless, 'controller', 'Active auto command', enumeration('takeoff', 'hold', 'land', 'return'))
    add('controller.returnState', 'Return state', dimensionless, 'controller', 'Return sequence', enumeration('climb', 'return', 'descend', 'loiter', 'land', 'landed'))
    add('controller.takeoffState', 'Takeoff state', dimensionless, 'controller', 'Takeoff ramp', enumeration('disarmed', 'spoolUp', 'readyForTakeoff', 'rampUp', 'flight'))
    for (const [field, label] of [['freefall', 'Freefall'], ['groundContact', 'Ground contact'], ['maybeLanded', 'Maybe landed'], ['landed', 'Landed']] as const) {
      add(`controller.land.${field}`, label, dimensionless, 'controller', 'Land detector', flag)
    }
  }
  const positionAxes = flightLoop ? xyz : ['z']
  vector('setpoint.position', 'Position setpoint', 'm', 'controller', `${world}, at the CoM`, positionAxes)
  if (flightLoop) {
    vector('setpoint.velocity', 'Velocity setpoint', 'm/s', 'controller', world)
    vector('setpoint.acceleration', 'Acceleration setpoint', 'm/s²', 'controller', world)
  }
  vector('setpoint.attitude', 'Attitude setpoint', dimensionless, 'controller', attitude, xyzw)
  vector('setpoint.rates', 'Rate setpoint', 'rad/s', 'controller', body)
  add('setpoint.collectiveThrust', 'Collective thrust setpoint', dimensionless, 'controller', 'Normalized positive collective')
  if (flightLoop) vector('setpoint.thrustWorld', 'Normalized thrust setpoint', dimensionless, 'controller', world)
  vector('controller.velocityIntegral', 'Velocity integral', 'm/s²', 'controller', world, positionAxes)
  vector('controller.rateIntegral', 'Rate integral', dimensionless, 'controller', `${body}, normalized torque`)
  for (const sign of ['positive', 'negative']) {
    for (const axis of ['roll', 'pitch', 'yaw', 'collective']) {
      add(`controller.saturation.${sign}.${axis}`, `${axis} ${sign} saturation`, dimensionless, 'controller', 'Allocation demand', flag)
    }
  }
  add('controller.hoverThrust', 'Hover thrust estimate', dimensionless, 'controller', 'Normalized collective')
  add('controller.hoverThrustVariance', 'Hover thrust variance', dimensionless, 'controller', 'Squared normalized collective')
  add('controller.hoverThrustValid', 'Hover thrust estimate valid', dimensionless, 'controller', 'Estimator validity', flag)

  // FlightCommand (flight_modes.rs:49-82) and Setpoint (controller.rs:659-667).
  if (flightLoop) {
    add('input.command', 'Input command', dimensionless, 'input', 'Command supplied to the controller',
      enumeration('rates', 'attitudeSetpoint', 'positionSetpoint', 'stabilized', 'altitude', 'position', 'takeoff', 'hold', 'land', 'return'))
    for (const [field, label, frame] of [
      ['forward', 'Forward stick', 'Positive forward'],
      ['right', 'Right stick', 'Positive right'],
      ['yawRight', 'Yaw stick', 'Positive clockwise from above'],
      ['throttle', 'Throttle stick', 'Centered, positive up'],
    ] as const) {
      add(`input.stick.${field}`, label, dimensionless, 'input', frame)
    }
    vector('input.rates', 'Commanded body rate', 'rad/s', 'input', body)
    add('input.collective', 'Commanded collective', dimensionless, 'input', 'Normalized positive collective')
  }
  vector('input.attitude', 'Commanded attitude', dimensionless, 'input', attitude, xyzw)
  add('input.yawRate', 'Yaw rate feedforward', 'rad/s', 'input', 'Positive counterclockwise about world +Z')
  if (flightLoop) {
    vector('input.position', 'Commanded position', 'm', 'input', world)
    vector('input.velocity', 'Commanded velocity', 'm/s', 'input', world)
    vector('input.acceleration', 'Commanded acceleration', 'm/s²', 'input', world)
    add('input.heading', 'Commanded heading', 'rad', 'input', 'From world +X toward +Y')
    add('input.headingRate', 'Commanded heading rate', 'rad/s', 'input', 'Positive counterclockwise about world +Z')
    add('input.takeoffAltitude', 'Requested takeoff altitude', 'm', 'input', 'Above the starting CoM, world +Z')
  } else {
    add('input.altitude', 'Commanded altitude', 'm', 'input', 'World Z-up, at the CoM')
    add('input.climbRate', 'Commanded climb rate', 'm/s', 'input', 'World Z-up velocity feedforward')
  }
  if (sensors || flyOnGyro) {
    vector('sensor.gyro', 'Gyroscope', 'rad/s', 'sensor', body)
    for (const axis of xyz) add(`sensor.gyroClipped.${axis}`, `Gyroscope ${axis.toUpperCase()} clipped`, dimensionless, 'sensor', body, flag)
    vector('sensor.accelerometer', 'Accelerometer specific force', 'm/s²', 'sensor', body)
    for (const axis of xyz) add(`sensor.accelerometerClipped.${axis}`, `Accelerometer ${axis.toUpperCase()} clipped`, dimensionless, 'sensor', body, flag)
    add('sensor.barometer.pressure', 'Barometer pressure', 'Pa', 'sensor', 'ISA pressure')
    add('sensor.barometer.altitude', 'Barometer pressure altitude', 'm', 'sensor', 'ISA geopotential altitude')
    vector('sensor.gps.position', 'GPS centre of mass position', 'm', 'sensor', world)
    vector('sensor.gps.velocity', 'GPS centre of mass velocity', 'm/s', 'sensor', world)
  }
  if (flyOnGyro) {
    vector('sensor.gyroFiltered', 'Gyroscope used by rate loop', 'rad/s', 'sensor', body)
    vector('sensor.angularAccelerationFiltered', 'Angular acceleration used by rate loop', 'rad/s²', 'sensor', body)
    add('controller.rateSource', 'Rate feedback source', dimensionless, 'controller', 'Rate loop input', enumeration('true', 'gyro'))
  }
  return columns
}
