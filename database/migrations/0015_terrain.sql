-- Rebuild assets to store ASCII terrain beside models (0009 uses the same rebuild).
CREATE TABLE assets_new (
  id                  TEXT PRIMARY KEY CHECK (length(id) = 64),
  filename            TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  format              TEXT NOT NULL CHECK (format IN ('glb', 'gltf', 'asc')),
  bytes               INTEGER NOT NULL CHECK (bytes > 0),
  triangles           INTEGER CHECK (triangles >= 0),
  bounds_json         TEXT CHECK (bounds_json IS NULL OR json_valid(bounds_json)),
  imported_at         TEXT NOT NULL,
  hull_json           TEXT CHECK (hull_json IS NULL OR json_valid(hull_json)),
  terrain_nodata_value REAL,
  CHECK (
    (format IN ('glb', 'gltf') AND triangles IS NOT NULL AND bounds_json IS NOT NULL
      AND terrain_nodata_value IS NULL)
    OR
    (format = 'asc' AND triangles IS NULL AND bounds_json IS NULL AND hull_json IS NULL)
  )
);

INSERT INTO assets_new (id, filename, format, bytes, triangles, bounds_json, imported_at, hull_json)
SELECT id, filename, format, bytes, triangles, bounds_json, imported_at, hull_json FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
