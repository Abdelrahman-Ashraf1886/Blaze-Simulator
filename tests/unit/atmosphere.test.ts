import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { airDensity, isaConstants, isaTemperaturePressure } from '../../src/domain/atmosphere'

const ref = JSON.parse(readFileSync(join(__dirname, '../../database/reference/physics.v1.json'), 'utf8'))
const c = isaConstants(ref)

describe('ISA air density (USSA 1976, below 11 km)', () => {
  it('takes its constants from the cited reference file, in SI', () => {
    expect(c.p0).toBe(101325)
    expect(c.t0).toBe(288.15)
    expect(c.lapseRate).toBeCloseTo(-0.0065, 15)
    expect(c.molarMass).toBeCloseTo(0.0289644, 12)
    expect(c.universalGasConstant).toBeCloseTo(8.31432, 12)
  })

  it('gives the cited sea-level density (USSA Table I: 1.2250 kg/m³) at 0 m', () => {
    expect(Math.abs(airDensity(c, 0) - 1.225)).toBeLessThan(5e-5)
  })

  it('satisfies the hydrostatic equation dP/dH = −ρ g0 (central difference, 1e-7 relative)', () => {
    for (const h of [-2000, 0, 1500, 5000, 10500]) {
      const d = 0.5
      const dp = (isaTemperaturePressure(c, h + d).pressurePa - isaTemperaturePressure(c, h - d).pressurePa) / (2 * d)
      const rhoG = airDensity(c, h) * c.g0
      expect(Math.abs(dp + rhoG) / rhoG, `H = ${h} m`).toBeLessThan(1e-7)
    }
  })

  it('a hot day lowers the density as T_std / T at the same pressure', () => {
    const std = airDensity(c, 1000) // T = 281.65 K
    expect(airDensity(c, 1000, 30) / std).toBeCloseTo(281.65 / 303.15, 12)
  })

  it('refuses altitudes outside the layer and temperatures at or below absolute zero', () => {
    expect(() => airDensity(c, 12000)).toThrow(/11000/)
    expect(() => airDensity(c, -6000)).toThrow(RangeError)
    expect(() => airDensity(c, 0, -273.15)).toThrow(/absolute zero/)
  })
})
