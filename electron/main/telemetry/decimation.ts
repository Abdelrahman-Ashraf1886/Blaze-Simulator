import type { RecordingPoint } from '../../ipc/contract'

/**
 * Rows arrive in chronological order and have uniform spacing. Keep both
 * extrema of each bucket in time order and reserve a point to mark a gap.
 * A one-point budget keeps the first row. No input array is retained.
 */
export async function minMaxBuckets(
  rows: AsyncIterable<RecordingPoint[]>,
  rowCount: number,
  columnCount: number,
  maxPoints: number,
): Promise<RecordingPoint[][]> {
  const result = Array.from({ length: columnCount }, () => [] as RecordingPoint[])
  if (maxPoints >= rowCount || maxPoints === 1) {
    for await (const row of rows) {
      row.forEach((point, column) => result[column]!.push(point))
      if (maxPoints === 1) break
    }
    return result
  }

  const bucketCount = Math.floor(maxPoints / 2)
  const extraExtrema = Array.from({ length: columnCount }, () => [] as number[])
  let minima: RecordingPoint[] = []
  let maxima: RecordingPoint[] = []
  let gaps: (RecordingPoint | null)[] = []
  const emit = () => minima.forEach((min, column) => {
    const max = maxima[column]!
    const gap = gaps[column]
    const points = [min]
    if (min !== max) points.push(max)
    if (gap && min !== gap) points.push(gap)
    points.sort((a, b) => a.timeS - b.timeS)
    const output = result[column]!
    if (gap && min !== max) extraExtrema[column]!.push(output.length + points.indexOf(max))
    output.push(...points)
  })
  let index = 0
  let previous = -1
  for await (const row of rows) {
    const bucket = Math.floor((index++ / rowCount) * bucketCount)
    if (bucket !== previous) {
      emit()
      minima = [...row]
      maxima = [...row]
      gaps = row.map((point) => point.value === null ? point : null)
      previous = bucket
    } else {
      row.forEach((point, column) => {
        if (point.value === null) {
          gaps[column] ??= point
          return
        }
        const min = minima[column]!.value
        const max = maxima[column]!.value
        if (min === null || point.value < min) minima[column] = point
        if (max === null || point.value > max) maxima[column] = point
      })
    }
  }
  emit()
  return result.map((points, column) => {
    if (points.length <= maxPoints) return points
    const dropped = new Set(extraExtrema[column]!.slice(0, points.length - maxPoints))
    return points.filter((_, index) => !dropped.has(index))
  })
}
