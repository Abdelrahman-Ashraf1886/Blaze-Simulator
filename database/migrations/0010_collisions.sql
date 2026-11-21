-- Schema v10 (Phase 4.4): collisions.
--
-- 1. assemblies.interference_json: the workshop interference check's settings.
--    { "toleranceM": number (m, 0 to 0.05), "allowedPairs": [[a, b], ...] }, each pair two
--    part ids (or "frame" for the parametric frame), sorted. NULL = not set: the starting
--    tolerance and no allowed pairs (src/domain/collisions.ts). A JSON column rather than a
--    table, because saving an assembly replaces all of its part rows.
-- 2. assemblies.environment_json: the project's flight environment (src/domain/environment.ts).
--    { "ground": { "friction": number|null, "restitution": number|null },
--      "obstacles": [{ "id", "name", "center": [x,y,z], "size": [x,y,z], "yaw": rad,
--                      "friction": number|null, "restitution": number|null }] }
--    null values are not set; the simulation refuses to start until they are. NULL column =
--    nothing entered yet.
-- 3. assets.hull_json: the convex hull of an imported model, computed at import
--    (electron/main/assets/hull.ts): { "points": [[x,y,z], ...] | null, "reason": string|null },
--    in file units and file axes. points null = no usable hull (reason says why); the model then
--    collides as its bounding box. NULL column = not computed yet (back-filled at startup).
--
-- All three are validated in main (electron/ipc/schemas.ts, hull.ts).
-- 0010 was extended before it shipped; development databases that ran the first version
-- (interference_json only) get the missing columns from `repairUnshippedMigrations` in
-- electron/main/db/database.ts.

ALTER TABLE assemblies ADD COLUMN interference_json TEXT CHECK (interference_json IS NULL OR json_valid(interference_json));
ALTER TABLE assemblies ADD COLUMN environment_json TEXT CHECK (environment_json IS NULL OR json_valid(environment_json));
ALTER TABLE assets ADD COLUMN hull_json TEXT CHECK (hull_json IS NULL OR json_valid(hull_json));
