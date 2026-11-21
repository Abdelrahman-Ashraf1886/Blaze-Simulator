/**
 * Viewport image capture. The canvas registers a capture function while it is
 * mounted; the toolbar calls `captureViewport()`.
 */
type Capture = () => Promise<Uint8Array>
let current: Capture | null = null

export function setViewportCapture(fn: Capture | null) {
  current = fn
}

export function captureViewport(): Promise<Uint8Array> {
  if (!current) return Promise.reject(new Error('The 3D view is not ready.'))
  return current()
}

/** Objects with this flag (the move/rotate gizmo) are hidden in captured images. */
export const NO_CAPTURE = 'blazeNoCapture'
