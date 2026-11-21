# ADR 0003: The renderer uses the engine's Z-up, metre world frame

**Status:** accepted (2026-11-21)

## Context
The simulation engine (ADR 0001) uses a right-handed, Z-up frame in SI units:
+X forward (nose), +Y left, +Z up, metres and radians. three.js and glTF default to
+Y up. If the renderer used Y-up, every pose crossing between the engine and the
view would need a conversion, which is a classic source of sign errors in flight
visualisation.

## Decision
- The renderer adopts the engine frame: `Object3D.DEFAULT_UP = (0, 0, 1)` is set
  in `src/three/setup.ts` before any object is created.
- Cameras and controls use Z as up. Stored assembly data is in metres, with
  rotations as unit quaternions.
- The UI shows millimetres and degrees. Conversion happens only at the field
  boundary (`frame-values.ts`, `PartPanels.tsx`).
- Imported glTF (Y-up by specification) is converted once, per part
  (`src/three/model-units.ts`):
  - Y-up files get a +90° rotation about X, so file +Y becomes world +Z and file +Z
    becomes world −Y;
  - Z-up files (common from CAD) keep their axes;
  - units are scaled to metres.

## Consequences
- \+ Engine states (Phase 4–6) can be drawn without axis swaps. A unit test checks
  the documented mapping against the three.js quaternion.
- \+ PX4 geometry (body y right) needs only one documented negation, in
  `frame-geometry.ts`.
- − drei helpers that assume Y-up need checking:
  - `GridHelper` is rotated onto the XY plane;
  - `CameraControls` is told the camera's up vector;
  - `GizmoViewport` shows the true axes.
- − Contributors used to three.js must remember Z is up. The status strip shows
  "Z-up · millimetres".
