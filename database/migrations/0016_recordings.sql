-- Schema v16: NULL metadata distinguishes pre-v16 runs.
-- Open recordings have an aborted fallback status until their writer closes.
ALTER TABLE simulation_runs ADD COLUMN kind TEXT CHECK (kind IN ('flight', 'scenario', 'step-test'));
ALTER TABLE simulation_runs ADD COLUMN title TEXT;
ALTER TABLE simulation_runs ADD COLUMN file_name TEXT;
ALTER TABLE simulation_runs ADD COLUMN bytes INTEGER CHECK (bytes >= 0);
ALTER TABLE simulation_runs ADD COLUMN sample_count INTEGER CHECK (sample_count >= 0);
ALTER TABLE simulation_runs ADD COLUMN engine_version TEXT;
ALTER TABLE simulation_runs ADD COLUMN state_hash TEXT;
ALTER TABLE simulation_runs ADD COLUMN end_reason TEXT;
ALTER TABLE simulation_runs ADD COLUMN incomplete INTEGER CHECK (incomplete IN (0, 1));
ALTER TABLE simulation_runs ADD COLUMN recording_open INTEGER CHECK (recording_open IN (0, 1));
