import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { recordingIdSchema } from '../../../../electron/ipc/schemas'
import { Button } from '@/components/ui/button'
import { readReport, type ReportData } from './report-data'
import { ReportGraphs, reportNumber } from './ReportGraphs'
import './report.css'

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="report-muted">Not recorded</span>
  return typeof value === 'object' && value !== null
    ? <pre className="report-value num">{JSON.stringify(value, null, 2)}</pre>
    : <span className={typeof value === 'number' ? 'num' : undefined}>{String(value)}</span>
}

function Facts({ rows }: { rows: [string, unknown][] }) {
  return (
    <dl className="report-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="report-muted">{label}</dt><dd><Value value={value} /></dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="report-section" aria-label={title}><h2>{title}</h2>{children}</section>
}

export function FlightReport({ data, actions }: { data: ReportData; actions?: ReactNode }) {
  const { summary, recorded, metrics, graphs, notices } = data
  const { header, end } = summary
  const config = recorded.config
  return (
    <article className="flight-report" data-selectable>
      <header className="report-heading">
        <h1>{header?.title || 'Flight report'}</h1>
        {actions}
      </header>
      <Facts rows={[
        ['Project', header?.projectName], ['Recorded at', header?.startedAt], ['Kind', header?.kind],
        ['App version', header?.appVersion], ['Engine version', header?.engineVersion],
        ['End reason', end?.reason], ['Final state hash', end?.finalStateHash ?? undefined],
      ]} />
      {summary.incomplete && <p role="status" className="report-warning">This recording is incomplete. Only the saved data is shown.</p>}
      {summary.integrityError && <p role="alert" className="report-warning">Recording is damaged. {summary.integrityError}</p>}
      {end?.engineError && <p role="alert" className="report-warning">{end.engineError}</p>}
      {!header && <p className="report-warning">The recording header is unavailable.</p>}
      {header && (recorded.loadMissing || recorded.startMissing) &&
        <p className="report-warning">Some engine request details could not be read from the recording.</p>}
      {notices.map((notice) => <p key={notice} role="status" className="report-warning">{notice}</p>)}
      <p className="report-muted">Build, conditions and controller settings come from the requests sent to the engine when this run was recorded. Metrics and graphs use the saved samples.</p>

      <Section title="Build">
        <Facts rows={[
          ['Vehicle mass (kg)', recorded.vehicle?.totalMassKg], ['Motors', recorded.vehicle?.motors],
          ['Propulsion', recorded.propulsion], ['Body drag', recorded.aero],
        ]} />
      </Section>

      <Section title="Conditions">
        <Facts rows={[
          ['Air density (kg/m³)', config?.airDensityKgM3], ['Battery cut-off', config?.cutoff],
          ['Environment', recorded.environment], ['Start position (m)', config?.startPositionM],
          ['Start clearance (m)', config?.startClearanceM], ['Wind', config?.wind],
          ['Ground-effect rotor radii (m)', config?.groundEffect], ['Turbulence seed', recorded.turbulence?.seed],
          ['Sensors', recorded.sensors],
          ...(header?.kind === 'scenario' ? [['Scenario request', recorded.scenarioRequest] as [string, unknown]] : []),
          ...(header?.kind === 'step-test' ? [['Step test request', recorded.test] as [string, unknown]] : []),
        ]} />
      </Section>

      <Section title="Controller">
        <Facts rows={[
          ['Mode at start', recorded.controllerMode], ['Airmode', recorded.airmode], ['Thrust model factor', recorded.thrustFactor],
        ]} />
        <h3>Gain overrides</h3>
        {recorded.gains && Object.keys(recorded.gains).length
          ? <Facts rows={Object.entries(recorded.gains)} />
          : <p className="report-muted">No gain overrides recorded.</p>}
      </Section>

      <Section title="Graphs">
        <ReportGraphs channels={header?.channels ?? []} graphs={graphs} />
      </Section>

      <Section title="Metrics">
        <dl className="report-metrics">
          {metrics.map(({ id, name, result, definition, unit }) => (
            <div key={id}>
              <dt>{name}</dt>
              <dd className={'value' in result ? 'num' : 'report-muted'}>
                {'value' in result ? reportNumber(result.value) + (unit === '1' ? '' : ' ' + unit) : 'Not available: ' + result.reason}
              </dd>
              <dd className="report-definition report-muted">{definition}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {header?.kind === 'scenario' && <Section title="Engine scenario report">
        {recorded.scenarioReport
          ? <Value value={recorded.scenarioReport} />
          : <p>The engine’s scenario report was not recorded.</p>}
      </Section>}

      <Section title="Model limits">
        <ul>
          {/* ADR 0010:11–17 and ADR 0009:20–24,30–37. Vibration: phase 7 plan:152–154. */}
          {recorded.wind && <li>Wind acts directly on body drag only. The model omits rotor inflow and rotor drag from wind.</li>}
          {Array.isArray(config?.groundEffect) && config.groundEffect.length > 0 &&
            <li>Ground effect uses a single-rotor thrust correction independently at each rotor. Rotor interactions are omitted and the error for a multirotor is unknown.</li>}
          {recorded.turbulence?.kind === 'dryden' &&
            <li>Dryden turbulence uses a frozen field and needs mean wind. It does not apply to hovering flight.</li>}
          {recorded.sensors != null && recorded.sensors !== false
            ? <li>The sensor configuration shown above identifies the inputs sent for this run. Motor and propeller vibration is omitted, so the simulated response can look better than the real vehicle’s response.</li>
            : config && <li>The controller uses exact simulated state. Motor and propeller vibration is omitted, so the simulated response can look better than the real vehicle’s response.</li>}
          {!config && <li>The recorded start request is needed to identify which model limits apply.</li>}
        </ul>
      </Section>
    </article>
  )
}

function ReportRoute({ id }: { id: string }) {
  const [data, setData] = useState<ReportData>()
  const [error, setError] = useState<string>()
  const [printing, setPrinting] = useState(false)
  const [printStatus, setPrintStatus] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    const api = window.api?.recording
    if (api) {
      void readReport(api, id, controller.signal).then(setData, (failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }
    return () => controller.abort()
  }, [id])

  async function savePdf() {
    setPrinting(true)
    setPrintStatus(undefined)
    try {
      const api = window.api?.recording
      if (!api) return
      const result = await api.printReportPdf()
      if (!result.ok) setPrintStatus(result.error.message)
      else if (result.data) setPrintStatus('PDF saved.')
    } catch {
      setPrintStatus('Could not save the PDF.')
    } finally {
      setPrinting(false)
    }
  }

  if (data) return <FlightReport data={data} actions={
    <div className="report-actions">
      <Link className="text-accent" to="/telemetry">Telemetry</Link>
      <Button variant="primary" disabled={printing} onClick={() => { void savePdf() }}>
        {printing ? 'Saving PDF…' : 'Save as PDF'}
      </Button>
      {printStatus && <span role="status">{printStatus}</span>}
    </div>
  } />
  return (
    <div className="px-6 pt-5">
      <Link className="text-accent" to="/telemetry">Telemetry</Link>
      <p role={error ? 'alert' : 'status'}>{error ?? (window.api?.recording ? 'Loading report…' : 'Recording API is unavailable.')}</p>
    </div>
  )
}

export default function ReportPage() {
  const { id } = useParams()
  return id && recordingIdSchema.safeParse({ id }).success ? <ReportRoute key={id} id={id} /> : (
    <p role="alert" className="px-6 pt-5">This report link has an invalid recording ID.</p>
  )
}
