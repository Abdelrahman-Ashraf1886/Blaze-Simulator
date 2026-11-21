import { FRAME_PARAM_LIMITS, type FrameParams } from '../../../electron/ipc/contract'

/** Metres → millimetres with at most one decimal, without float noise. */
export const toMm = (m: number) => String(Math.round(m * 10_000) / 10)

/**
 * Parses a millimetre entry (dot or comma decimal) and checks it against the
 * frame limits and the other parameters. Returns metres or an error message.
 */
export function parseFrameValue(
  key: keyof FrameParams,
  text: string,
  frame: FrameParams,
): { ok: true; metres: number } | { ok: false; message: string } {
  const mm = Number(text.trim().replace(',', '.'))
  if (text.trim() === '' || !Number.isFinite(mm)) return { ok: false, message: 'Enter a number in millimetres' }
  const metres = Math.round(mm * 10) / 10_000 // keep 0.1 mm resolution
  const { min, max } = FRAME_PARAM_LIMITS[key]
  if (metres < min || metres > max) return { ok: false, message: `Between ${toMm(min)} and ${toMm(max)} mm` }
  const next = { ...frame, [key]: metres }
  if (next.plateSize >= next.motorDiagonal) {
    return {
      ok: false,
      message:
        key === 'plateSize' ? 'Must be smaller than the motor-to-motor diagonal' : 'Must be larger than the centre plate',
    }
  }
  return { ok: true, metres }
}
