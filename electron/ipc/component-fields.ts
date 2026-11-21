/**
 * Component categories and the specification fields each one can hold.
 *
 * Data only (no zod), so the renderer can build forms and tables from it; main
 * builds its validation schemas from the same definitions (`component-schemas.ts`).
 * Fields are limited to what datasheets commonly state, and all are optional:
 * a missing value stays missing, and checks report "cannot check" instead of
 * assuming one.
 */
import type { Dimension, Unit } from '../../src/domain/units'

export const COMPONENT_CATEGORIES = [
  'motor',
  'propeller',
  'battery',
  'esc',
  'flight-controller',
  'power-module',
  'peripheral',
  'wire',
  'connector',
] as const
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  motor: 'Motor',
  propeller: 'Propeller',
  battery: 'Battery',
  esc: 'ESC',
  'flight-controller': 'Flight controller',
  'power-module': 'Power module',
  peripheral: 'Peripheral',
  wire: 'Wire',
  connector: 'Connector',
}

// ---- Provenance -----------------------------------------------------------------

/**
 * manufacturer: from a datasheet or the manufacturer's product page (reference required);
 * measured: the user's own test; user: entered without a document.
 */
export const SPEC_SOURCES = ['manufacturer', 'measured', 'user'] as const
export type SpecSource = (typeof SPEC_SOURCES)[number]

export interface SpecReference {
  /** Web address of the datasheet or product page. */
  url?: string
  /** Title of a document (e.g. a PDF datasheet) when there is no stable URL. */
  document?: string
  /** Where in the document: page, table or section. */
  locator?: string
  /** Date the source was read, YYYY-MM-DD. */
  retrieved?: string
}

export interface Provenance {
  source: SpecSource
  reference?: SpecReference
  /** Conditions the source states for the value, e.g. "10 s burst", "at 25 °C". */
  condition?: string
}

export const PORT_TYPES = ['uart', 'can', 'i2c', 'spi', 'pwm', 'rc', 'usb', 'adc'] as const
export type PortType = (typeof PORT_TYPES)[number]
export interface Port {
  name: string
  type: PortType
}

export type QuantityValue = Provenance & { value: number; unit: Unit }
export type IntegerValue = Provenance & { value: number }
export type TextValue = Provenance & { value: string }
export type PortsValue = Provenance & { value: Port[] }
/** A table as the source prints it: one unit per numeric column. */
export type TableValue = Provenance & {
  value: { units: Record<string, Unit>; rows: Record<string, number | string>[] }
}
export type SpecValue = QuantityValue | IntegerValue | TextValue | PortsValue | TableValue

// ---- Field definitions ----------------------------------------------------------------

interface Base {
  key: string
  label: string
  help?: string
}
export type FieldDef =
  | (Base & { kind: 'quantity'; dimension: Dimension; unit: Unit })
  | (Base & { kind: 'integer'; min: number; max: number })
  | (Base & { kind: 'text'; maxLength: number })
  | (Base & { kind: 'choice'; options: readonly { value: string; label: string }[] })
  | (Base & { kind: 'ports' })
  | (Base & {
      kind: 'table'
      columns: readonly ({ key: string; label: string } & ({ kind: 'text' } | { kind: 'quantity'; dimension: Dimension; unit: Unit }))[]
    })

const q = (key: string, label: string, dimension: Dimension, unit: Unit, help?: string): FieldDef => ({
  key,
  label,
  kind: 'quantity',
  dimension,
  unit,
  help,
})
const int = (key: string, label: string, min: number, max: number, help?: string): FieldDef => ({ key, label, kind: 'integer', min, max, help })
const text = (key: string, label: string, help?: string): FieldDef => ({ key, label, kind: 'text', maxLength: 200, help })
const choice = (key: string, label: string, options: [string, string][]): FieldDef => ({
  key,
  label,
  kind: 'choice',
  options: options.map(([value, l]) => ({ value, label: l })),
})

const mass = q('mass', 'Mass', 'mass', 'g')
/** Outer size as stated (length along the part's X, width Y, height Z when linked in the workshop). */
const size = [q('length', 'Length', 'length', 'mm'), q('width', 'Width', 'length', 'mm'), q('height', 'Height', 'length', 'mm')]
const mountPattern = text('mountPattern', 'Mounting pattern', 'As stated, e.g. "16 × 16 mm, M3"')
const cellsMin = int('cellsMin', 'Cells, minimum', 1, 24, 'Lithium cells in series (S)')
const cellsMax = int('cellsMax', 'Cells, maximum', 1, 24, 'Lithium cells in series (S)')

/** In display order. The `unit` of a quantity is the one forms propose first. */
export const COMPONENT_FIELDS: Record<ComponentCategory, readonly FieldDef[]> = {
  motor: [
    q('kv', 'Kv', 'kv', 'rpm/V'),
    cellsMin,
    cellsMax,
    q('maxCurrent', 'Maximum current', 'current', 'A'),
    q('maxPower', 'Maximum power', 'power', 'W'),
    q('internalResistance', 'Internal resistance', 'resistance', 'mΩ'),
    q('noLoadCurrent', 'No-load current', 'current', 'A', 'Put the test voltage in the condition'),
    q(
      'rotorInertia',
      'Rotor inertia',
      'inertia',
      'g·cm²',
      'Moment of inertia of the rotating bell, magnets and shaft about the shaft axis (without the propeller)',
    ),
    q(
      'mechanicalTimeConstant',
      'Mechanical time constant',
      'time',
      'ms',
      'τm = J·R/Kt² of the bare motor, as datasheets define it; used when the rotor inertia is not stated',
    ),
    mass,
    q('statorDiameter', 'Stator diameter', 'length', 'mm'),
    q('statorHeight', 'Stator height', 'length', 'mm'),
    q('shaftDiameter', 'Shaft diameter', 'length', 'mm'),
    q('bodyDiameter', 'Body diameter', 'length', 'mm', 'Outer diameter of the motor'),
    q('bodyLength', 'Body length', 'length', 'mm', 'Outer length along the shaft, as stated'),
    mountPattern,
    {
      key: 'thrustTable',
      label: 'Manufacturer test data',
      kind: 'table',
      columns: [
        { key: 'prop', label: 'Propeller', kind: 'text' },
        { key: 'voltage', label: 'Voltage', kind: 'quantity', dimension: 'voltage', unit: 'V' },
        { key: 'throttle', label: 'Throttle', kind: 'quantity', dimension: 'ratio', unit: '%' },
        { key: 'thrust', label: 'Thrust', kind: 'quantity', dimension: 'force', unit: 'gf' },
        { key: 'current', label: 'Current', kind: 'quantity', dimension: 'current', unit: 'A' },
        { key: 'power', label: 'Power', kind: 'quantity', dimension: 'power', unit: 'W' },
        { key: 'rpm', label: 'Speed', kind: 'quantity', dimension: 'angularSpeed', unit: 'rpm' },
      ],
    },
  ],
  propeller: [
    q('diameter', 'Diameter', 'length', 'in'),
    q('pitch', 'Pitch', 'length', 'in'),
    int('blades', 'Blades', 2, 8),
    choice('hand', 'Rotation', [
      ['cw', 'Clockwise'],
      ['ccw', 'Counter-clockwise'],
      ['pair', 'Sold as a CW/CCW pair'],
    ]),
    q('boreDiameter', 'Bore diameter', 'length', 'mm'),
    mass,
    text('material', 'Material'),
    {
      key: 'performanceTable',
      label: 'Manufacturer performance data',
      help: 'Columns and units as the source prints them; one row per speed (e.g. the static, zero-airspeed row of each RPM block)',
      kind: 'table',
      columns: [
        { key: 'rpm', label: 'Speed', kind: 'quantity', dimension: 'angularSpeed', unit: 'rpm' },
        { key: 'airspeed', label: 'Airspeed V', kind: 'quantity', dimension: 'speed', unit: 'mph' },
        { key: 'advanceRatio', label: 'Advance ratio J', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'efficiency', label: 'Efficiency Pe', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'ct', label: 'Thrust coef. Ct', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'cp', label: 'Power coef. Cp', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'powerImperial', label: 'Power', kind: 'quantity', dimension: 'power', unit: 'hp' },
        { key: 'torqueImperial', label: 'Torque', kind: 'quantity', dimension: 'torque', unit: 'in·lbf' },
        { key: 'thrustImperial', label: 'Thrust', kind: 'quantity', dimension: 'force', unit: 'lbf' },
        { key: 'power', label: 'Power', kind: 'quantity', dimension: 'power', unit: 'W' },
        { key: 'torque', label: 'Torque', kind: 'quantity', dimension: 'torque', unit: 'N·m' },
        { key: 'thrust', label: 'Thrust', kind: 'quantity', dimension: 'force', unit: 'N' },
        { key: 'thrustPerPower', label: 'Thrust/power', kind: 'quantity', dimension: 'thrustPerPower', unit: 'g/W' },
        { key: 'mach', label: 'Tip Mach', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'reynolds', label: 'Reynolds (75 % span)', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
        { key: 'figureOfMerit', label: 'Figure of merit', kind: 'quantity', dimension: 'dimensionless', unit: '1' },
      ],
    },
  ],
  battery: [
    choice('chemistry', 'Chemistry', [
      ['lipo', 'LiPo'],
      ['lihv', 'LiHV'],
      ['li-ion', 'Li-ion'],
      ['life', 'LiFePO₄'],
    ]),
    int('series', 'Cells in series (S)', 1, 24),
    int('parallel', 'Cells in parallel (P)', 1, 20),
    q('packVoltageNominal', 'Pack voltage, nominal', 'voltage', 'V'),
    q('capacity', 'Capacity', 'charge', 'mAh'),
    q('cRateContinuous', 'Discharge rate, continuous', 'crate', 'C'),
    q('cRateBurst', 'Discharge rate, burst', 'crate', 'C', 'Put the duration in the condition'),
    q('cellVoltageNominal', 'Cell voltage, nominal', 'voltage', 'V'),
    q('cellVoltageMax', 'Cell voltage, full charge', 'voltage', 'V'),
    q('internalResistance', 'Internal resistance', 'resistance', 'mΩ', 'Of the whole pack (used for the voltage under load)'),
    mass,
    q('length', 'Length', 'length', 'mm'),
    q('width', 'Width', 'length', 'mm'),
    q('height', 'Height', 'length', 'mm'),
    text('connector', 'Connector'),
  ],
  esc: [
    choice('format', 'Format', [
      ['single', 'Single'],
      ['4-in-1', '4-in-1'],
    ]),
    cellsMin,
    cellsMax,
    q('continuousCurrent', 'Continuous current', 'current', 'A', 'Per motor output'),
    q('burstCurrent', 'Burst current', 'current', 'A', 'Put the duration in the condition'),
    text('protocols', 'Protocols', 'As stated, e.g. "PWM, DShot150/300/600"'),
    q('becVoltage', 'BEC voltage', 'voltage', 'V'),
    q('becCurrent', 'BEC current', 'current', 'A'),
    mass,
    ...size,
    mountPattern,
  ],
  'flight-controller': [
    text('processor', 'Processor'),
    q('inputVoltageMin', 'Input voltage, minimum', 'voltage', 'V'),
    q('inputVoltageMax', 'Input voltage, maximum', 'voltage', 'V'),
    { key: 'ports', label: 'Ports', kind: 'ports' },
    int('pwmOutputs', 'PWM outputs', 0, 32),
    mass,
    ...size,
    mountPattern,
  ],
  'power-module': [
    cellsMin,
    cellsMax,
    q('inputVoltageMin', 'Input voltage, minimum', 'voltage', 'V'),
    q('inputVoltageMax', 'Input voltage, maximum', 'voltage', 'V'),
    q('continuousCurrent', 'Continuous current', 'current', 'A'),
    choice('sensing', 'Sensing', [
      ['none', 'None'],
      ['analog', 'Analog voltage and current'],
      ['digital', 'Digital (I²C or CAN)'],
    ]),
    q('outputVoltage', 'Regulated output voltage', 'voltage', 'V'),
    q('outputCurrent', 'Regulated output current', 'current', 'A'),
    mass,
    ...size,
  ],
  peripheral: [
    choice('role', 'Role', [
      ['gps', 'GPS / compass'],
      ['rc-receiver', 'RC receiver'],
      ['telemetry-radio', 'Telemetry radio'],
      ['other', 'Other'],
    ]),
    choice('requiredPort', 'Connects to', [
      ['uart', 'UART'],
      ['can', 'CAN'],
      ['i2c', 'I²C'],
      ['rc', 'RC input'],
      ['usb', 'USB'],
    ]),
    q('supplyVoltage', 'Supply voltage', 'voltage', 'V', 'When stated as a single value'),
    q('supplyVoltageMin', 'Supply voltage, minimum', 'voltage', 'V'),
    q('supplyVoltageMax', 'Supply voltage, maximum', 'voltage', 'V'),
    q('supplyCurrent', 'Supply current', 'current', 'A', 'Put the operating state in the condition'),
    mass,
    ...size,
  ],
  wire: [
    q('crossSection', 'Conductor size', 'area', 'AWG'),
    choice('conductor', 'Conductor', [
      ['copper', 'Copper'],
      ['aluminium', 'Aluminium'],
    ]),
    q('insulationRating', 'Insulation temperature rating', 'temperature', '°C'),
  ],
  connector: [
    text('series', 'Series', 'e.g. "XT60"'),
    q('ratedCurrent', 'Rated current', 'current', 'A'),
    q('contactResistance', 'Contact resistance', 'resistance', 'mΩ'),
  ],
}

// ---- Component record -----------------------------------------------------------------

export const COMPONENT_ORIGINS = ['built-in', 'user', 'imported'] as const
export type ComponentOrigin = (typeof COMPONENT_ORIGINS)[number]

export interface ComponentInput {
  category: ComponentCategory
  name: string
  manufacturer: string | null
  notes: string | null
  /** Keyed by field key of the category. */
  specs: Record<string, SpecValue>
}

export interface Component extends ComponentInput {
  id: string
  origin: ComponentOrigin
  /** Version of the field definitions the record was written with. */
  schemaVersion: number
  /** Incremented on every update; an update based on an older revision is rejected. */
  revision: number
  createdAt: string
  updatedAt: string
}

export const COMPONENT_SCHEMA_VERSION = 1
