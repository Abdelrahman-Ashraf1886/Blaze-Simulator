# ADR 0001: Rust engine runs as a sidecar process

**Status:** accepted (2026-11-20)

## Context
The physics engine must be Rust, never run on the React thread, stay independent
of the UI, and be testable on its own. Options considered: Node-API addon
(napi-rs) loaded in main/utility process; WebAssembly in a Web Worker; separate
executable (sidecar).

## Decision
Ship `drone-engine.exe` as a separate process spawned and supervised by the
Electron main process, speaking a versioned NDJSON protocol over stdio.

## Consequences
- + A crash or hang in the engine cannot take down the UI; the supervisor restarts it.
- + Native threads (rayon etc.) and full `std` are available; no WASM limits.
- + No Node ABI coupling: Electron upgrades never require rebuilding the engine.
- + The engine can be driven by tests, scripts or other front ends without Electron.
- − Serialisation cost per message. Acceptable for control traffic; high-rate
  telemetry will use a binary framed stream (see ARCHITECTURE.md) if profiling
  shows JSON is a bottleneck.
- − One more artefact to package (`extraResources/engine`).
