# Install or upgrade

The 0.8.0 release is an unsigned Windows x64 build shared directly by its sender. Windows 11 x64 is the tested platform. Use the setup executable to install for your Windows user, or use the portable executable to launch without installing. Both use the workspace for that Windows account. [Release information](../release/README.md#L3) · [Platform decision](../plans/phase-8-quality.md#L65) · [Installer configuration](../../electron-builder.yml#L47)

## Check the file before opening it

1. Get the executable and its expected SHA-256 from the sender. Open PowerShell in the folder with the executable and `SHA256SUMS.txt`.
2. Run the first command and the command for the executable you received.

   ```powershell
   Get-Content .\SHA256SUMS.txt
   Get-FileHash .\BlazeUAV-Setup-0.8.0.exe -Algorithm SHA256
   Get-FileHash .\BlazeUAV-Portable-0.8.0.exe -Algorithm SHA256
   ```

3. Compare the result, the entry for that file in `SHA256SUMS.txt`, and your sender's expected hash. Letter case can differ. Stop if the hashes differ. [Release verification instructions](../release/README.md#L16)

## Open the verified file

If SmartScreen shows **Windows protected your PC**, choose **More info** to see the file name and publisher. If your Windows policy permits it, **Run anyway** appears. Use it only after verifying the checksum and deciding you trust the sender. [Release SmartScreen instructions](../release/README.md#L28)

- **Setup.** Follow the installer and choose an installation folder when prompted. Launch **Blaze UAV** from the Start menu or desktop shortcut.
- **Portable.** Open the portable executable directly. Use the same Windows account when switching to a new portable build to keep the same data location. [Installer options](../../electron-builder.yml#L47) · [Portable upgrade](../release/README.md#L30)

## Upgrade from 0.1.0

1. In the old app, press **Alt** if the menu is hidden. Open **Help → About Blaze UAV** and locate the folder containing the **Data file**. Close the app. Copy that whole folder to a separate location.
2. Verify and run the new installer. Select your existing installation directory. For portable, run the new portable executable under the same Windows account.
3. Open a project and its recordings. The app applies pending database migrations on open. Keep the whole-folder copy if you need to return to the older app. Older recordings can play from saved samples. Verification requires the original engine version and protocol. [Upgrade steps and compatibility](../release/README.md#L30) · [Hidden menu](../../electron/main/index.ts#L157)

Next, [build a project](workshop.md).
