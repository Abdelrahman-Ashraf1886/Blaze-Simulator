# Design Review follow-up: Phase 1 UI, pass 2 (responsive + unslop)

**Reviewed:** 2026-11-20 · **Focus:** generic "AI dashboard" patterns, responsiveness to window size, scaling and zoom
**Previous review:** `phase1-ui_20261120_2108.md` (all items there remain fixed)

## What read as generic, and what replaced it
| Before | After |
|---|---|
| Inter + JetBrains Mono | IBM Plex Sans + Plex Mono |
| Rounded bordered cards with UPPERCASE eyebrow titles | Docked sections, sentence-case titles, hairline separators |
| Tailwind-sky accent used decoratively | Cockpit colour semantics; cyan only for interactive elements |
| Dashboard "System status" dumping Electron/Chromium/platform | Engine and Workspace readouts; build details under Help → About |
| Filler copy ("Workspace overview", "Engineering workstation") | Removed |
| Native `<select>` for frame layout | Rotor-layout picker with quad/hex/octo glyphs |
| Default Electron icon, light title bar on a dark app | Quad-X icon; native dark title bar and menus |
| Sidebar footer status block | Window-wide status bar |

## Responsiveness
Verified by the e2e suite, with no horizontal overflow on Dashboard or Projects at:
880×560, 1093×566 (1366×768 at 125 %), 1280×672 at 150 % zoom, 1100×700 at 200 %
zoom, 1920×1040 and 2560×1400. The sidebar rail switches at 1180 CSS px. Tables
drop secondary columns through container queries. The window minimum was lowered
from 1100×700 to 880×560, and the initial size now comes from the work area.

## Open suggestions
- Route-level code splitting once three.js arrives (Phase 2).
- Persist window position and size between sessions.
