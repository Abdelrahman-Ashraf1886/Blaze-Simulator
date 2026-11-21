/**
 * Outlines of the carbon frame, in metres, for extrusion. Pure (three.js Shape
 * only), so the outlines can be tested without WebGL.
 *
 * Centre plate: a square of `plateSize` with chamfered corners, two battery-strap
 * slots, four lightening holes and — when the plate is large enough — the common
 * 30.5 × 30.5 mm flight-controller bolt pattern.
 *
 * Arm (local x from the frame centre towards the motor): starts under the plate,
 * tapers from 1.35 × to 1 × the arm width, has lightening slots, and ends in a
 * round motor pad (radius 1.05 × arm width) with a shaft clearance hole and four
 * motor bolt holes. These are visual details of a typical frame, not measurements
 * of any product; the frame's stated parameters (diagonal, arm width/thickness,
 * plate size) are unchanged.
 */
import { Path, Shape } from 'three'

const circle = (x: number, y: number, r: number) => {
  const p = new Path()
  p.absarc(x, y, r, 0, Math.PI * 2, false)
  return p
}

/** A rounded slot (stadium) along x or y. */
function slot(cx: number, cy: number, length: number, width: number, alongX: boolean) {
  const r = width / 2
  const h = Math.max(0, length / 2 - r)
  const p = new Path()
  if (alongX) {
    p.moveTo(cx - h, cy - r)
    p.lineTo(cx + h, cy - r)
    p.absarc(cx + h, cy, r, -Math.PI / 2, Math.PI / 2, false)
    p.lineTo(cx - h, cy + r)
    p.absarc(cx - h, cy, r, Math.PI / 2, (3 * Math.PI) / 2, false)
  } else {
    p.moveTo(cx + r, cy - h)
    p.lineTo(cx + r, cy + h)
    p.absarc(cx, cy + h, r, 0, Math.PI, false)
    p.lineTo(cx - r, cy - h)
    p.absarc(cx, cy - h, r, Math.PI, Math.PI * 2, false)
  }
  return p
}

export function plateShape(size: number): Shape {
  const h = size / 2
  const k = size * 0.2 // chamfer
  const s = new Shape()
  s.moveTo(-h + k, -h)
  s.lineTo(h - k, -h)
  s.lineTo(h, -h + k)
  s.lineTo(h, h - k)
  s.lineTo(h - k, h)
  s.lineTo(-h + k, h)
  s.lineTo(-h, h - k)
  s.lineTo(-h, -h + k)
  s.closePath()
  // Battery-strap slots either side of the centre.
  s.holes.push(slot(0, size * 0.3, size * 0.42, size * 0.07, true), slot(0, -size * 0.3, size * 0.42, size * 0.07, true))
  // Lightening holes on the diagonals.
  for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) s.holes.push(circle(x * size * 0.25, y * size * 0.1, size * 0.045))
  // Flight-controller stack pattern, when it fits between the slots.
  if (size >= 0.07) for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) s.holes.push(circle(x * 0.01525, y * 0.01525, 0.0016))
  return s
}

export interface ArmOutline {
  shape: Shape
  /** Where the arm starts under the plate, and the motor pad radius (for hardware placement). */
  root: number
  padRadius: number
  rootWidth: number
}

export function armShape(length: number, width: number, plateSize: number): ArmOutline {
  const root = plateSize * 0.3
  const wr = width * 1.35
  const wt = width
  const pr = width * 1.05
  const cx = Math.sqrt(pr * pr - (wt / 2) ** 2)
  const s = new Shape()
  s.moveTo(root, -wr / 2)
  s.lineTo(length - cx, -wt / 2)
  s.absarc(length, 0, pr, Math.atan2(-wt / 2, -cx), Math.atan2(wt / 2, -cx), false)
  s.lineTo(root, wr / 2)
  s.closePath()
  // Lightening slots between the plate edge and the pad.
  const from = plateSize * 0.6
  const to = length - pr * 1.7
  const pitch = width * 1.9
  const n = Math.max(0, Math.floor((to - from) / pitch))
  for (let i = 0; i < n; i++) s.holes.push(slot(from + (i + 0.5) * ((to - from) / n), 0, width * 1.1, width * 0.36, true))
  // Motor pad: shaft clearance and four bolt holes on the diagonals.
  s.holes.push(circle(length, 0, width * 0.18))
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2
    s.holes.push(circle(length + Math.cos(a) * width * 0.48, Math.sin(a) * width * 0.48, Math.max(width * 0.055, 0.0008)))
  }
  return { shape: s, root, padRadius: pr, rootWidth: wr }
}
