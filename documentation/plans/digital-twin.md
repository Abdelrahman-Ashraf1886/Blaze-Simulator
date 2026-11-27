# Digital twin implementation plan: Phases 9–15

Status (2026-11-26): **Planned; implementation has not started.** This plan extends
the existing simulator roadmap. Phase 8 remains the quality and distribution plan;
its open decisions are not resolved by this document.

## Outcome and scope

Blaze UAV will maintain a versioned digital counterpart of a specific physical UAV,
update it from that aircraft's measurements, and produce predictions whose accuracy
and limits are demonstrated on independent data. The first supported use case is
hover power and remaining endurance for one multicopter, one supported PX4 firmware
version, and a documented payload and operating envelope. Controller-response
validation follows when firmware integration is available.

The first release supports one connected aircraft at a time on Windows. PX4 ULog
is the proposed first import format and MAVLink 2 the proposed live transport.
These are planning defaults based on the current PX4-derived simulator, not claims
that an aircraft or flight log has already been supplied. ArduPilot, fleet services,
cloud storage, automatic parameter writes and autonomous aircraft control are later
extensions. A useful twin does not require autonomous control.

Completion is judged against the declared use case and operating envelope. It does
not mean every physical effect is modelled or every aircraft type is supported.

## Starting point

- Phases 1–7 provide assemblies, sourced component specifications, mass properties,
  propulsion and battery models, deterministic physics, PX4 v1.13.3-derived control,
  environments, simulated sensors, recordings, replay, graphs and reports.
- Phase 7 deferred ULog and an attitude estimator. Most control feedback still uses
  exact simulated state; only the rate loop optionally uses a modelled gyro.
- Current live simulation advances from renderer requests and can lose simulated
  time during slow rendering. Physical telemetry and live prediction need an
  independent clock and must not inherit that behavior.
- Existing recording Verify checks deterministic simulation replay. It does not
  establish agreement with physical flight. Imported measurements need a distinct
  provenance and validation path.
- Phase 8's analytical validation remains useful but does not substitute for the
  aircraft-specific evidence required below.

## Sequence and dependencies

| Phase | Result | Depends on |
|---|---|---|
| 9 Aircraft identity and evidence | A physical aircraft linked to immutable build and measurement snapshots | Phase 8 data-safety and migration work before shipping new persisted data |
| 10 Real flight data and comparison | Traceable ULog import, replay and measured-versus-simulated comparisons | 9; a representative real log for aircraft-level acceptance |
| 11 Calibration and independent validation | A calibrated model with quantified error and a defined validity envelope | 10; measured bench data and separate validation flights |
| 12 Live synchronization and prediction | A live, read-only twin with explicit timing, freshness and uncertainty | 11; access to the target aircraft and telemetry link |
| 13 Actual firmware integration | Repeatable SITL comparisons and, when needed, HITL evidence | 10–11; 12 transport/clock infrastructure before HITL |
| 14 Lifecycle and health | Predictions follow component changes, battery ageing and maintenance | 11–12; firmware compatibility evidence from 13 where relevant |
| 15 Digital twin acceptance | Packaged, documented release with end-to-end physical evidence | 9–14 and applicable Phase 8 release gates |

Start identity schemas and offline import fixtures while Phase 8 work proceeds.
Finish data safety before releasing them. Complete the offline validated model
before live prediction; add SITL after offline comparison without waiting for all
live UI work. No calendar duration is committed until hardware, logs and validation
access are known.

## Phase 9 — Aircraft identity and evidence

**Goal:** every measurement and prediction names the actual aircraft configuration
it represents, including the configuration that existed at the time of a flight.

| Milestone | Delivers |
|---|---|
| 9.0 Reference aircraft and validation contract | Select aircraft, PX4 version, available instruments and logs, initial use case, operating envelope and required evidence. Register numerical pass limits before fitting models. |
| 9.1 Aircraft registry | Stable aircraft ID; serial/asset identifiers where available; links to a project and physical component instances, including battery and payload. Keep aircraft identity separate from mutable MAVLink system IDs. |
| 9.2 Configuration snapshots | Immutable assembly, mass/CoM/inertia, component, sensor mounting, firmware, parameter and environment snapshots with effective times, hashes and a change reason. Historical runs retain the snapshot used then. |
| 9.3 Evidence store | Preserve original logs and bench measurements with checksums, acquisition time, source, units, instrument accuracy where known and configuration links. Extend current value provenance with structured measurement conditions and uncertainty. |
| 9.4 Data migration and portability | Migrations, backup/restore and export/import for aircraft, evidence and snapshots. Reuse Phase 8 project packaging; large recordings remain explicit export choices. |

**Acceptance:** two aircraft can share a design without sharing history; replacing a
battery or payload creates a new effective configuration without changing old runs;
export/import preserves evidence hashes and snapshot references. Missing firmware,
mass or measurement accuracy remains unknown rather than receiving an invented value.

**Likely areas:** `electron/main/db/`, `database/migrations/`, `electron/ipc/`,
`src/features/projects/`, `src/features/components/`, new aircraft/evidence modules.

## Phase 10 — Real flight data and comparison

**Goal:** reproduce and inspect a real flight, then compare equivalent quantities
without silently changing clocks, frames or signal meanings.

| Milestone | Delivers |
|---|---|
| 10.0 Import contract and fixtures | Pin supported ULog/PX4 schemas and parser dependency after a capability/licence review. Inventory required topics and test real, truncated, oversized, unsupported and incomplete logs. |
| 10.1 Loss-aware ULog importer | Preserve original file; extract available sensor, estimated-state, actuator, battery, controller, firmware and parameter data. Store channel provenance, units, sample rate, gaps and import diagnostics. |
| 10.2 Measurement channel model | Separate raw measurements, onboard estimates, simulator truth and model predictions. Normalize NED/FRD to Blaze's Z-up/FLU at a tested boundary; preserve origins, quaternion convention and altitude reference. Do not fill unavailable motors, RPM or current with fabricated values. |
| 10.3 Clock and comparison tools | Retain source and receive/import timestamps; split reboot/reset segments; expose estimated offsets and uncertainty. Resample only for explicit comparisons, document interpolation and never interpolate across a declared gap. Align equivalent filtered signals and account for delay. |
| 10.4 Real replay and controlled simulation | Real-flight 3D replay, synchronized graphs and a comparison report. Reconstruct initial state and available inputs; distinguish actuator-driven plant replay from controller-driven replay. Report unknown wind or missing inputs as limitations. |

**Acceptance:** known frame/time fixtures transform correctly; import/reopen/export
preserves channel meaning and gaps; a real log replays with its configuration;
overlays report bias, RMSE, peak error, usable duration and excluded intervals.
Onboard position estimates are labelled as estimates, not independent ground truth.
Imported logs use integrity checks, not the simulator's deterministic Verify claim.

**Likely areas:** `electron/main/telemetry/`, `src/domain/telemetry-channels.ts`,
`src/features/telemetry/`, `src/features/flight/frame.ts`, new import/comparison modules.

## Phase 11 — Calibration and independent validation

**Goal:** make the model representative of the selected aircraft and demonstrate
useful predictive accuracy on measurements not used to fit it.

| Milestone | Delivers |
|---|---|
| 11.0 Measurement campaign | Document mass/CoM measurements, available inertia evidence, motor/propeller thrust and response, battery discharge/sag, and flight conditions. Define instrument needs and a repeatable collection procedure. Record parameters that cannot be identified from available evidence. |
| 11.1 Calibration engine | Fit bounded, physically meaningful parameters in stages: propulsion, battery, then drag and relevant sensor effects. Report fit residuals, parameter uncertainty, sensitivity and correlations; refuse unsupported estimates instead of fitting every parameter to one flight. |
| 11.2 Calibration versions | Immutable candidate and accepted parameter sets tied to evidence, algorithms and engine versions. Review before activation; support rollback and comparison with the original model. Never overwrite sourced manufacturer specifications with fitted values. |
| 11.3 Independent validation | Freeze fitting data and a separate validation set before fitting. Compare baseline and calibrated predictions for hover power, consumed energy and endurance under defined conditions; add motion/control metrics when the inputs support them. Failed validation remains visible. |
| 11.4 Validity and uncertainty | Publish supported mass/payload, voltage, temperature, wind and maneuver ranges. Use uncertainty propagation or parameter ensembles to provide prediction intervals; check interval coverage on validation data. Flag extrapolation and invalidate affected claims after material changes. |

**Acceptance:** calibration is reproducible from preserved inputs; held-out flights
meet the numerical contract from 9.0; the report includes sample counts, conditions,
measurement uncertainty, baseline errors, calibrated errors and prediction-interval
coverage. Agreement with onboard estimates is distinguished from externally measured
accuracy. Bench-only or synthetic evidence cannot pass the real-flight gate.

**Likely areas:** new `src/domain/calibration/`, main-process calibration jobs,
engine batch interfaces, `src/features/analysis/`, validation fixtures and reports.

## Phase 12 — Live synchronization and prediction

**Goal:** maintain current measured state and run useful predictions alongside the
aircraft without allowing rendering delays to alter ingestion or model time.

| Milestone | Delivers |
|---|---|
| 12.0 MAVLink transport | Serial and UDP adapters outside the renderer, explicit aircraft selection, heartbeat/reconnect handling, bounded queues and recording. Check firmware and configuration compatibility; unknown compatibility is visible. Initial operation is read-only, apart from protocol exchanges for discovery, stream setup and time synchronization. |
| 12.1 Independent clock and ingestion | Timestamp messages on arrival and retain onboard timestamps. Estimate clock offset/drift with MAVLink TIMESYNC where supported; detect boot resets, out-of-order messages, loss and duplicates. Define stale thresholds per channel and a clock-error budget. |
| 12.2 Live state adapter | Feed existing graphs and 3D views through a physical-aircraft source. Distinguish measured state, onboard estimates and display interpolation. Preserve discontinuities and show disconnected, stale and unknown states. No UI request advances the physical timeline. |
| 12.3 Prediction sessions | Initialize a separate simulation from a supported synchronized state, including calibrated battery state and required controller/motor state where identifiable. Add explicit engine state initialization/snapshot support; do not assume position and attitude alone reproduce hidden state. Run endurance/energy forecasts with uncertainty and stated mission assumptions. |
| 12.4 Operational evidence | Record telemetry, configuration, clock mapping and model revisions so live results can be reproduced offline. Measure throughput, source-to-ingestion age, processing latency and queue growth separately from display latency. |

**Acceptance:** a timestamped replay rig exercises loss, jitter, reordering, reboot,
disconnect and reconnect. A blocked renderer does not stop ingestion or corrupt
time; a one-hour run meets predeclared latency, memory and loss budgets. Missing
clock evidence is reported rather than presented as exact synchronization. Physical
aircraft tests confirm identity, freshness and forecast behavior; insufficient or
stale inputs suppress affected predictions rather than producing confident values.

**Likely areas:** new `electron/main/aircraft/`, engine host scheduling/state APIs,
`src/features/flight/` source adapters, telemetry buffers and live status UI.

## Phase 13 — Actual firmware integration

**Goal:** test the supported aircraft firmware against the same calibrated plant,
and quantify differences from the existing PX4 v1.13.3-derived controller.

| Milestone | Delivers |
|---|---|
| 13.0 Firmware compatibility contract | Pin the actual PX4 release, airframe, parameters, mixer/allocator, actuator mapping, estimator inputs and supported simulation interface. Record differences from Blaze's controller port. |
| 13.1 SITL bridge | Exchange simulated sensor/environment inputs and firmware actuator outputs; define units, frames, saturation, scheduling and a simulation clock. Keep the ported-controller mode available and clearly labelled. |
| 13.2 Sensor/estimator path | Let the actual firmware estimator process modelled sensors, including configured noise and delay. Compare estimator outputs with simulator truth and logged flight estimates. Add missing sensor effects only when evidence requires them. |
| 13.3 Firmware comparison suite | Repeat hover, response, payload and disturbance cases with frozen firmware/configuration. Report estimator, actuator and trajectory differences; pin seeds and record timing, without promising bitwise firmware determinism. |
| 13.4 HITL qualification, conditional | If the use case requires controller hardware/timing fidelity, connect a real flight controller to the plant, measure timing and compare with SITL. Document the bench setup and prevent physical motor actuation during these tests. |

**Acceptance:** the selected firmware completes the agreed SITL scenarios and
comparison report; unsupported firmware is identified. If HITL is selected, timing,
packet-loss and hardware tests meet its registered limits. Otherwise record HITL as
not exercised and limit hardware-timing claims accordingly. HITL is an extension,
not a universal requirement for a power/endurance twin.

**Likely areas:** new firmware bridge in the engine host/main process, protocol
adapters, sensor models, scenario runner and firmware integration fixtures.

## Phase 14 — Lifecycle and health

**Goal:** keep the twin representative as the aircraft and its batteries change.

| Milestone | Delivers |
|---|---|
| 14.0 Component lifecycle | Track component installation/removal, maintenance, battery usage/cycles where available and effective configuration dates. Associate every flight with the battery and payload actually used. |
| 14.1 Change and drift detection | Compare observed power, voltage sag and supported motion metrics against condition-matched validated predictions. Establish baselines, persistence rules and false-alarm measurements. Separate sensor faults, model mismatch and unknown causes. |
| 14.2 Revalidation workflow | Material hardware, firmware or calibration changes mark affected validation claims as needing review. Propose recalibration from new evidence, retain previous versions and require explicit activation of updates. |
| 14.3 Decision support | Compare payload/mission alternatives and remaining endurance with uncertainty and applicability. Show evidence behind health observations; do not assert component remaining life without degradation evidence. |

**Acceptance:** replacing a battery or changing payload leaves historical results
unchanged and triggers the appropriate applicability checks. Controlled degradation
fixtures and repeat real observations demonstrate detection behavior and report
false alarms. An unvalidated update cannot silently become the active validated
model. Reports can reconstruct the configuration and model active for any flight.

**Likely areas:** aircraft registry, calibration versions, new health/lifecycle
domain modules, dashboard, analysis and telemetry reports.

## Phase 15 — Digital twin acceptance and release

**Goal:** demonstrate the complete measurement-to-prediction loop on the selected
physical aircraft, with explicit evidence and a supportable packaged release.

| Milestone | Delivers |
|---|---|
| 15.0 Evidence audit | Versioned matrix linking each claimed capability to aircraft configuration, firmware/model versions, source measurements, tests, errors, uncertainty, validity range and known limitations. |
| 15.1 End-to-end aircraft demonstration | Register aircraft, import calibration evidence, validate on independent flights, connect live, generate a forecast, compare with the observed outcome, then perform a configuration change and revalidation. |
| 15.2 Resilience and regression | Parser robustness, clock/transport faults, bounded-resource soak, migration/restore and full project export/import. Re-run existing simulator golden cases; document deliberate engine changes and retain older recording compatibility rules. |
| 15.3 Packaged release and guide | Install/upgrade checks, supported aircraft/firmware list, connection and measurement guides, reproducible validation report and release notes. Review telemetry parsing and transport boundaries under the Phase 8 security workflow. |

**Release gate:** all selected use-case thresholds pass on the packaged build and
the real reference aircraft. The evidence includes held-out prediction errors,
interval coverage, live clock/freshness performance, configuration traceability and
recovery behavior. Failures and untested conditions remain visible. Synthetic
fixtures establish software correctness but cannot replace physical evidence.

The release may claim **an aircraft-specific digital twin validated for the stated
power/endurance envelope** once these gates pass. Control-fidelity and HITL claims
require their own Phase 13 evidence. Expansion to other aircraft, firmware or
operating ranges repeats the relevant calibration and acceptance gates.

## Decisions and resources needed before dependent implementation

| Decision/resource | Needed by | Planning default or required input |
|---|---|---|
| Reference aircraft and firmware | 9.0 | One actual multicopter; exact model, build and PX4 version must be supplied/verified. |
| Intended prediction and pass limits | 9.0, before fitting | Hover power and endurance first. Register allowed power/energy error, endurance error, interval coverage and operating conditions; numerical values remain open until measurement capability and intended use are known. |
| Real evidence and collection access | 10–11 | Original ULogs, configuration, independent flights and bench measurements. Use documented datasets for importer development; do not claim aircraft acceptance without the reference aircraft evidence. |
| Transport, telemetry rates and timing budgets | 12.0–12.1 | MAVLink 2 over serial/UDP; choose channel rates, stale thresholds and p95 latency/clock-error limits from hardware measurements before acceptance runs. |
| Firmware test depth | 13.0 | SITL in scope; HITL conditional on available hardware and whether hardware-timing claims are needed. |
| Degradation evidence | 14.1 | Measured condition changes and repeat flights; lifetime predictions deferred until sufficient evidence exists. |

Missing physical resources block the dependent acceptance gate, not unrelated
software work. No hardware purchase, aircraft operation, firmware change or remote
service deployment is authorized by this documentation plan.

## Reference guidance

- [MAVLink common messages](https://mavlink.io/en/messages/common.html) and
  [time synchronization](https://mavlink.io/en/services/timesync.html): message
  semantics and clock alignment; pin the dialect/version when implementing.
- [PX4 ULog format](https://docs.px4.io/main/en/dev_log/ulog_file_format.html):
  import format; support actual logged topic schemas explicitly.
- [PX4 simulation](https://docs.px4.io/main/en/simulation/index) and
  [hardware simulation](https://docs.px4.io/main/en/simulation/hardware): firmware
  integration options; verify support against the selected PX4 release.
- Existing project contracts: [architecture](../ARCHITECTURE.md),
  [component provenance](../adr/0007-component-provenance.md),
  [controller boundary](../adr/0009-px4-controller-perfect-state.md),
  [recordings and sensors](../adr/0011-telemetry-recording-and-sensor-models.md),
  [Phase 8 quality plan](phase-8-quality.md).
