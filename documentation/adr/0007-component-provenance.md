# ADR 0007: Component values are stored as stated, with their source, and converted only where they are used

**Status:** accepted (2026-11-21)

## Context
Every number in the component library ends up in a check, a calculation or, from
Phase 4, the physics. Hobby datasheets state values in mixed units (mAh, inches,
AWG, gram-force, rpm/V), often with a condition attached ("21 A, 180 s",
"2–6S LiPo input"), and sometimes not at all. The project rule is that no
specification is invented. A user must be able to put any stored value next to
its datasheet and see the same number, and see where it came from.

## Decision
- **One shape for every value**: `{ value, unit?, source, reference?, condition? }`
  (`electron/ipc/component-fields.ts`).
  - `source` is `manufacturer` (datasheet or official product page), `measured`
    (the user's own test) or `user` (entered without a document).
  - `reference` holds the URL or document title, the page or table, and the date
    it was read.
  - `condition` holds the stated condition as text, e.g. "180 s".
- **The schema enforces the citation** (`electron/ipc/component-schemas.ts`, zod,
  in main): a `manufacturer` value without a URL or document title, or without
  a read date, is refused. The same schema validates IPC edits, imported packs and
  the built-in seed, so no path stores an uncited manufacturer value. A test runs
  over every built-in record (`tests/unit/seed.test.ts`).
- **Stored as stated, never normalised**: 1300 mAh stays 1300 mAh and 12 AWG stays
  12 AWG. The unit must be one the field allows for its dimension. Values are
  converted to SI only where they are used, by `toSI` in `src/domain/units.ts`
  (each exact definition cited there), inside the checks and the electrical
  calculations.
- **Messages quote the value as stated**, with its condition ("rated 20 A per
  motor, below MN3110 KV700's maximum 21 A (Max continuous current (180 s))").
- **Derived values are labelled, never stored**: for example a battery's
  continuous current, C × capacity, is computed where it is needed and shown as
  "calculated" with its formula. Electrical results carry their formula, as a
  tooltip, beside the value.
- **Missing stays missing**: a check that needs an absent value reports
  "cannot check" with the reason. A calculation shows a dash and lists what is
  not specified. Nothing falls back to a typical value.
- **Built-in data is versioned and never edited in place by the user**: the seed
  (`database/seed/components.v1.json`) is upserted by id on each start. Editing a
  built-in makes a user copy that keeps its provenance. Records the user owns are
  never overwritten by the seed.
- **Links store only the component id**: a part's linked mass and size are
  resolved for display and checks. The part keeps its own values, so unlinking
  restores them.

## Consequences
- \+ Any stored value can be checked against its source by eye. Corrections to the
  built-in data reach existing installs without touching user records.
- \+ One conversion path (`toSI`) is tested once (`tests/unit/units.test.ts`), and
  the checks, calculations and Phase 4 engine inputs share it.
- \+ Packs round-trip exactly: export, import into an empty library and export
  again gives the same bytes (`tests/unit/component-library.test.ts`).
- − Every consumer must convert before comparing. A raw `value` compared across
  units would be a bug. The domain helpers (`si`, `quantity`) exist so that no
  rule reads `.value` of a quantity directly.
- − Stated conditions are free text. A check cannot tell whether "max current
  (10 s)" matches what it assumes, so it quotes the condition and leaves the
  judgement to the user. A structured condition is future work.
