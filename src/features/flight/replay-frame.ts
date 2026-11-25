import { Quaternion, Vector3 } from 'three'
import type { RecordingHeader, RecordingSeries } from '../../../electron/ipc/contract'
import { EnvironmentSchema, VehicleDefinitionSchema, type VehicleDefinition } from '../../../electron/main/engine/protocol'
import { idleFrame } from './EngineFlightSource'
import type { FlightFrame, Quat, Vec3 } from './frame'

const POSITION = ['state.position.x', 'state.position.y', 'state.position.z']
const ROTATION = ['state.quaternion.x', 'state.quaternion.y', 'state.quaternion.z', 'state.quaternion.w']
export const REPLAY_POSE_CHANNELS = [...POSITION, ...ROTATION]

export function recordedBuild(header: RecordingHeader) {
  const load = JSON.parse(header.vehicleLoad)
  if (load?.type !== 'vehicle.load') throw new Error('Recorded vehicle.load is unavailable')
  const vehicle = VehicleDefinitionSchema.parse(load.vehicle)
  const start = JSON.parse(header.startRequest)
  const environment = EnvironmentSchema.safeParse(header.kind === 'flight' ? start?.environment : start?.config?.environment)
  return { vehicle, environment: environment.success ? environment.data : undefined }
}

// Same integer-step clock used by electron/main/telemetry/reader.ts.
export function replayTimeAt(header: RecordingHeader, index: number): number {
  return (header.firstSampleStep + index * header.samplePeriodSteps) * header.stepLengthS
}

/** Latest recorded row at or before the playhead, clamped to the recorded range. */
export function replayIndexAt(header: RecordingHeader, count: number, timeS: number): number {
  let first = 0
  let stop = count
  while (first < stop) {
    const mid = first + Math.floor((stop - first) / 2)
    if (replayTimeAt(header, mid) <= timeS) first = mid + 1
    else stop = mid
  }
  return Math.max(0, first - 1)
}

export function replayWindowAt(header: RecordingHeader, count: number, index: number) {
  // Read one simulated second at a time (250 rows at the D11 sample rate).
  const rows = Math.max(1, Math.ceil(1 / (header.samplePeriodSteps * header.stepLengthS)))
  const first = index - index % rows
  return { first, fromS: replayTimeAt(header, first), toS: replayTimeAt(header, Math.min(count, first + rows) - 1) }
}

export function replayFrame(series: readonly RecordingSeries[], row: number, vehicle: VehicleDefinition): FlightFrame | undefined {
  const points = new Map(series.map(({ channel, points }) => [channel, points[row]]))
  const timeS = points.get(POSITION[0]!)?.timeS
  if (timeS === undefined) return
  const pose = REPLAY_POSE_CHANNELS.map((name) => {
    const point = points.get(name)
    return point?.timeS === timeS ? point.value : null
  })
  if (!pose.every((value) => value !== null && Number.isFinite(value))) return
  const positionM = pose.slice(0, POSITION.length) as Vec3
  const quaternion = pose.slice(POSITION.length) as Quat
  const comM = new Vector3(...vehicle.com).applyQuaternion(new Quaternion(...quaternion)).add(new Vector3(...positionM)).toArray()
  // The read-only viewport consumes the clock and pose. Diagnostic fields retain the idle representation.
  return { ...idleFrame(0, positionM, vehicle.com), timeS, positionM, quaternion, comM }
}
