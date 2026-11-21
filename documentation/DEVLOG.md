# Development log

## 2026-11-21 — Phase 4, milestone 4.1: mass properties

**Built**
- **Frame mass**: a new frame field (migration `0008_frame_mass.sql`, schema v8),
  entered by the user with its source recorded like a part's mass. Not set = the
  CoM is incomplete. It is spread over a uniform-density model of the frame (plate,
  plus each arm outside the plate), so the frame has its own CoM and inertia.
- **`src/domain/mass.ts`** (pure, documented at the top of the file):
  - CoM = Σ mᵢ rᵢ / Σ mᵢ, positions taken through the attachment chain;
  - part inertia: uniform box or cylinder, propellers as thin blades averaged over
    a turn (mR²/3 about the shaft), imported models by their bounding box;
  - totals about the CoM by the parallel axis theorem, rotated into body axes;
  - products of inertia with the tensor sign convention;
  - parts without a mass are left out and listed;
  - `vehicleDefinition()` builds the engine's input (the shared interface in
    `plans/phase-4-physics.md`); the frame goes in as `frame:plate` and
    `frame:arm-n`.
- **Hover balance**: the least-squares thrust split that carries m·g with no roll or
  pitch moment about the CoM. If a motor would need negative thrust, the drone
  cannot hover level (error); a share above your margin (default +10 %, editable)
  is a warning. Both appear in Checks under the new `hover-balance` rule. Yaw is
  left out until each prop's drag torque is modelled (4.5).
- **Workshop**:
  - **Mass section**: total mass and weight; CoM X/Y/Z, horizontal offset and
    distance from the frame reference; the inertia tensor in g·m²; hover thrust and
    share per motor; a Method block.
  - **Viewport**: a constant-size CoM marker with a drop line to the ground. It
    can be toggled in the view panel or with C, and is dimmed while incomplete.
  - **Live dragging**: everything follows a gizmo drag before release.
- The ESLint config now ignores `.claude/**`. The parallel sessions' worktrees live
  there and broke `eslint .`.

**Verified** (`npm run test:all`, exit 0)
- Rust: 11 tests. Typecheck and lint clean.
- vitest: 205 tests, 20 of them new, against hand calculations written out in the
  tests:
  - box, cylinder and propeller inertia;
  - a rotated part, including the 45° product of inertia;
  - a battery moved 30 mm (exact CoM shift, ΔIzz and Ixz);
  - a mass change;
  - missing masses;
  - quad hover shares 1 ± d/a and the infeasible case;
  - the frame mass split;
  - thrust points (with a prop and with a tilted mount);
  - detaching leaves the mass properties unchanged.
- Playwright: 35 tests, 1 new. With a 300 g frame and a 500 g battery, moving the
  battery 40 mm forward puts the CoM at 25.0 mm and gives hover shares of
  1 ± 25/a. A warning appears and clears with the margin, undo restores the CoM,
  C toggles the marker, and the frame mass survives a restart. No console errors.
  Performance: 59.3 fps at 1080p and 38.1 fps at 4K, with 50 parts.

## 2026-11-21 — Workshop realism: frame, parts, materials, lighting

Display only. Sizes, masses and every check still use the part envelopes and the
frame's stated parameters, so no engineering value changed.

**Built**
- **Lighting**: image-based lighting from three.js `RoomEnvironment` (generated in
  the renderer, nothing downloaded, so the CSP is unchanged), plus a key light, a
  fill light and a hemisphere light.
- **Materials** (`src/three/materials.ts`), shared by every model so the scene
  still compiles only a handful of shaders:
  - carbon fibre: a 2×2 twill weave drawn on a canvas, repeating every 12 mm,
    non-metallic with a satin clearcoat;
  - aluminium, anodized black and accent, steel, copper, plastics, PCB, gold, LEDs.
- **Frame** (`src/three/frame-shapes.ts`, `FrameModel.tsx`):
  - carbon plates and arms are extruded outlines with a 0.2 mm bevel:
    - plate: chamfered, with strap slots, lightening holes and the 30.5 mm FC
      pattern;
    - arms: tapered, with lightening slots, ending in a round motor pad with a
      shaft hole and bolt holes;
  - socket-head screws clamp the arms; four bolts on each motor pad;
  - the "Simple" display mode keeps the old boxes.
- **Parts** (`src/three/part-models.tsx`):
  - motor: base, stator with copper windings, a lathed bell with vents and band,
    shaft and prop nut;
  - propeller: twisted aerofoil blades whose pitch angle follows the stated pitch,
    θ = atan(P / 2πr), mirrored for CW, with a carbon or plastic finish taken from
    the component's material;
  - battery with label, leads, XT60 and balance plug; ESC board; flight controller
    case with ports and LEDs; GPS puck; telemetry radio; power module.

**Fixed while reviewing screenshots**
- Carbon looked white at grazing angles: metalness 0.25 and a strong clearcoat
  reflected the room lights. Carbon is now dielectric (metalness 0), with a weaker
  clearcoat, a darker weave and a lower environment intensity.
- Prop plastic was near-white and is now dark grey. The swept disc keeps a lighter
  colour so it still shows on the dark grid.
- Switching to "Simple" threw `Cannot read properties of undefined (reading
  'count')`. React reused the detailed frame's mesh for the simple box, and drei
  `<Edges>` read its geometry before the box was attached. The two branches are
  now keyed separately.

**Verified**
- `npm run test:all`: 11 Rust, 185 unit and 34 e2e tests pass; typecheck and lint
  are clean. Two e2e tests (a gizmo drag, and a dialog click with "element is not
  stable") and the 4K perf figure (1.0 fps) failed in one full run while the
  window was throttled. Re-running those four specs passed all 16 tests, with
  59.3 fps at 1080p and 42.6 fps at 4K (50 parts).
- Screenshots reviewed: overview, motor close-up, body close-up, top view.

## 2026-11-21 — Phase 3, milestone 3.7: electrical calculations

**Built**
- `src/domain/electrical.ts` (pure, steady state). The model is documented at the
  top of the file and in the designer's "Method" block:
  - **Load case**: every motor at its stated maximum current (with the stated
    condition, e.g. 180 s), or one current the user enters. Battery at nominal
    voltage or full charge. Conductor temperature 20/40/60/80 °C.
  - **Currents**: the power wiring is walked as a tree from the battery; a power
    module passes current through. Each cable carries the sum of the loads
    downstream. A loop, or two batteries in one network, is refused with a reason
    instead of an assumed split.
  - **Cables**: R = ρ(T)·2L/A (both conductors of the lead), copper ρ₂₀ = 1/58
    Ω·mm²/m and α₂₀ = 0.00393 K⁻¹ (IEC 60028, annealed copper), A from AWG
    (ASTM B258). ΔV = I·R, P = I²·R.
  - **Battery**: V = V_oc − I·R_int with the pack's stated internal resistance;
    without it the terminal voltage is shown as not specified.
  - **Voltage at each ESC** (and so each motor) = terminal voltage − the drops on
    its path.
  - **Ratings for the load case**: battery continuous discharge (C × capacity),
    power-module continuous current, ESC continuous current per output.
  - Every missing value is a dash with the reason as a tooltip, and the reasons
    are listed under "Not calculated". Nothing is guessed.
- **Calculations drawer** in the Electrical Designer (toolbar button): load-case
  controls, battery, ratings (over-rated items in red; click selects the part),
  supply per ESC, power cables (click opens the wire to set gauge and length),
  method.
- The battery's internal-resistance field now says it is the whole pack's.
- The Markdown report no longer says wiring checks are missing (they have been
  included since 3.6).

**Found with the built-in hex**: six MN3110s at their stated 21 A (180 s) draw
126 A through the PM02 V3, whose PCB is rated 60 A continuous. The drawer shows it
in red; at 8 A per motor (48 A) it is within rating. The Tattu pack states no
internal resistance and no full-charge cell voltage, so sag and "full charge" are
shown as not specified.

**Deferred**
- Wire ampacity and connector ratings: the plan wants a cited ampacity table with
  its conditions, and none has been sourced yet. Until then cables show current,
  drop and loss but no rating.
- Motor-phase cables: their current depends on commutation (Phase 4 motor model).
- The load case is a view setting and is not saved with the project.

**Verified** (`npm run test:all`, exit 0)
- `cargo test`: 11 passed. Typecheck and lint clean.
- `vitest`: 185 passed, 8 new, each against a hand calculation written out in the test
  file and matched to 0.1 %: IEC resistivity at 20 and 60 °C; 12 AWG 150 mm =
  1.56324 mΩ; a two-motor network (42 A, sag 16.8 → 15.96 V, ESC voltages 15.85954
  and 15.82475 V, total loss 40.2299 W); temperature and an entered current;
  missing values with their reasons; loops, two batteries and no battery; ratings;
  the auto-wired hex overloading the PM02.
- `playwright`: 34 passed, 1 new (auto-wired hex: 126 A, 14.80 V, PM02 over its rating;
  12 AWG 150 mm main lead → 197.0 mV, 227.9 mV at 60 °C; 8 A per motor → 48 A
  within rating; no console errors).

## 2026-11-21 — Phase 3, milestone 3.6: Electrical Designer

**Built**
- **Wiring model**
  - Migration `0007_wiring.sql` (schema v7): `assemblies.wiring_json` holds the
    wires and the schematic positions. It is saved with the assembly in the same
    transaction, so undo/redo and the stale-revision check cover wiring like any
    edit.
  - Validation: unique wire ids, both ends on existing parts, no wire from a port
    to itself, schematic entries only for existing parts, up to 2000 wires.
  - Deleting a part removes its wires and its schematic position.
  - A wire is one cable: a power lead, the three motor phases, an ESC signal, or a
    peripheral cable. It can carry a gauge (AWG), a length (mm) and a colour; all
    three stay "not set" until the user enters them.
- **Ports** (`src/domain/wiring.ts`, pure), from the part's kind and linked
  component:
  - battery: power out;
  - power module: power in and out, plus sense (analog → ADC, digital → CAN);
  - ESC: power in, plus a signal and a motor output per channel (4-in-1 = 4);
  - motor: phases;
  - flight controller: its component's listed ports by name (Pixhawk 6C: Telem1–3,
    GPS1–2, I2C, CAN1–2, DSM RC, PPM/SBUS RC, USB, Power1–2) plus "PWM 1…n" (16
    stated outputs); a generic set when unlinked;
  - peripheral: one connector of its required type.

  Only ports of the same kind connect. Power, CAN and I²C are shared buses; every
  other port takes one cable.
- **Auto-wire** (PX4 convention):
  - battery → power module → every ESC;
  - power-module sense → "Power1";
  - ESC output n → motor n, by motor-mount number, so a missing motor leaves a gap;
  - PWM n → that ESC's signal;
  - GPS → "GPS1", telemetry radio → "Telem1", RC receiver → an RC input, others →
    the first free port of their type.

  It reports what it could not wire (e.g. two batteries: series or parallel is the
  user's choice). It is one undo step, and replacing existing wiring asks first.
- **Wiring checks**, added to the Checks panel in both the workshop and the
  designer:
  - wire-port: a wire on a port the part no longer has;
  - wire-kind: a wire joining different kinds;
  - port-conflict: two cables on a point-to-point port, naming the devices;
  - unwired: once wiring has started, a battery, power-module input/output, ESC
    power, motor, used ESC output without a signal, peripheral, or flight
    controller power left unconnected.
- With wiring, the **ESC-current check pairs different ESCs with their motors**
  one by one (before, it said "cannot check").
- **Electrical Designer page** (enabled in the sidebar; lazy-loaded with
  `@xyflow/react` 12.12.1, MIT):
  - one box per electrical part, with its ports on the sides, coloured by kind;
  - drag between ports to connect (only valid pairs are accepted); Delete removes
    a cable; moving a box is saved as an undoable step;
  - the side panel has:
    - the wire inspector: either end can be moved to another port of the same
      kind, and gauge, length and colour can be set;
    - a part's ports and what is on each;
    - the checks;
    - a wire list, which keyboard users can use without the canvas;
  - Undo/redo (Ctrl+Z/Y), a save indicator, and a link to the workshop.

**Bugs found and fixed**
- The assembly store saved and loaded only frame, motors and parts, so wiring was
  silently dropped on restart (caught by the e2e restart check). It now saves the
  whole document, and loads the optional fields when present.
- Deleting the battery's cable raised no warning: "unwired" now covers batteries
  and power modules.
- Peripheral connectors were drawn on the wrong side, so cables looped backwards.
  They are now on the right side.
- The performance test measured 1 fps once. Chromium throttles a hidden or covered
  window to 1 fps, and the screen was evidently not visible during that run. The
  test now disables background throttling for its window and logs visibility.
  Measured again: 59.3 fps at 1080p, 46.6 fps at 4K, unchanged from before.

**Deviation from the plan**: wiring lives in one JSON column of the assembly rather
than separate `wires`/`wire_ends` tables, so it shares the assembly's atomic save,
revision check and undo history. Calculations in 3.7 read it from there.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 177 passed, 8 new:
  - ports per part (the Pixhawk 6C's 13 named ports plus 16 PWM, 4-in-1 channels,
    analog and CAN sense, GPS UART, none for props or unlinked payloads);
  - connection rules;
  - auto-wire on a hex (22 cables, exact pairs, passes its own checks);
  - PX4 numbering with a missing motor, and the notes;
  - port conflict naming GPS and Radio;
  - missing ports, wrong kinds, and unwired warnings only once wiring has started;
  - motor-by-motor ESC pairing through the wiring;
  - wiring edits and deletion clean-up.
- `playwright`: 33 passed, 2 new:
  - a 17-part hex: auto-wire gives 22 wires and no errors or warnings; moving the
    GPS cable to Telem1 gives the exact port-conflict error; clicking it shows the
    flight controller's ports; undo clears it; a gauge of 12 AWG and a length of
    150 mm survive a restart along with all 22 wires;
  - deleting a wire raises a warning; a second auto-wire asks before replacing 21
    wires and restores 22.
- Typecheck and lint clean; no console errors.

## 2026-11-21 — Phase 3, milestone 3.5: compatibility checks and diagnostics

**Built**
- `src/domain/checks.ts` (pure; documented in the file). Nine rules, each with a
  one-sentence reason shown in the report:
  - **motor-count**: empty motor mounts (warning), two motors on one mount (error);
  - **battery-cells**: the battery's S against every motor's and ESC's cell range;
  - **esc-outputs**: ESC outputs (4-in-1 = 4, single = 1) against the motor count;
  - **esc-current**: ESC continuous current per motor against motor maximum current;
  - **battery-current**: C rating × capacity, labelled "calculated", against the
    sum of motor maximum currents;
  - **prop-bore**: bore against motor shaft. Smaller is an error, larger a warning
    ("adapter needed").
  - **prop-hand**: a CW/CCW propeller against its motor mount's spin ("pair" passes);
  - **prop-clearance**: swept discs at about the same height that overlap (error) or
    are less than 10 mm apart (warning). Tilted discs are compared approximately,
    and the message says so.
  - **prop-frame**: a disc reaching below the top of the frame.
- Behaviour common to all rules:
  - Only stated values are compared, in SI. Messages quote values as stated, with
    their conditions, e.g. "rated 20 A per motor, below MN3110 KV700's maximum
    21 A (Max continuous current (180 s))", or "a 0.25 in bore on the 4 mm shaft".
  - Missing data gives **cannot-check** with the reason, never a guess. Examples:
    an unlinked part; two batteries, where series or parallel is decided by the
    wiring; differing ESCs, where pairing is decided by the wiring.
  - Identical parts are grouped, so four identical motors give one message
    ("4 × 10x4.5MR … 4 × MN3110 KV700").
- `check-input.ts` builds the check input from the stored assembly (linked
  components, sizes as drawn, world positions and axes, the motor mount each part
  sits on). The exploded view is never used.
- **Checks panel** (left panel):
  - findings by severity with icons;
  - clicking a finding selects the parts involved;
  - "Copy report" copies a Markdown report with counts, findings by severity, and
    every rule with its reason.
- **Status strip**: "N errors · M warnings"; a click selects the first finding's
  parts.

**Found by the checks themselves**: 13-inch props on the default 450 mm quad
overlap by 12 mm (adjacent motors are 318 mm apart; two discs need 330 mm). My
first "clean build" test had exactly that mistake; the test now uses a 550 mm
frame for the clean case and keeps the 450 mm case as a failing one.

**Moved to later milestones (as planned)**: flight-controller port conflicts and
wire/connector ratings need the wiring graph (3.6, 3.7). The report is copied as
Markdown; there is no file export.

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 169 passed, 12 new. Every rule has passing and failing cases, plus
  cannot-check cases; the report format is covered too.
- `playwright`: 31 passed, 2 new:
  - a 6S test battery with a 4S test ESC gives the exact error naming both; "1
    error" in the status strip; clicking it selects the battery; the report is on
    the clipboard; swapping in the Tattu 4S clears all errors;
  - 13" T-Motor props on a 450 mm quad give four "overlap by 12 mm" errors;
    switching to APC 10" props clears them, and the bore warning remains.
- Performance with 50 parts is unchanged (59.6 fps at 1080p). Typecheck and lint
  clean.

## 2026-11-21 — Detailed part models

Asked by the user ("where are the models of the components", then "you can use
from repo main").

**Found**: the Blaze-Simulator repository's `main` has no model files. Its parts
are built in code (`dist/scene.mjs`, `dist/pixhawk-3d.mjs`) from three.js
primitives. Its catalogue values have no sources, so they were not taken. The
permission and how it was applied are recorded in `reference-analysis.md`.

**Built**
- `src/three/part-models.tsx`: detailed procedural models after that design,
  written for this renderer (Z-up, metres):
  - motor: base flange, copper windings in the gap, bell with an accent band, vented
    cap, shaft;
  - propeller: extruded blades with coloured tips, the blade count from a linked
    component (default 2), mirrored for CW/CCW from the motor mount the prop
    sits on, a prop-adapter hub and a faint swept disc;
  - battery: pack with wrap label and end caps;
  - ESC: PCB, MOSFETs, solder pads;
  - flight controller: Pixhawk-style case with lip, forward arrow, screws, LEDs,
    and one port socket per port of a linked component;
  - payload: an electronics module.

  Custom parts and imported models are unchanged.
- **Every model fills its part's envelope exactly**: the motor's sections add up
  to its height, the blades stay inside the disc, the boxes stay inside L × W × H.
  A linked MN3110 is still exactly Φ37.7 × 28.5 mm. Sizes, bounds, snapping and
  the size readout still use the envelope.
- An invisible envelope takes the clicks (thin blades are hard to hit) and shows
  the selection outline. The measure tool skips it and measures the visible
  surfaces.
- View panel "Parts: Detailed | Simple" (remembered); Simple draws the plain
  envelope shapes as before.

**Found in screenshots and fixed**:
- one blade colour vanished against the dark background (both blades are now one
  light colour with orange tips);
- the hub was as wide as the motor top (now about a prop-adapter size);
- the motor band z-fought with the bell (now 0.6 % proud of it).

**Verified**
- `cargo test`: 11 passed.
- `vitest`: 157 passed.
- `playwright`: 29 passed, 1 new: Detailed by default, Simple on request,
  dimensions unchanged in both, remembered after a restart.
- Performance with 50 parts is unchanged: 59.2 fps at 1080p, 46.0 fps at 4K.
- Typecheck and lint clean; no console errors in the screenshot runs.

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
