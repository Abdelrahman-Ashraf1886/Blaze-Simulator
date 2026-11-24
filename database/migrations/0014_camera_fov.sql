-- Schema v14 (Phase 6.8): a camera part's vertical field of view.
--
-- The user's own entry, degrees, strictly between 0 and 180 (electron/ipc/contract.ts, CAMERA_FOV_DEG);
-- NULL = not set, so FPV is unavailable on that part. No source states it, so there is no default.
ALTER TABLE assembly_parts ADD COLUMN camera_fov_deg REAL
  CHECK (camera_fov_deg IS NULL OR (camera_fov_deg > 0 AND camera_fov_deg < 180));
