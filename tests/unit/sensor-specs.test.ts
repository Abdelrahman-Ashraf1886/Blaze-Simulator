import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Component } from '../../electron/ipc/component-fields'
import { parsePack } from '../../electron/main/components/pack'
import { cepToAxisSigma, noiseDensityToSampleSigma, resolveSensorSpecs } from '../../src/domain/sensor-specs'

const seed = parsePack(readFileSync(join(__dirname, '../../database/seed/components.v1.json'), 'utf8'))
function seededComponent(name: string): Component {
  const entry = seed.find(({ input }) => input.name === name)
  if (!entry?.id) throw new Error('Missing seeded component: ' + name)
  return {
    ...entry.input, id: entry.id,
    origin: 'built-in', revision: 0, schemaVersion: 1, createdAt: '', updatedAt: '',
  }
}

const pixhawk = seededComponent('Pixhawk 6C')
const m10 = seededComponent('M10 GPS')
const m9n = seededComponent('M9N GPS')
const components = { [pixhawk.id]: pixhawk, [m10.id]: m10, [m9n.id]: m9n }
const parts = [
  { id: 'fc', kind: 'flight-controller', name: 'Pilot board', componentId: pixhawk.id },
  { id: 'gps1', kind: 'gps', name: 'GPS 1', componentId: m10.id },
  { id: 'gps2', kind: 'custom', name: 'GPS 2', componentId: m9n.id },
] as const

describe('build sensor specifications', () => {
  it('reports the six seeded values with their manufacturer provenance and conditions', () => {
    const { values } = resolveSensorSpecs({ parts }, components)
    const tdk = 'https://invensense.tdk.com/products/motion-tracking/6-axis/icm-42688-p/'
    const tdkLocator = 'Product Features and Benefits'
    const holybro = 'https://docs.holybro.com/gps-and-rtk-system/m8n-m9n-m10-gps/standard-m10-m9n-m8n-gps/overview'
    const expected = [
      ['fc', 'imuName', 'ICM-42688-P', undefined, tdk, tdkLocator],
      ['fc', 'gyroNoiseDensity', 2.8, 'mdps/√Hz', tdk, tdkLocator],
      ['fc', 'accelNoiseDensity', 70, 'µg/√Hz', tdk, tdkLocator],
      ['fc', 'baroRmsNoise', 0.012, 'mbar', 'https://www.te.com/usa-en/product-MS561101BA03-50.html', 'p. 4, Resolution RMS, OSR 4096'],
      ['gps1', 'gpsHorizontalCep', 2, 'm', holybro, 'Holybro M10 GPS column'],
      ['gps2', 'gpsHorizontalCep', 1.5, 'm', holybro, 'Holybro M9N GPS column'],
    ]
    expect(values.map(({ partId, field, value }) => [
      partId, field.key, value.value, 'unit' in value ? value.unit : undefined,
      value.reference?.url, value.reference?.locator,
    ])).toEqual(expected)
    for (const { layer, value } of values) {
      expect(layer).toBe('manufacturer')
      expect(value.source).toBe('manufacturer')
      expect(value.reference?.retrieved).toBe('2026-11-25')
    }
    for (const { value } of values.slice(0, 3)) {
      expect(value.condition).toContain('DSK320X with BMI423')
      expect(value.condition).toContain('Check which your board has.')
    }
    expect(values.find(({ field }) => field.key === 'baroRmsNoise')?.value.condition)
      .toBe("VDD = 3 V, 25 deg C, oversampling 4096 (conversion time 8.22 ms typ., p. 3); the autopilot's actual oversampling setting may differ")
  })

  it('reports exactly the missing specs, including each GPS delay and where to enter it', () => {
    const other = { ...m10, id: 'telemetry', specs: { role: { value: 'telemetry-radio', source: 'manufacturer' } } } satisfies Component
    const result = resolveSensorSpecs({
      parts: [...parts, { id: 'radio', kind: 'gps', name: 'Radio', componentId: other.id }],
    }, { ...components, [other.id]: other })
    expect(result.missing.map(({ partId, field }) => [partId, field.key])).toEqual([
      ['fc', 'gyroFullScaleRange'], ['fc', 'accelFullScaleRange'], ['fc', 'baroOutputRate'],
      ...['gps1', 'gps2'].flatMap((id) => [
        'gpsVerticalAccuracy', 'gpsVelocityAccuracy', 'gpsUpdateRate', 'gpsPositionDelay',
      ].map((key) => [id, key])),
    ])
    for (const entry of result.missing) {
      expect(entry.enterAt).toBe('catalog-fill')
      expect(entry.componentId).toBe(parts.find((part) => part.id === entry.partId)?.componentId)
    }
    expect(resolveSensorSpecs({ parts: [] }, components)).toEqual({ values: [], missing: [] })
  })

  it('keeps instance overrides and catalogue fills with their own provenance', () => {
    const fill = { value: 3, unit: 'm', source: 'measured', condition: 'Bench measurement' } as const
    const override = { value: 4, unit: 'm', source: 'user', condition: 'Build estimate' } as const
    const result = resolveSensorSpecs({ parts: [
      parts[1],
      { ...parts[1], id: 'override', overrides: { gpsHorizontalCep: override } },
    ] }, { [m10.id]: { ...m10, fills: { gpsHorizontalCep: fill } } })
    expect(result.values).toMatchObject([
      { partId: 'gps1', value: fill, layer: 'catalog' },
      { partId: 'override', value: override, layer: 'instance' },
    ])
  })

  it('points to the component editor, duplication or linking when a gap cannot use a catalogue fill', () => {
    const builtIn = { ...pixhawk, specs: {} }
    const own = { ...builtIn, id: 'own', origin: 'user' } satisfies Component
    const result = resolveSensorSpecs({ parts: [
      parts[0],
      { ...parts[0], id: 'own-part', componentId: own.id },
      { ...parts[0], id: 'unlinked', componentId: null },
    ] }, { [builtIn.id]: builtIn, [own.id]: own })
    expect(result.values).toEqual([])
    expect(result.missing.filter(({ field }) => field.key === 'imuName')).toMatchObject([
      { partId: 'fc', enterAt: 'duplicate-component' },
      { partId: 'own-part', enterAt: 'component-editor' },
      { partId: 'unlinked', componentId: null, enterAt: 'link-component' },
    ])
  })
})

describe('sensor noise conversions', () => {
  it('integrates one-sided white noise through half the sample rate', () => {
    // At 200 Hz the one-sided bandwidth is 100 Hz, so multiply the density by 10.
    expect(noiseDensityToSampleSigma(0.0028, 200)).toBeCloseTo(0.028, 14)
    expect(noiseDensityToSampleSigma(0.0028, 1000)).toBeCloseTo(0.06260990337, 10)
  })

  it('converts a 50% circular radius to isotropic per-axis sigma', () => {
    // sqrt(2 ln 2) ≈ 1.1774100225, so a 2 m CEP gives about 1.6986436 m per axis.
    expect(cepToAxisSigma(2)).toBeCloseTo(1.6986436, 7)
    expect(cepToAxisSigma(0)).toBe(0)
  })
})
