import { join } from 'node:path'

export function thirdPartyNoticesPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  const base = isPackaged ? resourcesPath : join(appPath, 'build')
  return join(base, 'notices', 'THIRD-PARTY-NOTICES.txt')
}
