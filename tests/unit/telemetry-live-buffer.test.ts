import { describe, expect, it } from 'vitest'
import { createLiveBuffer } from '../../src/features/telemetry/live-buffer'

describe('live telemetry column ring', () => {
  it('wraps in chronological order and keeps column alignment', () => {
    const buffer = createLiveBuffer(10, 3)
    buffer.begin(['x', 'time', 'y'])
    buffer.append([[10, 0, -10], [20, 1, -20], [30, 2, -30], [40, 3, -40]])
    expect(buffer.read(['y', 'time', 'x', 'absent'], 2)).toEqual([
      { channel: 'y', points: [{ timeS: 2, value: -30 }, { timeS: 3, value: -40 }] },
      { channel: 'time', points: [{ timeS: 2, value: 2 }, { timeS: 3, value: 3 }] },
      { channel: 'x', points: [{ timeS: 2, value: 30 }, { timeS: 3, value: 40 }] },
    ])
    expect(buffer.read(['time'], 0)[0]?.points.map(({ timeS }) => timeS)).toEqual([1, 2, 3])
  })

  it('drops by simulation time even when capacity remains, keeping the inclusive boundary', () => {
    const buffer = createLiveBuffer(2, 8)
    buffer.begin(['time', 'value'])
    buffer.append([[0, 70], [1, 71], [3, 73]])
    expect(buffer.read(['time'], 0)[0]?.points.map(({ timeS }) => timeS)).toEqual([1, 3])
    buffer.append([[7, 77]])
    expect(buffer.read(['value'], 0)[0]?.points).toEqual([{ timeS: 7, value: 77 }])
  })

  it('keeps null and NaN as gaps, ignores invalid rows, and starts each run fresh', () => {
    const buffer = createLiveBuffer(2, 4)
    buffer.begin(['time', 'value'])
    buffer.append([[0, NaN], [1, null], [2, 0], [NaN, 1], [1, 1], [3]])
    buffer.end()
    buffer.append([[3, 9]])
    expect(buffer.read(['value'], 0)[0]?.points).toEqual([
      { timeS: 0, value: null }, { timeS: 1, value: null }, { timeS: 2, value: 0 },
    ])
    buffer.begin(['time', 'new'])
    expect(buffer.read(['value', 'new'], 0)).toEqual([{ channel: 'new', points: [] }])
  })
})
