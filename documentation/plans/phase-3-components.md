# Phase 3 plan: Components and Electrical

Status: **in progress**. Progress: 3.1 ✅ (values stored as stated by the source,
not converted to SI; see DEVLOG) · 3.2 ✅ · 3.3 ✅ (20 parts; see DEVLOG for sources and gaps) · 3.4 ✅ (links store only the component id; values resolved at display) · detailed part models (see DEVLOG) · 3.5 ✅ (port and wire-rating checks move to 3.6–3.7 with the wiring).
The proposed options were chosen: a cited starter set,
`@xyflow/react`, and checks and electrical maths in TypeScript. Phase 1 and
Phase 2 must stay green throughout: every milestone ends with `npm run test:all`
passing.

## Goal
A component library in which every specification value has a source. The user can:
- link the parts of an assembly to real components;
- see compatibility problems as they build;
- wire the drone in an Electrical Designer;
- get steady-state electrical numbers (currents, voltage drops, losses, ratings)
  with the maths documented.

## The rule that shapes this phase
Never invent a specification. Concretely:
- Every value is stored as `{ value, unit, source, reference }`. `source` is
  `manufacturer` (datasheet or official product page), `measured` (the user's own
  test) or `user` (entered without a document). `reference` holds the URL or
  document, the page or table, and the date it was retrieved.
- The schema refuses a `manufacturer` value without a reference, and a test runs
  over every built-in record.
- Values the UI derives (for example a battery's maximum continuous current =
  C rating × capacity) are labelled "calculated" and show their formula. They are
  never stored as if a manufacturer had stated them.
- Missing data stays missing. A check that needs a value nobody has entered says
  "cannot check: X not specified" instead of assuming one.

## Scope
**In scope**
1. **Component model**: one schema per category (below), with units and
   provenance, versioned, validated with zod at the IPC boundary.
2. **Library UI** (the "Components" page, enabled):
   - browse, search and filter by category;
   - a detail view in which every value shows its source and reference;
   - add, edit and duplicate your own components (the source is required);
   - import and export JSON packs.
3. **Built-in data**: see decision 1.
4. **Linking in the workshop**:
   - a part can be linked to a library component of its kind;
   - linked values (mass, dimensions) replace the user values, and the inspector
     shows where they came from;
   - unlinking restores the user values;
   - linking is undoable.
5. **Compatibility checks** (pure rules, each documented and unit tested):
   - motor and ESC cell range against the battery's series cell count;
   - ESC continuous current ≥ motor maximum current (margin adjustable, default
     none);
   - battery continuous current (calculated) ≥ the sum of motor maximum currents;
   - propeller bore against motor shaft; propeller hand against motor spin;
   - motor count = rotor count; one ESC output per motor;
   - **propeller clearance** (deferred from Phase 2): swept discs that overlap
     each other, or the frame and parts, in 3D;
   - wire and connector ratings against the current through them (with wiring,
     below);
   - flight-controller port use: two peripherals on one port, or a required port
     the board does not have.

   Each finding has a severity (error / warning / cannot-check), a message, the
   parts and wires it involves, and the rule's reference.
6. **Diagnostics**:
   - a panel in the workshop and in the Electrical Designer listing findings;
   - clicking a finding selects what it is about;
   - a count in the status strip;
   - a report that can be copied or exported as Markdown.
7. **Electrical Designer** (the "Electrical Designer" page, enabled):
   - a schematic editor: components as nodes, with ports from their
     specification;
   - wires as edges, with gauge (AWG or mm²), length and colour;
   - **Auto-wire** builds a reference harness: battery → power module → ESC(s) →
     motors (phases), FC outputs → ESC signal by motor number, and peripherals →
     their usual ports. You can edit it afterwards.
8. **Electrical calculations** (steady state, documented in the file and in the
   UI):
   - per-branch current for a chosen load case (each motor at its maximum
     current, or a current you enter);
   - wire resistance R = ρ·L/A, with copper resistivity and its temperature
     coefficient (source cited), and the voltage drop and power loss for each
     wire;
   - battery voltage under load, using internal resistance if the datasheet
     gives it (otherwise "not specified");
   - a summary of the voltage at each motor and ESC.

**Out of scope** (later phases): thrust, hover current, flight time, AUW,
thrust-to-weight and centre of gravity (Phase 4 engineering analysis and
physics); temperature rise over time; firmware configuration.

## Component categories and fields
Only fields a datasheet commonly states. Every field is optional except identity;
checks degrade to "cannot check" when a field is missing.

| Category | Fields |
|---|---|
| Motor | Kv (rpm/V), cell range (S), max continuous current (A), max power (W), internal resistance (mΩ), no-load current (A @ V), mass (g), stator size, shaft Ø (mm), mounting pattern (mm), manufacturer test table (prop, V, throttle, thrust g, current A) |
| Propeller | diameter (in), pitch (in), blades, hand (CW/CCW/pair), bore Ø (mm), mass (g), material; published performance data if the manufacturer provides it (e.g. APC) |
| Battery | chemistry, series (S), parallel (P), capacity (mAh), C rating continuous/burst, nominal and maximum cell voltage, internal resistance (if stated), mass (g), dimensions (mm), connector |
| ESC | single or 4-in-1, cell range, continuous/burst current (A), protocols, BEC (V, A), mass (g), mounting pattern |
| Flight controller | processor, input voltage range, ports (name, type: UART/CAN/I²C/PWM/RC/USB, count), PWM outputs, mass (g), mounting pattern |
| Power module / PDB | voltage range, continuous current (A), sensing (V/I), regulated outputs |
| Peripheral | GPS, RC receiver or telemetry radio: required port type, supply voltage, mass |
| Wire and connector | wire: AWG or mm², conductor material, insulation rating; connector: rated continuous current, contact resistance |

## Architecture decisions
| Topic | Proposal | Reason |
|---|---|---|
| Storage | Migration 0005: `components` gets `origin` (built-in / user / imported), `schema_version` and `revision`; a `project_components` link through the parts' `component_id`; tables `wires` and `wire_ends` per project | Relational, so the checks and reports can query it; the same IPC pattern as before |
| Built-in data | Shipped as versioned JSON in `database/seed/`, loaded on start (insert or update by id); user edits are always copies, never overwrites | Updates to built-in data never clobber user work |
| Validation | zod per category in `electron/ipc/components.ts`; quantity = `{value, unit, source, reference}` with unit checking | One schema for IPC, imports and seed tests |
| Checks and calculations | Pure TypeScript in `src/domain/` (no React, no three), run in the renderer as you edit and unit tested in Node | Instant feedback; physics stays out of the UI; see decision 3 |
| Wiring editor | `@xyflow/react` (MIT) for the schematic canvas | Pan/zoom, handles and edge routing done and accessible; see decision 2 |
| Units | Stored as the source states them, with the unit (e.g. 1300 mAh, 5 in, 12 AWG). Checks and calculations convert to SI with `src/domain/units.ts` | Each stored value can be compared with its datasheet directly |

## Milestones
| # | Milestone | Done when |
|---|---|---|
| 3.1 | **Component model**: per-category schemas, quantity/provenance type, migration 0005, repositories, IPC, units module | Schema refuses a manufacturer value without a reference; IPC round-trips; unit conversions tested |
| 3.2 | **Library UI**: browse/search/filter, detail with sources, add/edit/duplicate user components, JSON import/export | e2e: create a component, export, delete, import, identical; malformed packs refused with clear messages |
| 3.3 | **Built-in data** (decision 1) | Every value cited; a test fails on any uncited value; each record spot-checked against its source and logged in the DEVLOG |
| 3.4 | **Link parts to components** | e2e: link a motor, mass and size come from the datasheet with a visible source; unlink and undo restore the user values |
| 3.5 | **Checks and diagnostics**: rule engine, propeller clearance, diagnostics panel, status count, Markdown report | Each rule has passing and failing unit cases; e2e: 6S battery with a 4S-rated ESC raises an error that points at both |
| 3.6 | **Electrical Designer**: schematic editor, ports from the specs, wire properties, auto-wire, FC port checks | e2e: auto-wire a hex, then move a GPS onto the telemetry port and get a port-conflict error |
| 3.7 | **Electrical calculations**: load cases, wire R / ΔV / loss, battery sag, ratings | Results match hand calculations (in the test file) to 0.1 %; formulas and constants cited in code and UI |
| 3.8 | **Hardening and docs**: performance with 200 components / 100 wires, ADRs (component provenance, domain-module boundary), DEVLOG/ROADMAP | Acceptance list below is green |

## Acceptance criteria
- No specification value is stored or shown without a source. Calculated values
  are labelled with their formula.
- Every check has unit tests with passing and failing inputs, and says "cannot
  check" rather than guessing when data is missing.
- e2e, persisting across a restart:
  1. build a hex from library components;
  2. auto-wire it;
  3. see zero errors;
  4. swap in a battery outside the ESC's rating and get the error;
  5. fix it and get zero errors again.
- Electrical results match documented hand calculations within 0.1 %.
- JSON pack import/export round-trips exactly, and bad packs are refused with
  reasons.
- Undo/redo covers linking, wiring and component edits inside a project.
- Phase 1–2 suites still pass; zero console errors; typecheck and lint clean.

## Risks
| Risk | Mitigation |
|---|---|
| Datasheets disagree with product pages, or change | Keep the exact source and retrieval date per value; built-in data is versioned; prefer datasheet PDFs over shop listings |
| Hobby specs are loosely defined (e.g. "max current" for 10 s, or continuous) | Store the stated condition with the value (`condition` text); checks use only values whose condition matches what they assume, otherwise "cannot check" |
| Ampacity of wire depends on insulation, bundling and airflow | Show ampacity as a guideline with its cited table and conditions; warn, never error, on ampacity alone |
| Scope: Phase 3 is the largest phase so far | Milestones ship separately; each ends green and gets a short review |

## Decisions (2026-11-21)
1. **Built-in data**: a cited starter set of about 15–25 parts. Each value comes
   from the manufacturer's datasheet or product page, with its URL and retrieval
   date. Values are looked up during milestone 3.3, not recalled from memory.
2. **Wiring editor**: `@xyflow/react`.
3. **Checks and electrical maths**: a TypeScript domain module now. Dynamic battery
   and motor models go into the Rust engine in Phase 4.
