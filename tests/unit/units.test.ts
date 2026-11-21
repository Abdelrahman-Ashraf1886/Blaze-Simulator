import { describe, expect, it } from 'vitest'
import { UNITS, convert, dimensionOf, fromSI, toSI, unitsOf, type Unit } from '../../src/domain/units'

describe('units', () => {
  it('uses the exact definitions', () => {
    expect(toSI(1, 'in')).toBe(0.0254)
    expect(toSI(1, 'oz')).toBeCloseTo(0.028349523125, 15)
    expect(toSI(1300, 'mAh')).toBeCloseTo(4680, 9) // coulombs
    expect(toSI(1, 'Ah')).toBe(3600)
    expect(toSI(60, 'rpm/V')).toBeCloseTo(2 * Math.PI, 12) // rad/(s·V)
    expect(toSI(1000, 'gf')).toBeCloseTo(9.80665, 12)
    expect(toSI(25, '°C')).toBeCloseTo(298.15, 12)
    expect(toSI(50, '%')).toBe(0.5)
  })

  it('C rating times capacity gives current: 1300 mAh at 100 C is 130 A', () => {
    expect(toSI(100, 'C') * toSI(1300, 'mAh')).toBeCloseTo(130, 9)
  })

  it('AWG follows ASTM B258: 12 AWG ≈ 3.31 mm², 20 AWG ≈ 0.518 mm², and round-trips', () => {
    expect(convert(12, 'AWG', 'mm²')).toBeCloseTo(3.309, 3)
    expect(convert(20, 'AWG', 'mm²')).toBeCloseTo(0.5176, 4)
    expect(convert(0, 'AWG', 'mm²')).toBeCloseTo(53.48, 2)
    for (const n of [0, 10, 14, 18, 22, 30]) expect(fromSI(toSI(n, 'AWG'), 'AWG')).toBeCloseTo(n, 10)
  })

  it('every linear unit round-trips through SI, and conversions stay within a dimension', () => {
    for (const u of Object.keys(UNITS) as Unit[]) expect(fromSI(toSI(123.456, u), u)).toBeCloseTo(123.456, 9)
    expect(convert(5, 'in', 'mm')).toBeCloseTo(127, 12)
    expect(() => convert(1, 'in', 'g')).toThrow(/Cannot convert in \(length\) to g \(mass\)/)
    expect(unitsOf('current')).toEqual(['A', 'mA'])
    expect(dimensionOf('mΩ')).toBe('resistance')
  })
})
