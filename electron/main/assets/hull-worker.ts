/**
 * Worker-thread entry for the model hull (hull-async.ts starts it). Runs `modelHull` off
 * the main thread and posts back the result, or the error that call threw.
 * Built as its own bundle by electron-vite (`./hull-worker?modulePath`).
 */
import { parentPort } from 'node:worker_threads'
import { inspectModel, modelHull } from './hull'
import type { HullRequest, HullResponse } from './hull-async'

// A null port means this file was loaded in a thread that is not a worker (a test or tool
// that imports it); then there is nothing to listen to.
parentPort?.on('message', (req: HullRequest) => {
  let reply: HullResponse
  const transfer: ArrayBuffer[] = []
  try {
    switch (req.kind) {
      case 'hull':
        reply = { id: req.id, hull: modelHull(req.bytes, req.format, req.bounds) }
        break
      case 'model':
        reply = { id: req.id, model: inspectModel(req.bytes, req.filename), bytes: req.bytes }
        transfer.push(req.bytes.buffer as ArrayBuffer)
        break
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    reply = { id: req.id, error: { name: err.name, message: err.message, stack: err.stack } }
  }
  parentPort!.postMessage(reply, transfer)
})
