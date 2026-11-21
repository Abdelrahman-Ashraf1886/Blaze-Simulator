import type { DesktopApi, IpcResult } from '../../electron/ipc/contract'

/** Error raised in the renderer when an IPC call returns `ok: false`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw new ApiError(result.error.code, result.error.message)
}

/** Indirection so stores can be tested with a fake API. */
export function getApi(): DesktopApi {
  // `globalThis` is `window` in the renderer; avoids a DOM-lib dependency so
  // stores can be type-checked and tested under Node.
  return (globalThis as typeof globalThis & { api: DesktopApi }).api
}
