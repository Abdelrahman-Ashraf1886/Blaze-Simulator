-- Schema v12 (Phase 4.8 part B): the flight conditions of a project.
--
-- assemblies.flight_json: the values the live flight needs that no source states for a build, the
-- user's entries (there are no defaults):
--   { "ambientAltitudeM": number|null, "temperatureC": number|null,
--     "cutoffType": "voltageV"|"chargeMah", "cutoffValue": number|null }
-- ambientAltitudeM sets the air density (standard atmosphere); temperatureC null = the standard
-- atmosphere's. (The air density each motor's propeller data was taken at is a property of that data's
-- source, kept with its component, not here.) cutoffValue is the battery cut-off, in V or mAh by cutoffType. null = not set: the flight
-- test lists it as missing and does not start. A JSON column like environment_json (0010), because saving
-- an assembly replaces all of its part rows. NULL = nothing entered.

ALTER TABLE assemblies ADD COLUMN flight_json TEXT CHECK (flight_json IS NULL OR json_valid(flight_json));
