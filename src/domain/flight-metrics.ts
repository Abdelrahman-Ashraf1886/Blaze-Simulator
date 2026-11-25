import { telemetryChannels } from './telemetry-channels'

export interface FlightMetric {
  id: string
  name: string
  unit: string
  definition: string
  result: { value: number } | { reason: string }
}

export interface FlightMetricSample {
  timeS: number
  values: Readonly<Record<string, number | null>>
}

interface MetricOptions {
  channels: readonly string[]
  elapsedS?: number
  rateStepAxis?: 'x' | 'y' | 'z'
}

const axes = ['x', 'y', 'z'] as const
const vector = (prefix: string, suffixes: readonly string[] = axes) => suffixes.map((axis) => prefix + '.' + axis)
const quaternion = vector('state.quaternion', [...axes, 'w'])
const velocity = vector('state.velocity')
const rates = vector('state.bodyRates')
const rateTargets = vector('setpoint.rates')
const position = vector('state.com')
const positionTargets = vector('setpoint.position')
const wind = vector('loads.wind')
const landFlags = vector('controller.land', ['groundContact', 'maybeLanded', 'landed'])
const sticks = vector('input.stick', ['forward', 'right', 'throttle'])
const allocation = ['positive', 'negative'].flatMap((sign) =>
  vector('controller.saturation.' + sign, ['roll', 'pitch', 'yaw', 'collective']))
const controller = telemetryChannels(0, 'flightLoop')
function enumCode(channel: string, label: string) {
  const entry = controller.find(({ name }) => name === channel)
  if (entry?.kind !== 'enum') throw new Error('Expected telemetry enum ' + channel)
  return entry.values.indexOf(label)
}
const holdCode = enumCode('controller.autoMode', 'hold')
const positionCode = enumCode('controller.mode', 'position')
const positionCommand = enumCode('input.command', 'position')
const motorCommand = /^motor\.\d+\.(throttle|command)$/
const groundEffectFlag = /^motor\.\d+\.groundEffectBelowTestedRange$/

export function flightMetricChannels(channels: readonly string[]) {
  const fixed = new Set([
    ...quaternion, ...velocity, ...rates, ...rateTargets, ...position, ...positionTargets, ...wind,
    ...landFlags, ...sticks, ...allocation, 'state.groundContact', 'controller.autoMode',
    'controller.mode', 'input.command', 'stepTest.setpoint', 'stepTest.measured',
    'pack.voltage', 'pack.current', 'pack.chargeUsed', 'loads.windAboveRange', 'loads.windInvalid',
  ])
  return channels.filter((name) => fixed.has(name) || motorCommand.test(name) || groundEffectFlag.test(name))
}

type Values = FlightMetricSample['values']
type Read = (values: Values) => number | undefined
type Reduce = 'mean' | 'rms' | 'min' | 'max' | 'last' | 'time' | 'energy'

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readChannel(name: string): Read {
  return (values) => {
    const value = values[name]
    return finite(value) ? value : undefined
  }
}

function anyFlag(values: Values, names: readonly string[]) {
  const flags = names.map((name) => values[name])
  if (flags.includes(1)) return 1
  return flags.length && flags.every((value) => value === 0) ? 0 : undefined
}

function difference(values: Values, target: string, measured: string) {
  const a = values[target]
  const b = values[measured]
  if (finite(a) && finite(b)) return a - b
}

function tilt(values: Values) {
  const [x, y, z, w] = quaternion.map((name) => values[name])
  if (!finite(x) || !finite(y) || !finite(z) || !finite(w)) return
  // For a body-to-world quaternion, cos(tilt) = Rzz. The half-angle form
  // preserves small angles and works for nonzero scaled quaternions as well.
  const across = Math.hypot(x, y)
  const along = Math.hypot(z, w)
  if (across || along) return 2 * Math.atan2(across, along) * 180 / Math.PI
}

function magnitude(values: Values, names: readonly string[]) {
  const components = names.map((name) => values[name])
  if (components.every(finite)) return Math.hypot(...components)
}

function holdWindow(values: Values, auto: boolean) {
  if (auto) return values['controller.autoMode'] === holdCode
  // The engine publishes finite position targets while it owns a lock
  // (flight_modes.rs:464–490, PX4 FlightTaskManualPosition.cpp:110–142).
  // Require recorded neutral translation sticks with no added deadband.
  return values['controller.mode'] === positionCode && values['input.command'] === positionCommand
    && sticks.every((name) => values[name] === 0)
}

function measure(read: Read, reduce: Reduce) {
  let count = 0
  let total = 0
  let previous: number | undefined
  return {
    add(sample: Values, dt: number) {
      const value = read(sample)
      if (reduce === 'time' || reduce === 'energy') {
        if (finite(value) && finite(previous) && dt > 0) {
          total += dt * (reduce === 'time' ? previous : previous / 2 + value / 2)
          count++
        }
      } else if (finite(value)) {
        count++
        switch (reduce) {
          case 'min': total = count === 1 ? value : Math.min(total, value); break
          case 'max': total = count === 1 ? value : Math.max(total, value); break
          case 'last': total = value; break
          case 'mean': total = total * ((count - 1) / count) + value / count; break
          case 'rms': total = Math.hypot(total * Math.sqrt((count - 1) / count), value / Math.sqrt(count)); break
        }
      }
      previous = value
    },
    result(reason: string): FlightMetric['result'] {
      return count && finite(total) ? { value: total } : { reason: count ? 'Result exceeds numeric range' : reason }
    },
  }
}

/** One pass over chronological raw samples, retaining one row and running aggregates. */
export function createFlightMetrics({ channels, elapsedS, rateStepAxis }: MetricOptions) {
  const stats: { add: (values: Values, dt: number) => void; result: () => FlightMetric }[] = []
  const add = (id: string, name: string, unit: string, definition: string, reduce: Reduce, read: Read, missing: string) => {
    const stat = measure(read, reduce)
    stats.push({ add: stat.add, result: () => ({ id, name, unit, definition, result: stat.result(missing) }) })
  }
  const intervals = 'Uses the first value of each adjacent pair with valid data at both ends.'
  const tiltDefinition = 'Angle between body up and world up from the recorded body-to-world quaternion.'
  const noFlags = 'No adjacent samples with enough recorded flag data'

  // PX4 v1.13.3 modules/land_detector/LandDetector.cpp:139–171 publishes
  // these hysteresis states. Use the recorded flags without rerunning PX4.
  add('airtime', 'Time in the air', 's', 'Time with ground contact, maybe landed and landed all clear. ' + intervals,
    'time', (v) => {
      const contact = anyFlag(v, landFlags)
      if (contact !== undefined) return 1 - contact
    }, noFlags)
  add('tilt-max', 'Largest tilt', '°', tiltDefinition, 'max', tilt, 'No valid attitude quaternion')
  add('tilt-rms', 'RMS tilt', '°', 'Sample RMS of the angle. ' + tiltDefinition, 'rms', tilt, 'No valid attitude quaternion')
  axes.forEach((axis, i) => {
    const step = rateStepAxis === axis
    add('rate-' + axis, axis.toUpperCase() + ' body-rate tracking RMS', 'rad/s',
      step ? 'Sample RMS of recorded rate-step target minus measured response on the tested body axis.'
        : 'Sample RMS of body-rate setpoint minus recorded simulated body rate, using paired values on this axis.',
      'rms', (v) => step ? difference(v, 'stepTest.setpoint', 'stepTest.measured') : difference(v, rateTargets[i]!, rates[i]!),
      'No paired body-rate setpoint and measurement')
  })
  for (const [id, label, auto, window] of [
    ['auto', 'Auto hold', true, 'Samples with controller auto mode Hold.'],
    ['centred', 'Centred position flight', false, 'Samples in manual Position mode with centred forward, right and throttle sticks and a recorded position lock for the measured axes.'],
  ] as const) {
    add(id + '-altitude', label + ' altitude error RMS', 'm',
      'Sample RMS of CoM height minus height target. ' + window, 'rms',
      (v) => holdWindow(v, auto) ? difference(v, positionTargets[2]!, position[2]!) : undefined,
      'No altitude and target pairs in this hold window')
    add(id + '-horizontal', label + ' horizontal error RMS', 'm',
      'Sample RMS of horizontal CoM distance from its target. ' + window, 'rms', (v) => {
        if (!holdWindow(v, auto)) return
        const x = difference(v, positionTargets[0]!, position[0]!)
        const y = difference(v, positionTargets[1]!, position[1]!)
        if (finite(x) && finite(y)) return Math.hypot(x, y)
      }, 'No horizontal position and target pairs in this hold window')
  }
  add('speed', 'Largest speed', 'm/s', 'Largest magnitude of the three world-frame CoM velocity components.',
    'max', (v) => magnitude(v, velocity), 'No complete velocity vector')
  for (const [id, label, direction, sign] of [['climb', 'climb', 'upward', 1], ['sink', 'sink', 'downward', -1]] as const) {
    add(id, 'Largest ' + label + ' speed', 'm/s', 'Largest ' + direction + ' CoM speed, reported as a nonnegative value.',
      'max', (v) => {
        const vz = v[velocity[2]!]
        if (finite(vz)) return Math.max(0, sign * vz)
      }, 'No vertical velocity samples')
  }
  const motors = channels.filter((name) => motorCommand.test(name))
  for (const channel of motors.length ? motors : ['motor']) {
    const label = channel === 'motor' ? 'Motor' : 'Motor ' + (Number(channel.split('.')[1]) + 1)
    const read = readChannel(channel)
    for (const id of ['mean', 'max'] as const) {
      add(channel + '-' + id, label + ' throttle ' + id, '1',
        'Sample ' + (id === 'max' ? 'maximum' : 'mean') + ' of the recorded normalized motor command.',
        id, read, 'No recorded motor commands')
    }
    for (const endpoint of [0, 1]) {
      add(channel + '-' + endpoint, label + ' time at ' + endpoint, 's',
        'Time with the recorded normalized motor command exactly at ' + endpoint + '. ' + intervals, 'time', (v) => {
          const command = read(v)
          if (finite(command)) return Number(command === endpoint)
        }, 'No adjacent valid motor commands')
    }
  }
  add('allocation-saturation', 'Time with allocation saturation', 's',
    'Time with any recorded positive or negative roll, pitch, yaw or collective saturation flag set. ' + intervals,
    'time', (v) => anyFlag(v, allocation), noFlags)
  add('voltage', 'Minimum pack voltage', 'V', 'Smallest recorded pack terminal voltage.',
    'min', readChannel('pack.voltage'), 'No pack voltage samples')
  add('current', 'Peak pack current', 'A', 'Largest recorded pack current.',
    'max', readChannel('pack.current'), 'No pack current samples')
  add('charge', 'Charge used', 'C', 'Last valid cumulative pack charge used since run start.',
    'last', readChannel('pack.chargeUsed'), 'No cumulative charge samples')
  add('energy', 'Pack energy used', 'J',
    'Trapezoidal sum of voltage times current over adjacent samples with both channels valid at both ends. Covers the sampled span only.',
    'energy', (v) => {
      const voltage = v['pack.voltage']
      const current = v['pack.current']
      if (finite(voltage) && finite(current)) return voltage * current
    }, 'No adjacent samples with paired pack voltage and current')
  add('wind-mean', 'Mean wind speed at the CoM', 'm/s', 'Sample mean of recorded wind vector magnitudes at the centre of mass.',
    'mean', (v) => magnitude(v, wind), 'No complete CoM wind vector')
  add('wind-max', 'Largest wind speed at the CoM', 'm/s', 'Largest recorded wind vector magnitude at the centre of mass.',
    'max', (v) => magnitude(v, wind), 'No complete CoM wind vector')
  const belowRange = channels.filter((name) => groundEffectFlag.test(name))
  for (const [id, name, definition, flags] of [
    ['wind-range', 'Time with wind above range', 'Time with the wind-above-range flag set.', ['loads.windAboveRange']],
    ['ground-effect-range', 'Time with ground effect below tested range', 'Time with any rotor’s ground-effect-below-tested-range flag set.', belowRange],
    ['wind-invalid', 'Time with invalid wind', 'Time with the wind-invalid flag set.', ['loads.windInvalid']],
  ] as const) {
    add(id, name, 's', definition + ' ' + intervals, 'time', (v) => anyFlag(v, flags), noFlags)
  }

  let previous: FlightMetricSample | undefined
  let touchdownSeen = false
  let touchdown: number | undefined
  return {
    add(sample: FlightMetricSample) {
      if (!finite(sample.timeS) || sample.timeS < 0 || (previous && sample.timeS <= previous.timeS)) return
      const dt = previous ? sample.timeS - previous.timeS : 0
      if (!touchdownSeen && previous?.values['state.groundContact'] === 0 && sample.values['state.groundContact'] === 1) {
        touchdownSeen = true
        const vz = previous.values[velocity[2]!]
        if (finite(vz) && vz < 0) touchdown = -vz
      }
      for (const stat of stats) stat.add(sample.values, dt)
      previous = sample
    },
    results(): FlightMetric[] {
      const duration = finite(elapsedS) ? elapsedS : previous?.timeS
      return [{
        id: 'duration', name: 'Duration flown', unit: 's',
        definition: 'Elapsed simulation time in the recorded end frame, or the last recorded sample time since run start.',
        result: duration === undefined ? { reason: 'No recorded end time or samples' } : { value: duration },
      }, ...stats.map((stat) => stat.result()), {
        id: 'touchdown', name: 'Touchdown vertical speed', unit: 'm/s',
        definition: 'Downward CoM speed in the sample just before the first physical ground-contact flag changes from clear to set.',
        result: touchdown === undefined ? { reason: 'No descending sample immediately before the first recorded ground contact' } : { value: touchdown },
      }]
    },
  }
}
