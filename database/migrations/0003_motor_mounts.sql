-- Schema v3: per-motor spin/tilt overrides, keyed by mount id ("motor-1" …).
-- Motors not present use the PX4 default spin and zero tilt.
ALTER TABLE assemblies ADD COLUMN motors_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(motors_json));
