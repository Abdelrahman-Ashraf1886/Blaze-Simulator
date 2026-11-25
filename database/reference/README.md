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
| `unit` | when the source states one | Normally a unit from `src/domain/units.ts` (convert with `toSI`). Left out when the source gives none (most PX4 gains); the `condition` then quotes how the source defines the number. `"1"` marks a dimensionless value. |
| `min`, `max` | when documented | Numeric bounds copied only from the parameter comment's `@min` / `@max`, in the same unit as `value`. Either bound may be absent. Enum labels do not imply bounds. |
| `source` | yes | `standard` (a published standard), `manufacturer` (a datasheet), `software-default` (a default in a named software release), or `derived`. |
| `reference` | yes, except for `derived` | `{ url?, document?, locator, retrieved }`: a URL or document title, where in it (`locator`: page, table, line), and the date it was read (YYYY-MM-DD). |
| `condition` | yes | What the source says the value applies to: laminate and fibre fraction, layer of the atmosphere, how a gain is defined, a misprint noticed in the source. |
| `formula`, `inputs` | `derived` only | The formula, written using the keys of the cited entries it uses (in the same set). A derived value never has a `reference`; its inputs carry the citations. |

`tests/unit/reference-data.test.ts` enforces this: every entry is complete, units
are known conversion units or explicitly retained PX4 source units, each derived
value matches its formula, and the cited ISA values satisfy the standard's own
equation of state.

### Sets in version 1

- `isa`: U.S. Standard Atmosphere 1976. Sea-level g0, P0, T0, ρ0, the 0–11 km lapse rate, R* and M0, plus the specific gas constant derived as R*/M0.
- `carbonFibrePlate`: carbon/epoxy plate density from two datasheets (Elevated Materials, RS PRO). The frame plate's own manufacturer is unknown, so the user chooses one or enters their own.
- `px4`: PX4-Autopilot v1.13.3 defaults for the multicopter attitude, rate and vertical position/velocity controllers. Airframe files may override them.
- `px4Position` (36): PX4 v1.13.3 position/velocity gains and limits, manual stick mapping, altitude/position submode selection, acceleration/jerk limits and aggregate velocity settings. Includes the landing slowdown/takeoff parameters read by the manual tasks; recording them does not select a ground-handling implementation. Vertical gains and thrust limits are reused from `px4`.
- `px4Allocation` (1): `MC_AIRMODE`, with its documented behaviours and tuning caution in `condition`.
- `px4ThrustModel` (1): `THR_MDL_FAC`, with the source's static thrust model quoted in `condition`. This is the firmware default; a vehicle-specific fit is not reference data.
- `px4HoverThrust` (6): all six `HTE_*` estimator parameters. `MPC_USE_HTE` and `MPC_THR_HOVER` are reused from `px4`.

- `takeoffLandPx4` (10) records the PX4 v1.13.3 takeoff ramp and spool-up, automatic ascent/descent speed and yaw-rate limits, the multicopter land-detector parameters `LNDMC_*` and `MIS_TAKEOFF_ALT`. `MPC_TKO_SPEED`, `MPC_LAND_SPEED`, `MPC_LAND_ALT1/2`, `MPC_TILTMAX_LND` and `MPC_JERK_AUTO` live in `px4Position`. `MPC_LAND_CRWL` and `MPC_LAND_ALT3` require a range sensor.
- `returnPx4` (10) records the multicopter return defaults and ranges. FlightLoop sessions accept the five `RTL_*` flight parameters, `NAV_ACC_RAD`, `NAV_MC_ALT_RAD`, `MIS_YAW_ERR` and `MPC_XY_CRUISE` by exact name. Heading mode `RTL_HDG_MD` is fixed at 0. PX4 v1.13.3's multicopter startup sets `NAV_ACC_RAD` to 2 m, `RTL_RETURN_ALT` to 30 m and `RTL_DESCEND_ALT` to 10 m. The entries' condition text records their generic defaults. The saved controller tuning catalogue excludes this session-only set. [Multicopter startup defaults](https://github.com/PX4/PX4-Autopilot/blob/v1.13.3/ROMFS/px4fmu_common/init.d/rc.mc_defaults#L18-L21)
- `landDetectorConstantsPx4` (3): compile-time constants of `MulticopterLandDetector.h` (300 ms free-fall time, 2 s landed-phase time, 1 m distance). They are not parameters: the locator quotes the `static constexpr` line instead of a `PARAM_DEFINE` line, and the keys are the C++ names.
- `windShear` (2): the roughness length z0 of the mean-wind profile u = u20·ln(h/z0)/ln(20/z0): 0.15 ft for Category C flight phases, 2.0 ft for the others. Source: MIL-F-8785C (5 November 1980), 3.7.3.2, printed p. 51, read from the EverySpec scan as page images (primary text, `source: "standard"`). Its unit `ft` has no conversion in `src/domain/units.ts`; it is retained as the source states it, and consumers check `isUnit` before `toSI`. A value known only from a secondary source (for example a vendor's documentation of a standard) is not given `source: "standard"`; its `condition` says it is secondary.

Set ids starting with `px4` are read as tunable controller parameters (`src/domain/controller-params.ts`), so other PX4 sets must not use that prefix; that is why the two sets above end in `Px4`.

The original `px4` set is frozen at 38 entries for the Phase 4.7 Rust `Gains`
conformance test. New parameters belong in the separate sets above; exact PX4
parameter keys must be unique across all `px4*` sets (`landDetectorConstantsPx4` keys are C++ constant names, not parameters).

For the PX4 parameter sets, defaults come from the actual `PARAM_DEFINE_*` line in the
raw file at tag v1.13.3, cited with its GitHub line anchor. Units and bounds come
from the immediately preceding doc comment, not inferred physical dimensions or
enum values. `norm`, `normalized_thrust` and `SD` are represented by `"1"`, and
`m/s^2` by `"m/s²"`; `condition` retains the original unit token. The source unit
strings `deg`, `Hz`, `m/s^3` and `normalized_thrust/s` are retained verbatim because
`src/domain/units.ts` has no conversions for them. They are reference metadata:
consumers must check `isUnit` before calling `toSI`, and must not silently treat
these values as dimensionless. No conversion units are added in this data-only change.

`MPC_XY_VEL_ALL` and `MPC_Z_VEL_ALL` have negative firmware defaults: their comments
say negative values keep the individual parameters active. `SYS_VEHICLE_RESP`
is excluded as the draft plan requests (no port of its parameter rewriting).
No requested parameter was missing from the fetched definitions; the manual-mode
reads were checked in `FlightTask`, `ManualAltitude`, `ManualAltitudeSmoothVel`,
`ManualPosition`, `ManualAcceleration`, `Sticks` and `StickAccelerationXY`.

A change to a value is a new citation, not an edit. If a source is revised, update
`reference.retrieved` and `locator` together with the value.
