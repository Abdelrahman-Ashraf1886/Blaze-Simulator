//! `engine-core` — the drone simulation library.
//!
//! This crate contains only deterministic computation. It performs no IO and
//! knows nothing about Electron, IPC or rendering, so every model can be unit
//! tested in isolation and reused by other hosts.
//!
//! Status (Phase 4.3): the vehicle definition and its validation
//! (`vehicle`), and the fixed-step rigid-body core on rapier (`sim`). Motors,
//! battery, aerodynamics, contacts and the controller follow in 4.4–4.7; see
//! `documentation/plans/phase-4-physics.md`. Modules are added when they
//! contain real, tested models, never as empty stubs. Phase 4.7 adds the tested PX4-style controller.

pub mod controller;
pub mod math;
pub mod sim;
pub mod vehicle;

/// Engine crate version, reported to the host during the handshake.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
