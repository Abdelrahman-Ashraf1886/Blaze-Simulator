# Blaze UAV

Blaze UAV is a Windows desktop app for designing hobby multicopters and flying them in a simulation. Use it to build a model, check the design, tune the simulated controller, and review recorded runs. The app runs locally. All flight controls act on the simulation.

**Status** · Phase 8, quality and distribution, is in progress. The 0.8.0 Windows build was packaged and checked on the build PC. Clean-PC install and upgrade testing is pending. [Phase 8 plan](documentation/plans/phase-8-quality.md#L74)

## Use the app

Windows 11 x64 is the tested platform. The installer and portable build include the simulation engine. Start with the [user guide](documentation/guide/README.md), [installation](documentation/guide/install.md), or [first build](documentation/guide/workshop.md). See the [release notes and verification instructions](documentation/release/README.md) for the Windows build. [Platform decision](documentation/plans/phase-8-quality.md#L65) · [Engine packaging](electron-builder.yml#L30)

## Develop the app

Use Node.js 22.12+, stable Rust, and Visual Studio C++ build tools. Run commands from the repository root. The packaged app includes its own runtime. [Node.js requirement](package-lock.json#L390) · [Development setup](documentation/ARCHITECTURE.md) · [Command definitions](package.json#L8)

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies and Electron |
| `npm run dev` | Builds the release engine and starts Electron with hot reload |
| `npm run build` | Builds the engine and app in the checkout |
| `npm start` | Previews the built app |
| `npm run typecheck` | Checks the main process, renderer, and end-to-end TypeScript |
| `npm run lint` | Runs ESLint |
| `npm test` | Builds the engine and runs Vitest |
| `npm run engine:test` | Runs the Rust workspace tests |
| `npm run test:e2e` | Builds the app and runs Playwright against it |
| `npm run test:all` | Runs Rust tests, typecheck, lint, Vitest, and Playwright |
| `npm run test:flight-perf` / `npm run profile` | Measures flight performance / runs the profiling script |
| `npm run validation-report` | Generates the validation report |
| `npm run dist` | Builds the Windows installer and portable executable |
| `npm run release` | Builds and verifies the Windows release and writes its checksums |
| `npm run notices` / `npm run icon` | Generates third-party notices / renders the app icon |

## Repository layout

`electron/` contains the main process, preload and IPC. `src/` contains the React interface. `simulation-engine/` contains the Rust workspace. `database/migrations/` holds the database schema changes. `tests/` holds the tests, and `build/` holds packaging assets. See the [architecture](documentation/ARCHITECTURE.md), [roadmap](documentation/ROADMAP.md), and [design language](documentation/DESIGN.md).

Blaze UAV is copyright © 2026 Blaze UAV contributors. All rights reserved. [Release terms](documentation/release/README.md#L3)
