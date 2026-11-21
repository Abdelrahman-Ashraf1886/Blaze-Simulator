/**
 * TypeScript mirror of `simulation-engine/engine-host/src/protocol.rs`.
 * Both sides must change together; bump PROTOCOL_VERSION on breaking changes.
 */
export const PROTOCOL_VERSION = 1

export type EngineCommand = { type: 'hello' } | { type: 'ping' } | { type: 'shutdown' }

export interface HelloResult {
  engineVersion: string
  protocolVersion: number
  threads: number
}

export interface PongResult {
  engineUptimeUs: number
}

export interface EngineErrorBody {
  code: 'INVALID_JSON' | 'INVALID_REQUEST'
  message: string
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: EngineErrorBody }

export function isEngineResponse(v: unknown): v is EngineResponse {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.ok === 'boolean' && (typeof o.id === 'number' || o.id === null)
}
