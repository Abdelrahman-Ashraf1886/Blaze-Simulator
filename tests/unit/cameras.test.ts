import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { chaseCameraPose, fixedCameraPose, fpvCameraPose, orbitCameraPose, type CameraPose } from '../../src/features/flight/cameras'
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
