# Troubleshooting

## Engine not connected

Open **Dashboard → Simulation engine** and check **State**, **Restarts**, and any error under them. If the engine is starting or restarting, wait for **Connected**. If the error persists, close and reopen Blaze UAV. If you launched from the checkout, run `npm run dev` from the repository root so the app builds the local engine first. For the Windows release, confirm you are opening the verified installed or portable build. Use **Settings → Logs and diagnostics** to save the error details. [Dashboard status and errors](../../src/features/dashboard/DashboardPage.tsx#L138) · [Engine restart handling](../../electron/main/engine/supervisor.ts#L275) · [Development command](../../package.json#L9) · [Engine locations](../../electron/main/index.ts#L105) · [Diagnostics](settings.md#logs-and-diagnostics)

## SmartScreen

First verify the checksum, then follow the SmartScreen steps for the verified file. See [Install or upgrade](install.md#open-the-verified-file). If the checksum differs, stop and get a fresh copy from the sender. If policy does not offer **Run anyway**, ask the Windows administrator about the unsigned build. [Release verification](../release/README.md#L16)

## Flight hitches on integrated graphics

Open **Settings → Graphics** and read **Drawing card**. If the PC has a faster card, choose **High performance**, restart, and check the drawing card again. Windows can override the app preference. On the tested laptop, the Intel UHD 630 had visible WebGL stalls during flight. Those stalls did not occur on its GTX 1650 with the high-performance setting. [Graphics controls](../../src/features/settings/GraphicsSection.tsx#L24) · [Measured result](../plans/phase-8-quality.md#L41) · [Graphics decision](../plans/phase-8-quality.md#L60)

## Restore after a database problem

If the app opens, use [Database copies in Settings](settings.md#data-and-restore). If startup shows **Database integrity check failed**, choose **Restore newest good copy** when offered. It saves the current database beside the restored one. With no usable copy, **Continue read-only at own risk** opens the data SQLite can still read, and **Quit** closes the app. Missing attachments and recording files need a copy of those files. [Startup recovery choices](../../electron/main/index.ts#L293) · [Restore scope](../../src/features/settings/SettingsSections.tsx#L87)
