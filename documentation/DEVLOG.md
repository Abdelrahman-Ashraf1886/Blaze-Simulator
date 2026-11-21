# Development log

## 2026-11-21 — Phase 3, milestone 3.4: linking parts to components

**Built**
- A part can be linked to a library component (`componentId`; migration
  `0006_part_components.sql`, schema v6).
  - The link is stored, not the values. The part keeps its own shape and mass, and
    `links.ts` (pure) works out what to show:
    - motor: body diameter × body length → cylinder;
    - propeller: diameter → swept disc, keeping the part's disc thickness;
    - battery, ESC, flight controller, power module, peripheral: length × width ×
      height → box along the part's X, Y, Z;
    - the stated mass, converted to kg (e.g. 0.53 oz → 15.0 g);
    - imported models keep their mesh and take only the mass.
  - When a component does not state enough, the part's own value is used and the
    UI says so.
  - Unlinking or undo therefore restores the part's own values exactly, and a
    corrected built-in record shows up in every project that uses it.
- **Inspector**: a "Component" row offers only fitting categories:
  - motor → motors;
  - payload → peripherals and power modules;
  - custom → everything.

  While linked:
  - size and mass are read-only and show their condition, source and citation
    link;
  - the part's own mass is shown as "kept for when you unlink";
  - changing the part kind to one the link does not fit removes the link in the
    same undo step.
- Linked sizes are used everywhere a size matters: drawing, the size readout,
  dimensions, bounds and fit, resting a part on a linked part (a prop on a linked
  MN3110 sits on its stated 28.5 mm), mount snapping, and "without mass" in the
  tree and status strip.
- **Storage rules**:
  - a save that links to a component that no longer exists is refused;
  - a component in use cannot be deleted. The message names the projects, e.g.
    'Used by 1 part in "In-use quad". Unlink it in the workshop first.' (also an
    SQLite `ON DELETE RESTRICT`).
- **Built-in data**: new size fields (motor body diameter/length; length/width/
  height for ESCs, flight controllers, power modules and peripherals). 30 cited
  sizes were added to 10 built-ins from the pages already read, for example
  Pixhawk 6C "84.8 * 44 * 12.4 mm" and MN3110 "Φ37.7×28.5mm".
  - They were checked against the live pages: every stated dimension string
    matched.
  - The seed is now version 2 (177 values). Existing installs pick the new values
    up through the in-place update from 3.3.
- Refused deletes close the confirmation dialog so the reason is visible.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 157 passed, 6 new:
  - sizes by category (MN3110 → Φ37.7 × 28.5 mm, APC 10" → 127 mm radius, Tattu →
    133 × 45 × 33.5 mm, Pixhawk → box);
  - GPS (no size) and imported models keep their own shape;
  - mass conversion and fallbacks;
  - display-only resolution (the stored document is unchanged);
  - a prop resting on a linked motor;
  - category filtering;
  - a save with a missing link refused;
  - deleting an in-use component refused, with the exact message.
- `playwright`: 28 passed, 2 new:
  - link a motor: 37.7 × 37.7 × 28.5 mm and 99 g with "Manufacturer" and T-Motor's
    URL; "without mass" disappears; a prop added on it sits at 18.3 mm; unlink
    restores 28 × 28 × 30 mm and an empty mass; Ctrl+Z re-links; still linked
    after a restart;
  - deleting a linked copy is refused with its reason, and the dialog closes.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.3: built-in components with sources

**Built**
- `database/seed/components.v1.json`: 20 built-in components (147 values) in the
  pack format, with fixed ids (UUID v5).
  - Every value is `source: manufacturer`, with the page URL, the section, the
    date read (2026-11-21) and, where the page qualifies the value, a condition
    (e.g. "Max continuous current (180 s)", "±20 g", "aluminium case").
  - Values were read in the browser on the manufacturer's own pages during this
    milestone, not recalled.
- `electron/main/components/seed.ts` loads them at each start:
  - it adds missing ones as read-only built-ins;
  - it updates a built-in in place when the seed is corrected (new
    `replaceBuiltIn`, revision bumped);
  - it never touches user records (including a user record that holds a seed id);
  - it never deletes built-ins dropped from the seed;
  - the seed goes through the same validation as any import.
- New fields, so values could be stored exactly as stated instead of converted:
  - power modules: cell range (pages state "2~12S", not volts);
  - peripherals: supply voltage min/max/single and supply current;
  - batteries: nominal pack voltage;
  - motor test tables: an RPM column (new `rpm` unit).

**Sources**

| Part(s) | Page |
|---|---|
| Holybro Pixhawk 6C (processor, max input 6 V, 16 PWM outputs, 59.3 g aluminium case, 13 ports with names and types) | docs.holybro.com technical specification and ports pages |
| Holybro PM02 V3, PM06 V2, PM08-CAN (cells, continuous/burst current, sensing, 5.2 V/3 A output, mass) | docs.holybro.com power module comparison |
| Holybro M10 and M9N GPS (4.7–5.2 V, < 200 mA at 5 V, 36.8 g V2) | docs.holybro.com standard M10/M9N/M8N overview |
| Holybro SiK Telemetry Radio V3 100 mW and 1 W | docs.holybro.com SiK radio V3 |
| T-Motor MN3110 KV470 / KV700 / KV780 (Kv, 3–6S, 180 s max current and power, internal resistance, idle current at 10 V, mass, stator, shaft, and 25–30 test rows each) | store.tmotor.com MN3110, Specifications tab |
| Holybro Tekko32 F4 4in1 50A and Tekko32 F4 45A ESCs | holybro.com product pages |
| T-Motor P13×4.4 and P15×5 CF propellers | store.tmotor.com product pages, Specifications tab |
| APC 10×4.5MR, 11×4.5MR, 12×4.5MR | apcprop.com product pages |
| Tattu G-Tech 5200 mAh 4S 35C, Gens ace Adventure 3600 mAh 4S 60C | genstattu.com (Tattu and Gens ace's official store) |

**Verification of the data**
- T-Motor's test tables were extracted from the page's HTML, not retyped. The
  stored rows were re-extracted from the live page, and the SHA-256 of both
  matched (`4ade8287…`).
- An automated spot check fetched every cited page and searched for every cited
  number. 124 numbers were checked:
  - 121 appear verbatim;
  - 3 are APC's "1/4 in." bores, stored as 0.25 in with the original wording in
    the condition.

  Each MN3110 value was checked inside its own Kv table.
- Text values (processor, port names, protocols, mounting) were read by hand.
- Unit test: in every test row, power = voltage × current (±0.011 W). This holds
  for all 80 rows, which catches transposed digits.

**Honest gaps**
- Ambiguous values are stored with the page's own words, not reinterpreted:
  - Tekko32 45A: the page only says "45A designed";
  - Gens ace 3600: "60C" is only in the product title;
  - T-Motor prop mass is labelled "Weight (Single Blade)".
- Left out because the manufacturer page has no figures:
  - Holybro's X500 V2 kit motor (2216 KV920) and its 20 A ESC;
  - T-Motor's AIR 20A ESC: its rating is only in the product name, with no
    continuous/burst figure.
- No wire or connector records yet. Wire resistance comes from the AWG standard
  in 3.7; connector ratings still need a manufacturer datasheet that can be read.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 151 passed, 6 new:
  - loads once, idempotent on restart;
  - 15–25 parts across all main categories;
  - every value cited from an https manufacturer page (allow-listed hosts) with a
    date;
  - test-table consistency;
  - unique fixed ids;
  - corrections update in place without touching user copies or user records.
- `playwright`: 26 passed. The library e2e test now starts with the 20 built-ins:
  - Pixhawk 6C is read-only, shows 16 PWM outputs linked to Holybro's page, and
    lists Telem1 (UART);
  - the user-component flow works alongside the built-ins.
- Typecheck and lint clean.

## 2026-11-21 — Phase 3, milestone 3.2: component library page

**Built**
- **Components page** (enabled in the sidebar; Electrical Designer stays disabled
  until 3.6). Sections of the phase in progress are now enabled one by one with a
  `ready` flag. The disabled-section e2e check moved to Engineering Analysis.
- **List**:
  - search (name, manufacturer, category, notes) and category filters with counts;
  - columns for category, values ("6 · 4 cited") and origin;
  - empty states that say what to do.
- **Detail**: every field of the category, in order.
  - A set value shows its value and unit, any condition, its source (Manufacturer /
    Measured / Entered by you) and the citation (host · page · date read), linked
    to the source URL (opens in the system browser).
  - Unset fields read "not specified".
  - Manufacturer test tables are shown as a table with their units.
  - Edit and Delete are disabled for built-in records, with the reason.
- **Editor** (dialog, built from the field definitions):
  - name, manufacturer and notes, plus each field with value, unit (only units of
    that dimension), source and, when cited, source URL or document title,
    page/section, date read (today by default) and condition;
  - port lists and table rows can be added and removed;
  - a value without a chosen source is refused in the form;
  - main's messages (which name the field) are listed when a save is refused.
- **Packs** (`electron/main/components/pack.ts`): JSON format
  `blaze-uav.components` v1.
  - Export all, the filtered list, or one component, through a Save dialog.
  - Import through an Open dialog, all or nothing: every entry is validated with
    the same schema as an edit, so the citation rules apply to imports. Problems
    are listed per entry and field (first five shown).
  - Entries whose id already exists are skipped, so re-importing adds nothing.
  - Limits: 10 MB, 5000 entries.
- Editor form logic (`editor-model.ts`) and display helpers (`spec-format.ts`) are
  pure and unit tested.

**Found and fixed during the screenshot check**: the editor scrolled sideways. A
`<fieldset>` cannot shrink below its content's width by default, and the
thrust-table editor is wide. With `min-w-0` the table scrolls inside its own box.
Field hints now show under the field name instead of as the "Condition"
placeholder.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 145 passed, 12 new:
  - export → delete → import identical (ids, values, sources), with re-import
    skipping everything;
  - entries without ids;
  - refusals: not JSON, wrong format, newer version, duplicate ids, and a mixed
    pack (an uncited manufacturer value, a wrong unit, a non-object), with
    nothing imported;
  - editor round trip of a stored component;
  - the "choose a source" and number errors;
  - references, ports and tables;
  - strict number parsing;
  - display formatting.
- `playwright`: 26 passed, 1 new:
  - create a motor through the editor, refused first for a value without a
    source and then for a manufacturer value without a URL;
  - the detail view shows the sources and the link;
  - edit, duplicate, search, filter;
  - export (2), delete both;
  - a malformed pack and a non-JSON file are refused with their messages;
  - import: the values and sources match the originals exactly;
  - persists after a restart.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.1: component model and storage

**Built**
- `src/domain/units.ts`: a pure units module shared by main and the renderer. It
  covers 13 dimensions and conversion to and from SI. The exact definitions are
  documented in the file:
  - inch, ounce;
  - Ah, mAh;
  - Kv (rpm/V → rad/(s·V));
  - C rating (current = rate × charge);
  - gram-force (standard gravity);
  - °C;
  - AWG via ASTM B258, d = 0.127 mm × 92^((36 − n)/39).
- `electron/ipc/component-fields.ts`: nine categories and their fields, as plain
  data:
  - motor, propeller, battery, ESC, flight controller, power module, peripheral,
    wire, connector;
  - field kinds: quantity with unit, whole number, text, choice, port list, and a
    table with one unit per column (for manufacturer thrust tests);
  - every field is optional.

  The renderer will build forms from this, and main builds validation from it.
- Provenance on every value: `source` (manufacturer / measured / user), a
  `reference` (URL or document, locator, retrieval date) and an optional
  `condition`.
- `electron/ipc/component-schemas.ts`: zod schemas generated from the field table.
  Refused, with messages that name the field (e.g. "Kv: Unit must be one of
  rpm/V"):
  - a manufacturer value without a URL or document title, or without the date it
    was read;
  - non-http(s) URLs;
  - wrong units and negative values;
  - non-whole counts;
  - fields from another category;
  - duplicate port names;
  - min > max (compared in SI, so 4500 mV vs 5.5 V works);
  - malformed tables.
- Migration `0005_component_library.sql` (schema v5): `components` gains `origin`
  (built-in / user / imported), `schema_version`, `revision` and `notes`, plus a
  category + name index.
- Repository and IPC: list (optionally by category), get, create, update,
  delete and duplicate.
  - Updates use the same stale-revision rejection as assemblies, and a component
    cannot change category.
  - Built-in records are read-only. Duplicate makes an editable user copy that
    keeps every value's provenance.

**Deviation from the plan**: values are stored as the source states them (e.g.
"1300 mAh", "5 in"), not converted to SI. This way a stored value can be compared
with its datasheet directly. Checks convert with `toSI`. The links from parts to
components and the wiring tables will come in their own migrations (3.4 and 3.6),
when they are used.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 133 passed, 21 new:
  - exact unit definitions, a C rating × capacity example, and AWG against
    standard values (12 AWG = 3.309 mm², 20 AWG = 0.5176 mm²) with round trips;
  - field-table integrity;
  - an exact IPC round trip;
  - the citation rule;
  - nine refusal cases with their messages;
  - thrust tables, ports, cross-unit voltage ranges;
  - stale updates, category changes, read-only built-ins and duplication.
- `playwright`: 25 passed (no UI yet; the library page is milestone 3.2).
- Typecheck and lint clean.

## 2026-11-21 — Phase 2, milestones 2.6–2.7: inspection, building tools, hardening

Scope revised with the user before starting: four gaps against the approved plan
were added (fit including parts, drag onto a mount, gizmo hidden by parts, status
strip), plus three tools the user asked for (copy to all motor mounts, image
export, measure).

**Built**
- Inspection maths (`inspection.ts`, pure and unit tested):
  - world matrices of all parts in one pass;
  - part and assembly bounds;
  - exploded-view offsets;
  - status counts;
  - mount snapping;
  - measurement.
- **Exploded view** (X, or the toolbar toggle and its spread slider):
  - parts on motor mounts move out along their arm, parts on plates move away from
    the plate, free parts move outward from the centre (or up when near it), and
    each stacked level lifts by the same distance;
  - full spread = 0.3 × the motor diagonal;
  - display only: the gizmo is off while it is shown, so offsets can never be saved.
- **Dimension overlay**: X/Y/Z extent lines on the selected part, in its own axes
  and drawn over everything, with constant-size mm labels that follow exploded
  positions.
- **Connection markers**: a constant-size dot on every mount while a part is
  selected. The current mount is filled, and the drag target is enlarged. They
  never take clicks: an earlier clickable version covered the gizmo's centre
  handle (caught by the drag e2e test), so attaching is by drag or "Attached to".
- **Drag onto a mount**: while moving with snapping on, a mount within 15 mm
  sideways (and within the part's half height + 15 mm vertically) lights up.
  Releasing attaches the part there. This is one undo step, and a release elsewhere
  is a normal move.
- **Fit**: F frames the selected part, or the whole assembly including parts when
  nothing is selected. Automatic re-framing uses the assembly bounds.
- **Gizmo**: drawn last (render order), so parts no longer hide it.
- **Status strip**: part count, plus "unattached", "without mass" and "model
  warning(s)" buttons; each selects the first matching part.
- **Copy to all motor mounts** (inspector button for a part on a motor mount):
  - copies the part and everything attached to it onto every motor mount without
    a part of that kind;
  - poses are kept relative to each mount (so copies follow motor tilt);
  - one undo step.
- **Save image of the view** (toolbar):
  - renders one frame at ≥ 2× device pixels without the gizmo, and encodes it as
    PNG in the renderer;
  - main validates the bytes (`viewport:savePng`: PNG signature, ≤ 50 MB), shows a
    Save dialog proposing a safe file name in Pictures, and writes the file.
- **Measure tool** (M):
  - two clicks on any surface; with snapping on, a click snaps to the nearest mesh
    vertex within 8 px;
  - the amber line and label show the distance, and the status strip shows
    distance and ΔX/ΔY/ΔZ in mm;
  - Esc clears the measurement, a second Esc leaves the tool;
  - labels let clicks through while measuring, and nothing is selected or saved.
- Narrow layouts: below a 640 px toolbar, Persp/Ortho and Grid hide (P and G still
  work), like the presets.
- Shortcuts also work while the explode slider has focus (its arrow keys stay its
  own).
- ADRs: 0003 (Z-up renderer) and 0004 (asset store and protocol).

**Real exports**: Blender 4.2.3 was found on this machine.
`tests/fixtures/blender/make_fixtures.py` builds a 100 × 60 × 50 mm camera pod and
exports it three ways:
- default GLB: accepted, 100 × 60 × 50 mm at the glTF defaults (m, +Y up), and
  loads;
- "glTF Separate" (.gltf + .bin): refused, naming `pod-separate.bin`;
- Draco GLB: refused.

**Performance** (this machine, `tests/e2e/performance.spec.ts`, 50 parts including
the Blender model, orbiting for about 2 s):

| Size | Rendered fps | Frame median | p95 |
|---|---|---|---|
| 1920×1080 | 59.8 | 16.6 ms | 16.7 ms |
| 3840×2160 | 42.6 | 16.9 ms | 33.5 ms |

The idle viewport rendered 0 frames over 1 s after the camera settled. The test
fails if the 1080p median falls below 50 fps.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 112 passed, 11 new:
  - bounds through all attachment kinds;
  - exploded offsets per attachment kind, with the saved doc unchanged;
  - status counts;
  - snap rule (sideways, height, current mount excluded, top vs bottom plate);
  - copy to mounts (hex, with a tilted mount);
  - PNG validation and safe file names (including `../`, reserved names and
    control characters);
  - measurement and vertex snapping;
  - the Blender exports.
- `playwright`: 25 passed, 8 new:
  - status strip, dimensions, markers, fit and exploded view (saved positions and
    save state unchanged);
  - drag onto the motor 1 marker (highlight halfway: no, at the marker: yes);
  - copy to mounts on a hex;
  - PNG export (≥ 2× size, PNG signature, proposed name);
  - measure (450.0 mm between motor pads, ΔZ 0);
  - **hex acceptance**: 6 motors and 6 propellers, two spins reversed, and the
    Blender GLB under the bottom plate. After a restart the stored assembly is
    deep-equal and the model loads.
  - **every edit kind** (frame, spin, tilt, add, nudge, rotate, resize, mass,
    rename, copy to mounts, duplicate, attach, detach, delete, import, model
    units): undone back to the empty assembly (stored state equals the initial
    one), then redone (equals the final one);
  - performance.
- Typecheck and lint clean; no console errors in any of these flows.

**Decided not to do**: splitting the 1.2 MB workshop chunk further. It already
loads only with the workshop, from local disk, so more files would not be
measurably faster.

**Known limits**
- Saved images contain the 3D scene only; the DOM labels (motor numbers,
  dimensions) are not in the PNG.
- Copies on other motor mounts keep the same orientation in the mount frame (no
  per-arm yaw), which suits round parts but not, for example, an ESC aligned to
  its arm.
- Exploded view and the measure tool are not saved by design.

## 2026-11-21 — Phase 2, milestone 2.5: model import (GLB / glTF)

**Built**
- `electron/main/assets/gltf.ts` (pure validator, main only). Accepts `.glb` and
  self-contained `.gltf` (glTF 2.0). Rejects with a message meant for the user:
  - files over 50 MB, checked from the file size before reading;
  - a wrong GLB signature, or a truncated container;
  - glTF versions other than 2.x;
  - buffers or images referencing another file or a URL (only `data:` URIs and
    GLB buffer views are allowed);
  - Draco, meshopt and KTX2 compression (no decoders are bundled);
  - files with no meshes, broken node references or node loops.
  It also computes the triangle count and the default scene's bounds. Bounds come
  from POSITION accessor min/max, which glTF 2.0 requires, transformed through the
  node hierarchy.
- Asset store (`electron/main/assets/store.ts`):
  - Files are copied to `<userData>/assets/<sha256>.<glb|gltf>`; identical bytes
    are stored once.
  - Migration `0004_assets.sql` (schema v4) records the file name, format, size,
    triangle count and bounds.
  - At startup, assets no part uses are deleted (row and file). Undo history does
    not survive a restart, so nothing that could still be redone is lost.
- `blaze-asset://model/<sha256>` protocol: privileged, fetch-capable, and serves
  only exact 64-hex ids from the store folder. The CSP `connect-src` now allows
  `blaze-asset:`, plus `blob:`/`data:`, which three.js uses for embedded textures.
- Import flow:
  - "Import model (.glb, .gltf)…" in the Add part panel. Main shows the native
    file dialog and validates the file.
  - An options dialog then asks for the file's units (m / mm / in) and up axis
    (+Y glTF, +Z CAD), and the part kind. It shows a live X × Y × Z size preview,
    flags sizes above 3 m or below 1 mm ("Check the units"), and warns above
    500,000 triangles.
  - The import is one undoable edit, and the part rests on the selected mount or
    part like any other part.
- Placement maths (`src/three/model-units.ts`, documented in the file): centre the
  file's bounding box on the part origin, rotate +90° about X for Y-up files (file
  +Y → world +Z, file +Z → world −Y), then scale by metres per unit (inch =
  0.0254 m exactly).
- Rendering:
  - three's `GLTFLoader` through `useLoader`, with each part getting its own clone.
  - While a model loads, or if it fails to load, its bounding box is drawn instead,
    so the part stays visible and selectable.
  - The selected model shows its box outline.
- Inspector for model parts: file name, units, up axis, display status
  ("Shown · N triangles", or the load error) and a size readout. The size readout
  now appears for every shape.

**Deviation from the plan**: units and up axis are stored per part (in its
shape) instead of per asset, so the same file can be used at different scales and
a wrong unit can be corrected later with undo. The `assets` table therefore holds
only facts about the file.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 101 passed, 13 new:
  - bounds through node translation, rotation and scale;
  - every rejection case above, including `../` and URL buffers and a `file:///`
    image;
  - content-addressed storage and dedupe;
  - a sparse 50 MB+ file refused without reading it;
  - protocol URL resolution refusing traversal, unknown ids, uppercase ids and
    other hosts;
  - saves referencing an unknown asset rejected;
  - garbage collection after a project is deleted;
  - unit and up-axis maths checked against the three.js quaternion;
  - model parts resting on a mount.
- `playwright`: 17 passed, 2 new:
  - Import a 100 × 20 × 50 (Y-up, mm) GLB. The preview is 100000 mm in metres,
    with a units warning, then 100 × 50 × 20 mm in millimetres. The model loads
    (12 triangles) and rests at z = 14 mm. Undo/redo of the import and of a unit
    change both work, it is identical after a restart, and there are no console
    errors.
  - An external-reference `.gltf` and a text file renamed `.glb` are both refused
    with their messages, and no part is added.
- Typecheck and lint clean.
- Screenshot check: an 80 mm-tall Y-up box stands upright on the motor 1 mount.

**Notes**: test fixtures are generated in code (`tests/fixtures/gltf.ts`), so no
third-party model files are in the repository. Real-world exporter files (Blender,
Fusion, Onshape) have not been tried yet.

## 2026-11-20 — Phase 2, milestone 2.4: parts and editing

**Built**
- Attachment model (`assembly-ops.ts`, pure). A part is free (world pose), on a
  frame mount (pose relative to the mount; follows frame size and motor tilt;
  `plate-bottom` faces down), or on another part (pose relative to it). Operations:
  add, delete (with everything attached), duplicate (subtree with fresh ids and the
  next free names), attach (rests the part on its new target), detach (keeps the
  world pose), and quaternion ↔ XYZ-degree conversion. Attaching a part to its own
  subtree is refused.
- Seven part kinds start with placeholder shapes (box or cylinder; propellers as
  their swept disc) and **no mass**. The UI says so; nothing is presented as a
  product specification.
- Viewport: parts render inside their mount/parent frames. Click to select; the
  drei `TransformControls` gizmo moves or rotates the selected part with 5 mm / 15°
  snapping (toggle with S). One drag is one undo step.
- Left panel: "Add part" library (adds to the selected mount or part, otherwise on
  top of the frame) and an Assembly tree grouped by mount, with attached parts
  nested and "no mass" flagged. Right panel: Part inspector with name, kind,
  attached-to (frame mounts and valid parts only), box/cylinder shape and size in
  mm, position (mm) and rotation (°) relative to the attachment, optional mass in g
  (stored with `source: 'user'`), Duplicate, and Delete (shows how many attached
  parts go with it).
- Keyboard: W move, E rotate, S snap, arrows/PgUp/PgDn nudge (5 mm, or 1 mm with
  snap off), Ctrl+D duplicate, Del delete, Esc deselect. Existing undo/redo covers
  all of it.
- Shared `NumberField` component (commit on Enter/blur, Esc reverts, reasons for
  invalid values).

**Verified**: `cargo test` 11, `vitest` 88 (7 new: placement on mount/part/frame,
cascade delete, subtree duplicate, loop refusal, detach keeping the world pose
through a 20° motor tilt, bottom-plate orientation, Euler round-trips),
`playwright` 15 (2 new: a full library/tree/inspector/keyboard flow with
persistence across restart; and a real mouse click in the 3D view that selects a
part, followed by a gizmo drag that moves it, snapped to 5 mm, with undo
available). Typecheck and lint clean, and no console errors in the parts flow.

**Notes**: the gizmo is not drawn above parts that hide it (three.js
`TransformControls` default). Model (GLB) parts render nothing until milestone 2.5.

## 2026-11-20 — Phase 2, milestone 2.3: parametric frame and motor mounts

**Source check**: motor numbering, positions and default spin were taken from
PX4-Autopilot v1.13.3 `src/lib/mixer/MultirotorMixer/geometries/{quad_x,hex_x,octa_x}.toml`
(fetched and read, not recalled). PX4's body y axis points right, so it is negated
for our y-left world. Spin is as seen from above. PX4 v1.14+ configures geometry
through control-allocation parameters instead; that numbering has not been checked
here.

**Built**
- `src/three/frame-geometry.ts` (pure): `buildFrame(layout, params, overrides)` →
  motor mount points (arm tip, top face; id `motor-n`, PX4 name, arm angle, spin,
  tilt, default spin, customised flag), plate top/bottom mounts, arm boxes and
  framing bounds. The frame sits on the ground plane: z ∈ [0, arm thickness].
- Migration `0003_motor_mounts.sql` (schema v3): `motors_json` holds per-motor
  overrides. Only motors that differ from the PX4 default are stored; resetting
  removes the entry. Validation: keys `motor-1`…`motor-8`, spin `cw`/`ccw`,
  tilt within ±30° (about the arm axis).
- Viewport draws the centre plate, arms (with edges), mount pads and spin arrows
  (270° arc, follows the tilt). The camera re-frames when the frame's size changes
  until the user moves it.
- Motor labels ("1 · CCW") are DOM buttons in an overlay, positioned by a projector
  inside the canvas (`screen-labels.tsx`). They stay a constant size and render on
  demand. This replaces drei `<Html>`, which dropped the first label under React 19
  StrictMode.
- Project panel: motor list in PX4 order (customised motors in amber). View
  panel: Motor inspector with mount name, position, arm angle, CW/CCW toggle, tilt
  in degrees, the PX4 default, and Reset. All edits go through undo/redo and the
  save. Esc or a click on empty space clears the selection.

**Bugs found and fixed**: the status strip could report "Top view" while a newly
opened project showed iso (the camera rig ignored the stored preset); the motor
selection carried over between projects.

**Verified**: `cargo test` 11, `vitest` 81 (16 geometry: every motor of all three
layouts within 0.01 mm of the PX4 unit vectors × half-diagonal, opposite motors
exactly one diagonal apart, X orientation, PX4 quad order and spins, CW/CCW
balance, overrides, bounds, plate mounts; plus storage, migration and validation of
overrides), `playwright` 13 (2 new: every layout's labels and default spins; spin
and tilt edit, undo, the ±30° limit, geometry following the diagonal, persistence,
reset). Typecheck and lint clean.

## 2026-11-20 — Phase 2, milestone 2.2: assembly model, saving, undo/redo

**Built**
- Migration `0002_assembly.sql` (schema v2): `assemblies` (one per project: revision,
  frame parameters) and `assembly_parts` (kind, shape, parent and mount, position,
  quaternion, optional mass with source). The parent foreign key is deferred, so a
  whole assembly can be written in any order. Everything is deleted with its project.
- Repository `assemblies.load` creates the assembly with starting frame values per
  layout on first open. `assemblies.save` replaces the document atomically, bumps the
  revision and the project's modified time, and throws `ConflictError` if the edit
  was based on an older revision.
- IPC `assembly:load`, `assembly:save`, plus `assembly:saveSync` (same handler,
  blocking), which is used only while a window unloads. zod validation covers frame
  limits and plate < diagonal; parts check unit quaternions, coordinates within a
  20 m cube, mass > 0 with `source: 'user'`, SHA-256 asset ids, unique ids,
  existing parents, no attachment loops, ≤ 500 parts. New error code `CONFLICT`.
- Renderer store (`assembly-store.ts`): snapshot-based undo/redo with labels (cap
  200), a 500 ms debounced save, at most one save in flight (later edits re-save on
  the new revision), and a conflict state that stops saving and offers Reload.
- Workshop: Frame editor (motor-to-motor diagonal, centre plate, arm width/thickness
  in mm, comma decimals accepted, reasons shown for invalid values, Esc reverts),
  undo/redo buttons with labels, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, and a save status
  with Retry/Reload in the status strip.
- Starting values are labelled as such in the UI. They are editable design
  dimensions, not component specifications.

**Bugs found and fixed**
- On quit, the database was closed before the windows. A save fired while the
  window unloaded could hit a closed database and the last edit was lost
  (intermittently). The database now closes on `will-quit`, after all windows.
  Verified by repeating the quick-close e2e 5×.
- With undo/redo added, the workshop toolbar overflowed by 8 px at 200 % zoom. The
  view-preset buttons now hide below 640 px of width; keys 1–4 still work.

**Verified**: `cargo test` 11, `vitest` 63 (24 new: v1→v2 upgrade, repository
round-trip, conflict, cascade, 12 validation cases, store undo/redo, debounce,
in-flight ordering, conflict, sync flush, mm parsing), `playwright` 11 (2 new:
edit, undo/redo, invalid input and restart persistence; closing the app inside the
save debounce keeps the edit). Typecheck and lint clean.

**Deviation from plan**: undo uses document snapshots rather than command objects.
Documents are small immutable values, so snapshots are simpler and cannot drift
from the data.

## 2026-11-20 — Phase 2, milestone 2.1: viewport shell

**Built**
- Drone Workshop enabled in the sidebar. `/workshop` lists projects to open;
  `/workshop/<id>` opens one. Project names on the Dashboard and Projects pages link
  into the workshop.
- The workshop route is lazy-loaded: three.js (separate ~1 MB chunk) is not loaded
  on any other page.
- Viewport (three 0.187, React Three Fiber 9, drei 10): Z-up world shared with the
  engine (`src/three/setup.ts`); perspective (35° vertical FOV) and orthographic
  cameras; Top / Front / Right / Iso presets; fit; 10 mm / 100 mm ground grid;
  origin axes; axis gizmo. Renders on demand only.
- Framing uses `fitToSphere` (keeps the viewing direction; `fitToBox` snaps to an
  axis). The view re-frames on every resize until the user moves the camera.
  Switching projection keeps the direction.
- Resizable, collapsible Project and View panels (`react-resizable-panels` v4);
  layout, projection and grid choice are remembered. Toolbar toggles follow the
  group layout, so panels squeezed shut by a narrow window show correctly.
- Shortcuts: 1–4 views, F fit, P projection, G grid.

**Verified**: `cargo test` 11, `vitest` 39 (6 new for view maths), `playwright` 9
(3 new). The new e2e tests cover three.js loading only in the workshop, every
preset and projection staying framed, the canvas exactly matching its container
from 880×560 to 3840×2160 and at 150 %/200 % zoom, panel collapse, layout
persisting across restarts, and the workshop added to the no-overflow matrix.
Typecheck and lint clean.

**Notes**: React Three Fiber 9 logs a `THREE.Clock` deprecation warning with three
0.187. It comes from the library, not our code. The frame-time log at 4K is
scheduled for milestone 2.7.

## 2026-11-20 — Renamed to Blaze UAV

- Product name **Blaze UAV**, project folder `Documents\Blaze UAV`, npm name `blaze-uav`.
- App ID `com.blazeuav.app`; installers `BlazeUAV-Setup-<version>.exe` and
  `BlazeUAV-Portable-<version>.exe`; Start menu and desktop shortcut "Blaze UAV".
- User data moves to `%APPDATA%\Blaze UAV\blaze-uav.db`. Data saved under the old
  name (`%APPDATA%\Drone Simulator`) is not migrated; it was test data only.
- Test-only variables renamed to `BLAZE_UAV_USER_DATA` and `BLAZE_UAV_ENGINE`.
- Unchanged internals: engine binary `drone-engine.exe` and the Rust crate names.

## 2026-11-20 — Phase 1, pass 2: new location, UI redesign, desktop hardening

**Moved** the project from `Documents\DroneSimulator` to `Documents\blaze`. Build
outputs were not copied. A fresh `npm ci`, release engine build and the full test
suite pass in the new location. `better-sqlite3`'s implicit `node-gyp` install
script is now denied in `allowScripts`: the package ships Node-API prebuilds, so
fresh installs no longer try to compile C++.

**UI redesign** (rules in `DESIGN.md`)
- IBM Plex Sans/Mono instead of Inter/JetBrains Mono. Colour follows
  glass-cockpit semantics (cyan interactive, green normal, amber caution, red
  failure). Graphite chrome sits one step darker than the work area.
- Boxed cards replaced by docked sections with hairlines. Uppercase eyebrow
  labels and filler subtitles removed. Values are monospaced and bright, units muted.
- New: rotor-layout glyphs (quad/hex/octo X) in tables and as the frame picker in
  the New project dialog; app icon and brand mark (`build/icon.svg` →
  `npm run icon`); window-wide status bar (engine state, round trip, schema, version).
- Developer details (Electron/Chromium/platform) moved from the dashboard to
  Help → About.

**Responsive behaviour**
- Sidebar becomes an icon rail below 1180 CSS px (zoom counts) or on demand;
  the choice is remembered.
- Page grids and tables use container queries; secondary columns drop out.
- Dialogs fit small windows. The native title bar, menus and scrollbars are dark.
- Window sized from the actual work area. Minimum lowered from 1100×700 to
  880×560, so the app fits a 1366×768 laptop at 125 %. The previous fixed
  1440×900 window overflowed this machine's 1536×864 work area.

**Hardening**: single-instance lock; engine-status revisions (fixes a stale
"Restarting" that could outlive a later "Failed"); plain-language engine start
errors; database-open failures shown in a native dialog instead of a silent hang;
3 s quit deadline.

**Verified**
- `cargo test`: 11 passed. `vitest`: 33 passed. Typecheck (node, web, e2e
  configs) and lint clean.
- `playwright`: 6 passed. Main flow with zero console errors, engine kill and
  recovery, missing engine binary → visible "Failed" with reason, second launch
  focuses the first window, window inside the work area with an 880×560 minimum,
  and no horizontal overflow at 880×560, 1093×566, 1280×672 at 150 % zoom,
  1100×700 at 200 % zoom, 1920×1040 and 2560×1400.
- `npm run dev` checked over CDP: renderer served by Vite, engine connected, no
  console errors or CSP violations.
- `npm audit --omit=dev`: 0 vulnerabilities in shipped dependencies. The 6
  moderate findings are in electron-builder's build-time `minimatch` chain.

## 2026-11-20 — Phase 1: Foundation

**Built**
- Repository analysis of Blaze-Simulator (`reference-analysis.md`). It has no license, so it is used as inspiration only.
- Architecture and ADRs: Rust sidecar engine (ADR 0001), SQLite in main (ADR 0002).
- Rust workspace: `engine-core` (math types, Z-up SI conventions) and `engine-host` (`drone-engine`, NDJSON protocol v1: hello/ping/shutdown).
- Electron main: secure window (sandbox, context isolation, CSP, navigation lock), `EngineSupervisor` (handshake, health ping, restart with backoff, failed state, clean shutdown), SQLite with migrations, typed and zod-validated IPC.
- React UI: dark engineering theme, navigation (unbuilt sections disabled with phase tags), dashboard (recent projects, simulation history, live system status, component count), projects page (create/rename/delete).
- electron-builder: NSIS installer and portable exe; engine bundled in `resources/engine`.

**Verified**
- `cargo test --workspace`: 11 passed (math, protocol, spawned-binary integration).
- `vitest`: 31 passed (migrations, repositories, FK cascade, IPC validation, channel parity with preload, supervisor against the real binary including crash-restart and failed state, stores).
- `playwright`: 2 passed (connect → create → persist across restart → rename → delete; disabled nav; engine killed → Restarting → Connected).
- Typecheck and lint clean.
- Packaged app (`win-unpacked`) launched: engine connected from `resources/engine`, project created in SQLite.
- NSIS installer (`DroneSimulator-Setup-0.1.0.exe`, 131 MB) on the dev machine: silent per-user install to `%LOCALAPPDATA%\Programs\Drone Simulator` → installed app connected to its engine and saved a project → silent uninstall removed the folder, desktop shortcut and registry entry.

**Design review** (`.ui-design/reviews/phase1-ui_20261120_2108.md`): fixed table wrapping at the 1100 px minimum, capped content width on large screens, raised tertiary contrast, compact timestamps, and minified the renderer (1,091 kB → 351 kB). Responsive-3D requirements added to the Phase 2 criteria.

**Not done / known gaps**
- Installer not yet tested on a *clean* Windows machine, and upgrade (0.1.0 → 0.1.1) not tested. Both are scheduled for Phase 8. Unsigned: SmartScreen will warn.
- ~~No app icon yet~~ (added in pass 2).
- No physics yet. The engine only implements the protocol handshake.
