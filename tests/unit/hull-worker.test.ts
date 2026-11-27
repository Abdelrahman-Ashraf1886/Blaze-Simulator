/**
 * The model hull on a worker thread (electron/main/assets/hull-async.ts): the same hull as
 * the synchronous `modelHull`, the same errors, several calls at once, and a worker that
 * dies. The worker is built from hull-worker.ts the way electron-vite builds it (one
 * bundle, three.js inside) and started from a temporary folder.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectGltf } from '../../electron/main/assets/gltf'
import { modelHull } from '../../electron/main/assets/hull'
import { createHullPool, type HullPool } from '../../electron/main/assets/hull-async'
import { boxGlb, boxGltf, packGlb } from '../fixtures/gltf'

type V3 = [number, number, number]

/** A GLB with one point mesh (float32 POSITION). */
function pointsGlb(points: V3[]): Buffer {
  const data = new Float32Array(points.flat())
  const min = [0, 1, 2].map((k) => points.reduce((m, p) => Math.min(m, p[k]!), Infinity))
  const max = [0, 1, 2].map((k) => points.reduce((m, p) => Math.max(m, p[k]!), -Infinity))
  return packGlb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: points.length, type: 'VEC3', min, max }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.byteLength }],
      buffers: [{ byteLength: data.byteLength }],
    },
    new Uint8Array(data.buffer),
  )
}

/** `n` points on a sphere of radius `r` (Fibonacci lattice), so every one is a hull vertex. */
function sphere(n: number, r: number): V3[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n
    const ring = Math.sqrt(1 - y * y)
    return [r * ring * Math.cos(golden * i), r * y, r * ring * Math.sin(golden * i)] as V3
  })
}

/** A fresh copy each time: the pool takes the bytes it is given. */
const own = (b: Uint8Array) => Uint8Array.from(b)

const cases: { name: string; bytes: Uint8Array; file: string }[] = [
  { name: 'a box (GLB)', bytes: boxGlb({ size: [2, 3, 4], centre: [1, 0, 0] }), file: 'a.glb' },
  { name: 'a box (embedded glTF)', bytes: boxGltf({ size: [2, 3, 4], centre: [1, 0, 0] }), file: 'a.gltf' },
  { name: 'a turned, offset box', bytes: boxGlb({ size: [2, 4, 6], node: { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [1, -2, 3] } }), file: 'b.glb' },
  { name: 'a sphere of 500 vertices', bytes: pointsGlb(sphere(500, 0.37)), file: 'c.glb' },
  { name: 'a flat model (no hull)', bytes: pointsGlb(sphere(60, 1).map(([x, , z]) => [x, 0, z] as V3)), file: 'd.glb' },
  { name: 'a hull with too many vertices (no hull)', bytes: pointsGlb(sphere(5000, 1)), file: 'e.glb' },
]

let dir: string
let workerFile: string
const pools: HullPool[] = []
const poolOf = (spawn: () => Worker | Promise<Worker>, opts?: { maxWorkers?: number; idleMs?: number; jobMs?: number }) => {
  const p = createHullPool(spawn, opts)
  pools.push(p)
  return p
}
const realWorker = () => new Worker(workerFile)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hull-worker-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: {
      ssr: join(import.meta.dirname, '../../electron/main/assets/hull-worker.ts'),
      outDir: dir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'hull-worker.mjs' } },
    },
  })
  workerFile = join(dir, 'hull-worker.mjs')
}, 60_000)

afterAll(() => {
  for (const p of pools) p.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the worker gives the synchronous result', () => {
  for (const c of cases) {
    it(`${c.name}: the same hull, bit for bit`, async () => {
      const facts = inspectGltf(c.bytes, c.file)
      const sync = modelHull(c.bytes, facts.format, facts.bounds)
      const pool = poolOf(realWorker)
      const async = await pool.run(own(c.bytes), facts.format, facts.bounds)
      expect(async).toEqual(sync)
      // toEqual treats -0 and 0 alike; compare the exact bits of every coordinate too.
      const bits = (h: typeof sync) => (h.points ?? []).flat().map((v) => Object.is(v, -0) ? 'neg0' : String(v))
      expect(bits(async)).toEqual(bits(sync))
      expect(async.reason).toBe(sync.reason)
    })
  }

  it('at least one case has a hull and one is refused, so both paths are compared', () => {
    const results = cases.map((c) => {
      const facts = inspectGltf(c.bytes, c.file)
      return modelHull(c.bytes, facts.format, facts.bounds).points === null
    })
    expect(results).toContain(true)
    expect(results).toContain(false)
  })

  it('the bytes move to the worker: the caller\'s array is detached, a pooled Buffer slice is copied and kept', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    const pool = poolOf(realWorker)
    const sole = own(cases[0]!.bytes)
    const before = sole.buffer.byteLength
    expect(before).toBeGreaterThan(0)
    await pool.run(sole, facts.format, facts.bounds)
    expect(sole.byteLength).toBe(0) // transferred, not copied

    const shared = new Uint8Array(new ArrayBuffer(cases[0]!.bytes.byteLength + 64), 32, cases[0]!.bytes.byteLength)
    shared.set(cases[0]!.bytes)
    const r = await pool.run(shared, facts.format, facts.bounds)
    expect(shared.byteLength).toBe(cases[0]!.bytes.byteLength) // a sub-view is copied first, the original stays usable
    expect(r).toEqual(modelHull(cases[0]!.bytes, facts.format, facts.bounds))
  })
})

describe('errors', () => {
  it('an error modelHull throws is the error the call rejects with (same class, name and message)', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    let thrown: unknown
    try {
      modelHull(cases[0]!.bytes, facts.format, null as never)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const pool = poolOf(realWorker)
    const rejected = await pool.run(own(cases[0]!.bytes), facts.format, null as never).catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(TypeError)
    expect((rejected as Error).name).toBe((thrown as Error).name)
    expect((rejected as Error).message).toBe((thrown as Error).message)
    expect((rejected as Error).stack).toContain((thrown as Error).message)
  })

  it('a failed call does not poison the worker: the next one still works', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    const pool = poolOf(realWorker, { maxWorkers: 1 })
    await expect(pool.run(own(cases[0]!.bytes), facts.format, null as never)).rejects.toThrow(TypeError)
    await expect(pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)).resolves.toEqual(modelHull(cases[0]!.bytes, facts.format, facts.bounds))
  })

  it('a worker that cannot start rejects the call, and a later call tries again', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    let tries = 0
    const pool = poolOf(() => {
      if (++tries === 1) throw new Error('no worker today')
      return realWorker()
    })
    await expect(pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)).rejects.toThrow('no worker today')
    await expect(pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)).resolves.toEqual(modelHull(cases[0]!.bytes, facts.format, facts.bounds))
    expect(tries).toBe(2)
  })

  it('a worker that dies mid-job (uncaught error, or exit) rejects its jobs, and is replaced', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    const bad = (code: string) => () => new Worker(`require('node:worker_threads').parentPort.on('message', () => { ${code} })`, { eval: true })
    let mode: 'throw' | 'exit' | 'ok' = 'throw'
    const pool = poolOf(() => (mode === 'ok' ? realWorker() : bad(mode === 'throw' ? "throw new RangeError('boom')" : 'process.exit(7)')()), { maxWorkers: 1 })

    const thrown = await pool.run(own(cases[0]!.bytes), facts.format, facts.bounds).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe('boom')

    mode = 'exit'
    await expect(pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)).rejects.toThrow(/exited/)

    mode = 'ok'
    await expect(pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)).resolves.toEqual(modelHull(cases[0]!.bytes, facts.format, facts.bounds))
  })

  it('a crash rejects every job that worker held, not just one', async () => {
    const facts = inspectGltf(cases[0]!.bytes, 'a.glb')
    const pool = poolOf(() => new Worker("require('node:worker_threads').parentPort.on('message', () => process.exit(3))", { eval: true }), { maxWorkers: 1 })
    const all = await Promise.allSettled([1, 2, 3].map(() => pool.run(own(cases[0]!.bytes), facts.format, facts.bounds)))
    expect(all.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
  })

  it('close() rejects running jobs and the pool starts new workers afterwards', async () => {
    const facts = inspectGltf(cases[3]!.bytes, 'c.glb')
    const pool = poolOf(realWorker)
    const running = pool.run(own(cases[3]!.bytes), facts.format, facts.bounds)
    pool.close()
    await expect(running).rejects.toThrow(/stopped/)
    await expect(pool.run(own(cases[3]!.bytes), facts.format, facts.bounds)).resolves.toEqual(modelHull(cases[3]!.bytes, facts.format, facts.bounds))
  })
})

describe('several calls at once', () => {
  it('each resolves to its own model\'s hull, whichever worker ran it and in whatever order they finish', async () => {
    const pool = poolOf(realWorker)
    // Mixed sizes, repeated, so a worker's queue holds a slow job before a fast one.
    const jobs = [...cases, ...cases, ...cases].map((c, i) => ({ ...c, i }))
    const expected = jobs.map((c) => {
      const f = inspectGltf(c.bytes, c.file)
      return modelHull(c.bytes, f.format, f.bounds)
    })
    const got = await Promise.all(
      jobs.map((c) => {
        const f = inspectGltf(c.bytes, c.file)
        return pool.run(own(c.bytes), f.format, f.bounds)
      }),
    )
    expect(got).toEqual(expected)
  })

  it('never starts more workers than the pool allows, and reuses them', async () => {
    let started = 0
    const pool = poolOf(() => (started++, realWorker()), { maxWorkers: 2 })
    const f = inspectGltf(cases[3]!.bytes, 'c.glb')
    await Promise.all(Array.from({ length: 6 }, () => pool.run(own(cases[3]!.bytes), f.format, f.bounds)))
    await Promise.all(Array.from({ length: 6 }, () => pool.run(own(cases[3]!.bytes), f.format, f.bounds)))
    expect(started).toBe(2)
  })

  it('an idle worker is ended, and the next call starts a new one', async () => {
    let started = 0
    const pool = poolOf(() => (started++, realWorker()), { maxWorkers: 1, idleMs: 30 })
    const f = inspectGltf(cases[0]!.bytes, 'a.glb')
    await pool.run(own(cases[0]!.bytes), f.format, f.bounds)
    await new Promise((r) => setTimeout(r, 150))
    await pool.run(own(cases[0]!.bytes), f.format, f.bounds)
    expect(started).toBe(2)
  })
})

it('inspects a hostile hierarchy in the existing worker before computing a hull', async () => {
  const bytes = readFileSync(join(import.meta.dirname, '../fixtures/hostile/cycle.gltf'))
  const pool = poolOf(realWorker)
  const started = performance.now()
  await expect(pool.inspect(own(bytes), 'cycle.gltf')).rejects.toThrow(/cycle/)
  console.info(`Hostile model worker round trip: ${(performance.now() - started).toFixed(1)} ms`)
})

it('cancels and times out an unresponsive hull worker', async () => {
  const stalled = () => new Worker("require('node:worker_threads').parentPort.on('message', () => {})", { eval: true })
  const pool = poolOf(stalled, { maxWorkers: 1, jobMs: 100 })
  const model = cases[0]!
  const facts = inspectGltf(model.bytes, model.file)
  const controller = new AbortController()
  const first = pool.run(own(model.bytes), facts.format, facts.bounds, controller.signal)
  controller.abort(new Error('Cancelled test'))
  await expect(first).rejects.toThrow('Cancelled test')
  await expect(pool.run(own(model.bytes), facts.format, facts.bounds)).rejects.toThrow(/timed out/)
})
