# Blaze UAV Windows releases

Blaze UAV is copyright © 2026 Blaze UAV contributors. All rights reserved. This unsigned Windows x64 build is for you and people you give it to directly. Third-party terms are available under **Help → Third-party notices**. The release decisions are recorded in [Phase 8](../plans/phase-8-quality.md#decisions).

## Build

Use a Windows x64 checkout with the repository's npm and Rust dependencies already installed, an installed Electron distribution, and the electron-builder tools in the local cache. Run from the repository root.

```powershell
$env:CARGO_BUILD_JOBS = '1'
npm run release
```

The script clears `out/` and the current version's output directory, builds the release engine, checks the notices, packages the app, reads the fuses, lists the ASAR, and checks the payload in each Windows executable. It writes `SHA256SUMS.txt`, `release-manifest.json`, and `ASAR-CONTENTS.txt` to `release/0.8.0/`. The manifest records the source commit, whether the working tree differed, the versions, and each executable's size and hash. The release runs offline. Signing stays disabled and publishing is set to `never`. The Windows signing configuration in `electron-builder.yml` records the hooks for a future signed build.

## Verify before opening

Get the executable and its expected hash from the person who gave you the release. Compare that hash with `SHA256SUMS.txt` and the PowerShell result. Matching SHA-256 hashes confirm that the bytes match the copy your sender checked.

```powershell
Get-Content .\SHA256SUMS.txt
Get-FileHash .\BlazeUAV-Setup-0.8.0.exe -Algorithm SHA256
Get-FileHash .\BlazeUAV-Portable-0.8.0.exe -Algorithm SHA256
```

Use the line that matches the file you received. Hexadecimal letter case does not matter. Stop if the hashes differ.

Windows SmartScreen may show **Windows protected your PC** for the unsigned file. **More info** expands the dialog and shows the file name and publisher information. If Windows policy permits the launch, the expanded dialog shows **Run anyway**. After verifying the checksum, you can choose that button if you trust the sender and want to proceed.

## Upgrade from 0.1.0

1. In the 0.1.0 app, open **Help → About Blaze UAV** and find the folder that contains the **Data file**. Close the app. Copy the whole folder to a separate location so project attachments and recordings are included.
2. Run the verified 0.8.0 installer and select the existing installation directory. For a portable copy, start the new portable executable. Use the same Windows account to retain the same app data location.
3. Open a project and its recordings after launch. The app applies pending database migrations on open. Keep the saved data folder if you need to return to the older app.

The installed app and engine both report 0.8.0. Recordings made with the 0.1.0 engine will show **cannot verify** in 0.8.0 because verification requires the recording's engine version and protocol. This check is separate from opening a recording for playback. See [0.8.0 release notes](0.8.0.md).

## Check this computer

Open **Help → Check this computer** to run the three saved engine inputs in separate sidecar processes. The dialog shows the CPU name and compares each final state hash with its saved value. The result applies to those inputs on that machine. It makes no network request.
