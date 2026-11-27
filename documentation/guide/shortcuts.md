# Keyboard shortcuts

## Drone Workshop

| Key | Action |
| --- | --- |
| **1**, **2**, **3**, **4** | Top, front, right, isometric views |
| **F**, **P**, **G**, **X** | Fit, switch projection, toggle grid, toggle exploded view |
| **M**, **C**, **B** | Toggle measurement, centre-of-mass marker, collision shapes |
| **Esc** | Clear a measurement first, then exit measurement mode or clear selection |
| **W**, **E**, **R**, **S** | Move, rotate, scale, toggle snap |
| **Arrow keys**, **Page Up**, **Page Down** | Nudge the selected part horizontally or vertically in its attachment axes |
| **Delete** or **Backspace** | Delete the selected part |
| **Ctrl+Z**, **Ctrl+Y** or **Ctrl+Shift+Z**, **Ctrl+D** | Undo, redo, duplicate the selected part |

Workshop shortcuts are ignored while editing a text input. Electrical Designer also uses **Ctrl+Z** for undo and **Ctrl+Y** or **Ctrl+Shift+Z** for redo. [Preset order](../../src/features/workshop/WorkshopPage.tsx#L72) · [View and history keys](../../src/features/workshop/WorkshopPage.tsx#L251) · [Part keys](../../src/features/workshop/WorkshopPage.tsx#L857) · [Electrical keys](../../src/features/electrical/ElectricalPage.tsx#L116)

## Flight Simulator

Click or tab to the flight view during a keyboard run. Use **W/S** for throttle up/down, **A/D** for yaw left/right, **↑/↓** for forward/back, and **←/→** for left/right. Release the keys to centre them. Focus loss clears them. [Flight keys](../../src/features/flight/FlightPage.tsx#L479)

## Telemetry and menu

On a focused graph, **←/→** moves between samples. Where the graph supports zoom, press **Enter** at each end of the range. **Esc** clears the cursor and range anchor. Press **Alt** to show the Windows menu. [Graph keys](../../src/features/telemetry/TelemetryGraph.tsx#L318) · [Menu](../../electron/main/index.ts#L157)
