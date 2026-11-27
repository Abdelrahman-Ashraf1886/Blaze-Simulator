# Hostile input fixtures

- `cycle.gltf` has an unreachable node cycle alongside a displayable mesh.
- `repeated-parent.gltf` assigns one child to two parents.
- `repeated-root.gltf` lists a root twice in the same scene.
- `invalid-accessor.gltf` declares two billion positions in four bytes of buffer storage.
- `oversized.asc` declares a grid larger than the measured terrain budget. Its short body checks that the header is rejected first.
- `deep-pack.json` exceeds the pack schema's nesting depth through an unused field.
- `oversized-graphics.json` adds whitespace to an otherwise valid graphics preference, exceeding the writer's maximum size.
- `oversized-frame.blzr` contains a valid BLZR preamble and frame-header CRC declaring a request length of 2^32 ? 1. No payload is stored.
- `invalid-replay.ndjson` contains a flight step one tick over the wire schema's limit.
- `malformed-reply.ndjson` matches a pending request ID and supplies a null error body.
- `formula-headers.json` contains all six formula prefixes and a normal telemetry channel.

The desktop specs are collected with `npx playwright test --config=tests/unit/hostile-playwright.config.ts` after building the app. The separate config keeps the specs within the milestone's edit fence.
