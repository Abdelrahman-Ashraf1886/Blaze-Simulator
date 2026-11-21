-- Schema v10 (Phase 4.4): the workshop interference check's settings.
-- interference_json: { "toleranceM": number (m, 0 to 0.05), "allowedPairs": [[a, b], ...] }
-- with each pair two part ids (or "frame" for the parametric frame), sorted.
-- Validated in main (electron/ipc/schemas.ts). NULL = not set: the starting tolerance
-- and no allowed pairs (src/domain/collisions.ts). A JSON column rather than a table,
-- because saving an assembly replaces all of its part rows.

ALTER TABLE assemblies ADD COLUMN interference_json TEXT CHECK (interference_json IS NULL OR json_valid(interference_json));
