-- Schema v6: a part can be linked to a library component (Phase 3).
-- The part keeps its own (user) shape and mass; the linked component's stated values
-- are shown and used instead while the link exists, so unlinking restores them.
-- RESTRICT: a component in use cannot be deleted (the app says which projects use it).

ALTER TABLE assembly_parts ADD COLUMN component_id TEXT REFERENCES components (id) ON DELETE RESTRICT;
CREATE INDEX assembly_parts_component ON assembly_parts (component_id);
