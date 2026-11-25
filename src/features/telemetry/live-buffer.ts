import type { RecordingSeries } from '../../../electron/ipc/contract'
import { sampleValue, type SampleValue } from './samples'

type Row = readonly SampleValue[]

/** Rows are in engine column order, with the run clock in the 'time' column
 * (telemetry-channels.ts:35–37). The caller supplies the retention and capacity. */
export function createLiveBuffer(durationS: number, capacity: number) {
  if (!Number.isFinite(durationS) || durationS <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Invalid live telemetry retention or capacity')
  }
  const times = new Float64Array(capacity)
  let columns = new Map<string, Float64Array>()
  let channelNames: string[] = []
  let clockIndex = -1
  let head = 0
  let length = 0
  let recording = false

  return {
    begin(channels: readonly string[]) {
      const clock = channels.indexOf('time')
      if (clock < 0 || new Set(channels).size !== channels.length) throw new Error('Invalid live telemetry channels')
      columns = new Map(channels.filter((name) => name !== 'time').map((name) => [name, new Float64Array(capacity)]))
      channelNames = [...channels]
      clockIndex = clock
      head = 0
      length = 0
      recording = true
    },
    append(rows: readonly Row[]) {
      if (!recording) return
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
          const values = columns.get(name)
          if (values) values[slot] = sampleValue(row[column]) ?? NaN
        })
        length++
      }
    },
    end() {
      recording = false
    },
    read(names: readonly string[], fromS: number): RecordingSeries[] {
      const selected = names.filter((name) => name === 'time' ? clockIndex >= 0 : columns.has(name))
      return selected.map((channel) => {
        const values = channel === 'time' ? times : columns.get(channel)!
        const points = []
        for (let i = 0; i < length; i++) {
          const slot = (head + i) % capacity
          const timeS = times[slot]!
          if (timeS >= fromS) points.push({ timeS, value: sampleValue(values[slot]) })
        }
        return { channel, points }
      })
    },
  }
}
