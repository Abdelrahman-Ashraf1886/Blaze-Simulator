-- Schema v2: one assembly per project (frame parameters + placed parts).
-- Lengths in metres, rotations as unit quaternions (x, y, z, w), Z-up world frame.

CREATE TABLE assemblies (
  project_id  TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- Incremented on every save; a save based on an older revision is rejected.
  revision    INTEGER NOT NULL CHECK (revision >= 0),
  frame_json  TEXT NOT NULL CHECK (json_valid(frame_json)),
  updated_at  TEXT NOT NULL
);

CREATE TABLE assembly_parts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES assemblies (project_id) ON DELETE CASCADE,
  sort_index   INTEGER NOT NULL,
  -- Part this one is attached to; deferred so a whole assembly can be written in any order.
  parent_id    TEXT REFERENCES assembly_parts (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  mount_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('motor', 'propeller', 'battery', 'flight-controller', 'esc', 'payload', 'custom')),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  shape_json   TEXT NOT NULL CHECK (json_valid(shape_json)),
  px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
  qx REAL NOT NULL, qy REAL NOT NULL, qz REAL NOT NULL, qw REAL NOT NULL,
  -- Mass is optional; when present its provenance is recorded (only user-entered values exist before Phase 3).
  mass_kg      REAL CHECK (mass_kg IS NULL OR mass_kg > 0),
  mass_source  TEXT CHECK (mass_source IS NULL OR mass_source = 'user'),
  CHECK ((mass_kg IS NULL) = (mass_source IS NULL))
);
CREATE INDEX assembly_parts_project ON assembly_parts (project_id, sort_index);
CREATE INDEX assembly_parts_parent ON assembly_parts (parent_id);
