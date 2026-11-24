import { Readout, Readouts, Section } from '@/components/section'
import { fromSI, toSI, type Unit } from '@/domain/units'
import type { MassProperties } from '@/domain/mass'
import type { AxisVector, FlightFrame } from './frame'
import type { Indicator } from './indicators'

const value = (n: number, unit: Unit, digits = 3) => fromSI(n, unit).toFixed(digits)
const vector = (v: readonly number[], unit: Unit) => v.map((n) => value(n, unit)).join(' / ')
const optionalValue = (n: number | null, unit: Unit) => n === null ? '—' : value(n, unit)
const optionalVector = (v: readonly (number | null)[], unit: Unit) => v.map((n) => optionalValue(n, unit)).join(' / ')
const axes = (v: AxisVector, unit: Unit) => vector([v.x, v.y, v.z], unit)
export const endReason = (ended: FlightFrame['ended']) => ended === 'voltageCutoff' ? 'Voltage cut-off' : ended === 'chargeCutoff' ? 'Charge cut-off' : null

function EnvironmentLoads({ loads }: { loads: NonNullable<FlightFrame['environmentLoads']> }) {
  const counts = { inactive: 0, applied: 0, invalidInput: 0, invalidWind: 0, nonFiniteThrust: 0 }
  let belowRange = 0
  for (const status of loads.groundEffectStatus) {
    counts[status.type]++
    if (status.type === 'applied' && status.belowTestedRange) belowRange++
  }
  return <Section title="Environment loads">
    <Readouts>
      <Readout label="Wind at CoM (world X / Y / Z)" value={vector(loads.windComWorldMps, 'm/s')} unit="m/s" />
      <Readout label="Ground-effect added thrust" value={value(loads.groundEffectAddedThrustN, 'N')} unit="N" />
      <Readout label="Ground-effect motors" value={loads.groundEffectStatus.length === 0 ? 'Off' :
        `${counts.applied} applied / ${counts.inactive} inactive / ${counts.invalidInput} invalid inputs / ${counts.invalidWind} invalid wind / ${counts.nonFiniteThrust} non-finite thrust`} />
    </Readouts>
    {loads.windAboveRange && <p className="text-warn">Above the shear model’s height range. The engine held wind at the top of the profile for this step.</p>}
    {loads.windInvalid && <p className="text-warn">A wind calculation failed this step. Wind drag or the gust’s progress may be affected.</p>}
    {(counts.invalidInput > 0 || counts.invalidWind > 0 || counts.nonFiniteThrust > 0) &&
      <p className="text-warn">The engine skipped ground-effect thrust on motors with an invalid calculation this step.</p>}
    {belowRange > 0 && <p className="text-warn">Ground effect was applied below the tested height range on {belowRange} {belowRange === 1 ? 'motor' : 'motors'}.</p>}
  </Section>
}

export function DebugPanel({ frame, mass, indicators, source = 'demo' }: { frame: FlightFrame; mass: MassProperties; indicators: Record<string, Indicator>; source?: 'demo' | 'live' }) {
  const loop = frame.flightLoop
  const saturation = loop?.saturation ?? frame.control?.saturation
  return (
    <div className="space-y-5 text-[12.5px] [&_dd]:break-words [&_dd]:!overflow-visible [&_dd]:!whitespace-normal" data-testid="flight-debug">
      <Section title="Physics debug">
        {source === 'demo' && <p className="mb-2 text-warn">Demo telemetry — scripted, not a flight prediction.</p>}
        <Readouts>
          <Readout label="Time" value={value(frame.timeS, 's')} unit="s" />
          <Readout label="End reason" value={endReason(frame.ended) ?? 'None'} mono={false} />
        </Readouts>
      </Section>
      <Section title="Indicators">
        <ul className="border-t border-line">
          {Object.entries(indicators).map(([name, indicator]) => (
            <li key={name} className="border-b border-line/60 py-2">
              <div className={indicator.state === 'warning' ? 'text-warn' : indicator.state === 'ok' ? 'text-ok' : 'text-fg-subtle'}>{name}: {indicator.state}</div>
              <p className="mt-1 text-fg-muted">{indicator.detail}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Current build mass">
        <p className="mb-2 text-fg-subtle">Body axes X / Y / Z. Shape-derived inertia assumes uniform solids; entered overrides are retained.</p>
        {mass.missingMass.length > 0 && <p className="mb-2 text-warn">Incomplete mass: {mass.missingMass.map((m) => m.name).join(', ')}. Flying requires every mass.</p>}
        <Readouts>
          <Readout label="Mass" value={value(mass.totalMassKg, 'g', 1)} unit="g" />
          <Readout label="CoM (body)" value={mass.com ? vector(mass.com, 'mm') : 'Unknown'} unit="mm" />
          <Readout label="Ixx / Iyy / Izz" value={mass.inertia ? mass.inertia.slice(0, 3).map((n) => fromSI(n, 'kg·m²').toPrecision(5)).join(' / ') : 'Unknown'} unit="kg·m²" />
          <Readout label="Ixy / Ixz / Iyz" value={mass.inertia ? mass.inertia.slice(3).map((n) => fromSI(n, 'kg·m²').toPrecision(5)).join(' / ') : 'Unknown'} unit="kg·m²" />
        </Readouts>
      </Section>
      <Section title="Pose and velocity">
        <Readouts>
          <Readout label="Origin (world)" value={vector(frame.positionM, 'm')} unit="m" />
          <Readout label="CoM (world)" value={vector(frame.comM, 'm')} unit="m" />
          <Readout label="Quaternion x/y/z/w" value={vector(frame.quaternion, '1')} />
          <Readout label="Linear (world)" value={vector(frame.linearVelocityMps, 'm/s')} unit="m/s" />
          <Readout label="Angular (body)" value={vector(frame.angularVelocityBodyRadps, 'deg/s')} unit="deg/s" />
        </Readouts>
      </Section>
      <Section title="Thrust and forces">
        <Readouts>
          <Readout label="Total thrust" value={value(frame.totalThrustN, 'N')} unit="N" />
          <Readout label="Thrust X / Y / Z" value={axes(frame.thrustBodyN, 'N')} unit="N" />
          <Readout label="Drag X / Y / Z" value={axes(frame.dragBodyN, 'N')} unit="N" />
        </Readouts>
        {frame.motors.map((motor, i) => (
          <div key={i} className="mt-2">
            <h3 className="py-1 font-medium">Motor {i + 1}</h3>
            <Readouts>
              <Readout label="Throttle" value={value(motor.throttle, '%', 1)} unit="%" />
              <Readout label="Speed" value={value(motor.omegaRadps, 'rpm', 1)} unit="rpm" />
              <Readout label="Thrust" value={value(motor.thrustN, 'N')} unit="N" />
              <Readout label="Drag torque (air)" value={value(motor.dragTorqueNm, 'N·m')} unit="N·m" />
            </Readouts>
          </div>
        ))}
      </Section>
      {frame.environmentLoads && <EnvironmentLoads loads={frame.environmentLoads} />}
      <Section title="Torque (body X / Y / Z)">
        <Readouts>
          {([['Arm', frame.armTorqueNm], ['Drag reaction', frame.dragReactionTorqueNm], ['Spin-up reaction', frame.spinUpReactionTorqueNm], ['Rotor gyro', frame.rotorGyroTorqueNm], ['Total', frame.totalTorqueNm]] as const).map(([label, v]) => (
            <Readout key={label} label={label} value={axes(v, 'N·m')} unit="N·m" />
          ))}
          <Readout label="Control demand" value={frame.control ? vector(frame.control.torqueDemand, 'N·m') : 'Unavailable'} unit="N·m" />
          <Readout label="Rate integral" value={frame.control ? vector(frame.control.rateIntegral, 'N·m') : 'Unavailable'} unit="N·m" />
          <Readout label="Saturation + / −" value={saturation ? `${saturation.positive.map(Number).join(' ')} / ${saturation.negative.map(Number).join(' ')}` : 'Unavailable'} />
        </Readouts>
      </Section>
      {loop && <Section title="PX4 controller">
        <p className="py-1 text-fg-muted">World X / Y / Z · — = inactive</p>
        <Readouts>
          <Readout label="Position setpoint" value={<span className="text-setpoint">{optionalVector(loop.positionSetpointM, 'm')}</span>} unit="m" />
          <Readout label="Velocity setpoint" value={<span className="text-setpoint">{optionalVector(loop.velocitySetpointMps, 'm/s')}</span>} unit="m/s" />
          <Readout label="Acceleration setpoint" value={<span className="text-setpoint">{optionalVector(loop.accelerationSetpointMps2, 'm/s²')}</span>} unit="m/s²" />
          <Readout label="Velocity integral" value={optionalVector(loop.velocityIntegral, 'm/s²')} unit="m/s²" />
          <Readout label="Hover thrust estimate" value={optionalValue(loop.hoverThrust.estimate, '%')} unit="%" />
          <Readout label="Hover thrust standard deviation" value={optionalValue(loop.hoverThrust.standardDeviation, '%')} unit="%" />
          <Readout label="Hover thrust validity" value={loop.hoverThrust.valid ? 'Valid' : 'Invalid'} />
        </Readouts>
      </Section>}
      <Section title="Battery and atmosphere">
        <Readouts>
          <Readout label="Pack voltage" value={value(frame.packVoltageV, 'V')} unit="V" />
          <Readout label="Pack current" value={value(frame.packCurrentA, 'A')} unit="A" />
          <Readout label="Charge used" value={value(toSI(frame.chargeUsedMah, 'mAh'), 'mAh')} unit="mAh" />
          <Readout label="Air density" value={value(frame.densityKgM3, 'kg/m³')} unit="kg/m³" />
        </Readouts>
      </Section>
      <Section title="Contacts" count={frame.contacts.length}>
        <ul className="border-t border-line">
          {frame.contacts.length === 0 && <li className="py-2 text-fg-subtle">No contacts.</li>}
          {frame.contacts.map((contact, i) => <li key={i} className="break-words border-b border-line/60 py-2">{contact.part} → {contact.object}<div className="num">{value(contact.startS, 's')} s → {contact.endS === null ? 'active' : `${value(contact.endS, 's')} s`}</div></li>)}
        </ul>
      </Section>
    </div>
  )
}
