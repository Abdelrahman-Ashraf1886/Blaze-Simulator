import type { FlightSensorsDoc } from '../../../../electron/ipc/contract'
import { NumberField } from '@/components/number-field'
import { GPS_DELAY_SUGGESTION } from '@/domain/sensors'
import type { SensorValue } from '@/domain/sensor-specs'
import { formatReference, formatValue, SOURCE_LABELS } from '../../components/spec-format'
import { ChoiceField, optionalNumber } from '../../workshop/environment/fields'
import {
  GYRO_REFERENCE, px4GyroDefaults, rateLoopLabel, selectedSensorPart, sensorId, sensorLabels, sourceLabels,
  type SensorGroup, type SensorSources, type SourceKey,
} from './settings'

type Vector = [number, number, number]
type Constraint = NonNullable<Parameters<typeof optionalNumber>[1]>
type FilterSettings = NonNullable<FlightSensorsDoc['gyroFilters']>

const hint = 'text-[11.5px] text-fg-subtle'
const action = 'my-1 text-left text-[12px] text-accent underline underline-offset-2'
const whole = (value: number) => Number.isSafeInteger(value)
const nonnegative = { accepts: (v: number) => v >= 0, message: 'Enter a number of zero or more.' }
const positive = { accepts: (v: number) => v > 0, message: 'Enter a number greater than zero.' }
const delay = { accepts: (v: number) => whole(v) && v >= 0, message: 'Enter whole milliseconds of zero or more.' }
const period = { accepts: (v: number) => whole(v) && v > 0, message: 'Enter a positive whole millisecond period.' }

export function SensorNotice({ mode }: { mode: FlightSensorsDoc['mode'] | undefined }) {
  if (!mode || mode === 'off') return null
  // phase-7-telemetry.md:37–44,77–100,152–154.
  return <div className="space-y-1 py-2 text-[12px] text-fg-muted" data-testid="sensor-notice">
    <p>Rate loop uses {rateLoopLabel(mode)}. All other control and state use perfect state.
      {mode === 'flyOnGyro' && ' The loop uses true rates while waiting for the first gyro sample.'}
    </p>
    <p>The model can record gyro, accelerometer, barometer and GPS samples with noise and delay. The gyro and accelerometer sample at 1 kHz and support constant bias and random walk. IMU saturation and clipping require a full-scale range.</p>
    <p>Motor and propeller vibration, temperature effects on sensors, misalignment, scale errors, sensor failures, magnetometer, GPS satellite geometry and state estimation are unmodelled. You can enter extra vibration noise from your own log.</p>
    <p className="text-warn">Noise without vibration looks too good. A real gyro sees motor and propeller vibration, so tuning that works here can fail on the real aircraft.</p>
  </div>
}

function CatalogueValue({ spec }: { spec: SensorValue }) {
  const { value, field, layer } = spec
  return <p className={hint}>
    {field.label} {formatValue(field, value)} · {layer === 'instance' ? 'Part override' : 'Catalogue'} · {SOURCE_LABELS[value.source]}
    {value.condition && ` · ${value.condition}`}
    {value.reference && ` · ${formatReference(value.reference)}`}
  </p>
}

function SensorNumber({ path, label, unit, value, allowOff, constraint, spec, onCommit }: {
  path: string
  label: string
  unit: string
  value?: number | null
  allowOff?: boolean
  constraint?: Constraint
  spec?: SensorValue
  onCommit: (value: number | null | undefined) => void
}) {
  const initial = value === null ? 'off' : value === undefined ? '' : String(value)
  return <div>
    <NumberField key={initial} id={sensorId(path)} label={label} unit={unit} initial={initial} width={120}
      placeholder={spec ? 'use catalogue' : allowOff ? 'enter or off' : 'enter value'}
      parse={(text) => {
        if (allowOff && text.trim().toLowerCase() === 'off') return { ok: true, value: null }
        const parsed = optionalNumber(text, constraint)
        return parsed.ok ? { ok: true, value: parsed.value ?? undefined } : parsed
      }}
      onCommit={onCommit} />
    {spec && <CatalogueValue spec={spec} />}
  </div>
}

function VectorField({ path, label, unit, value, allowOff, onCommit }: {
  path: string; label: string; unit: string; value?: Vector | null; allowOff?: boolean
  onCommit: (value: Vector | null | undefined) => void
}) {
  const initial = value === null ? 'off' : value?.join(', ') ?? ''
  return <NumberField key={initial} id={sensorId(path)} label={label} unit={unit} initial={initial} width={185}
    placeholder={allowOff ? 'x, y, z or off' : 'x, y, z'}
    parse={(text) => {
      if (!text.trim()) return { ok: true, value: undefined }
      if (allowOff && text.trim().toLowerCase() === 'off') return { ok: true, value: null }
      const [x, y, z, ...rest] = text.split(',').map((part) => part.trim() ? Number(part) : Number.NaN)
      return x !== undefined && y !== undefined && z !== undefined && rest.length === 0 && [x, y, z].every(Number.isFinite)
        ? { ok: true, value: [x, y, z] satisfies Vector }
        : { ok: false, message: 'Enter three finite numbers in X, Y, Z order, separated by commas.' }
    }}
    onCommit={onCommit} />
}

type NumericField<T> = {
  key: keyof T & string
  label: string
  unit: string
  constraint?: Constraint
  allowOff?: boolean
  specKey?: string
  specNeedsSigma?: boolean
}

function NumericFields<T>({ group, value, fields, spec, onChange }: {
  group: SensorGroup; value: T; fields: readonly NumericField<T>[]
  spec: (key?: string) => SensorValue | undefined; onChange: (value: T) => void
}) {
  return fields.map(({ key, label, unit, constraint, allowOff, specKey, specNeedsSigma }) => {
    const catalogue = spec(specKey)
    return <div key={key}>
      <SensorNumber path={`${group}.${key}`} label={label} unit={unit}
        value={value[key] as number | null | undefined} constraint={constraint} allowOff={allowOff}
        spec={specNeedsSigma ? undefined : catalogue} onCommit={(entry) => onChange({ ...value, [key]: entry })} />
      {specNeedsSigma && catalogue && <>
        <CatalogueValue spec={catalogue} />
        <p className={hint}>Enter a 1σ value for this statistic or choose “off”.</p>
      </>}
    </div>
  })
}

type Imu = NonNullable<FlightSensorsDoc['gyro']>
type Barometer = NonNullable<FlightSensorsDoc['barometer']>
type GPS = NonNullable<FlightSensorsDoc['gps']>

const imuFields = (group: 'gyro' | 'accelerometer', unit: string): NumericField<Imu>[] => {
  const prefix = group === 'gyro' ? 'gyro' : 'accel'
  return [
    { key: 'noiseSigma', label: 'Sample noise σ', unit, constraint: nonnegative, allowOff: true, specKey: `${prefix}NoiseDensity` },
    { key: 'vibrationSigma', label: 'Vibration noise σ', unit, constraint: nonnegative, allowOff: true },
    { key: 'randomWalk', label: 'Bias random walk σ', unit: `${unit}/√s`, constraint: nonnegative, allowOff: true },
    { key: 'range', label: 'Full-scale limit', unit, constraint: positive, allowOff: true, specKey: `${prefix}FullScaleRange` },
    { key: 'delayMs', label: 'Delay', unit: 'ms', constraint: delay, allowOff: true },
  ]
}

const barometerFields: NumericField<Barometer>[] = [
  { key: 'sigmaPa', label: 'Pressure noise σ', unit: 'Pa', constraint: nonnegative, allowOff: true, specKey: 'baroRmsNoise' },
  { key: 'biasPa', label: 'Pressure bias', unit: 'Pa', allowOff: true },
  { key: 'periodMs', label: 'Sample period', unit: 'ms', constraint: period, specKey: 'baroOutputRate' },
  { key: 'delayMs', label: 'Delay', unit: 'ms', constraint: delay, allowOff: true },
]
const gpsFields: NumericField<GPS>[] = [
  { key: 'positionSigmaHorizontalM', label: 'Horizontal position noise σ', unit: 'm', constraint: nonnegative, allowOff: true, specKey: 'gpsHorizontalCep' },
  { key: 'positionSigmaVerticalM', label: 'Vertical position noise σ', unit: 'm', constraint: nonnegative, allowOff: true,
    specKey: 'gpsVerticalAccuracy', specNeedsSigma: true },
  { key: 'velocitySigmaMps', label: 'Velocity noise σ', unit: 'm/s', constraint: nonnegative, allowOff: true,
    specKey: 'gpsVelocityAccuracy', specNeedsSigma: true },
  { key: 'periodMs', label: 'Sample period', unit: 'ms', constraint: period, specKey: 'gpsUpdateRate' },
  { key: 'delayMs', label: 'Delay', unit: 'ms', constraint: delay, allowOff: true, specKey: 'gpsPositionDelay' },
]

function FilterNumber({ path, param, value, allowOff, onCommit }: {
  path: string; param: typeof GYRO_REFERENCE.gyroCutoffHz; value?: number; allowOff?: boolean
  onCommit: (value: number | undefined) => void
}) {
  const { name, min, max, description, source } = param
  return <div title={source.locator}>
    <SensorNumber path={`flyOnGyro.${path}`} label={name} unit="Hz" value={value} allowOff={allowOff}
      constraint={{ accepts: (v) => v >= min && v <= max, message: `Enter ${min}–${max} Hz.` }}
      onCommit={(v) => onCommit(v === null ? 0 : v)} />
    <p className={hint}>{min}–{max} Hz · {description}</p>
  </div>
}

function GyroFilters({ value, onChange }: { value: FilterSettings; onChange: (value: FilterSettings) => void }) {
  return <div className="mt-2">
    <button type="button" className={action} onClick={() => onChange(px4GyroDefaults())}>Use PX4 v1.13.3 defaults</button>
    {(['gyroCutoffHz', 'dgyroCutoffHz'] as const).map((key) =>
      <FilterNumber key={key} path={key} param={GYRO_REFERENCE[key]} value={value[key]}
        onCommit={(v) => onChange({ ...value, [key]: v })} />)}
    {(['notch0', 'notch1'] as const).map((key) => {
      const notch = value[key]
      const params = GYRO_REFERENCE[key]
      return <div key={key}>
        <FilterNumber path={`${key}.frequencyHz`} param={params.frequencyHz} value={notch === null ? 0 : notch?.frequencyHz}
          allowOff onCommit={(frequencyHz) => onChange({ ...value, [key]: { ...notch, frequencyHz } })} />
        <FilterNumber path={`${key}.bandwidthHz`} param={params.bandwidthHz} value={notch?.bandwidthHz}
          onCommit={(bandwidthHz) => onChange({ ...value, [key]: { ...notch, frequencyHz: notch === null ? 0 : notch?.frequencyHz, bandwidthHz } })} />
      </div>
    })}
  </div>
}

export function SensorSection({ settings, sources, mountOf, onChange }: {
  settings: FlightSensorsDoc | null | undefined
  sources: SensorSources
  mountOf: (partId: string) => Vector | undefined
  onChange: (settings: FlightSensorsDoc) => void
}) {
  const mode = settings?.mode ?? 'off'
  return <section className="mt-3" aria-labelledby="flight-sensors-heading">
    <details data-testid="flight-sensors">
      <summary id="flight-sensors-heading" className="cursor-pointer text-[12px] font-medium text-fg-muted">Sensors
        {mode === 'recorded' ? ' · Recorded only' : mode === 'flyOnGyro' ? ' · Fly on gyro' : ' · Off'}
      </summary>
      <ChoiceField id={sensorId('mode')} label="Sensor mode" value={mode}
        options={[[ 'off', 'Off'], ['recorded', 'Recorded only'], ['flyOnGyro', 'Fly on gyro']]}
        onChange={(v) => onChange({ ...settings, mode: v as FlightSensorsDoc['mode'] })} />
      {settings && mode !== 'off' && <ActiveSensors settings={settings} sources={sources} mountOf={mountOf} onChange={onChange} />}
    </details>
    <SensorNotice mode={mode} />
  </section>
}

function ActiveSensors({ settings, sources, mountOf, onChange }: {
  settings: FlightSensorsDoc; sources: SensorSources; mountOf: (partId: string) => Vector | undefined
  onChange: (settings: FlightSensorsDoc) => void
}) {
  const set = (patch: Partial<FlightSensorsDoc>) => onChange({ ...settings, ...patch })
  const controller = selectedSensorPart(sources, 'flightControllerPartId', settings.flightControllerPartId)
  const gpsPart = selectedSensorPart(sources, 'gpsPartId', settings.gpsPartId)
  const findSpec = (partId?: string) => (key?: string) => sources.specs.values.find((s) => s.partId === partId && s.field.key === key)
  const fcSpec = findSpec(controller?.id)
  const gpsSpec = findSpec(gpsPart?.id)
  const imuName = fcSpec('imuName')
  const mount = settings.accelerometer && controller ? mountOf(controller.id) : undefined
  return <>
    {(['flightControllerPartId', 'gpsPartId'] as const).map((key: SourceKey) => {
      const parts = sources[key]
      const selected = key === 'flightControllerPartId' ? controller : gpsPart
      return <ChoiceField key={key} id={sensorId(key)} label={sourceLabels[key]} value={selected?.id ?? ''}
        options={[[ '', parts.length ? 'Choose a part' : 'Enter values manually'], ...parts.map((p) => [p.id, p.name] as const)]}
        disabled={parts.length < 2} onChange={(id) => set({ [key]: id || undefined })} />
    })}
    {imuName && <CatalogueValue spec={imuName} />}
    <p className={hint}>Blank overrides use a catalogue value where one is available. Enter “off” to disable an individual effect.</p>
    <SensorNumber path="seed" label="Seed (repeats sensor noise)" unit="1" value={settings.seed}
      constraint={{ accepts: whole, message: 'Enter a signed safe integer.' }} onCommit={(seed) => set({ seed: seed ?? undefined })} />
    <button type="button" className={action} onClick={() => set({ seed: crypto.getRandomValues(new Int32Array(1))[0]! })}>New seed</button>
    <p className={hint}>IMU noise density supplies sample σ at 1 kHz. Enter vibration noise from your own log, or “off” (unmodelled).</p>
    {(Object.keys(sensorLabels) as SensorGroup[]).map((group) => {
      const state = settings[group]
      return <div className="mt-2" key={group}>
        <ChoiceField id={sensorId(group)} label={sensorLabels[group]} value={state === null ? 'off' : state === undefined ? '' : 'on'}
          options={[[ '', 'Choose on or off'], ['off', 'Off'], ['on', 'On']]}
          onChange={(v) => set({ [group]: v === 'on' ? {} : v === 'off' ? null : undefined })} />
        {(group === 'gyro' || group === 'accelerometer') && settings[group] && (() => {
          const imu = settings[group]
          const unit = group === 'gyro' ? 'rad/s' : 'm/s²'
          return <>
            <NumericFields group={group} value={imu} fields={imuFields(group, unit)} spec={fcSpec} onChange={(v) => set({ [group]: v })} />
            <VectorField path={`${group}.bias`} label="Constant bias (body X, Y, Z)" unit={unit} allowOff value={imu.bias}
              onCommit={(bias) => set({ [group]: { ...imu, bias } })} />
          </>
        })()}
        {group === 'gyro' && settings.mode === 'flyOnGyro' &&
          <GyroFilters value={settings.gyroFilters ?? {}} onChange={(gyroFilters) => set({ gyroFilters })} />}
        {group === 'accelerometer' && settings.accelerometer && <>
          <VectorField path="accelerometer.mountPositionM" label="Mount (forward, left, up)" unit="m" value={settings.accelerometer.mountPositionM}
            onCommit={(mountPositionM) => set({ accelerometer: { ...settings.accelerometer, mountPositionM: mountPositionM ?? undefined } })} />
          {mount && <button type="button" className={action}
            onClick={() => set({ accelerometer: { ...settings.accelerometer, mountPositionM: mount } })}>
            Use flight controller position ({mount.join(', ')} m)
          </button>}
        </>}
        {group === 'barometer' && settings.barometer && <>
          <NumericFields group={group} value={settings.barometer} fields={barometerFields} spec={fcSpec} onChange={(barometer) => set({ barometer })} />
          <p className={hint}>Pressure reference uses the ambient altitude and air temperature above.</p>
        </>}
        {group === 'gps' && settings.gps && <>
          <NumericFields group={group} value={settings.gps} fields={gpsFields} spec={gpsSpec} onChange={(gps) => set({ gps })} />
          <button type="button" className={action} title={GPS_DELAY_SUGGESTION.source}
            onClick={() => set({ gps: { ...settings.gps, delayMs: GPS_DELAY_SUGGESTION.value } })}>
            {GPS_DELAY_SUGGESTION.label} · {GPS_DELAY_SUGGESTION.value} {GPS_DELAY_SUGGESTION.unit}
          </button>
        </>}
      </div>
    })}
  </>
}
