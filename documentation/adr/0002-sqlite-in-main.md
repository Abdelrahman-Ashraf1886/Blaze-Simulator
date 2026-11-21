# ADR 0002: SQLite lives in the main process

**Status:** accepted (2026-11-20)

## Context
Projects, simulation history and the component library need durable local
storage. The renderer is sandboxed and must not access the filesystem.

## Decision
Use `better-sqlite3` in the Electron main process only. The renderer reaches data
exclusively through typed, zod-validated IPC handlers backed by repository
functions. Schema changes are append-only SQL migrations tracked by
`PRAGMA user_version`.

## Consequences
- + Single writer, synchronous API, simple transactions.
- + v13 ships Node-API prebuilds, so the same binary loads in Node (Vitest) and
  Electron, with no electron-rebuild step.
- − Synchronous queries block main while running; keep queries indexed and small.
  Bulk telemetry storage (Phase 7) will be written in batches or moved to a
  worker if measurements show main-thread stalls.
