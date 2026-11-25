import { z } from 'zod'
import { BodyDragSchema, MotorBodySchema, PropulsionDefinitionSchema } from '../../../../electron/main/engine/protocol'
import { convert, fromSI } from '../../../domain/units'
import type { ReportData } from './report-data'
import { Facts, ReportTable, quantity, reportNumber, vector } from './ReportFacts'

const motorsSchema = z.array(MotorBodySchema)
type Motors = z.infer<typeof motorsSchema>
type Propulsion = z.infer<typeof PropulsionDefinitionSchema>

function MotorsTable({ motors }: { motors: Motors }) {
  // protocol.ts:45–49 and vehicle.rs:98–107 describe the motor geometry.
  const tilted = motors.map(({ thrustAxis: [x, y, z] }) => x !== 0 || y !== 0 || z !== 1)
  const showAxis = tilted.includes(true)
  return <ReportTable title="Motors" columns={['Motor', 'X (mm)', 'Y (mm)', 'Z (mm)', 'Spin', ...(showAxis ? ['Thrust axis'] : [])]}
    rows={motors.map(({ position, spin, thrustAxis }, index) => [
      String(index + 1), ...position.map((m) => reportNumber(convert(m, 'm', 'mm'))),
      spin === 'cw' ? 'Clockwise' : 'Counterclockwise', ...(showAxis ? [tilted[index] ? vector(thrustAxis) : ''] : []),
    ])} />
}

function motorLabel(numbers: number[]) {
  const ranges: string[] = []
  const ordered = [...numbers].sort((a, b) => a - b)
  for (let index = 0; index < ordered.length; index++) {
    const first = ordered[index]!
    let last = first
    while (ordered[index + 1] === last + 1) last = ordered[++index]!
    ranges.push(first === last ? String(first) : first + '-' + last)
  }
  return (numbers.length === 1 ? 'Motor ' : 'Motors ') + ranges.join(', ')
}

function PropulsionTable({ propulsion, motors }: { propulsion: Propulsion; motors: Motors | undefined }) {
  // propulsion.rs:38–62 identifies motors by part ID and gives the coefficient units.
  const groups = new Map<string, { settings: Omit<Propulsion['motors'][number], 'partId'>; numbers: number[] }>()
  const motorNumbers = new Map(motors?.map(({ partId }, i) => [partId, i + 1]))
  for (const { partId, ...settings } of propulsion.motors) {
    const number = motorNumbers.get(partId)
    if (number === undefined) return <Facts rows={[['Propulsion', propulsion]]} />
    const key = JSON.stringify(settings)
    const group = groups.get(key)
    if (group) group.numbers.push(number)
    else groups.set(key, { settings, numbers: [number] })
  }
  const columns = Array.from(groups.values(), ({ numbers, settings: m }) => [
    motorLabel(numbers), reportNumber(fromSI(m.kvRadPerSV, 'rpm/V')), reportNumber(m.resistanceOhm),
    reportNumber(m.noLoadCurrentA), reportNumber(m.thrustCoefNs2), reportNumber(m.torqueCoefNms2),
    reportNumber(m.inertiaKgM2), reportNumber(m.referenceDensityKgM3),
    m.throttleMap ? 'Measured points: ' + m.throttleMap.map(([throttle, duty]) =>
      quantity(fromSI(throttle, '%'), '%') + ' → ' + quantity(fromSI(duty, '%'), '%')).join(', ')
      : 'No measured map recorded (ideal ESC)',
  ])
  // One column per group of identical motors, so a page is never as wide as the list of properties.
  return <ReportTable title="Propulsion" columns={['Property', ...columns.map(([label]) => label!)]} rows={[
    'kV (rpm/V)', 'Resistance (Ω)', 'No-load current (A)', 'Thrust coefficient (N·s²)', 'Torque coefficient (N·m·s²)',
    'Inertia (kg·m²)', 'Reference density (kg/m³)', 'Throttle map',
  ].map((property, index) => [property, ...columns.map((cells) => cells[index + 1]!)])} />
}

export function ReportBuild({ recorded }: { recorded: ReportData['recorded'] }) {
  const { vehicle, propulsion, aero, loadMissing } = recorded
  if (loadMissing) return <Facts rows={[['Vehicle load', recorded.loadLine || undefined]]} />
  const motors = motorsSchema.safeParse(vehicle?.motors).data
  const drive = PropulsionDefinitionSchema.safeParse(propulsion).data
  const drag = BodyDragSchema.safeParse(aero).data
  // propulsion.rs:67–71 uses coulombs here. units.ts:91–94 uses C for C-rate,
  // so convert the SI charge directly to mAh.
  return <>
    <Facts rows={vehicle
      ? [['Vehicle mass (kg)', vehicle.totalMassKg === undefined ? 'Missing from request' : vehicle.totalMassKg]]
      : [['Vehicle', recorded.vehicleValue === undefined ? 'Missing from request' : recorded.vehicleValue]]} />
    {motors ? <MotorsTable motors={motors} /> : vehicle && <Facts rows={[
      ['Motors', vehicle.motors === undefined ? 'Missing from request' : vehicle.motors],
    ]} />}
    {drive ? <>
      <PropulsionTable propulsion={drive} motors={motors} />
      <h3>Battery</h3>
      <Facts rows={[
        ['Open-circuit voltage', quantity(drive.battery.openCircuitVoltageV, 'V')],
        ['Internal resistance', quantity(drive.battery.internalResistanceOhm, 'Ω')],
        ['Capacity', quantity(fromSI(drive.battery.capacityC, 'mAh'), 'mAh') + ' (' + quantity(drive.battery.capacityC, 'C') + ')'],
      ]} />
    </> : <Facts rows={[['Propulsion', propulsion === undefined ? 'None' : propulsion]]} />}
    {drag ? <ReportTable title="Body drag" columns={['Body axis', 'Cd', 'Area (cm²)']}
      rows={(['X', 'Y', 'Z'] as const).map((axis, i) => [
        axis, reportNumber(drag.cdBody[i]!),
        // units.ts:75–78 gives the linear conversion. Apply it to both dimensions of area.
        reportNumber(drag.areaM2[i]! * convert(1, 'm', 'cm') ** 2),
      ])} /> : <Facts rows={[['Body drag', aero === undefined ? 'None' : aero]]} />}
  </>
}

