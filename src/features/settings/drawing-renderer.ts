let renderer: string | null | undefined

/** Probe once per renderer process without retaining a canvas or a WebGL context. */
export function getDrawingRenderer(): string | null {
  if (renderer !== undefined) return renderer
  renderer = null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const gl = canvas.getContext('webgl2')
  if (gl) {
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      if (info) {
        const name: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
        if (typeof name === 'string' && name.trim()) renderer = name
      }
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
  return renderer
}
