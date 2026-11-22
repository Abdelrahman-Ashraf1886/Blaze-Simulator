-- Schema v11 (number 0010 is Phase 4.4's): Phase 4.5 inputs no source states.
--
-- 1. The build's body drag coefficients, one per body axis. Body drag per axis is
--    F = ½ ρ C_d,i A_i v_i |v_i| with A_i the projected area of the collision shapes
--    (derived); no source states C_d for a build, so it is the user's entry, with its
--    provenance recorded like the frame mass. NULL = not set: the Ready-to-fly
--    checklist lists the axis and flight is blocked.

ALTER TABLE assemblies ADD COLUMN body_cd_x REAL CHECK (body_cd_x IS NULL OR body_cd_x > 0);
ALTER TABLE assemblies ADD COLUMN body_cd_y REAL CHECK (body_cd_y IS NULL OR body_cd_y > 0);
ALTER TABLE assemblies ADD COLUMN body_cd_z REAL CHECK (body_cd_z IS NULL OR body_cd_z > 0);
ALTER TABLE assemblies ADD COLUMN body_cd_source TEXT CHECK (body_cd_source IS NULL OR body_cd_source = 'user');

-- 2. Catalog gap-fills: a value the user enters for a field a built-in component leaves
--    empty (e.g. the MN3110's rotor inertia). Kept apart from the seed record, which stays
--    read-only and is replaced by seed updates without touching these. spec_json holds one
--    spec value { value, unit?, source, reference?, condition? }; source is 'measured' or
--    'user' (never 'manufacturer'), validated in main. Applies wherever the component is
--    linked; a part's own override (below) wins over it.

CREATE TABLE component_fills (
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (component_id, field_key)
);

-- 3. Per-part overrides of a linked component's quantity / integer fields:
--    { fieldKey: spec value } with source 'measured' or 'user'. NULL = none.
--    Resolution: part override > catalog fill > manufacturer value > missing.

ALTER TABLE assembly_parts ADD COLUMN overrides_json TEXT;
