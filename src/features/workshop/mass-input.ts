/**
 * The assembly as the mass calculation (src/domain/mass.ts) sees it: every body
 * placed in body coordinates, and the thrust points of the motor mounts.
 *
 * Frame: its entered mass spread over a uniform-density model of the parametric
 * frame (one plate of plateSize² × armThickness plus each arm's length outside the
 * plate, armWidth × armThickness), so the frame's own CoM and inertia follow its
 * shape. Holes, chamfers and screws are ignored (labelled in the UI).
 */
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { AssemblyDocument, PartShape } from '../../../electron/ipc/contract'
import {
  hoverBalance,
  massProperties,
  type BodyInput,
  type CollisionShape,
  type HoverBalance,
  type MassProperties,
  type MotorInput,
  type Quat,
  type Vec3,
} from '../../domain/mass'
import type { FrameGeometry } from '../../three/frame-geometry'
import { mountFrames, shapeExtent, worldMatrix, type AssetBounds } from './assembly-ops'
import { effectiveMass, effectiveShape, type ComponentIndex } from './links'

export const FRAME_BODY_ID = 'frame'

/** The frame as boxes of uniform density: id suffix, centre, size, rotation about Z. */
export function frameBoxes(geo: FrameGeometry, plateSize: number, armWidth: number, t: number) {
  const boxes: { id: string; center: Vec3; size: Vec3; angle: number }[] = [
    { id: `${FRAME_BODY_ID}:plate`, center: [0, 0, t / 2], size: [plateSize, plateSize, t], angle: 0 },
  ]
  geo.arms.forEach((arm, i) => {
    const dir = geo.motors[i]!.armDirection
    // Where the arm's centre line leaves the square plate.
    const exit = plateSize / 2 / Math.max(Math.abs(dir[0]), Math.abs(dir[1]), 1e-12)
    const length = arm.length - exit
    if (length <= 0) return
    const mid = exit + length / 2
    boxes.push({ id: `${FRAME_BODY_ID}:arm-${i + 1}`, center: [dir[0] * mid, dir[1] * mid, t / 2], size: [length, armWidth, t], angle: arm.angle })
  })
  return boxes
}

const quatZ = (angle: number): Quat => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]

export function collisionShape(shape: PartShape, assets: AssetBounds): CollisionShape {
  if (shape.type === 'box') return { type: 'box', halfExtents: shape.size.map((v) => v / 2) as Vec3 }
  if (shape.type === 'cylinder') return { type: 'cylinder', radius: shape.radius, halfHeight: shape.height / 2 }
  // An imported model is taken as its bounding box until its hull is computed at import (open after 4.4).
  const extent = shapeExtent(shape, assets) ?? [0, 0, 0]
  return { type: 'box', halfExtents: extent.map((v) => v / 2) as Vec3 }
}

function pose(m: Matrix4): { position: Vec3; quaternion: Quat } {
  const p = new Vector3()
  const q = new Quaternion()
  m.decompose(p, q, new Vector3())
  q.normalize()
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] }
}

export function massBodies(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  components: ComponentIndex,
  assets: AssetBounds = {},
): BodyInput[] {
  const { plateSize, armWidth, armThickness: t } = doc.frame
  const boxes = frameBoxes(geo, plateSize, armWidth, t)
  const frameMass = doc.frameMass?.valueKg ?? null
  const bodies: BodyInput[] = []
  if (frameMass === null) {
    bodies.push({ id: FRAME_BODY_ID, name: 'Frame', massKg: null, model: 'solid', shape: { type: 'box', halfExtents: [0, 0, 0] }, position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  } else {
    const volume = boxes.reduce((s, b) => s + b.size[0] * b.size[1] * b.size[2], 0)
    for (const b of boxes) {
      bodies.push({
        id: b.id,
        name: b.id === `${FRAME_BODY_ID}:plate` ? 'Frame plate' : `Frame arm ${b.id.split('-').pop()}`,
        massKg: (frameMass * b.size[0] * b.size[1] * b.size[2]) / volume,
        model: 'solid',
        shape: { type: 'box', halfExtents: b.size.map((v) => v / 2) as Vec3 },
        position: b.center,
        quaternion: quatZ(b.angle),
      })
    }
  }
  for (const p of doc.parts) {
    const placed = pose(worldMatrix(doc, geo, p.id))
    bodies.push({
      id: p.id,
      name: p.name,
      massKg: effectiveMass(p, components)?.valueKg ?? null,
      model: p.kind === 'propeller' ? 'propeller' : 'solid',
      shape: collisionShape(effectiveShape(p, components), assets),
      ...placed,
      override: p.inertia ? { inertia: p.inertia.inertia, comOffset: p.inertia.comOffset } : null,
    })
  }
  return bodies
}

/**
 * One thrust point per motor mount. With a motor on the mount, thrust acts at the
 * prop hub (the prop's centre) or, without a prop, at the top of the motor; with an
 * empty mount, at the mount surface. The axis is the mount's +Z (tilt included).
 */
export function motorInputs(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  components: ComponentIndex,
  assets: AssetBounds = {},
): MotorInput[] {
  const frames = mountFrames(geo)
  return geo.motors.map((mount) => {
    const frame = frames.get(mount.id)!
    const axis = new Vector3(0, 0, 1).applyQuaternion(frame.quaternion)
    const motor = doc.parts.find((p) => p.kind === 'motor' && p.parentId === null && p.mountId === mount.id)
    const prop = motor && doc.parts.find((p) => p.kind === 'propeller' && p.parentId === motor.id)
    let position: Vec3 = [...mount.position]
    if (prop) position = pose(worldMatrix(doc, geo, prop.id)).position
    else if (motor) {
      const h = (shapeExtent(effectiveShape(motor, components), assets)?.[2] ?? 0) / 2
      const top = new Vector3(0, 0, h).applyMatrix4(worldMatrix(doc, geo, motor.id))
      position = [top.x, top.y, top.z]
    }
    return {
      partId: motor?.id ?? mount.id,
      name: `Motor ${mount.number}`,
      position,
      thrustAxis: [axis.x, axis.y, axis.z],
      spin: mount.spin,
    }
  })
}

export interface MassState {
  mp: MassProperties
  motors: MotorInput[]
  /** null until the CoM is known. */
  hover: HoverBalance | null
}

/** Mass properties of a document (pure; also used by the checks). */
export function massState(
  doc: AssemblyDocument,
  geo: FrameGeometry,
  components: ComponentIndex,
  assets: AssetBounds = {},
): MassState {
  const mp = massProperties(massBodies(doc, geo, components, assets))
  const motors = motorInputs(doc, geo, components, assets)
  const hover = mp.com ? hoverBalance(motors, mp.com, mp.totalMassKg) : null
  return { mp, motors, hover }
}

