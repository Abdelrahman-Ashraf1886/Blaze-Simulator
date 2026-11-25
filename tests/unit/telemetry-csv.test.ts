import { describe, expect, it } from 'vitest'
import { telemetryChannels } from '../../src/domain/telemetry-channels'
import { telemetryCsv } from '../../src/domain/telemetry-csv'

const metadata = {
  title: 'Flight\r\n# second line',
  projectName: 'Project Ω',
  startedAt: '2026-11-25T12:00:00.000Z',
  engineVersion: 'test-engine',
  finalStateHash: 'test-hash',
  incomplete: false,
}

describe('telemetry CSV formatting', () => {
  it('round-trips float64 values and preserves empty fields and signed zero', () => {
    const values = [-0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e21, Math.PI, Number.MAX_VALUE, NaN, null, undefined]
    const csv = telemetryCsv(values.map((_, index) => ({ name: `column${index}`, unit: '1' })), metadata, {})
    const row = csv.row(values)
    expect(row).toBe('-0,0,5e-324,-5e-324,1e+21,3.141592653589793,1.7976931348623157e+308,,,\r\n')
    const parsed = row.slice(0, -2).split(',').map((field) => field === '' ? null : Number(field))
    expect(parsed).toEqual([...values.slice(0, -3), null, null, null])
  })

  it('quotes recorded names and units, including commas, quotes and line breaks', () => {
    const csv = telemetryCsv([
      { name: 'wind, "east"', unit: 'm/s' },
      { name: 'time', unit: 's' },
      { name: 'angle', unit: '°\nrad' },
    ], metadata, {})
    expect(csv.header).toBe('time [s],"wind, ""east"" [m/s]","angle [°\nrad]"\r\n')
    expect(csv.row([2, 1, 3])).toBe('1,2,3\r\n')
  })

  it('writes a BOM and single-line metadata comments only when requested', () => {
    const columns = [{ name: 'time', unit: 's' }]
    expect(telemetryCsv(columns, metadata, {}).header).toBe('time [s]\r\n')
    expect(telemetryCsv(columns, metadata, { bom: true, comments: true }).header).toBe(
      '\uFEFF# Run title: "Flight\\r\\n# second line"\r\n'
      + '# Project: "Project Ω"\r\n'
      + '# Started at: "2026-11-25T12:00:00.000Z"\r\n'
      + '# Engine version: "test-engine"\r\n'
      + '# Final hash: "test-hash"\r\n'
      + '# Incomplete: false\r\n'
      + 'time [s]\r\n',
    )
  })

  it('uses units and enum names from the channel table while keeping flag and unknown codes', () => {
    const table = telemetryChannels(2, 'flightLoop')
    const columns = ['time', 'controller.mode', 'motor.1.groundEffectStatus', 'state.groundContact'].map((name) =>
      table.find((column) => column.name === name)!,
    )
    const codes = telemetryCsv(columns, metadata, {})
    expect(codes.header).toBe('time [s],controller.mode [1],motor.1.groundEffectStatus [1],state.groundContact [1]\r\n')
    expect(codes.row([1, 0, 1, 1])).toBe('1,0,1,1\r\n')
    const names = telemetryCsv(columns, metadata, { enumNames: true })
    expect(names.row([1, 0, 1, 1])).toBe('1,attitudeHold,applied,1\r\n')
    expect(names.row([1, -0, 100, 0])).toBe('1,-0,100,0\r\n')
  })
})
