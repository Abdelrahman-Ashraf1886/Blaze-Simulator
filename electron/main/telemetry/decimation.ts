import type { RecordingPoint } from '../../ipc/contract'

/**
 * Rows arrive in chronological order and have uniform spacing. Keep both
 * extrema of each bucket in time order and one null when the entire bucket is
 * missing. A one-point budget keeps the first row. No input array is retained.
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
  let minima: RecordingPoint[] = []
  let maxima: RecordingPoint[] = []
  const emit = () => minima.forEach((min, column) => {
    const max = maxima[column]!
    const points = result[column]!
    if (min.timeS <= max.timeS) {
      points.push(min)
      if (min !== max) points.push(max)
    } else {
      points.push(max, min)
    }
  })
  let index = 0
  let previous = -1
  for await (const row of rows) {
    const bucket = Math.floor((index++ / rowCount) * bucketCount)
    if (bucket !== previous) {
      emit()
      minima = [...row]
      maxima = [...row]
      previous = bucket
    } else {
      row.forEach((point, column) => {
        if (point.value === null) return
        const min = minima[column]!.value
        const max = maxima[column]!.value
        if (min === null || point.value < min) minima[column] = point
        if (max === null || point.value > max) maxima[column] = point
      })
    }
  }
  emit()
  return result
}
