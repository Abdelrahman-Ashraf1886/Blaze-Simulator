import type { RecordingChannel } from '../../../electron/ipc/contract'
import { telemetryChannels, type TelemetryChannel } from '../../domain/telemetry-channels'

const staticChannels = new Map(
  [...telemetryChannels(0, 'attitudeHold'), ...telemetryChannels(0, 'flightLoop')]
    .map((channel) => [channel.name, channel]),
)
const motorChannels = new Map(telemetryChannels(1, 'flightLoop')
  .filter(({ group }) => group === 'motor').map((channel) => [channel.name, channel]))

export function channelDefinition(name: string): TelemetryChannel | undefined {
  const motor = /^motor\.(\d+)\.(.+)$/.exec(name)
  if (!motor) return staticChannels.get(name)
  const template = motorChannels.get(`motor.0.${motor[2]}`)
  if (template) return { ...template, name, label: template.label.replace('Motor 1', `Motor ${Number(motor[1]) + 1}`) }
}

export type PlotChannel = RecordingChannel & Pick<TelemetryChannel, 'frame'> &
  ({ kind: 'number' | 'flag' } | { kind: 'enum'; values: readonly string[] }) & {
    group: TelemetryChannel['group'] | 'other'
  }

export function describeChannel(channel: RecordingChannel): PlotChannel {
  const definition = channelDefinition(channel.name)
  return definition ? { ...definition, ...channel } : { ...channel, group: 'other', kind: 'number', frame: '' }
}

export function groupAxes<T extends { unit: string }>(channels: readonly T[]): Map<string, T[]> {
  const axes = new Map<string, T[]>()
  for (const channel of channels) {
    const axis = axes.get(channel.unit)
    if (axis) axis.push(channel)
    else axes.set(channel.unit, [channel])
  }
  return axes
}

// Milestone 7.4 graph requirement.
export const MAX_AXES = 2

export interface TelemetryGraphLayout {
  id: string
  channels: string[]
}

export interface TelemetryLayout {
  graphs: TelemetryGraphLayout[]
}

export function isTelemetryLayout(value: unknown): value is TelemetryLayout {
  if (typeof value !== 'object' || value === null || !('graphs' in value) || !Array.isArray(value.graphs)) return false
  const ids = new Set<string>()
  return value.graphs.every((graph: unknown) => {
    if (typeof graph !== 'object' || graph === null || !('id' in graph) || !('channels' in graph)) return false
    const { id, channels } = graph
    if (typeof id !== 'string' || !id.trim() || ids.has(id) || !Array.isArray(channels)) return false
    ids.add(id)
    if (!channels.every((name): name is string => typeof name === 'string' && !!name.trim())) return false
    const known = channels.map(channelDefinition).filter((channel) => channel !== undefined)
    return new Set(channels).size === channels.length && groupAxes(known).size <= MAX_AXES
  })
}

// Use the channel table's frames and native units. In particular, position
// setpoints use the CoM (telemetry-channels.ts:39,92–99).
function vector(prefix: string) {
  return [...staticChannels.keys()].filter((name) => name.startsWith(`${prefix}.`))
}

export const STARTER_LAYOUTS: ReadonlyArray<{
  name: string
  graphs: Array<TelemetryGraphLayout & { motorField?: string }>
}> = [
  { name: 'Attitude and rates', graphs: [
    { id: 'attitude', channels: [...vector('state.quaternion'), ...vector('setpoint.attitude')] },
    { id: 'rates', channels: [...vector('state.bodyRates'), ...vector('setpoint.rates')] },
  ] },
  { name: 'Position and velocity', graphs: [
    { id: 'position', channels: [...vector('state.com'), ...vector('setpoint.position')] },
    { id: 'velocity', channels: [...vector('state.velocity'), ...vector('setpoint.velocity')] },
  ] },
  { name: 'Motors', graphs: [
    { id: 'throttle', channels: [], motorField: 'throttle' },
    { id: 'speed', channels: [], motorField: 'speed' },
    { id: 'thrust', channels: [], motorField: 'thrust' },
  ] },
  { name: 'Battery', graphs: [
    { id: 'supply', channels: ['pack.voltage', 'pack.current'] },
    { id: 'charge', channels: ['pack.chargeUsed'] },
  ] },
  { name: 'Wind and loads', graphs: [
    { id: 'wind', channels: [...vector('loads.wind'), ...vector('loads.turbulence')] },
    { id: 'loads', channels: [...vector('loads.thrust'), ...vector('loads.drag'), ...vector('loads.totalTorque')] },
  ] },
]

export function starterLayout(index: number, available: readonly PlotChannel[]): TelemetryLayout {
  const graphs = STARTER_LAYOUTS[index]!.graphs.map(({ id, channels, motorField }) => ({
    id,
    channels: motorField
      ? available.filter(({ name, group }) => group === 'motor' && name.endsWith(`.${motorField}`)).map(({ name }) => name)
      : [...channels],
  }))
  return { graphs }
}
