-- Schema v13 (Phase 5.5): the controller gains a project overrides.
--
-- One set of overrides per project (plan decision D9). Only the overrides are stored: a parameter with
-- no row flies on its PX4 default, which stays in src/domain/controller-params.ts (from the cited
-- reference data), so "reset to PX4 defaults" deletes the rows. A row is parameter name -> value;
-- the name is checked against the parameter table and the value against PX4's documented range in
-- main (validateOverrides), before it is written. The CHECK only keeps a non-finite number out.
-- Rows go with the project.

CREATE TABLE controller_tuning (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  param_name TEXT NOT NULL CHECK (length(param_name) > 0),
  value REAL NOT NULL CHECK (abs(value) <= 1.7976931348623157e308),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, param_name)
);
