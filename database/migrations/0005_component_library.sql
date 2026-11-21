-- Schema v5: component library records (Phase 3).
-- spec_json holds { fieldKey: { value, unit?, source, reference?, condition? } }, validated
-- in main against electron/ipc/component-fields.ts. Built-in records are read-only;
-- users change copies.

ALTER TABLE components ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('built-in', 'user', 'imported'));
ALTER TABLE components ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1);
-- Incremented on every update; an update based on an older revision is rejected.
ALTER TABLE components ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE components ADD COLUMN notes TEXT;

CREATE INDEX components_category_name ON components (category, name);
