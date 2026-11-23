/**
 * `modelHull` (hull.ts) on worker threads, so a large model's hull (about 1 s for 200 000
 * vertices) does not block main's event loop, IPC and the UI.
 *
 * A small lazy pool (MAX_WORKERS threads, started on first use, `unref`'d so they never
 * keep the process alive, ended after IDLE_MS without work). Jobs go to a free worker, else
 * the least busy one; a worker runs its jobs one after another. The model's bytes are
 * transferred, not copied (see `transferable`). A worker that throws, crashes or exits
 * rejects the jobs it held and is replaced on the next call.
 */
import type { Worker } from 'node:worker_threads'
import type { Bounds3, ModelHull } from '../../ipc/contract'

export const MAX_WORKERS = 2
export const IDLE_MS = 30_000

type Format = 'glb' | 'gltf'
type WireError = { name: string; message: string; stack?: string }

export interface HullRequest {
  id: number
  bytes: Uint8Array
  format: Format
  bounds: Bounds3
}
export type HullResponse = { id: number; hull: ModelHull } | { id: number; error: WireError }

interface Job {
  resolve: (h: ModelHull) => void
  reject: (e: Error) => void
}
interface Slot {
  worker: Worker | null
  ready: Promise<Worker>
  jobs: Map<number, Job>
  idle: ReturnType<typeof setTimeout> | null
  dead: boolean
}

const ERRORS: Record<string, ErrorConstructor> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError }

/** An error as the worker threw it: same class (when built in), name, message and stack. */
function rebuild(e: WireError): Error {
  const err = new (ERRORS[e.name] ?? Error)(e.message)
  err.name = e.name
  if (e.stack !== undefined) err.stack = e.stack
  return err
}

const asError = (e: unknown, fallback: string): Error => (e instanceof Error ? e : new Error(typeof e === 'string' ? e : fallback))

/**
 * The bytes to post and the buffer to transfer. A view over a whole ArrayBuffer it alone
 * uses (what `readFileSync` returns for a file over 4 KiB) moves to the worker and is
 * detached here; anything else (a pooled Buffer slice, a sub-view, shared memory) is
 * copied once first, so transferring never detaches memory somebody else uses.
 */
function transferable(bytes: Uint8Array): { payload: Uint8Array; transfer: ArrayBuffer[] } {
  const buf = bytes.buffer
  if (buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return { payload: bytes, transfer: [buf] }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return { payload: copy, transfer: [copy.buffer] }
}

export interface HullPool {
  /** Same result (and same thrown error) as `modelHull`. `bytes` is detached when it is the sole view of its ArrayBuffer. */
  run(bytes: Uint8Array, format: Format, bounds: Bounds3): Promise<ModelHull>
  /** Ends the workers, rejecting jobs still running; a later `run` starts new ones. */
  close(): void
}

export function createHullPool(spawn: () => Worker | Promise<Worker>, opts: { maxWorkers?: number; idleMs?: number } = {}): HullPool {
  const max = opts.maxWorkers ?? MAX_WORKERS
  const idleMs = opts.idleMs ?? IDLE_MS
  const slots: Slot[] = []
  let nextId = 1

  const drop = (slot: Slot, reason: Error) => {
    slot.dead = true
    const i = slots.indexOf(slot)
    if (i >= 0) slots.splice(i, 1)
    if (slot.idle) clearTimeout(slot.idle)
    slot.idle = null
    const jobs = [...slot.jobs.values()]
    slot.jobs.clear()
    for (const j of jobs) j.reject(reason)
    void slot.worker?.terminate()
  }

  const arm = (slot: Slot) => {
    if (slot.idle) clearTimeout(slot.idle)
    slot.idle = null
    if (slot.jobs.size > 0) return
    slot.idle = setTimeout(() => drop(slot, new Error('The hull worker was stopped.')), idleMs)
    slot.idle.unref()
  }

  const open = (): Slot => {
    const slot: Slot = { worker: null, ready: Promise.resolve(null as unknown as Worker), jobs: new Map(), idle: null, dead: false }
    slot.ready = Promise.resolve()
      .then(spawn)
      .then((w) => {
        slot.worker = w
        if (slot.dead) void w.terminate() // closed while it started
        w.unref()
        w.on('message', (m: HullResponse) => {
          const job = slot.jobs.get(m.id)
          if (!job) return
          slot.jobs.delete(m.id)
          if ('error' in m) job.reject(rebuild(m.error))
          else job.resolve(m.hull)
          arm(slot)
        })
        w.on('error', (e) => drop(slot, asError(e, 'The hull worker failed.')))
        w.on('messageerror', (e) => drop(slot, asError(e, 'The hull worker sent a message that could not be read.')))
        w.on('exit', (code) => drop(slot, new Error(`The hull worker exited (code ${code}).`)))
        return w
      })
    slots.push(slot)
    return slot
  }

  const pick = (): Slot => {
    const free = slots.find((s) => s.jobs.size === 0)
    if (free) return free
    if (slots.length < max) return open()
    return slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a))
  }

  return {
    run(bytes, format, bounds) {
      return new Promise<ModelHull>((resolve, reject) => {
        const slot = pick()
        const id = nextId++
        slot.jobs.set(id, { resolve, reject })
        if (slot.idle) clearTimeout(slot.idle)
        slot.idle = null
        const { payload, transfer } = transferable(bytes)
        const req: HullRequest = { id, bytes: payload, format, bounds }
        slot.ready.then(
          (w) => {
            // The slot may have died while its worker started; its jobs were rejected then.
            if (slot.jobs.has(id)) w.postMessage(req, transfer)
          },
          (e: unknown) => drop(slot, asError(e, 'The hull worker could not be started.')),
        )
      })
    },
    close() {
      for (const s of [...slots]) drop(s, new Error('The hull worker was stopped.'))
    },
  }
}

let shared: HullPool | null = null

/** The pool the app uses: the worker bundle electron-vite builds from hull-worker.ts. */
function appPool(): HullPool {
  shared ??= createHullPool(async () => {
    const { Worker } = await import('node:worker_threads')
    const { default: file } = await import('./hull-worker?modulePath')
    return new Worker(file)
  })
  return shared
}

/**
 * `modelHull` on a worker thread. Resolves to the same hull; rejects with the error
 * `modelHull` would have thrown. Ownership of `bytes` passes to the worker: when it is
 * the sole view of its ArrayBuffer it is detached here, so read what you need first
 * (`byteLength`) or pass a copy.
 */
export function modelHullAsync(bytes: Uint8Array, format: Format, bounds: Bounds3): Promise<ModelHull> {
  return appPool().run(bytes, format, bounds)
}

/** Ends the app's hull workers (call on quit). They are unref'd and idle out anyway. */
export function shutdownHullWorkers(): void {
  shared?.close()
}
