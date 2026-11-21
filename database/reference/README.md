# Reference data

Physical constants and controller defaults that are not properties of one component.
The component seed (`database/seed/components.v1.json`) holds part specifications;
this folder holds everything else the simulation reads. The same rule applies to
both: **no value without a source**.

## `physics.v1.json`

```jsonc
{
  "format": "blaze-uav.reference",
  "version": 1,
  "note": "…",
  "sets": [
    {
      "id": "isa",                 // stable id the code looks up
      "title": "…",
      "note": "…",                 // what the set is for, and caveats that apply to all of it
      "values": [ /* entries */ ]
    }
  ]
}
```

Each entry:

| Field | Required | Meaning |
|---|---|---|
| `key` | yes | Unique within the set. For PX4 it is the exact parameter name (`MC_ROLLRATE_P`). |
| `value` | yes | A number, **as the source states it**. |
| `unit` | when the source states one | A unit from `src/domain/units.ts` (convert with `toSI`). Left out when the source gives none (most PX4 gains); the `condition` then quotes how the source defines the number. `"1"` marks a dimensionless value. |
| `source` | yes | `standard` (a published standard), `manufacturer` (a datasheet), `software-default` (a default in a named software release), or `derived`. |
| `reference` | yes, except for `derived` | `{ url?, document?, locator, retrieved }`: a URL or document title, where in it (`locator`: page, table, line), and the date it was read (YYYY-MM-DD). |
| `condition` | yes | What the source says the value applies to: laminate and fibre fraction, layer of the atmosphere, how a gain is defined, a misprint noticed in the source. |
| `formula`, `inputs` | `derived` only | The formula, written using the keys of the cited entries it uses (in the same set). A derived value never has a `reference`; its inputs carry the citations. |

`tests/unit/reference-data.test.ts` enforces this: every entry is complete, units
exist, each derived value matches its formula, and the cited ISA values satisfy the
standard's own equation of state.

### Sets in version 1

- `isa`: U.S. Standard Atmosphere 1976. Sea-level g0, P0, T0, ρ0, the 0–11 km lapse rate, R* and M0, plus the specific gas constant derived as R*/M0.
- `carbonFibrePlate`: carbon/epoxy plate density from two datasheets (Elevated Materials, RS PRO). The frame plate's own manufacturer is unknown, so the user chooses one or enters their own.
- `px4`: PX4-Autopilot v1.13.3 defaults for the multicopter attitude, rate and vertical position/velocity controllers. Airframe files may override them.

A change to a value is a new citation, not an edit. If a source is revised, update
`reference.retrieved` and `locator` together with the value.
