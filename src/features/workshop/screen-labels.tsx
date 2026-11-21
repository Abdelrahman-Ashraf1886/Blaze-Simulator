import { useFrame, useThree } from '@react-three/fiber'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Vector3 } from 'three'
import type { Vec3 } from '@/three/views'

/**
 * Screen-space labels for 3D points. Labels are ordinary DOM elements in an
 * overlay above the canvas (so they stay a constant size and are real buttons);
 * a projector inside the canvas moves them on every rendered frame. Rendering is
 * on demand, so idle labels cost nothing.
 */
export class LabelRegistry {
  readonly entries = new Map<string, { el: HTMLElement; position: Vec3 }>()
  private requestFrame: (() => void) | null = null
  /** Called by the projector once the canvas exists. */
  attach(requestFrame: (() => void) | null) {
    this.requestFrame = requestFrame
  }
  /** Asks for a frame so new or moved labels get placed. */
  invalidate() {
    this.requestFrame?.()
  }
}

export const LabelContext = createContext<LabelRegistry | null>(null)

/** A DOM label pinned to a world-space point. Must be rendered inside the viewport overlay. */
export function ScreenLabel({
  id,
  position,
  interactive = true,
  children,
}: {
  id: string
  position: Vec3
  /** False for read-only labels, so they never cover buttons or the canvas. */
  interactive?: boolean
  children: ReactNode
}) {
  const registry = useContext(LabelContext)
  const ref = useRef<HTMLDivElement>(null)
  const [x, y, z] = position
  useLayoutEffect(() => {
    if (!registry || !ref.current) return
    registry.entries.set(id, { el: ref.current, position: [x, y, z] })
    registry.invalidate()
    return () => {
      registry.entries.delete(id)
    }
  }, [registry, id, x, y, z])
  return (
    // Hidden until the first projection places it.
    <div
      ref={ref}
      className={`${interactive ? 'pointer-events-auto' : 'pointer-events-none'} absolute left-0 top-0`}
      style={{ visibility: 'hidden' }}
    >
      {children}
    </div>
  )
}

/** Lives inside the Canvas; projects every registered label each frame. */
export function LabelProjector() {
  const registry = useContext(LabelContext)
  const invalidate = useThree((s) => s.invalidate)
  const size = useThree((s) => s.size)
  const v = useRef(new Vector3())

  useEffect(() => {
    if (!registry) return
    registry.attach(invalidate)
    invalidate()
    return () => registry.attach(null)
  }, [registry, invalidate])

  useFrame(({ camera }) => {
    if (!registry) return
    for (const { el, position } of registry.entries.values()) {
      v.current.set(...position).project(camera)
      const onScreen = v.current.z > -1 && v.current.z < 1 && Math.abs(v.current.x) <= 1.05 && Math.abs(v.current.y) <= 1.05
      const px = ((v.current.x + 1) / 2) * size.width
      const py = ((1 - v.current.y) / 2) * size.height
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -50%)`
      el.style.visibility = onScreen ? 'visible' : 'hidden'
    }
  })
  return null
}
