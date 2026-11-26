# Phase 8 plan: quality and distribution

Status (2026-11-26): **Draft. D1–D16 are not decided.** Written against `blaze-sim` at 28e0dc9
(Phase 7 done, awaiting review). Earlier phases' decisions are written "P6-D2".

## Goal

Someone else can install Blaze UAV on their own PC, trust its numbers and keep their data:
- an installer that works on a clean Windows PC and upgrades without losing a project;
- a validation report that says, for each model, what it was checked against and how far off it is;
- a regression suite that runs against the installed app, not only the development build;
- known slow spots measured and either fixed or written down;
- user documentation, licences and notices that match what is shipped.

No new physics and no new simulation feature. Results and state hashes stay today's, bit for bit;
a fix that must change one (8.10) is listed, justified and approved on its own.

## What is there today

| Area | Today | Missing |
|---|---|---|
| Installer | `electron-builder.yml`: NSIS per user and portable, x64, unsigned. Built and smoke-tested once, in Phase 1 | Clean-PC test, upgrade test, checksums, release steps. No `release/` build since Phase 1 |
| Upgrade | Migrations 0001–0016 in transactions; a newer database is refused (`electron/main/db/database.ts`) | **No copy of the database is made before a migration.** A wrong migration cannot be undone |
| Logs | `console.*` only; messages say "See application log" | No log file exists, so that advice cannot be followed |
| Crashes | Engine supervisor restarts the engine; recordings recover | No handler for uncaught errors in main or for a lost renderer process |
| Settings page | Disabled sidebar entry (phase 8) | The page |
| Licences | App: `UNLICENSED`, no LICENSE file. No notices shipped | **The engine ports PX4 code (BSD-3-Clause), whose licence requires its notice in source and in binaries.** npm, Rust, Electron and font notices also |
| Tests | Rust, 856 unit, 62 end-to-end, flight performance, all on the development build | Packaged build, long runs, a second machine, golden results across versions |
| Validation | Analytical tests spread over the engine; results in 2,200 lines of DEVLOG | One report with every model, its check, the measured error and its limits |
| Docs | Architecture, ADRs, plans. README says "Phase 1 (foundation)" | User guide, correct README, release notes |
| Continuous checks | None (`.github` absent); everything runs on this PC | D12 |

### Known defects and open measurements carried into this phase

| # | Item | Where recorded |
|---|---|---|
| K1 | Two to five hitches per 20 s of flight, up to 426 ms, cause not traced | DEVLOG 6.0b, 7.12 |
| K2 | One ground run at 64.6 ms stick to draw (limit 67), not traced | DEVLOG 7.12 |
| K3 | Settings → Graphics chooses the GPU preference at startup and reports the current WebGL renderer. On the i7-9750H laptop the Intel UHD 630 stalled WebGL for 55–832 ms in flight. The stalls did not occur on the GTX 1650 with the high-performance switch. The earlier 4K workshop p95 on Intel was 33 ms (43 fps). | Measured 2026-11-26; DEVLOG 6.0b, e2e output |
| K4 | Rapier's single restitution sweep leaves flat multi-point impacts with a short rebound (65.7 mm vs 120 mm for the reference box) | [K4 investigation and upstream reproduction](../validation/k4-rebound.md) |
| K5 | On the 45° terrain fixture the quad touches at 27.972 s, slides downhill in contact and loses contact near the grid edge at 32.593 s. Vertical speed exceeds the detector’s 0.135 m/s limit at every post-touchdown update, so it never confirms landing by 34 s. The terrain scenario warns when the slope at the flight start exceeds atan(friction) (45.0° vs 21.8° at 0.4). | [DEVLOG 6.10](../DEVLOG.md#catalogue-acceptance) · [Fixture](../../tests/unit/scenario-protocol.test.ts#L626-L670) |
| K6 | Sensors-off step timed at 31 µs instead of 12 µs in two of three runs | DEVLOG 7.12 |
| K7 | Return parameters are not in the tuning editor; GPS spec fields show on every peripheral | Phase 6 and 7 notes |
| K8 | Never tried: a real PlayStation controller (yours), another PC, another GPU | – |

## Decisions (yours)

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Who is the release for? | (a) you and people you hand it to; (b) a public download | **(a)** now. Everything below works for (b) later; what (b) adds is signing (D2), a licence (D3) and the repository owner's agreement |
| D2 | Code signing | (a) unsigned, with published SHA-256 checksums and the SmartScreen steps written in the guide; (b) a certificate you buy; (c) Microsoft Artifact Signing; (d) Microsoft Store | **(a)** for D1(a). Microsoft states that EV certificates no longer avoid SmartScreen, so a certificate buys an identity and slow reputation, not a clean first run. (c) may be closed to individuals and to your country: a March 2026 answer on Microsoft's forum, not official policy, says so; check the Azure page before choosing it. The build is prepared for (b) or (c) either way; only you handle keys and payment |
| D3 | Licence of the app | (a) keep "all rights reserved", said plainly in the app and repository; (b) an open-source licence | **(a)** until you and the repository owner agree on (b). Either way third-party notices ship (8.0) |
| D4 | Version and engine version | (a) 0.8.0 for this phase's build, app and engine together; (b) 1.0.0; (c) stay at 0.1.0 | **(a)**. Recordings verify only against the same engine version, so it must change with every release that changes the engine. 1.0.0 is your call after review |
| D5 | Database copy before a migration | (a) always, keep the last 3 and show them in Settings; (b) always, keep all; (c) never | **(a)**. 3 is a choice, not a derived number |
| D6 | Restore and move projects | (a) restore a copy from Settings; (b) (a) + export one project to a file and import it on another PC, with its models and terrain | **(b)**. Today a project cannot leave the PC. Recordings are exported only if ticked (15 MB per minute) |
| D7 | Logs | (a) local log files, rotated, nothing ever sent; (b) (a) + a crash upload service | **(a)**. A "Save diagnostics" button makes a zip you can send yourself; it lists what is inside first and leaves out project data unless ticked |
| D8 | Update checks | (a) none; the guide says how to upgrade; (b) the app checks for a new version; (c) automatic updates | **(a)**. The app makes no network request today, and unsigned automatic updates are unsafe |
| D9 | Graphics card | High performance, power saving, or system | **High performance by default**, chosen by the user on 2026-11-26. Changes apply on restart. Windows’ per-app setting may override the preference. |
| D10 | Clean-PC and upgrade test | (a) Windows Sandbox on this PC; (b) a second PC of yours; (c) both | **(a)**, and (b) if you have one. Sandbox is a Windows 11 Pro feature that is off on this PC: turning it on needs your administrator approval and a restart |
| D11 | Validation against a real flight | (a) analytical and published data only; (b) (a) + a log from your own drone, if you have one with the build in the catalogue | **(a)**, and (b) whenever you bring a log. The report says "not compared with a real flight" until then |
| D12 | Checks on GitHub | (a) none, as today; (b) GitHub Actions on Windows for every push to `blaze-sim`: Rust, typecheck, lint, unit | **(a)** for now. (b) runs code on the repository owner's account and minutes; it needs their agreement. End-to-end and performance tests stay on this PC |
| D13 | Determinism on other PCs | (a) claim nothing; (b) ship a self-check that replays stored inputs and compares hashes, and report the result | **(b)**. "Reproducible" is proven only on this i7-9750H. Sandbox uses the same CPU, so it does not answer this; a second PC does |
| D14 | Supported systems | (a) Windows 11 x64 as tested, others "not tested"; (b) also Windows 10 | **(a)** unless you can test (b) |
| D15 | Performance limits | (a) keep 6.0b's for flight; state measured values for the rest, with no pass or fail; (b) set limits for startup, workshop and memory too | **(b)**, once 8.3 has measured them: you set the numbers, as in 6.0b |
| D16 | Known defects | (a) fix K1–K3 and K7, document K4–K6; (b) also try K4 (contact rebound) | **(a)**. K4 was tried at length in 4.4 without success and changing contact changes every hash. K6 is a measurement question and goes with 8.3 |

## Milestones

| Milestone | Delivers | Files it may touch | After |
|---|---|---|---|
| 8.0 Licences and notices | A generated list of every shipped component (npm runtime and bundled, Rust crates, Electron and Chromium, fonts, SQLite) with its licence text; the PX4 notice, with the list of ported files; a check that fails when a shipped dependency has no known licence; shown under Help | `scripts/*`, `build/notices/*`, `electron-builder.yml`, About dialog | – |
| 8.1 Data safety | Copy before migration, `quick_check` at start, restore, project export and import (D5, D6); a fault at any step leaves the old data readable | `electron/main/db/*`, `electron/main/projects/*` (new), `electron/ipc/*` | D5, D6 |
| 8.2 Logs and crashes | Rotating local log of main and engine, handlers for uncaught errors and a lost renderer, "Save diagnostics" (D7) | `electron/main/logging/*` (new), `electron/main/index.ts`, `electron/main/engine/supervisor.ts` | D7 |
| 8.3 Profiling | Traces that name the cause of K1 and K2; startup, memory over an hour, workshop at 4K on both GPUs (K3), K6; fixes where the cause is ours; proposed limits (D15) | `scripts/profile/*` (new), `tests/e2e/flight-performance.spec.ts`, then what the traces name | – (measuring), D9, D15 (limits) |
| 8.4 Settings page | Data folder and sizes, copies and restore, log folder, GPU choice, recording default, units where they exist, licences, versions | `src/features/settings/*` (new), `src/app/nav.ts` | 8.1, 8.2, D9 |
| 8.5 Regression suite | Golden results: every built-in scenario, step test and a sensor flight, hash and key numbers, kept per engine version; a run that compares builds; the end-to-end suite against the packaged app; a one-hour soak with recording; hostile input files for every parser (glTF, terrain, packs, recordings, project files) | `tests/*`, `simulation-engine/*/tests`, `scripts/*` | 8.1 (project files), 8.6 (packaged) |
| 8.6 Packaging | Version bump, Electron fuses, only needed files shipped, icon and metadata, checksums, release script, signing hook (D2), self-check (D13) | `electron-builder.yml`, `package.json`, `scripts/release/*`, `simulation-engine/Cargo.toml` | 8.0, D1–D4 |
| 8.7 Validation report | One document and one in-app page: for each model its equations, source, check, measured error, range and limits, generated from test output so it cannot drift | `documentation/validation/*` (new), `tests/validation/*` (new) | – (inventory), D11 |
| 8.8 Clean install and upgrade | On a clean Windows: install, run, record, uninstall; upgrade from the first build to this one with a project, components, recordings and an old database; downgrade is refused with a message | `tests/release/*` (new), DEVLOG | 8.6, D10 |
| 8.9 User guide | Install, first build, first flight, controller setup, tuning, telemetry, troubleshooting, limits; README; release notes. Screenshots from the app itself | `documentation/guide/*` (new), `README.md` | 8.4 |
| 8.10 Known defects | K1–K3 fixes not done in 8.3, K7; K4 and K5 described where the user meets them | named per fix | D16 |
| 8.11 Security pass | Review of IPC, file parsers, paths, CSP, navigation, dependencies; findings fixed or recorded | review first, then named files | 8.6 |
| 8.12 Acceptance | Everything below passes on the packaged build; DEVLOG, ROADMAP, ADR 0012 (distribution and data safety) | docs | all |

**Waves.** 1: 8.0, 8.3 (measuring only) and 8.7 (inventory only); these need no decision. 2: 8.1, 8.2.
3: 8.4, 8.5, 8.6. 4: 8.7 (report), 8.9, 8.10, 8.11. 5: 8.8, 8.12.

## Tests and evidence

1. **Notices:** every package and crate in the shipped build appears with licence text; a fixture without
   a licence fails the check; the PX4 notice is in the installer and beside the ported sources.
2. **Data safety:** kill the process at each step of copy, migration, restore and import; the old database
   opens afterwards. Disk full, read-only folder and a locked file give a message, not a loss. A
   project exported here and imported into an empty data folder produces the same engine payload and hash.
3. **Logs:** an uncaught error, an engine crash and a lost renderer each leave a log entry; rotation holds its
   limit; the diagnostics zip contains only what its list says.
4. **Profiling:** each figure with machine, build, power and run count; a hitch is "traced" only when the trace
   names the work and removing it removes the hitch.
5. **Golden results:** a changed result fails and names the scenario and the first differing number.
   Updating a golden file needs a reason in the same commit.
6. **Packaged app:** the end-to-end suite passes on `win-unpacked` and, where the test needs it, the installed app.
7. **Soak:** one hour of flight with recording; memory and frame time at the start and end are reported.
8. **Hostile files:** truncated, oversized, deeply nested and wrong-type files are refused with a message, within
   a stated time and memory.
9. **Clean PC and upgrade:** as in 8.8, scripted where Sandbox allows, the rest as a written checklist you run.
10. **Validation:** each row of the report comes from a test that ran in this build; a row without a test says
    "not validated".

## Measurements only you can enable

- Windows Sandbox (administrator approval, restart) or a second PC, for 8.8 and D13.
- Hands-off time on mains power: about 10 minutes per flight performance run, one hour for the soak.
- Your PlayStation controller (K8) and, for D11(b), a flight log of a real build.

## Risks

- **A copy of the database is not a backup of the models.** 3D models, terrain and recordings live beside it; the
  restore page says what a copy covers.
- **Profiling may name Chromium or the driver.** Then the cause is written down and not "fixed".
- **Packaged tests are slower** and share this PC with your work; they run only when you agree.
- **An unsigned installer warns.** The guide says so and shows the checksum; nobody is told to switch
  protection off.
- **Licences are a fact-finding task, not legal advice.** The list says what each licence text asks for.

## Sources for D2 and D10 (read 2026-11-26)

- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Status of Windows app distribution features](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status)
- [Artifact Signing pricing](https://azure.microsoft.com/pricing/details/artifact-signing/) and the [forum answer on individual accounts](https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident) (an automated answer, not policy)
- [Install Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install)
