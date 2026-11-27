# ADR 0012 — Distribution and data safety

Date: 2026-11-27. Status: Done, awaiting review.

## Context

Phase 8 prepares a Windows release and adds recovery and diagnostics for local data. App and engine ship together at 0.8.0. The release needs a clean Windows start and a repeatable check of engine results. [Phase 8 decisions](../plans/phase-8-quality.md#decisions-yours-recommendations-followed-from-2026-11-27) · [App version](../../package.json#L4) · [Engine version](../../simulation-engine/Cargo.toml#L6)

## Decision

- Run SQLite `quick_check` at startup. Verify a database copy before changing an older schema and keep the latest three pre-migration copies (D5). Preserve the displaced database during restore and journal the swap. Offer read-only recovery when the integrity check fails. [Copy and restore](../../electron/main/db/safety.ts#L113-L288) · [Retention count](../../electron/main/db/safety.ts#L12) · [Startup recovery](../../electron/main/index.ts#L304-L339)
- Use a bounded `.blazeproj` container to move a single project with its components, assets and optional recordings (D6). Verify the entries and stage import files before publishing them with the database transaction. [Container](../../electron/main/projects/container.ts#L135-L214) · [Transfer](../../electron/main/projects/transfer.ts#L193-L299)
- Keep rotating logs locally and let the user save a diagnostics ZIP (D7). Show what it contains and require opt-in for the project database snapshot. [Logger](../../electron/main/logging/logger.ts#L5-L46) · [Diagnostics](../../electron/main/logging/diagnostics.ts#L56-L94) · [Settings opt-in](../../src/features/settings/SettingsPage.tsx#L32-L38)
- Ship an unsigned per-user Windows x64 installer and portable executable. Keep user data on uninstall. Verify Electron fuses and packaged contents and write SHA-256 checksums. Link the engine's C runtime statically through the repository-root Cargo config so clean Windows can start it. [Builder](../../electron-builder.yml#L12-L57) · [Release checks](../../scripts/release/build.mjs#L112-L145) · [Cargo config](../../.cargo/config.toml#L1-L6)
- Ship three saved inputs and their expected state hashes for Help → Check this computer (D13). Check the engine and protocol versions before comparing hashes. [Self-check](../../electron/main/self-check.ts#L24-L102) · [Help command](../../electron/main/index.ts#L248-L256)

## Consequences

Database restore covers SQLite rows. Full data recovery also needs the model, terrain and recording files. Project export bundles the files for one project. The Sandbox upgrade kept the 0.1.0 project at schema 16. Unit tests cover migration copying. The clean install started the engine after static linking fixed the missing runtime. The unsigned build leaves signing open (D2). The self-check matched on the i7-9750H and still needs a second PC. Terrain over 262,144 samples is refused on import and on stored reads, including terrain saved before 0.8.0. [Copy scope](../../src/features/settings/SettingsSections.tsx#L87-L92) · [Terrain cap](../../src/domain/terrain.ts#L16-L23) · [Stored terrain](../../electron/main/assets/terrain-store.ts#L67-L84) · [Reviewer checks](../DEVLOG.md#reviewer-checks-2026-11-2627)
