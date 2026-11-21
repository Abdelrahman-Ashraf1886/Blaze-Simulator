-- Schema v4: imported 3D models (GLB / self-contained glTF).
-- The file lives in <userData>/assets/<id>.<format>; id is the SHA-256 of its bytes,
-- so importing the same file twice stores it once. Units and up axis are chosen per
-- part (in assembly_parts.shape_json), because they describe how the file is used.

CREATE TABLE assets (
  id           TEXT PRIMARY KEY CHECK (length(id) = 64),
  filename     TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  format       TEXT NOT NULL CHECK (format IN ('glb', 'gltf')),
  bytes        INTEGER NOT NULL CHECK (bytes > 0),
  triangles    INTEGER NOT NULL CHECK (triangles >= 0),
  -- Axis-aligned bounds of the default scene in file units and the file's own axes:
  -- {"min":[x,y,z],"max":[x,y,z]}.
  bounds_json  TEXT NOT NULL CHECK (json_valid(bounds_json)),
  imported_at  TEXT NOT NULL
);
