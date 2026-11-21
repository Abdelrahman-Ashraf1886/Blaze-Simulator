-- Schema v1: projects, simulation run history, component library.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  frame_type  TEXT NOT NULL CHECK (frame_type IN ('quad-x', 'hex-x', 'octo-x')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX projects_updated_at ON projects (updated_at DESC);

CREATE TABLE simulation_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  duration_s  REAL NOT NULL CHECK (duration_s >= 0),
  status      TEXT NOT NULL CHECK (status IN ('completed', 'aborted', 'failed'))
);
CREATE INDEX simulation_runs_project ON simulation_runs (project_id);
CREATE INDEX simulation_runs_started_at ON simulation_runs (started_at DESC);

-- Component library. Populated in Phase 3. Every value inside spec_json is
-- stored as {"value", "unit", "source": "manufacturer"|"user"|"estimated",
-- "reference"} so provenance is never lost.
CREATE TABLE components (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  name          TEXT NOT NULL,
  manufacturer  TEXT,
  spec_json     TEXT NOT NULL CHECK (json_valid(spec_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX components_category ON components (category);
