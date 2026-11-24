import { Quaternion, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { chaseCameraPose, easeChaseHeading, fixedCameraPose, fpvCameraPose, orbitCameraPose, toThreeCameraQuaternion, type CameraPose } from '../../src/features/flight/cameras'
import { CAMERA_MODES, cameraMount, cameraSettingsFromPref, hideCameraPart, initialDrag, startingCameraSettings, viewCameraPose, type CameraViewState } from '../../src/features/flight/camera-view'
import { demoFrame, FakeFlightSource } from '../../src/features/flight/FakeFlightSource'
import { STARTING_FRAME } from '../../electron/main/db/repositories'
import type { AssemblyDocument, AssemblyPart } from '../../electron/ipc/contract'
import { buildFrame } from '../../src/three/frame-geometry'
import type { Quat, Vec3 } from '../../src/features/flight/frame'

// Absolute tolerance for rotation and position arithmetic in these fixtures.
const tolerance = 1e-12
const quarterTurn = Math.SQRT1_2
const positionM: Vec3 = [10, 20, 30]
// Yaw +90 about world Z after a roll +90 about body X.
const frame = { positionM, quaternion: [0.5, 0.5, 0.5, 0.5] as Quat }

function expectVector(actual: readonly number[], expected: readonly number[], limit = tolerance) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((component, index) => expect(Math.abs(component - expected[index]!)).toBeLessThanOrEqual(limit))
}

function direction(pose: CameraPose, axis: Vec3): Vec3 {
  return new Vector3(...axis).applyQuaternion(new Quaternion(...pose.quaternion)).toArray()
}

describe('flight camera poses', () => {
  it('maps Three right, up and forward through a yawed and rolled FLU orientation', () => {
    const quaternion = toThreeCameraQuaternion(frame.quaternion)
    expectVector(new Vector3(1, 0, 0).applyQuaternion(quaternion).toArray(), [0, 0, -1])
    expectVector(new Vector3(0, 1, 0).applyQuaternion(quaternion).toArray(), [1, 0, 0])
    expectVector(new Vector3(0, 0, -1).applyQuaternion(quaternion).toArray(), [0, 1, 0])
  })

  it('eases along the short arc across ±180° and starts at the new heading on a run reset', () => {
    const right = 179 * Math.PI / 180
    const left = -right
    const elapsed = 0.25 * Math.log(2) // Half the remaining difference at the workshop time scale.
    expect(easeChaseHeading(right, left, elapsed)).toBeCloseTo(Math.PI, 12)
    expect(easeChaseHeading(left, right, elapsed)).toBeCloseTo(-Math.PI, 12)
    const state: CameraViewState = {}
    const at = (yaw: number) => ({ ...demoFrame(0), quaternion: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)] as Quat })
    const settings = { distanceM: 4, heightM: 3, fovDeg: 55 }
    viewCameraPose(state, at(right), 'Chase', false, elapsed, settings, settings, initialDrag)
    viewCameraPose(state, at(left), 'Chase', true, elapsed, settings, settings, initialDrag)
    expect(state.heading).toBeCloseTo(left, 12)
  })

  it('resolves a nested camera mount before composing it with the body pose and hides only the camera', () => {
    const parent: AssemblyPart = {
      id: 'parent', name: 'Bracket', kind: 'custom', shape: { type: 'box', size: [1, 1, 1] },
      position: [1, 2, 3], rotation: [0, 0, quarterTurn, quarterTurn], parentId: null, mountId: null, mass: null,
    }
    const part: AssemblyPart = {
      ...parent, id: 'camera', name: 'Camera', kind: 'camera', parentId: parent.id,
      position: [1, 0, 0], rotation: [0, 0, 0, 1], cameraFovDeg: 72,
    }
    const child: AssemblyPart = { ...parent, id: 'child', parentId: part.id, position: [1, 0, 0], rotation: [0, 0, 0, 1] }
    const doc: AssemblyDocument = { frame: STARTING_FRAME['quad-x'], motors: {}, parts: [parent, part, child] }
    const geo = buildFrame('quad-x', doc.frame)
    const mount = cameraMount(doc, geo, part)!
    const pose = fpvCameraPose(frame, mount)
    expectVector(pose.positionM, [13, 21, 33])
    expectVector(direction(pose, [1, 0, 0]), [0, 0, 1])
    expect(pose.fovDeg).toBe(72)
    expect(cameraMount(doc, geo, { ...part, cameraFovDeg: undefined })).toBeUndefined()
    const visible = hideCameraPart(doc, geo, part.id).parts
    expect(visible.map((entry) => entry.id)).toEqual([parent.id, child.id])
    expectVector(visible[1]!.position, [1, 4, 3])
    expect(doc.parts).toEqual([parent, part, child])
  })
  it('chases behind the projected nose of a yawed and rolled frame', () => {
    const pose = chaseCameraPose(frame, 4, 3, 55)
    expectVector(pose.positionM, [10, 16, 33])
    expectVector(direction(pose, [1, 0, 0]), [0, 0.8, -0.6])
    expectVector(direction(pose, [0, 0, 1]), [0, 0.6, 0.8])
    expect(pose.fovDeg).toBe(55)
  })

  it('orbits in world axes and aims from a fixed world point', () => {
    const orbit = orbitCameraPose(frame, Math.PI / 2, 4, 3, 55)
    expectVector(orbit.positionM, [10, 24, 33])
    expectVector(direction(orbit, [1, 0, 0]), [0, -0.8, -0.6])
    const fixed = fixedCameraPose(frame, [7, 20, 34], 65)
    expect(fixed.positionM).toEqual([7, 20, 34])
    expectVector(direction(fixed, [1, 0, 0]), [0.6, 0, -0.8])
    expect(fixed.fovDeg).toBe(65)
  })

  it('composes the part offset, rotation and FOV without mutating either pose', () => {
    const frozenFrame = Object.freeze({
      positionM: Object.freeze([...positionM] as const),
      quaternion: Object.freeze([...frame.quaternion] as const),
    })
    const part = Object.freeze({
      positionM: Object.freeze([1, 2, 3] as const),
      quaternion: Object.freeze([0, 0, quarterTurn, quarterTurn] as const),
      fovDeg: 72,
    })
    const pose = fpvCameraPose(frozenFrame, part)
    // Body +X maps to world +Y, +Y to +Z, and +Z to +X.
    expectVector(pose.positionM, [13, 21, 32])
    expectVector(pose.quaternion, [quarterTurn, 0, quarterTurn, 0])
    expectVector(direction(pose, [1, 0, 0]), [0, 0, 1])
    expect(pose.fovDeg).toBe(72)
  })

  it('keeps the chase position and view continuous through ±180°', () => {
    const delta = 1e-6
    const distance = 4
    const chase = (yaw: number) => chaseCameraPose({
      positionM, quaternion: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)],
    }, distance, 3, 55)
    const before = chase(Math.PI - delta)
    const after = chase(-Math.PI + delta)
    // Chord displacement is bounded by radius times arc angle, plus roundoff.
    expectVector(before.positionM, after.positionM, 2 * distance * delta + tolerance)
    expectVector(direction(before, [1, 0, 0]), direction(after, [1, 0, 0]), 2 * delta + tolerance)
  })

  it('uses the projected body-left axis when the nose is vertical', () => {
    const vertical = { positionM, quaternion: [0, quarterTurn, 0, quarterTurn] as Quat }
    expectVector(chaseCameraPose(vertical, 4, 3, 55).positionM, [6, 20, 33])
    const overhead = fixedCameraPose(vertical, [10, 20, 34], 55)
    expectVector(direction(overhead, [1, 0, 0]), [0, 0, -1])
    expectVector(direction(overhead, [0, 0, 1]), [1, 0, 0])
    expect(() => fixedCameraPose(vertical, positionM, 55)).toThrow(RangeError)
  })
})

describe('flight camera view preferences and session isolation', () => {
  const follow = { distanceM: 4, heightM: 3, fovDeg: 45 }
  const settings = startingCameraSettings(follow)

  it('falls back per field for invalid persisted preferences', () => {
    const stored = JSON.parse('{"distanceM":-1,"heightM":2,"fovDeg":"45"}')
    expect(cameraSettingsFromPref(stored, settings)).toEqual({ ...settings, heightM: 2 })
    expect(cameraSettingsFromPref('invalid', settings)).toEqual(settings)
  })

  it('keeps Fixed at its world point until adjusted and Orbit relative to the moving frame', () => {
    const initial = demoFrame(0)
    const later = { ...demoFrame(1), positionM: [4, 2, 1] as Vec3 }
    for (const mode of ['Fixed', 'Orbit'] as const) {
      const state: CameraViewState = {}
      const view = (f: typeof initial, drag = initialDrag) => viewCameraPose(state, f, mode, true, 0, follow, settings, drag)
      const before = view(initial)
      const after = view(later)
      const shift = new Vector3(...after.positionM).sub(new Vector3(...before.positionM))
      const movement = new Vector3(...later.positionM).sub(new Vector3(...initial.positionM))
      expectVector(shift.toArray(), mode === 'Fixed' ? [0, 0, 0] : movement.toArray())
      const adjusted = view(later, { azimuthRad: Math.PI / 2, heightM: 1 })
      expect(adjusted.positionM).not.toEqual(after.positionM)
    }
  })

  it('receives identical session frames and polls the same inputs with every camera', () => {
    vi.useFakeTimers()
    try {
      const script = [demoFrame(0), demoFrame(1), demoFrame(2)]
      const inputs = script.map(({ quaternion }, index) => ({ attitude: quaternion, verticalVelocityMps: index, yawRateRadps: 0 }))
      const mount: CameraPose = { positionM: [1, 0, 0], quaternion: [0, 0, 0, 1], fovDeg: 72 }
      for (const mode of CAMERA_MODES) {
        const source = new FakeFlightSource(script)
        const state: CameraViewState = {}
        const frames: typeof script = []
        const provide = vi.fn(() => inputs[frames.length]!)
        source.subscribe((current) => {
          Object.freeze(current.positionM)
          Object.freeze(current.quaternion)
          Object.freeze(current)
          const pose = viewCameraPose(state, current, mode, true, 1, follow, settings, initialDrag, mount)
          expect(toThreeCameraQuaternion(pose.quaternion).length()).toBeCloseTo(1, 12)
          frames.push(current)
        })
        source.start(provide)
        vi.runAllTimers()
        expect(provide.mock.results.map(({ value }) => value)).toEqual(inputs)
        expect(frames).toEqual(script)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
