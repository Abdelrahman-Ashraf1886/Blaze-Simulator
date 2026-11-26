const { createHook } = require('node:async_hooks')
const { monitorEventLoopDelay, performance, PerformanceObserver } = require('node:perf_hooks')

// Electron's documented default, node_modules/electron/electron.d.ts:15787–15789.
const config = {
  recording_mode: 'record-until-full',
  trace_buffer_size_in_kb: 100 * 1024,
  included_categories: [
    'blink.user_timing', 'blink', 'devtools.timeline', 'v8', 'cc', 'viz', 'gpu',
    'toplevel', 'renderer.scheduler', 'sequence_manager', 'ipc', 'mojom', 'electron',
  ],
}

exports.start = async (contentTracing, resolution) => {
  const available = new Set(await contentTracing.getCategories())
  await contentTracing.startRecording(config)
  const gc = []
  const collectGc = (entries) => {
    for (const { startTime, duration, detail } of entries) gc.push({ startTime, duration, detail })
  }
  const observer = new PerformanceObserver((entries) => collectGc(entries.getEntries()))
  observer.observe({ entryTypes: ['gc'] })

  const histogram = monitorEventLoopDelay({ resolution })
  histogram.enable()
  const loop = []
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    loop.push({ startTime: previous, duration: now - previous })
    previous = now
  }, resolution)

  const writes = []
  const pending = new Map()
  // FileHandle.write() in electron/main/telemetry/writer.ts:131–154. Time from
  // request creation to its completion callback, including the worker queue and I/O.
  const fs = createHook({
    init(id, type) {
      if (type !== 'FSREQPROMISE') return
      const stack = new Error().stack
      if (stack?.includes('FileHandle.write') && stack.includes('RecordingWriter.write')) {
        pending.set(id, performance.now())
      }
    },
    before(id) {
      const startTime = pending.get(id)
      if (startTime === undefined) return
      writes.push({ startTime, duration: performance.now() - startTime })
      pending.delete(id)
    },
  }).enable()

  return async (path) => {
    fs.disable()
    clearInterval(timer)
    histogram.disable()
    collectGc(observer.takeRecords())
    observer.disconnect()
    const usage = await contentTracing.getTraceBufferUsage().catch(() => null)
    await contentTracing.stopRecording(path)
    return {
      pid: process.pid, config, usage,
      categoriesKnownBeforeCapture: config.included_categories.filter((name) => available.has(name)),
      gc, writes, pendingWrites: [...pending.values()], loop, resolution,
      histogramNs: histogram.count ? {
        count: histogram.count, min: histogram.min, max: histogram.max,
        mean: histogram.mean, p95: histogram.percentile(95), p99: histogram.percentile(99),
      } : null,
    }
  }
}
