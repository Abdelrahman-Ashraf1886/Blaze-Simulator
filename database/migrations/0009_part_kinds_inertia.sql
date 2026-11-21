-- Schema v9 (Phase 4.2):
-- 1. More part kinds: 'gps', 'camera', 'sensor', 'landing-gear'.
-- 2. inertia_json: the user's own inertia of a part (null = derived from its shape,
--    see src/domain/mass.ts). JSON: { "inertia": [Ixx, Iyy, Izz, Ixy, Ixz, Iyz]
--    (kg·m², about the part's own centre of mass, in the part's axes, tensor sign
--    convention), "comOffset": [x, y, z] (m, part axes, from the shape centre),
--    "source": "user" }. Validated in main (electron/ipc/schemas.ts).
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with
-- every column, constraint and index of migrations 0002 and 0006, and the rows copied.
-- No other table references assembly_parts. The parent reference is deferred, so the
-- copy order does not matter.

CREATE TABLE assembly_parts_new (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES assemblies (project_id) ON DELETE CASCADE,
  sort_index   INTEGER NOT NULL,
  parent_id    TEXT REFERENCES assembly_parts_new (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  mount_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('motor', 'propeller', 'battery', 'flight-controller', 'esc', 'payload',
                                             'custom', 'gps', 'camera', 'sensor', 'landing-gear')),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  shape_json   TEXT NOT NULL CHECK (json_valid(shape_json)),
  px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
  qx REAL NOT NULL, qy REAL NOT NULL, qz REAL NOT NULL, qw REAL NOT NULL,
  mass_kg      REAL CHECK (mass_kg IS NULL OR mass_kg > 0),
  mass_source  TEXT CHECK (mass_source IS NULL OR mass_source = 'user'),
  component_id TEXT REFERENCES components (id) ON DELETE RESTRICT,
  inertia_json TEXT CHECK (inertia_json IS NULL OR json_valid(inertia_json)),
  CHECK ((mass_kg IS NULL) = (mass_source IS NULL))
);

INSERT INTO assembly_parts_new (id, project_id, sort_index, parent_id, mount_id, kind, name, shape_json,
                                px, py, pz, qx, qy, qz, qw, mass_kg, mass_source, component_id)
  SELECT id, project_id, sort_index, parent_id, mount_id, kind, name, shape_json,
         px, py, pz, qx, qy, qz, qw, mass_kg, mass_source, component_id
  FROM assembly_parts;

DROP TABLE assembly_parts;
ALTER TABLE assembly_parts_new RENAME TO assembly_parts;

CREATE INDEX assembly_parts_project ON assembly_parts (project_id, sort_index);
CREATE INDEX assembly_parts_parent ON assembly_parts (parent_id);
CREATE INDEX assembly_parts_component ON assembly_parts (component_id);
