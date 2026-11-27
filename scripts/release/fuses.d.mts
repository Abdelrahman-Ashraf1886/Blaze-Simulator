export function parseFuseWire(wire: { version: string; [index: number]: number }): Record<string, boolean>
export function verifyFusePolicy(actual: Record<string, boolean>, defaults: Record<string, boolean>): void
export function verifyPackagedFuses(packagedExe: string, stockExe: string): Promise<Record<string, boolean>>
