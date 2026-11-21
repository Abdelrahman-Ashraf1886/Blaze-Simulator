# ADR 0008: Engineering rules live in pure domain modules (`src/domain/*`)

**Status:** accepted (2026-11-21)

## Context
Phase 3 added compatibility checks, wiring rules and steady-state electrical
calculations. They run in the renderer as the user edits, in the Electrical
Designer and the workshop. Their results are the project's engineering claims, so
each needs unit tests against hand calculations. Some of the code is shared with
main: the unit conversions are used by the zod schemas. Phase 4 adds mass
properties on the same footing (ADR 0006). If such code depended on React,
three.js or IPC, it could only be tested through the UI, and its behaviour would
depend on rendering state.

## Decision
- `src/domain/*.ts` holds the engineering rules: `units.ts`, `checks.ts`,
  `wiring.ts`, `electrical.ts` (and, from Phase 4, `mass.ts`).
  - They are plain functions from data to data, with no module state and no I/O.
  - They take everything they need as arguments: parts with their linked
    components, world positions, wires and the load case.
- **Allowed imports**: other domain modules, and IPC *types* (`import type` from
  `electron/ipc/*`), so the domain and the IPC contract describe the same data.
- **Not allowed**: React, three.js, React Flow, zustand, Electron, Node APIs,
  zod, the renderer's stores, services, features or components. ESLint enforces
  this for `src/domain/**` (`eslint.config.mjs`, `no-restricted-imports`). Running
  `npm run lint` fails on a violation.
- **Adapters sit outside the domain**: `src/features/workshop/check-input.ts` and
  `wiring-input.ts` turn the stored assembly into domain input. They use three.js
  for world matrices, which is why they are not in `src/domain`. React components
  memoise the results and only display them.
- **Documented in the file**: each module's header states its model, its
  formulas and their sources (e.g. IEC 60028 copper resistivity in
  `electrical.ts`). The UI shows the same method text.

## Consequences
- \+ Every rule is unit tested in Node without a browser (`tests/unit/checks.test.ts`,
  `wiring.test.ts`, `electrical.test.ts`, `units.test.ts`). The electrical tests
  match hand calculations written in the test file to 0.1 %.
- \+ The same code runs in main (validation), the renderer and tests, and can be
  ported to the Rust engine where Phase 4 needs it in the loop.
- \+ Performance is measured on the functions themselves: at the schema maximum of
  2000 wires, the wiring checks take about 20 ms and the calculations about 40–50 ms
  (`wiring.test.ts`).
- − Callers must memoise. A pure function re-run on every render is still a cost.
  Since 3.8, one findings result is kept per document and shared by the checks
  panel, the status strip and the designer.
- − Adapters that need three.js maths (world transforms) stay in `features/` and
  are tested there, so the boundary has to be watched where geometry is involved.
