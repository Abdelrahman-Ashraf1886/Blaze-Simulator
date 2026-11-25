import { describe, expect, it } from 'vitest'
import { createLiveBuffer } from '../../src/features/telemetry/live-buffer'

/** The time column, then the named channels, as plain arrays. */
const read = (buffer: ReturnType<typeof createLiveBuffer>, ...names: string[]) =>
  buffer.createReader(names)().map((column) => Array.from(column))

describe('live telemetry column ring', () => {
  it('wraps in chronological order and keeps column alignment', () => {
    const buffer = createLiveBuffer(10, 3)
    buffer.begin(['x', 'time', 'y'])
    buffer.append([[10, 0, -10], [20, 1, -20], [30, 2, -30], [40, 3, -40]])
    expect(read(buffer, 'y', 'time', 'x', 'absent')).toEqual([
      [1, 2, 3], [-20, -30, -40], [1, 2, 3], [20, 30, 40], [null, null, null],
    ])
  })

  it('drops by simulation time even when capacity remains, keeping the inclusive boundary', () => {
    const buffer = createLiveBuffer(2, 8)
    buffer.begin(['time', 'value'])
    buffer.append([[0, 70], [1, 71], [3, 73]])
    expect(read(buffer, 'value')).toEqual([[1, 3], [71, 73]])
    buffer.append([[7, 77]])
    expect(read(buffer, 'value')).toEqual([[7], [77]])
  })

  it('keeps null and NaN as gaps, ignores invalid rows, and starts each run fresh', () => {
    const buffer = createLiveBuffer(2, 4)
    buffer.begin(['time', 'value'])
    buffer.append([[0, NaN], [1, null], [2, 0], [NaN, 1], [1, 1], [3]])
    buffer.end()
    buffer.append([[3, 9]])
    expect(read(buffer, 'value')).toEqual([[0, 1, 2], [null, null, 0]])
    buffer.begin(['time', 'new'])
    expect(read(buffer, 'value', 'new')).toEqual([[], [], []])
  })
})
