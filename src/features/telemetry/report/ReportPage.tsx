import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { recordingIdSchema } from '../../../../electron/ipc/schemas'
import { Button } from '@/components/ui/button'
import { readReport, type ReportData } from './report-data'
import { ReportBuild } from './ReportBuild'
import { ReportConditions, ReportModelLimits } from './ReportConditions'
import { Facts, Value, quantity, reportNumber } from './ReportFacts'
import { ReportGraphs } from './ReportGraphs'
import { ReportMetrics } from './ReportMetrics'
import './report.css'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="report-section" aria-label={title}><h2>{title}</h2>{children}</section>
}

function ReportController({ recorded }: { recorded: ReportData['recorded'] }) {
  const { config, controllerMode, gains, requestKind } = recorded
  if (!config) return recorded.startLine ? <p>The start request could not be interpreted.</p>
    : <Facts rows={[['Controller', undefined]]} />
  // engine.rs:573–607 resolves mixer overrides and defaults FlightLoop airmode to off.
  // engine.rs:645–658 resolves the thrust factor, defaulting to the linear model.
  // PX4 v1.13.3 lib/mixer_module/params.c:13–18 gives MC_AIRMODE's labels.
  const flightLoop = controllerMode?.startsWith('FlightLoop')
  const airmode = recorded.airmode ?? (flightLoop ? gains?.MC_AIRMODE ?? 0 : 'Does not apply')
  const mode = controllerMode?.replace('FlightLoop · ', 'Flight loop · ')
  const knownMode = requestKind !== 'flight' || mode === 'Attitude hold' ||
    ['rates', 'stabilized', 'altitude', 'position'].some((name) => mode === 'Flight loop · ' + name)
  return <>
    <Facts rows={[
      ['Mode at start', knownMode && mode ? mode : config.controller ?? 'Missing from request'],
      ['Airmode', airmode === 0 ? 'Disabled' : airmode === 1 ? 'Roll and pitch' : airmode === 2 ? 'Roll, pitch and yaw' : airmode],
      ['Thrust model factor', recorded.thrustFactor ?? (controllerMode ? '0 (linear)' : 'Unavailable')],
    ]} />
    <h3>Gain overrides</h3>
    {gains && Object.keys(gains).length ? <Facts rows={Object.entries(gains)} />
      : config.gains === undefined || gains ? <p className="report-muted">None</p> : <Value value={config.gains} />}
  </>
}

export function FlightReport({ data, actions }: { data: ReportData; actions?: ReactNode }) {
  const { summary, recorded, metrics, graphs, notices } = data
  const { header, end } = summary
  const scenarioReport = recorded.scenarioReport
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
        <ReportBuild recorded={recorded} />
      </Section>

      <Section title="Conditions">
        <ReportConditions recorded={recorded} />
      </Section>

      <Section title="Controller">
        <ReportController recorded={recorded} />
      </Section>

      <Section title="Graphs">
        <ReportGraphs channels={header?.channels ?? []} graphs={graphs} />
      </Section>

      <Section title="Metrics">
        <ReportMetrics metrics={metrics} />
      </Section>

      {header?.kind === 'scenario' && <Section title="Engine scenario report">
        {scenarioReport
          ? <>
            <Facts rows={[
              ['Scenario', scenarioReport.name], ['Result', scenarioReport.passed ? 'Passed' : 'Failed'],
              ['Checks passed', reportNumber(scenarioReport.checks.filter((check) => check.passed).length) +
                ' of ' + reportNumber(scenarioReport.checks.length)],
              ['Elapsed time', quantity(scenarioReport.elapsedS, 's')],
            ]} />
            <details className="report-screen-only"><summary>Engine response details</summary><Value value={scenarioReport} /></details>
          </>
          : <p>The engine’s scenario report was not recorded.</p>}
      </Section>}

      <Section title="Model limits">
        <ReportModelLimits recorded={recorded} />
      </Section>
      {(recorded.loadLine || recorded.startLine) && <details className="report-screen-only">
        <summary>Values as sent to the engine</summary>
        {recorded.loadLine && <><h3>Vehicle load request</h3><pre className="report-value num">{recorded.loadLine}</pre></>}
        {recorded.startLine && <><h3>Start request</h3><pre className="report-value num">{recorded.startLine}</pre></>}
      </details>}
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
