const { readFileSync, writeFileSync } = require('node:fs')

function trackKey({ pid, tid }) {
  return `${pid}:${tid}`
}

function classify({ name, cat = '' }, process, thread) {
  if (/(?:^|[.:_ ])(?:gc|majorgc|minorgc|scavenge|markcompact)(?:$|[.:_ ])/i.test(name)) return 'GC'
  if (/paint|raster|composite|commitlayers/i.test(name)) return 'paint'
  if (/gpu/i.test(process) || /(^|,)gpu(,|$)/.test(cat)) return 'GPU'
  if (/ipc|mojo/i.test(cat) || /ipc|mojo/i.test(name)) return 'IPC'
  if (/CrRendererMain|CrBrowserMain|Compositor/.test(thread) && /RunTask|ProcessTask|ThreadController/.test(name)) {
    return 'thread task'
  }
  return null
}

function clocks(events, profile) {
  const anchors = profile.anchors.flatMap((anchor) => {
    const event = events.find(({ name, ph, ts }) => name === anchor.name && ph !== 'M' && Number.isFinite(ts))
    return event ? [{ ...anchor, event }] : []
  })
  if (!anchors.length) throw new Error('No Chromium clock marker survived in this trace')
  const rendererOffsets = anchors.map(({ rendererMs, event }) => event.ts / 1000 - rendererMs)
  const rendererOffsetMs = (Math.min(...rendererOffsets) + Math.max(...rendererOffsets)) / 2
  const mainLowMs = Math.max(...anchors.map(({ event, mainAfterMs }) => event.ts / 1000 - mainAfterMs))
  const mainHighMs = Math.min(...anchors.map(({ event, mainBeforeMs }) => event.ts / 1000 - mainBeforeMs))
  const mainOffsetMs = mainLowMs <= mainHighMs ? (mainLowMs + mainHighMs) / 2 : null
  return {
    renderer: anchors[0].event,
    rendererOffsetMs, rendererAnchorResidualMs: (Math.max(...rendererOffsets) - Math.min(...rendererOffsets)) / 2,
    mainOffsetMs, mainBracketHalfWidthMs: mainOffsetMs === null ? null : (mainHighMs - mainLowMs) / 2,
    mainBoundsMs: [mainLowMs, mainHighMs],
    anchorsUsed: anchors.map(({ event, mainBeforeMs, mainAfterMs }) => ({
      name: event.name, tsUs: event.ts, mainBracketMs: mainAfterMs - mainBeforeMs,
    })),
  }
}

function describeTracks(events) {
  const processes = new Map()
  const threads = new Map()
  for (const event of events) {
    if (event.ph !== 'M') continue
    if (event.name === 'process_name') processes.set(event.pid, event.args?.name)
    if (event.name === 'thread_name') threads.set(trackKey(event), event.args?.name)
  }
  return {
    label: ({ pid, tid }) => ({
      process: processes.get(pid) ?? 'unlabelled', thread: threads.get(trackKey({ pid, tid })) ?? 'unlabelled',
    }),
    browserMain: (pid) => [...threads].find(([key, name]) => key.startsWith(`${pid}:`) && name === 'CrBrowserMain')?.[0].split(':')[1],
  }
}

function chromiumWork(events, tracks) {
  const work = []
  const stacks = new Map()
  const async = new Map()
  // Walk in timestamp order as some trace exporters group slices by track.
  for (const event of events.filter(({ ts }) => Number.isFinite(ts)).sort((a, b) => a.ts - b.ts)) {
    const { pid, tid, ph, ts, dur, cat, name } = event
    if (ph === 'M') continue
    const key = trackKey(event)
    const asyncId = JSON.stringify([event.id2?.global != null ? null : pid, cat, name, event.scope, event.id2 ?? event.id])
    const stack = stacks.get(key) ?? []
    let begin = event
    let duration = 0
    switch (ph) {
      case 'X': duration = dur; break
      case 'B': stack.push(event); stacks.set(key, stack); continue
      case 'E': begin = stack.pop(); break
      case 'b':
      case 'S': async.set(asyncId, event); continue
      case 'e':
      case 'F': begin = async.get(asyncId); async.delete(asyncId); break
      case 'i':
      case 'I':
      case 's':
      case 't':
      case 'f': break
      default: continue
    }
    if (!begin) continue
    if (begin !== event) duration = ts - begin.ts
    if (!Number.isFinite(duration) || duration < 0) continue
    const track = { pid: begin.pid, tid: begin.tid }
    const labels = tracks.label(track)
    const cause = classify(begin, labels.process, labels.thread)
    if (duration > 0 || cause) work.push({
      ...track, ...labels, cause, name: begin.name, category: begin.cat,
      startMs: begin.ts / 1000, endMs: (begin.ts + duration) / 1000,
      async: ['b', 'S'].includes(begin.ph),
      ...(begin !== event && (begin.pid !== pid || begin.tid !== tid) ? { endTrack: { pid, tid } } : {}),
    })
  }
  return work
}

function windows(profile, offset) {
  const { flight, periodMs, stickDrawDelaysMs } = profile
  const { capture, flips, startMs, endMs } = flight
  const draws = capture.draws.filter(({ drawnMs }) => drawnMs >= startMs && drawnMs < endMs)
  const selected = []
  const add = (kind, from, to) => selected.push({ kind, startMs: from + offset, endMs: to + offset, durationMs: to - from })
  for (let i = 1; i < draws.length; i++) {
    const from = draws[i - 1].drawnMs
    const to = draws[i].drawnMs
    if (to - from > 2 * periodMs) add('frame', from, to)
  }
  flips.forEach(({ atMs }, i) => {
    const delay = stickDrawDelaysMs[i]
    if (Number.isFinite(delay)) add('stick', atMs, atMs + delay)
  })
  return selected
}

function probeWork(profile, clock, tracks) {
  const { main, flight } = profile
  const work = []
  function add(track, cause, name, start, end, offset, async = false) {
    work.push({ ...track, ...tracks.label(track), cause, name, startMs: start + offset, endMs: end + offset, async })
  }
  const renderer = { pid: clock.renderer.pid, tid: clock.renderer.tid }
  flight.capture.requests.forEach(({ sentMs, responseMs, steps }, index) => {
    const offset = clock.rendererOffsetMs
    const label = `flightStep #${index + 1} (${steps} steps)`
    add(renderer, 'request', `${label} sent`, sentMs, sentMs, offset)
    if (responseMs === null) return
    add(renderer, 'response', `${label} received`, responseMs, responseMs, offset)
    add(renderer, 'IPC round trip', label, sentMs, responseMs, offset, true)
  })
  if (clock.mainOffsetMs !== null) {
    const tid = tracks.browserMain(main.pid)
    const track = { pid: main.pid, tid: tid === undefined ? null : Number(tid) }
    for (const { startTime, duration, detail } of main.gc) {
      add(track, 'GC', `Node GC (kind ${detail.kind})`, startTime, startTime + duration, clock.mainOffsetMs)
    }
    for (const { startTime, duration } of main.writes) {
      add(track, 'recording write', 'RecordingWriter FileHandle.write', startTime, startTime + duration, clock.mainOffsetMs, true)
    }
    for (const startTime of main.pendingWrites) {
      add(track, 'recording write', 'RecordingWriter write still pending at stop', startTime, startTime, clock.mainOffsetMs, true)
    }
    for (const { startTime, duration } of main.loop) {
      if (duration > 2 * main.resolution) {
        add(track, 'event-loop delay', 'Main timer gap (elapsed, including nominal interval)',
          startTime, startTime + duration, clock.mainOffsetMs, true)
      }
    }
  }
  return work
}

function unionDuration(spans) {
  let total = 0
  let until = -Infinity
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, end - Math.max(start, until))
    until = Math.max(until, end)
  }
  return total
}

function analyseTrace(trace, stickThresholdMs) {
  const profile = trace.blazeProfile
  if (profile?.version !== 1 || !profile.flight?.capture || !Array.isArray(trace.traceEvents)) {
    throw new Error('Expected a saved flight trace with timing samples')
  }
  if (!Number.isFinite(stickThresholdMs) || stickThresholdMs < 0) throw new Error('Expected a nonnegative stick threshold in ms')
  const clock = clocks(trace.traceEvents, profile)
  const tracks = describeTracks(trace.traceEvents)
  const work = [...chromiumWork(trace.traceEvents, tracks), ...probeWork(profile, clock, tracks)]
    .sort((a, b) => a.startMs - b.startMs)
  const summary = new Map()
  const samples = windows(profile, clock.rendererOffsetMs)
    .filter(({ kind, durationMs }) => kind === 'frame' || durationMs > stickThresholdMs)
    .sort((a, b) => a.startMs - b.startMs)
  let next = 0
  let active = []
  const delays = samples.map((window) => {
    const { startMs, endMs, kind } = window
    const groups = new Map()
    const evidence = new Map()
    active = active.filter((event) => event.endMs >= startMs)
    while (next < work.length && work[next].startMs <= endMs) {
      const event = work[next++]
      if (event.endMs >= startMs) active.push(event)
    }
    for (const event of active) {
      const start = Math.max(startMs, event.startMs)
      const end = Math.min(endMs, event.endMs)
      const point = event.startMs === event.endMs
      if (point ? start !== end : start >= end) continue
      const key = trackKey(event)
      const group = groups.get(key) ?? {
        pid: event.pid, tid: event.tid, process: event.process, thread: event.thread, events: [], longestTask: null,
      }
      const entry = { ...event, overlapMs: end - start }
      if (event.cause !== null) group.events.push(entry)
      if (!point && !event.async && (!group.longestTask || group.longestTask.overlapMs < entry.overlapMs)) {
        group.longestTask = entry
      }
      if (group.longestTask || group.events.length) groups.set(key, group)
      // A short routine slice or a timer gap alone does not explain a missed refresh.
      if (!event.cause || event.cause === 'event-loop delay' || entry.overlapMs < profile.periodMs) continue
      const spans = evidence.get(event.cause) ?? []
      spans.push([start, end])
      evidence.set(event.cause, spans)
    }
    if (!evidence.size) evidence.set('unknown', [[startMs, endMs]])
    const causes = [...evidence].map(([cause, spans]) => {
      const overlapMs = unionDuration(spans)
      const key = `${kind}:${cause}`
      const row = summary.get(key) ?? { kind, cause, count: 0, totalMs: 0 }
      row.count++
      row.totalMs += overlapMs
      summary.set(key, row)
      return { cause, overlapMs }
    }).sort((a, b) => b.overlapMs - a.overlapMs)
    return {
      ...window, causes, tracks: [...groups.values()].map((group) => ({
        ...group, events: group.events.sort((a, b) => b.overlapMs - a.overlapMs || a.startMs - b.startMs),
      })),
    }
  })
  const alignment = {
    rendererPid: clock.renderer.pid, rendererTid: clock.renderer.tid,
    rendererOffsetMs: clock.rendererOffsetMs, rendererAnchorResidualMs: clock.rendererAnchorResidualMs,
    mainOffsetMs: clock.mainOffsetMs, mainBracketHalfWidthMs: clock.mainBracketHalfWidthMs,
    mainBoundsMs: clock.mainBoundsMs, anchorsUsed: clock.anchorsUsed,
  }
  return {
    metadata: profile.metadata, periodMs: profile.periodMs, stickThresholdMs, alignment,
    traceBuffer: profile.main.usage, mainEventLoopDelayNs: profile.main.histogramNs,
    missingStickDraws: profile.stickDrawDelaysMs.filter((delay) => !Number.isFinite(delay)).length,
    captureOverflow: profile.flight.capture.overflow, summary: [...summary.values()], delays,
  }
}

module.exports = { analyseTrace }

if (require.main === module) {
  const [input, threshold, output] = process.argv.slice(2)
  if (!input || !threshold || !output || process.argv.length !== 5) {
    throw new Error('Usage: node scripts/profile/analyse.cjs TRACE.json STICK_MS ANALYSIS.json')
  }
  const result = analyseTrace(JSON.parse(readFileSync(input, 'utf8')), Number(threshold))
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  console.table(result.summary)
  console.log(`Analysed ${result.delays.length} delays in ${output}`)
}
