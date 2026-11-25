import type { RecordingHeader, RecordingPoint, RecordingSampleQuery, RecordingSeries } from '../../../electron/ipc/contract'
import type { PlotChannel } from './layout'

export interface TimeRange {
  fromS: number
  toS: number
}

export function recordingRange(header: RecordingHeader, count: number): TimeRange | undefined {
  if (!count) return
  // Same sample clock as electron/main/telemetry/reader.ts:132–134.
  const timeAt = (index: number) => (header.firstSampleStep + index * header.samplePeriodSteps) * header.stepLengthS
  return { fromS: timeAt(0), toS: timeAt(count - 1) }
}

export function sampleQuery(
  id: string,
  names: readonly string[],
  width: number,
  range?: TimeRange,
): RecordingSampleQuery | undefined {
  // One point per CSS pixel per series. The IPC requires a positive integer
  // budget, unique channels and a finite, nonnegative range (schemas.ts:33–43).
  const maxPoints = Math.floor(width)
  if (!names.length || !Number.isSafeInteger(maxPoints) || maxPoints < 1) return
  if (range && (!Number.isFinite(range.fromS) || !Number.isFinite(range.toS)
    || range.fromS < 0 || range.fromS > range.toS)) return
  return { id, channels: [...new Set(names)], maxPoints, ...range }
}

export type SampleValue = number | null
export const sampleValue = (value: SampleValue | undefined): SampleValue =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

// The reader decimates each column independently (decimation.ts:26–35).
// uPlot uses undefined for another series' timestamp, and null for a real gap.
export function alignSamples(series: readonly RecordingSeries[]): [number[], ...(SampleValue | undefined)[][]] {
  const times = [...new Set(series.flatMap(({ points }) => points.map(({ timeS }) => timeS)))].sort((a, b) => a - b)
  return [times, ...series.map(({ points }) => {
    const values = new Map(points.map(({ timeS, value }) => [timeS, sampleValue(value)]))
    return times.map((time) => values.get(time))
  })]
}

export function pointAt(points: readonly RecordingPoint[], timeS: number, stepped: boolean): SampleValue {
  let first = 0
  let stop = points.length
  while (first < stop) {
    const mid = Math.floor((first + stop) / 2)
    if (points[mid]!.timeS <= timeS) first = mid + 1
    else stop = mid
  }
  const before = points[first - 1]
  const after = points[first]
  if (!before || (!after && before.timeS !== timeS)) return null
  if (stepped || !after || timeS - before.timeS <= after.timeS - timeS) return sampleValue(before.value)
  return sampleValue(after.value)
}

export function valueLabel(channel: PlotChannel, value: SampleValue): string {
  if (value === null) return '—'
  if (channel.kind === 'enum') return channel.values[value] ?? String(value)
  // simulation-engine/engine-host/src/telemetry.rs:210–212.
  if (channel.kind === 'flag' && (value === 0 || value === 1)) return value === 1 ? 'True' : 'False'
  return String(value)
}
