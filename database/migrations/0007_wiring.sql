-- Schema v7: the project's wiring (Electrical Designer, Phase 3).
-- Stored with the assembly and saved in the same transaction, so undo/redo and the
-- stale-revision check cover wiring like any other edit. JSON:
--   { "wires": [ { id, from: {partId, port}, to: {partId, port}, gaugeAwg, lengthMm, color } ],
--     "schematic": { partId: { x, y } } }
-- Validated in main (electron/ipc/schemas.ts): every end must name an existing part.

ALTER TABLE assemblies ADD COLUMN wiring_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(wiring_json));
