import type { FlightMetric, FlightMetricGroup } from '../../../domain/flight-metrics'
import { ReportTable, quantity, reportNumber } from './ReportFacts'

const groups: FlightMetricGroup[] = ['Flight', 'Tracking', 'Motors', 'Power', 'Air', 'Landing']
const motorColumns = ['mean', 'max', '0', '1'] as const

function MotorMetrics({ metrics }: { metrics: FlightMetric[] }) {
  const rows = new Map<string, Partial<Record<typeof motorColumns[number], number>>>()
  for (const { motor, result } of metrics) {
    if (!motor || !('value' in result)) continue
    const cells = rows.get(motor.label) ?? {}
    cells[motor.column] = result.value
    rows.set(motor.label, cells)
  }
  if (!rows.size) return null
  // flight-metrics.ts computes these from motor commands; timing uses adjacent valid pairs.
  return <>
    <ReportTable title="Motor commands" columns={['Motor', 'Mean', 'Max', 'Time at 0 (s)', 'Time at 1 (s)']}
      rows={Array.from(rows, ([label, cells]) => [label, ...motorColumns.map((column) => {
        const value = cells[column]
        return value === undefined ? '—' : reportNumber(value)
      })])} />
    <p className="report-muted">Mean and max use the recorded normalized motor commands.
      Time at 0 and 1 counts intervals whose first command equals that endpoint, using pairs with valid commands at both ends.</p>
  </>
}

export function ReportMetrics({ metrics }: { metrics: FlightMetric[] }) {
  return groups.map((group) => {
    const members = metrics.filter((metric) => metric.group === group)
    if (!members.length) return null
    const unavailable = new Map<string, string[]>()
    for (const { name, result } of members) {
      if ('reason' in result) {
        const names = unavailable.get(result.reason) ?? []
        names.push(name)
        unavailable.set(result.reason, names)
      }
    }
    return <section key={group} aria-label={group}>
      <h3>{group}</h3>
      {group === 'Motors' && <MotorMetrics metrics={members} />}
      <dl className="report-metrics">
        {members.map(({ id, name, result, unit, definition, motor }) => !motor && 'value' in result && (
          <div key={id}>
            <dt>{name}</dt>
            <dd className="num">{unit === '1' ? reportNumber(result.value) : quantity(result.value, unit)}</dd>
            <dd className="report-definition report-muted">{definition}</dd>
          </div>
        ))}
      </dl>
      {Array.from(unavailable, ([reason, names]) =>
        <p key={reason} className="report-muted">Not available: {reason}. {names.join(', ')}.</p>)}
    </section>
  })
}
