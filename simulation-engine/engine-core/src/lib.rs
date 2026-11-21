//! `engine-core` — the drone simulation library.
//!
//! This crate contains only deterministic computation. It performs no IO and
//! knows nothing about Electron, IPC or rendering, so every model can be unit
//! tested in isolation and reused by other hosts.
//!
//! Status (Phase 1): only foundational math types exist. Physics, aerodynamics,
//! motor, battery, controller and sensor models are added in Phases 4–7; see
//! `documentation/ROADMAP.md`. Modules are added when they contain real,
//! tested models, never as empty stubs.

pub mod math;

/// Engine crate version, reported to the host during the handshake.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
