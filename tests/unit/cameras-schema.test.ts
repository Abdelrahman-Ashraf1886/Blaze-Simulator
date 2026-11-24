import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AssemblyPart } from '../../electron/ipc/contract'
import { saveAssemblySchema } from '../../electron/ipc/schemas'
import { STARTING_FRAME } from '../../electron/main/db/repositories'

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
