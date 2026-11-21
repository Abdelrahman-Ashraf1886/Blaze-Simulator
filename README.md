# Blaze UAV

Desktop drone engineering and flight simulation workstation: Electron + React UI,
Rust simulation engine, SQLite storage. Status: **Phase 1 (foundation)**, see
[documentation/ROADMAP.md](documentation/ROADMAP.md).

## Requirements (development only)
Node 22.12+, Rust (stable), Visual Studio C++ build tools. The installed app needs none of these.

## Commands
| Command | What it does |
|---|---|
| `npm install` | Installs deps and downloads Electron |
| `npm run dev` | Builds the engine (release), then starts the app with hot reload |
| `npm test` | Engine build plus Vitest unit/integration tests |
| `npm run engine:test` | Rust tests |
| `npm run test:e2e` | Production build plus Playwright tests against the real app |
| `npm run test:all` | Everything above, plus typecheck and lint |
| `npm run dist` | Windows NSIS installer and portable exe in `release/<version>/` |
| `npm run icon` | Re-renders `build/icon.png` from `build/icon.svg` |

Code signing: set `CSC_LINK` and `CSC_KEY_PASSWORD` before `npm run dist`.

## Layout
`electron/` main, preload and IPC · `src/` React renderer · `simulation-engine/` Rust
workspace · `database/migrations/` SQL · `tests/` unit and e2e · `build/` icon sources ·
`documentation/` architecture, [design language](documentation/DESIGN.md), ADRs, roadmap, dev log.
