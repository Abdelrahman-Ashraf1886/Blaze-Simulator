-- Schema v8: the frame's own mass (Phase 4, mass properties).
-- The parametric frame is not a library component, so its mass is the user's entry,
-- with its provenance recorded like a part's (assembly_parts.mass_kg / mass_source).
-- NULL = not set: the centre of mass is then incomplete and flight is blocked.

ALTER TABLE assemblies ADD COLUMN frame_mass_kg REAL CHECK (frame_mass_kg IS NULL OR frame_mass_kg > 0);
ALTER TABLE assemblies ADD COLUMN frame_mass_source TEXT CHECK (frame_mass_source IS NULL OR frame_mass_source = 'user');
