-- Schema v11 (number 0010 is Phase 4.4's): the build's body drag coefficient (Phase 4.5).
-- Body drag per axis is F = ½ ρ C_d A v² with A the projected area of the collision
-- shapes (derived); no source states C_d for a build, so it is the user's entry,
-- with its provenance recorded like the frame mass.
-- NULL = not set: the Ready-to-fly checklist lists it and flight is blocked.

ALTER TABLE assemblies ADD COLUMN body_cd REAL CHECK (body_cd IS NULL OR body_cd > 0);
ALTER TABLE assemblies ADD COLUMN body_cd_source TEXT CHECK (body_cd_source IS NULL OR body_cd_source = 'user');
