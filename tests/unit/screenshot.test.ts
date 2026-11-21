import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, safeFileName, savePngSchema } from '../../electron/main/screenshot'

const png = (extra = 8) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(extra).fill(0)])

describe('viewport image save', () => {
  it('accepts PNG bytes and refuses anything else', () => {
    expect(savePngSchema.safeParse({ bytes: png(), name: 'Quad' }).success).toBe(true)
    const msg = (v: unknown) => {
      const r = savePngSchema.safeParse(v)
      return r.success ? null : r.error.issues.map((i) => i.message).join('; ')
    }
    expect(msg({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]), name: 'x' })).toMatch(/not a PNG/)
    expect(msg({ bytes: new Uint8Array(0), name: 'x' })).toMatch(/empty/)
    expect(msg({ bytes: 'iVBORw0KGgo=', name: 'x' })).toMatch(/missing/)
    expect(msg({ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), name: 'x' })).toMatch(/larger than 50 MB/)
  })

  it('makes proposed names safe as file names', () => {
    expect(safeFileName('Survey hex · 2026-11-21 08:10')).toBe('Survey hex · 2026-11-21 08 10')
    expect(safeFileName('../../etc/passwd')).toBe('etc passwd')
    expect(safeFileName(String.raw`a\b/c:d*e?f"g<h>i|j`)).toBe('a b c d e f g h i j')
    expect(safeFileName('CON')).toBe('Blaze UAV view')
    expect(safeFileName('  ...  ')).toBe('Blaze UAV view')
    expect(safeFileName('x'.repeat(300))).toHaveLength(120)
  })
})
