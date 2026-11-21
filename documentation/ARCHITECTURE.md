# Architecture

```
┌──────────────────────────── Electron app ────────────────────────────┐
│                                                                      │
│  Renderer (sandboxed, no Node)          Main process (Node)          │
│  React · Router · Zustand · Tailwind    ┌──────────────────────┐     │
│  three / R3F (Phase 2+)                 │ IPC handlers (zod)   │     │
│        │  window.api (preload)          │ Repositories ─ SQLite│     │
│        └────── ipcRenderer.invoke ────▶ │ EngineSupervisor     │     │
│        ◀───── engine:statusChanged ──── └─────────┬────────────┘     │
│                                                   │ stdin/stdout     │
└───────────────────────────────────────────────────┼──────────────────┘
                                                    │ NDJSON protocol v1
                                      ┌─────────────▼─────────────┐
                                      │ drone-engine (Rust)       │
                                      │  engine-host: protocol,   │
                                      │    scheduling, threads    │
                                      │  engine-core: pure models │
                                      └───────────────────────────┘
```

## Processes and responsibilities

| Layer | Path | Owns | Must not |
|---|---|---|---|
| Renderer | `src/` | Presentation, interaction, view state | Touch disk, DB or the engine directly; run expensive computation |
| Preload | `electron/preload/` | Exposes the typed `window.api` (`DesktopApi`) | Import runtime libraries (keeps sandbox bundle tiny) |
| IPC contract | `electron/ipc/contract.ts` | Channel names, request schemas, result envelope, shared types | — |
| Main | `electron/main/` | Window/security, SQLite, engine lifecycle | Do simulation math |
| Engine host | `simulation-engine/engine-host` | Wire protocol, process loop, (later) real-time scheduler | Contain physics |
| Engine core | `simulation-engine/engine-core` | All physical models | Perform IO |

## Engine protocol (v1)

Newline-delimited JSON on stdin/stdout; stderr is log only.

| Request | Response `result` |
|---|---|
| `{"id":n,"type":"hello"}` | `{engineVersion, protocolVersion, threads}` |
| `{"id":n,"type":"ping"}` | `{engineUptimeUs}` |
| `{"id":n,"type":"shutdown"}` | `{}` then the process exits 0 |

Errors: `{"id":n|null,"ok":false,"error":{"code":"INVALID_JSON"|"INVALID_REQUEST","message"}}`.
A malformed line never terminates the engine. Rust source of truth:
`engine-host/src/protocol.rs`; TS mirror: `electron/main/engine/protocol.ts`.

**Planned evolution:** simulation control commands (Phase 4–6) are added to the
same channel. High-rate state/telemetry streaming will use a dedicated
binary-framed stream forwarded to the renderer through a `MessagePort`, so the
renderer receives frames without going through `ipcMain` per message.

## Engine supervision

`EngineSupervisor` (`electron/main/engine/supervisor.ts`): spawn → `hello`
handshake (protocol version must match, otherwise `failed` without retry) →
health `ping` every 2 s (round-trip shown in UI) → on exit/timeout, restart with
backoff `[250, 1000, 3000] ms`; after 5 consecutive failed starts → `failed`.
Clean shutdown on app quit sends `shutdown`, then kills after 1 s; the app quits
after at most 3 s even if the engine never exits. Start failures are reported in
plain language ("Engine executable not found: …", "Not allowed to start …").

Every status carries a monotonically increasing `revision`. The renderer keeps
the highest revision it has seen, so a status snapshot that arrives after a newer
push cannot roll the UI back (e.g. from `failed` to `restarting`).

## Desktop shell

- **Single instance** per userData directory; a second launch focuses the
  existing window and exits.
- **Window size** is 90 % of the work area of the display under the cursor
  (≤ 1680×1050), centred. Minimum 880×560 DIP, which fits a 1366×768 laptop at
  125 % scaling. `nativeTheme` is forced dark, so the title bar and menus match.
- **Database errors at startup** (e.g. a file from a newer app version) show a
  native error box naming the file, then exit without modifying it.
- **Help → About** lists app, engine, Electron/Chromium/Node versions and the data
  file location. The menu bar auto-hides; press Alt to show it.
- `BLAZE_UAV_USER_DATA` and (unpackaged builds only) `BLAZE_UAV_ENGINE` override
  the data directory and engine path for tests.

## Storage

SQLite (`better-sqlite3`, Node-API prebuilds, loads in both Node and Electron)
at `<userData>/blaze-uav.db`, WAL mode, foreign keys on. Schema version =
`PRAGMA user_version`; migrations in `database/migrations/NNNN_*.sql` are
append-only and run in a transaction each. Opening a DB from a newer app version
is refused rather than risking data loss.

**Assemblies** (schema v2): one per project, saved as a whole document with
optimistic concurrency. Each save carries the revision it was based on, and main
rejects it with `CONFLICT` if the stored revision differs. The renderer debounces
saves (500 ms), keeps at most one in flight, and on window unload saves
synchronously (`assembly:saveSync`). The database is closed on `will-quit`, after
every window has unloaded. Undo/redo lives in the renderer as document snapshots.

**Imported models** (schema v4): main validates a picked `.glb`/`.gltf`
(`electron/main/assets/gltf.ts`: 50 MB limit, signature, glTF 2.0, embedded data
only, no unsupported compression) and copies it to
`<userData>/assets/<sha256>.<ext>`; the `assets` table holds file facts (name,
size, triangles, bounds). The renderer loads models only through
`blaze-asset://model/<sha256>`, a privileged protocol whose handler serves exact
ids from that folder and nothing else. Units and up axis are part of each model
part's shape. Unused assets are removed at startup.

**Viewport images**: the renderer renders and encodes the PNG; main validates it
(`viewport:savePng`), asks where to save it, and writes the file. The renderer
never touches the disk. ADR 0003 covers the Z-up renderer, ADR 0004 the asset
store.

Component specifications (Phase 3) store each value with provenance:
`{value, unit, source: "manufacturer" | "user" | "estimated", reference}`.

## Security

`contextIsolation`, `sandbox`, no `nodeIntegration`; CSP header (`script-src 'self'`
in production); navigation and `window.open` blocked (https links go to the
system browser); every IPC payload validated with zod in main; renderer only
receives `{ok, data} | {ok:false, error:{code, message}}` with internal errors
logged, not leaked.

## Coordinate and unit conventions

SI units, `f64` state, right-handed Z-up world frame (+X forward, +Y left,
+Z up), gravity `(0, 0, -9.80665)`. Conversions (e.g. NED for PX4) happen only
at integration boundaries.
