import { telemetryChannels } from './telemetry-channels'

// RFC 4180 uses CRLF between records for interchange, independent of the host OS.
const CRLF = '\r\n'

export interface TelemetryCsvOptions {
  bom?: boolean
  comments?: boolean
  enumNames?: boolean
}

interface CsvColumn {
  name: string
  unit: string
}

interface CsvMetadata {
  title: string
  projectName: string
  startedAt: string
  engineVersion: string
  finalStateHash: string | null
  incomplete: boolean
}

// RecordingChannel persists names and units, so resolve enum codes by the same
// channel table and motor template used in src/features/telemetry/layout.ts:4–15.
const enums = new Map(telemetryChannels(1, 'flightLoop').flatMap((channel) =>
  channel.kind === 'enum' ? [[channel.name, channel.values] as const] : [],
))

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function line(fields: readonly string[]): string {
  return fields.map(field).join(',') + CRLF
}

function numeric(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return ''
  // Number#toString uses the shortest round-trip decimal and spells -0 as 0.
  return Object.is(value, -0) ? '-0' : String(value)
}

export function telemetryCsv(
  columns: readonly CsvColumn[],
  metadata: CsvMetadata,
  options: TelemetryCsvOptions = {},
) {
  const timeIndex = columns.findIndex(({ name }) => name === 'time')
  const indices = columns.map((_, index) => index)
  if (timeIndex > 0) indices.unshift(...indices.splice(timeIndex, 1))
  const enumValues = columns.map(({ name }) =>
    options.enumNames ? enums.get(name.replace(/^motor\.\d+\./, 'motor.0.')) : undefined,
  )
  const comments = [
    ['Run title', metadata.title],
    ['Project', metadata.projectName],
    ['Started at', metadata.startedAt],
    ['Engine version', metadata.engineVersion],
    ['Final hash', metadata.finalStateHash],
    ['Incomplete', metadata.incomplete],
  ]
  const prefix = options.comments
    // Escape embedded line breaks so every metadata entry stays on one comment line.
    ? comments.map(([key, value]) => `# ${key}: ${JSON.stringify(value)}${CRLF}`).join('')
    : ''
  return {
    header: (options.bom ? '\uFEFF' : '') + prefix + line(indices.map((index) => {
      const { name, unit } = columns[index]!
      return `${name} [${unit}]`
    })),
    row(values: readonly (number | null | undefined)[]): string {
      return line(indices.map((index) => {
        const value = values[index]
        return (value == null || Object.is(value, -0) ? undefined : enumValues[index]?.[value]) ?? numeric(value)
      }))
    },
  }
}
