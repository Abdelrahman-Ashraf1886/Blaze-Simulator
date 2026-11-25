# ADR 0011 — Telemetry recording and sensor models

Date: 2026-11-25. Status: Accepted.

## Context

The flight engine in ADR 0009 starts from perfect state. Phase 7 adds live graphs, saved samples, and the inputs needed to repeat a run. The recording must remain readable after an engine update. The rate loop can also use a modelled gyro. [ADR 0009](0009-px4-controller-perfect-state.md) · [Phase 7 decisions](../plans/phase-7-telemetry.md#decisions-made-with-you)

## Decision

- Keep metadata in SQLite and one recording file per run. At the sample rate, putting samples in SQLite rows would couple time-series writes and reads to the project database. A per-run file gives a sequential append path and keeps the deletion unit the same as the run. Sample inside the engine at exact step boundaries. Main owns file writes and drains a bounded queue. The renderer reads by IPC and can subscribe to live samples through flight replies. [Storage choice](../plans/phase-7-telemetry.md#decisions-made-with-you) · [Sampler](../../simulation-engine/engine-host/src/telemetry.rs#L196-L260) · [Writer](../../electron/main/telemetry/writer.ts#L104-L176) · [IPC](../../electron/ipc/handlers.ts#L91-L114)
- Append typed chunks with checksums for frame headers and payloads. Use little-endian float64 to preserve engine doubles and signed zero. Mark missing values with NaN. Keep the build and exact engine requests and close with the final state hash. Replay reads the saved samples. Verify uses a separate engine and requires matching engine and protocol versions, saved samples, final step count and final state hash. [Format](../../electron/main/telemetry/format.ts#L1-L64) · [Verify](../../electron/main/telemetry/verify.ts#L62-L166)
- Record modelled gyro, accelerometer, barometer and GPS when enabled. Only the rate loop can fly on the modelled gyro. Attitude, position and velocity come from true state, with no estimator. Model one-sided density as white noise over the Nyquist band, with sample sigma `N × √(fs/2)`. Treat entered gyro bias as the residual after calibration and bias correction. The model includes user-entered bias, random walk and delay where supported. Motor and propeller vibration has no physical model. An explicit extra white-noise term can represent a value obtained from a log. [Noise conversion](../../src/domain/sensor-specs.ts#L92) · [Sensor input](../../src/domain/sensors.ts#L174-L198) · [IMU effects](../../simulation-engine/engine-core/src/sensors.rs#L122-L140) · [Signal order](../ARCHITECTURE.md#recorded-sensors)
- Use PX4 v1.13.3 single-precision static notch, two-pole rate low-pass and angular-acceleration alpha filters. Run the cascade at 1 kHz and feed the rate loop on the next controller tick. Prime with the first delivered sample and set initial filtered acceleration to zero. [Rust filters](../../simulation-engine/engine-core/src/gyro_filters.rs#L1-L195) · [PX4 source locations](../DEVLOG.md#px4-v1133-source-lines)

## Consequences

An interrupted file can be read through the last intact chunk. The reader reports checksum failures and Verify requires a complete recording. History and export remain available from saved samples when the original engine version is unavailable. Disk grows with each saved run. The app shows sizes and leaves removal to the user. Filter timing follows the simulator tick and omits PX4's raw FIFO, publication throttle and dynamic notches. [Recovery and verification](../ARCHITECTURE.md#telemetry) · [Filter scope](../../simulation-engine/engine-core/src/gyro_filters.rs#L1-L4)
