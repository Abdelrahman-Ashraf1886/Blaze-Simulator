import type { DesktopApi } from '../../electron/ipc/contract'

declare global {
  interface Window {
    api: DesktopApi
  }
}

export {}
