/**
 * The workshop interference check on real assemblies (src/features/workshop/interference-input.ts):
 * mounted contact is accepted, a part pushed into the frame or into another part is an
 * error naming both, allowed pairs and the tolerance come from the document, and both
 * are saved (migration 0010) and validated.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssemblyDocument, FrameParams } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import { STARTING_FRAME, createRepositories } from '../../electron/main/db/repositories'
import { addPart, deletePart, updatePart } from '../../src/features/workshop/assembly-ops'
import { allFindings } from '../../src/features/workshop/findings'
import {
  assemblyInterferenceFindings,
  assemblyOverlaps,
  interferenceInput,
  interferenceSettings,
  setInterferenceTolerance,
  setPairAllowed,
} from '../../src/features/workshop/interference-input'
import { buildFrame } from '../../src/three/frame-geometry'

const frame: FrameParams = { motorDiagonal: 0.45, armWidth: 0.02, armThickness: 0.004, plateSize: 0.1 }
const geo = buildFrame('quad-x', frame)
const base: AssemblyDocument = { frame, motors: {}, parts: [] }
const errors = (doc: AssemblyDocument) => assemblyInterferenceFindings(doc, geo, {}, {}).filter((f) => f.severity === 'error')

/** A quad with a motor on every mount and a prop on each motor. */
function quad(): AssemblyDocument {
  let doc = base
  for (const m of geo.motors) {
    const motor = addPart(doc, 'motor', { kind: 'mount', id: m.id }, frame.armThickness, `motor-${m.number}`)
    doc = addPart(motor.doc, 'propeller', { kind: 'part', id: motor.part.id }, frame.armThickness, `prop-${m.number}`).doc
  }
  return doc
}

describe('interference on an assembly', () => {
  it('motors on their pads and props on their motors: contact is accepted, no finding', () => {
    const doc = quad()
    expect(errors(doc)).toEqual([])
    const input = interferenceInput(doc, geo, {}, {})
    // Frame (plate + 4 arms) and 8 parts.
    expect(input.bodies).toHaveLength(5 + 8)
    expect(input.attached).toContainEqual(['motor-1', 'frame'])
    expect(input.attached).toContainEqual(['prop-1', 'motor-1'])
  })

  it('a motor pushed 3 mm into its pad is still accepted (parent–child), but listed as mounted contact', () => {
    const doc = quad()
    const m = doc.parts.find((p) => p.id === 'motor-1')!
    const sunk = updatePart(doc, 'motor-1', { position: [m.position[0], m.position[1], m.position[2] - 0.003] })
    expect(errors(sunk)).toEqual([])
    const o = assemblyOverlaps(sunk, geo, {}, {}).find((x) => x.b === 'motor-1')!
    expect(o.status).toBe('attached')
    expect(o.depthM).toBeCloseTo(0.003, 9)
  })

  it('a free battery pushed into the plate is an error naming the battery and the frame, and both are highlighted', () => {
    const added = addPart(base, 'battery', { kind: 'none' }, frame.armThickness, 'bat')
    // Battery 35 mm tall; plate top at z = 4 mm. Centre at 4 + 17.5 − 2 mm → 2 mm into the plate.
    const doc = updatePart(added.doc, 'bat', { position: [0, 0, 0.004 + 0.0175 - 0.002], rotation: [0, 0, 0, 1] })
    const f = errors(doc)
    expect(f).toHaveLength(1)
    expect(f[0]!.message).toBe('Battery 1 and Frame overlap by 2 mm (your tolerance: 0.5 mm). Move one of them, or allow this pair if the overlap is intended.')
    expect(f[0]!.partIds).toEqual(['bat'])
    const o = assemblyOverlaps(doc, geo, {}, {})[0]!
    expect(o.bodies).toContain('frame:plate')
    expect(o.bodies).toContain('bat')
    // Resting exactly on the plate: no finding.
    expect(errors(updatePart(doc, 'bat', { position: [0, 0, 0.004 + 0.0175] }))).toEqual([])
  })

  it('two overlapping parts: an error; allowed, it goes; the tolerance decides the edge', () => {
    const a = addPart(base, 'battery', { kind: 'none' }, frame.armThickness, 'a')
    const b = addPart(a.doc, 'battery', { kind: 'none' }, frame.armThickness, 'b')
    // Batteries 45 mm wide side by side, centres 44 mm apart in Y, both well above the frame → 1 mm.
    let doc = updatePart(b.doc, 'a', { position: [0, 0, 0.1] })
    doc = updatePart(doc, 'b', { position: [0, 0.044, 0.1] })
    expect(errors(doc).map((f) => f.id)).toEqual(['interference:a,b'])
    expect(errors(setInterferenceTolerance(doc, 0.0011))).toEqual([])
    expect(errors(setInterferenceTolerance(doc, 0.0009))).toHaveLength(1)
    const allowed = setPairAllowed(doc, 'b', 'a', true)
    expect(interferenceSettings(allowed).allowedPairs).toEqual([['a', 'b']])
    expect(errors(allowed)).toEqual([])
    expect(assemblyOverlaps(allowed, geo, {}, {})[0]!.status).toBe('allowed')
    expect(errors(setPairAllowed(allowed, 'a', 'b', false))).toHaveLength(1)
    // Through the checks pipeline, most severe first.
    expect(allFindings(doc, geo, {}, 10).filter((f) => f.rule === 'interference').map((f) => f.severity)).toEqual(['error'])
    // Deleting a part drops its allowed pairs.
    expect(deletePart(allowed, 'b').interference?.allowedPairs).toEqual([])
  })

  it('an imported model whose size is not loaded cannot be checked', () => {
    const added = addPart(base, 'custom', { kind: 'none' }, frame.armThickness, 'm')
    const doc = updatePart(added.doc, 'm', { shape: { type: 'model', assetId: 'a'.repeat(64), units: 'mm', upAxis: 'z' } })
    expect(assemblyInterferenceFindings(doc, geo, {}, {}).map((f) => [f.severity, f.partIds])).toEqual([['cannot-check', ['m']]])
  })
})

describe('saving the interference settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blaze-interference-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('migration 0010 keeps v9 assemblies (no settings) and then stores the tolerance and allowed pairs', () => {
    const path = join(dir, 'v9.db')
    const v9 = new Database(path)
    v9.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.slice(0, 9)) v9.exec(m)
    v9.pragma('user_version = 9')
    v9.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', 'Legacy', 'quad-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    v9.prepare("INSERT INTO assemblies (project_id, revision, frame_json, updated_at) VALUES ('p1', 1, ?, '2026-01-01T00:00:00.000Z')").run(
      JSON.stringify(STARTING_FRAME['quad-x']),
    )
    v9.close()
    const db = openDatabase(path)
    expect(schemaVersion(db)).toBe(10)
    const repos = createRepositories(db)
    const loaded = repos.assemblies.load('p1')
    expect(loaded).not.toHaveProperty('interference')
    const a = addPart({ frame: loaded.frame, motors: {}, parts: [] }, 'battery', { kind: 'none' }, 0.004)
    const doc = setInterferenceTolerance(setPairAllowed(a.doc, a.part.id, 'frame', true), 0.0012)
    repos.assemblies.save({ projectId: 'p1', baseRevision: 1, ...doc })
    expect(repos.assemblies.load('p1').interference).toEqual({ toleranceM: 0.0012, allowedPairs: [[a.part.id, 'frame'].sort()] })
    db.close()
  })

  it('the save schema refuses a negative or huge tolerance, unknown parts, and unsorted or repeated pairs', () => {
    const a = addPart(base, 'battery', { kind: 'none' }, 0.004)
    const save = (interference: unknown) =>
      saveAssemblySchema.safeParse({ projectId: crypto.randomUUID(), baseRevision: 0, frame, motors: {}, parts: a.doc.parts, interference })
    const id = a.part.id
    const pair = [id, 'frame'].sort()
    expect(save({ toleranceM: 0.001, allowedPairs: [pair] }).success).toBe(true)
    expect(save(null).success).toBe(true)
    expect(save({ toleranceM: -0.001, allowedPairs: [] }).success).toBe(false)
    expect(save({ toleranceM: 0.06, allowedPairs: [] }).success).toBe(false)
    expect(save({ toleranceM: 0.001, allowedPairs: [[crypto.randomUUID(), 'frame'].sort()] }).success).toBe(false)
    expect(save({ toleranceM: 0.001, allowedPairs: [[...pair].reverse()] }).success).toBe(false)
    expect(save({ toleranceM: 0.001, allowedPairs: [pair, pair] }).success).toBe(false)
    expect(save({ toleranceM: 0.001, allowedPairs: [], extra: 1 }).success).toBe(false)
  })
})
