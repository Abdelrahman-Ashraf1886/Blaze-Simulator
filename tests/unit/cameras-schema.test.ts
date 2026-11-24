import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssemblyPart } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { MIGRATIONS, openDatabase, schemaVersion } from '../../electron/main/db/database'
import { createRepositories, STARTING_FRAME } from '../../electron/main/db/repositories'

const camera: AssemblyPart = {
  id: randomUUID(), name: 'Camera', kind: 'camera',
  shape: { type: 'box', size: [0.02, 0.02, 0.02] },
  parentId: null, mountId: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: null,
}
const input = { projectId: randomUUID(), baseRevision: 0, frame: STARTING_FRAME['quad-x'], motors: {} }

describe('camera part document', () => {
  it('round-trips through JSON and IPC validation with or without a vertical FOV', () => {
    for (const part of [camera, { ...camera, cameraFovDeg: 72 }]) {
      const document = { ...input, parts: [part] }
      expect(saveAssemblySchema.parse(JSON.parse(JSON.stringify(document)))).toEqual(document)
    }
  })

  it.each([0, 180, -1, Infinity, NaN, '72', null])('rejects the invalid vertical FOV %s', (cameraFovDeg) => {
    expect(saveAssemblySchema.safeParse({ ...input, parts: [{ ...camera, cameraFovDeg }] }).success).toBe(false)
  })
})

describe('camera field of view storage (schema v14)', () => {
  it('survives a save, a reload and a v13 upgrade; parts without one stay without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blazeuav-fov-'))
    try {
      const path = join(dir, 'old-v13.db')
      const old = new Database(path)
      old.pragma('foreign_keys = ON')
      for (const m of MIGRATIONS.slice(0, 13)) old.exec(m)
      old.pragma('user_version = 13')
      old.close()
      let db = openDatabase(path)
      expect(schemaVersion(db)).toBe(MIGRATIONS.length)
      const repos = createRepositories(db)
      const project = repos.projects.create({ name: 'FOV', frameType: 'quad-x' })
      const { revision, frame, motors } = repos.assemblies.load(project.id)
      const part = { kind: 'camera' as const, shape: { type: 'box' as const, size: [0.05, 0.05, 0.02] as [number, number, number] }, parentId: null, mountId: null,
        position: [0, 0, 0.02] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], mass: null }
      repos.assemblies.save({ projectId: project.id, baseRevision: revision, frame, motors, parts: [
        { ...part, id: '00000000-0000-4000-8000-000000000001', name: 'Set', cameraFovDeg: 72.5 },
        { ...part, id: '00000000-0000-4000-8000-000000000002', name: 'Unset' },
      ] })
      db.close()
      db = openDatabase(path)
      const parts = createRepositories(db).assemblies.load(project.id).parts
      expect(parts.map((p) => p.cameraFovDeg)).toEqual([72.5, undefined])
      expect('cameraFovDeg' in parts[1]!).toBe(false)
      expect(() => db.prepare('UPDATE assembly_parts SET camera_fov_deg = 180').run()).toThrow()
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
