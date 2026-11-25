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
//! contain real, tested models, never as empty stubs.

pub mod aero;
pub mod thrust_model;
pub mod ground_effect;
pub mod closed_loop;
pub mod environment;
pub mod flight;
pub mod flight_loop;
pub mod flight_modes;
pub mod math;
pub mod propulsion;
pub mod takeoff;
pub mod land_detector;
pub mod auto_modes;
pub mod scenario;
pub mod step_test;
pub mod trace;
pub mod sim;
pub mod vehicle;
pub mod hover_thrust;
pub mod controller;
pub mod position_control;
pub mod wind;
mod turbulence;

/// Engine crate version, reported to the host during the handshake.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
