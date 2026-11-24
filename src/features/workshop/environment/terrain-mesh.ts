import type { TerrainGrid } from '../../../domain/terrain'

/** Sample centres in world-oriented axes, relative to the southwest file corner.
 * src/domain/terrain.ts:94–122 defines the row order, sample positions and SW–NE diagonal.
 */
export function terrainMeshData({ rows, columns, cellSizeM, cornerM, heightsM }: TerrainGrid) {
  const origin: [number, number, number] = [cornerM[0], cornerM[1], 0]
  const positions = new Float32Array(heightsM.length * 3)
  const indices = new Uint32Array((rows - 1) * (columns - 1) * 6)
  let triangle = 0
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const nw = row * columns + column
      positions[3 * nw] = (column + 0.5) * cellSizeM
      positions[3 * nw + 1] = (rows - row - 0.5) * cellSizeM
      positions[3 * nw + 2] = heightsM[nw]!
      if (row === rows - 1 || column === columns - 1) continue
      const sw = nw + columns
      const ne = nw + 1
      const se = sw + 1
      indices[triangle++] = sw
      indices[triangle++] = ne
      indices[triangle++] = nw
      indices[triangle++] = sw
      indices[triangle++] = se
      indices[triangle++] = ne
    }
  }
  return { origin, positions, indices }
}
