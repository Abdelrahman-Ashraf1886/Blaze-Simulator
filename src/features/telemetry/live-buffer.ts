import { sampleValue, type SampleValue } from './samples'

type Row = readonly SampleValue[]
type LiveColumn = Float64Array | SampleValue[]
export type LiveData = [Float64Array, ...LiveColumn[]]

function copyRing(source: Float64Array, target: Float64Array, head: number, length: number) {
  if (head === 0 && length === source.length) {
    target.set(source)
    return
  }
  // Two contiguous spans, without allocating a subarray view at each new head.
  const first = Math.min(length, source.length - head)
  for (let i = 0; i < first; i++) target[i] = source[head + i]!
  for (let i = 0; i < length - first; i++) target[first + i] = source[i]!
}

/** Rows are in engine column order, with the run clock in the 'time' column
 * (telemetry-channels.ts:35–37). The caller supplies the retention and capacity. */
export function createLiveBuffer(durationS: number, capacity: number) {
  if (!Number.isFinite(durationS) || durationS <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Invalid live telemetry retention or capacity')
  }
  const times = new Float64Array(capacity)
  let columns = new Map<string, { values: Float64Array; lastGap: number }>()
  let channelNames: string[] = []
  let clockIndex = -1
  let head = 0
  let length = 0
  let recording = false

  return {
    begin(channels: readonly string[]) {
      const clock = channels.indexOf('time')
      if (clock < 0 || new Set(channels).size !== channels.length) throw new Error('Invalid live telemetry channels')
      columns = new Map(channels.filter((name) => name !== 'time').map((name) =>
        [name, { values: new Float64Array(capacity), lastGap: -Infinity }]))
      channelNames = [...channels]
      clockIndex = clock
      head = 0
      length = 0
      recording = true
    },
    append(rows: readonly Row[]) {
      if (!recording) return false
      let changed = false
      for (const row of rows) {
        const time = sampleValue(row[clockIndex])
        if (time === null || time < 0 || row.length !== channelNames.length) continue
        if (length && time <= times[(head + length - 1) % capacity]!) continue
        while (length && (length === capacity || times[head]! < time - durationS)) {
          head = (head + 1) % capacity
          length--
        }
        const slot = (head + length) % capacity
        times[slot] = time
        channelNames.forEach((name, column) => {
          const target = columns.get(name)
          if (!target) return
          const value = sampleValue(row[column])
          if (value === null) target.lastGap = time
          target.values[slot] = value ?? NaN
        })
        length++
        changed = true
      }
      return changed
    },
    end() {
      recording = false
    },
    reset() {
      recording = false
      head = 0
      length = 0
    },
    createReader(names: readonly string[]): () => LiveData {
      // Each plot owns its snapshot until its next draw.
      const clock = new Float64Array(capacity)
      let clockPrefix = clock.subarray(0, 0)
      const selected = names.map((name) => ({
        name, values: new Float64Array(capacity), prefix: clockPrefix, gaps: undefined as SampleValue[] | undefined,
      }))
      const data: LiveData = [clockPrefix, ...selected.map(({ prefix }) => prefix)]
      return () => {
        const full = length === capacity
        if (!full && clockPrefix.length !== length) clockPrefix = clock.subarray(0, length)
        data[0] = full ? clock : clockPrefix
        copyRing(times, clock, head, length)
        for (let i = 0; i < selected.length; i++) {
          const target = selected[i]!
          if (target.name === 'time') {
            data[i + 1] = data[0]
            continue
          }
          const column = columns.get(target.name)
          if (column) copyRing(column.values, target.values, head, length)
          // uPlot 1.6.32 checks for null, and treats NaN as a line coordinate
          // (dist/uPlot.cjs.js:2195–2226, 2237–2244).
          if (length && (!column || column.lastGap >= times[head]!)) {
            const gaps = target.gaps ??= []
            gaps.length = length
            if (column) {
              for (let j = 0; j < length; j++) gaps[j] = sampleValue(target.values[j])
            } else gaps.fill(null)
            data[i + 1] = gaps
          } else {
            if (!full && target.prefix.length !== length) target.prefix = target.values.subarray(0, length)
            data[i + 1] = full ? target.values : target.prefix
          }
        }
        return data
      }
    },
  }
}
