import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { analyseTrace } = require('../../scripts/profile/analyse.cjs') as {
  analyseTrace(trace: ReturnType<typeof savedTrace>, thresholdMs: number): {
    alignment: { mainOffsetMs: number | null }
    missingStickDraws: number
    summary: { cause: string }[]
    delays: { kind: string; tracks: { thread: string; events: { cause: string }[] }[] }[]
  }
}

function savedTrace() {
  return {
    traceEvents: [
      { ph: 'M', pid: 20, tid: 21, name: 'process_name', args: { name: 'Renderer' } },
      { ph: 'M', pid: 20, tid: 21, name: 'thread_name', args: { name: 'CrRendererMain' } },
      { ph: 'M', pid: 10, tid: 11, name: 'thread_name', args: { name: 'CrBrowserMain' } },
      { ph: 'R', pid: 20, tid: 21, name: 'start-anchor', ts: 1_000_000 },
      { ph: 'R', pid: 20, tid: 21, name: 'end-anchor', ts: 1_140_000 },
      { ph: 'B', pid: 20, tid: 21, name: 'Paint', ts: 1_008_000 },
      { ph: 'X', pid: 20, tid: 21, name: 'PaintImage', ts: 1_014_000, dur: 11_000 },
      { ph: 'E', pid: 20, tid: 21, ts: 1_027_000 },
      { ph: 'X', pid: 30, tid: 31, name: 'CommandBuffer', cat: 'gpu', ts: 1_058_000, dur: 15_000 },
      { ph: 'X', pid: 20, tid: 21, name: 'Paint', ts: 1_100_000, dur: 2_000 },
    ],
    blazeProfile: {
      version: 1,
      metadata: { buildCommit: 'hand-made trace', runCount: 1 },
      periodMs: 10,
      anchors: [
        { name: 'start-anchor', rendererMs: 50, mainBeforeMs: 79, mainAfterMs: 83 },
        { name: 'end-anchor', rendererMs: 190, mainBeforeMs: 218, mainAfterMs: 222 },
      ],
      main: {
        pid: 10, usage: { percentage: 0.1 }, histogramNs: { count: 10 }, resolution: 10,
        gc: [{ startTime: 102.5, duration: 12, detail: { kind: 1 } }],
        writes: [{ startTime: 132.5, duration: 14 }], pendingWrites: [],
        loop: [{ startTime: 173, duration: 24 }],
      },
      stickDrawDelaysMs: [26, 20, null],
      flight: {
        startMs: 50, endMs: 190, flips: [{ atMs: 100 }, { atMs: 130 }, { atMs: 160 }],
        capture: {
          draws: [60, 90, 100, 109, 118, 126, 136, 146, 180].map((drawnMs) => ({ drawnMs })),
          requests: [{ sentMs: 102, responseMs: 120, steps: 8 }],
          overflow: { requests: 0, draws: 0 },
        },
      },
    },
  }
}

describe('saved flight trace analysis', () => {
  it('aligns all clocks and clips nested work to each delayed frame or stick', () => {
    const result = analyseTrace(savedTrace(), 20)
    expect(result.alignment).toMatchObject({
      rendererOffsetMs: 950, rendererAnchorResidualMs: 0, mainOffsetMs: 919.5, mainBracketHalfWidthMs: 1.5,
    })
    expect(result.missingStickDraws).toBe(1)
    expect(result.summary).toEqual(expect.arrayContaining([
      { kind: 'frame', cause: 'paint', count: 1, totalMs: 17 },
      { kind: 'frame', cause: 'GC', count: 1, totalMs: 12 },
      { kind: 'frame', cause: 'unknown', count: 1, totalMs: 34 },
      { kind: 'stick', cause: 'GPU', count: 1, totalMs: 15 },
      { kind: 'stick', cause: 'recording write', count: 1, totalMs: 14 },
      { kind: 'stick', cause: 'IPC round trip', count: 1, totalMs: 18 },
    ]))
    const stick = result.delays.find(({ kind }) => kind === 'stick')!
    expect(stick.tracks.find(({ thread }) => thread === 'CrRendererMain')?.events.map(({ cause }) => cause))
      .toEqual(['IPC round trip', 'request', 'response'])
    expect(result.delays.filter(({ kind }) => kind === 'stick')).toHaveLength(1)
  })

  it('reports missing anchors and surfaces conflicting main brackets without aligning main events', () => {
    const trace = savedTrace()
    trace.blazeProfile.anchors[1]!.mainBeforeMs = 230
    trace.blazeProfile.anchors[1]!.mainAfterMs = 234
    const result = analyseTrace(trace, 20)
    expect(result.alignment.mainOffsetMs).toBeNull()
    expect(result.summary.some(({ cause }) => cause === 'recording write')).toBe(false)
    trace.blazeProfile.anchors = []
    expect(() => analyseTrace(trace, 20)).toThrow('No Chromium clock marker')
  })
})
