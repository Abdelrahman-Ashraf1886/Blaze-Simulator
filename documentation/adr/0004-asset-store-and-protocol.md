# ADR 0004: Imported models live in a content-addressed store served by a private protocol

**Status:** accepted (2026-11-21)

## Context
Users import GLB/glTF models of payloads and parts. The renderer is sandboxed,
has a strict CSP (`'self'`), and must never read arbitrary files. glTF can
reference external files and URLs. Imported files must survive restarts and must
not depend on the original file staying where it was.

## Decision
- **Validation in main** (`electron/main/assets/gltf.ts`). A file is refused when:
  - it is larger than 50 MB (checked from its size before reading);
  - its signature is wrong, or it is not glTF 2.0;
  - any buffer or image is not embedded;
  - it needs an unsupported compression (Draco, meshopt, KTX2);
  - its node references are broken or form a loop.

  Bounds come from accessor min/max through the node hierarchy, so main never
  needs WebGL.
- **Content-addressed store**: `<userData>/assets/<sha256>.<glb|gltf>`, with a row
  in the `assets` table (file name, size, triangles, bounds).
  - Identical bytes are stored once.
  - Assets no part uses are removed at startup. Undo history does not survive a
    restart, so this never removes something a redo could need.
- **Protocol** `blaze-asset://model/<sha256>`: registered as privileged (standard,
  secure, fetch).
  - The handler (`resolveAssetUrl`) accepts only an exact lowercase 64-hex id and
    serves only from the store folder.
  - CSP `connect-src` adds `blaze-asset:`, plus `blob:`/`data:` for textures
    three.js unpacks from the file.
- **How a model is used** (units, up axis) is part of the part's shape, not the
  asset. The same file can be used at different scales, and a wrong unit is an
  undoable edit.

## Consequences
- \+ The renderer only ever sees validated bytes, from one folder, by hash.
- \+ Projects are self-contained on this machine. A future project export
  must carry the project's assets with it.
- − `.gltf` files exported with a separate `.bin` (Blender's "glTF Separate") are
  refused. The message tells the user to export `.glb` or embed buffers.
- − Draco, meshopt and KTX2 files are refused until a decoder is bundled locally.
  The CSP forbids fetching decoders from a CDN.
- − Garbage collection runs only at startup, so files of deleted parts remain until
  the next launch.
