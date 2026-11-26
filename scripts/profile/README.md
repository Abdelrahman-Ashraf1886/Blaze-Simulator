# Phase 8.3 profiling

Run from the repository root in PowerShell. Use the app and engine built for the commit under test and set `BLAZE_PROFILE_BUILD_COMMIT` to that build's full Git hash. The desktop commands use the existing `out/` app and release engine. The trace command builds both through `scripts/flight-perf.cjs:3–9` with one Cargo build job and offline Cargo.

```powershell
$env:BLAZE_PROFILE_BUILD_COMMIT = git rev-parse HEAD # use this only if building the current checkout
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_NET_OFFLINE = 'true'
$env:npm_config_offline = 'true'
```

Keep the test window visible and focused. Leave the mouse, keyboard, controller, display settings, GPU preferences and power cable alone during a run. Prevent sleep and screen locking before starting. Keep background load comparable between runs. Choose unused output paths in an existing directory. Reports include the machine, supplied build commit, run count, and the observed power, display and GPU information.

## Flight trace and analysis

```powershell
$env:BLAZE_FLIGHT_PERF_TRACE = '1'
npm run test:flight-perf
Remove-Item Env:BLAZE_FLIGHT_PERF_TRACE
node scripts/profile/analyse.cjs path/to/flight-trace.json 64.6 flight-analysis.json
```

One capture per existing flight case. Each has the 20 s measurement and the existing response tail, plus test setup and teardown. Allow at least one minute of capture time in total, plus build, quad setup and takeoffs. The console prints each saved path under the Playwright results directory. Move any results you want to keep before the next Playwright run. Trace mode prints the existing performance limits as comparisons. Setup and capture validity checks still apply. The example threshold, 64.6 ms, comes from the near-limit ground case in `documentation/DEVLOG.md:27–32`. The analyser takes a threshold in milliseconds and uses strict greater-than comparisons for it and for two refresh periods. Analysis runs offline in seconds for typical traces. It has no focus or input restrictions.

Electron `contentTracing` records all participating processes using `record-until-full` and its documented 100 MiB buffer (`node_modules/electron/electron.d.ts:15776–15789`). Categories cover User Timing and Blink, DevTools timeline and V8, compositor and GPU (`cc`, `viz`, `gpu`), task scheduling (`toplevel`, `renderer.scheduler`, `sequence_manager`) and IPC (`ipc`, `mojom`, `electron`). The trace stores the requested and available categories, buffer usage if Electron reports it, and the complete configuration. Missing markers, buffer pressure or capture overflow can limit interpretation.

Each renderer User Timing marker has a renderer `performance.now()` timestamp and a Chromium trace timestamp. The analyser uses their difference to put flight samples on the trace clock and reports the maximum residual at the observed anchors. Main-process `performance.now()` reads bracket each renderer marker. The intersection of their offset ranges provides the main offset and its half-width error under the fixed-offset assumption. A missing end anchor weakens the estimate. Disjoint bounds leave main samples unaligned. These figures describe the observed clock alignment, with additional timer quantization and any unmeasured drift between anchors.

The JSON report groups work by process and thread and names the longest synchronous slice on each track, GC, paint, GPU, IPC events, and the renderer's flight requests and responses. The main probe adds Node GC, the `perf_hooks` event-loop delay histogram at one-refresh resolution rounded up to whole milliseconds, timestamped timer gaps, and `RecordingWriter` file-write spans. The spans include I/O queue and completion latency. Trace probes add overhead. Work overlapping a delay by at least one refresh is a candidate. The summary unions same-cause overlap within each delay, so different categories may overlap and the totals may exceed wall time. With no candidate the row is `unknown`. A long IPC round trip identifies a slow path. Establishing the cause requires checking which work, when removed, removes the hitch (`documentation/plans/phase-8-quality.md:97–98`).

## Startup, memory and workshop

```powershell
npm run profile -- startup 3 startup.json
npm run profile -- memory 1 3600 memory.json
# Set the primary display to 1920 × 1080 before the first command.
npm run profile -- workshop 3 1080 workshop-1080.json
# Set the primary display to 3840 × 2160 before the second command.
npm run profile -- workshop 3 2160 workshop-4k.json
```

- **Startup** launches two processes per pair. The cold run creates a fresh user-data directory and the warm run reuses it after a clean exit. Allow seconds per launch plus fixture startup. The OS file cache remains uncontrolled. To sample the first launch after boot, reboot before each `startup 1` pair and keep a separate report for each boot. The stopwatch uses the browser process creation time from Electron, the first window's `show` event, the supervisor's connected notification after `hello` and a visible Dashboard marker followed by a paint opportunity. The last is an upper bound on dashboard rendering. The report also includes Chromium's navigation first-contentful-paint entry when available. GPU inventory comes from Electron because the Dashboard has no WebGL scene. Sources are `electron/main/index.ts:110–128,392–398`, `electron/main/engine/supervisor.ts:238–255`, and `src/features/dashboard/DashboardPage.tsx:40–49`.
- **Memory** samples the app and OS process tree at startup, after takeoff and after stopping the flight, including the Rust sidecar. Windows snapshots include working set and private bytes. It records flight frame statistics in the first and last 20 s. A normal end before the last sample window starts triggers a fresh recorded flight in the same app so the soak can continue. The report lists the gaps. A paused or interrupted app is an invalid run. Allow the specified duration plus setup, takeoff and recording finalization. The milestone specifies an hour (`documentation/plans/phase-8-quality.md:74,102`).
- **Workshop** runs the same stock test quad and orbit workload at the requested physical display size, twice per pair. One launch uses Windows' normal choice and the other passes `--force_high_performance_gpu`. The WebGL renderer string identifies what drew each run, including cases where both launches used the same adapter. The report also gives the drawing buffer dimensions and device pixel ratio. Frame intervals come from the workshop's existing R3F render counter. The orbit lasts about two seconds per launch, plus scene setup. Sources are `tests/e2e/helpers.ts:61–98`, `tests/e2e/performance.spec.ts:25–47`, and `src/features/workshop/Viewport.tsx:256–265`.

## K6 engine step cost

```powershell
# Optional. Capture a short live fixture with the app, including the takeoff and hold.
npm run profile -- memory 1 40 fixture-run.json flight.blzr
npm run profile -- step-cost 3 flight.blzr engine-cost.json
```

Use a completed flight recording with all sensors and gyro feedback off. A manually saved `.blzr` from the app's `userData/recordings` also works. Keep the same power and load conditions through the comparison. Each invocation builds the offline profiling binary once in a temporary directory with the same engine modules, locked dependencies and release settings. The verification build took 10 min 18 s on this machine. Build time depends on the local Cargo cache and machine. Each pair replays the flight once per method without wall-clock pacing. The parser takes the load, start and step lines from the v1 recording format (`electron/main/telemetry/format.ts:3–32,75–83`) and validates the protocol frames' checksums. It runs with the recording's sampling cadence and again with sampling disabled, using the same flown setpoints and request chunk sizes.

The direct timer runs entirely inside the Rust profiling binary. It reports parse and dispatch time and the combined time through response serialization. The NDJSON timer uses the built production sidecar with one outstanding request and includes pipe transfer, scheduling and JavaScript reply parsing. Electron IPC and file writes are outside this measurement. The report prints microseconds per actual step and saves request counts, actual steps, final hashes and the per-step timing difference when the work matches. Compare unsampled direct and NDJSON variation first for the 12 vs 31 μs observation in `documentation/DEVLOG.md:21`. Use sampled runs to see the effect of engine sampling on the same flight.
