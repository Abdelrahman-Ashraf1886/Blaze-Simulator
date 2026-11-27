# Clean-install and upgrade test in Windows Sandbox (Phase 8, 8.8)

Needs the Windows Sandbox feature (Windows 11 Pro; administrator approval and a restart to turn it on).

1. Make a folder, for example `C:\sbx-host`, and copy into it: `run.ps1` from here, `BlazeUAV-Setup-0.8.0.exe` (from `npm run release`), and for the upgrade test `BlazeUAV-Setup-0.1.0.exe` (built with `npm run dist` at commit 28e0dc9) and an `old-userdata` folder made by `tests/install/prepare-old-userdata.spec.ts` against that 0.1.0 build (`BLAZE_OLD_APP`, `BLAZE_OLD_USERDATA`, `npx playwright test --config tests/install/playwright.config.ts`).
2. Write a `.wsb` file per mode with networking disabled, the folder mapped to `C:\sbx` (writable) and the logon command `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\sbx\run.ps1 -Mode clean` (or `upgrade`).
3. Open the `.wsb` file. The script installs silently, starts the app for about 30 s, checks that `drone-engine.exe` runs, takes a screenshot, copies the user data and logs to `C:\sbx\results\<mode>`, uninstalls (clean mode) and shuts the Sandbox down.
4. Read `results\<mode>\summary.json`, the screenshots and `userdata-*\logs\main.log`.
