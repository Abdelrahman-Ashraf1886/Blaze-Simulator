import { useId, useState, type CSSProperties } from 'react'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { RECOMMENDED_STEP_METRICS_OPTIONS, stepMetrics, type ResponseStep, type StepMetricsOptions, type StepMetricsResult, type StepSample } from '@/domain/step-response'
import { responsePlot } from './response-plot'
import { ExactSignalsNotice } from './tuning-notice'
import { readNumber, tuningInputClass } from './tuning-values'

export interface StepResponsePanelProps {
  samples: readonly StepSample[]
  step: ResponseStep
  gainsUsed: Readonly<Record<string, number>>
}

// documentation/DESIGN.md:18 assigns magenta to targets and setpoints.
const plotTheme = { '--color-setpoint': 'magenta' } as CSSProperties

const thresholdLabels = {
  riseLower: 'Rise lower fraction',
  riseUpper: 'Rise upper fraction',
  settlingBand: 'Settling band half-width fraction',
  steadyStateFraction: 'Final window fraction',
} satisfies Record<keyof StepMetricsOptions, string>
const thresholdKeys = Object.keys(thresholdLabels) as (keyof StepMetricsOptions)[]

const unavailableMessages = {
  'zero-step': 'The command has no step.',
  'too-few-samples': 'At least two samples are needed to calculate metrics.',
  'non-finite-input': 'Samples and step values must be finite.',
  'invalid-options': 'Use rise fractions with 0 ≤ lower < upper ≤ 1, a positive settling band, and a final window fraction greater than 0 and at most 1.',
  'invalid-times': 'Sample times must be strictly increasing.',
  'invalid-window': 'The sample window must cover the step and continue after it.',
  'numeric-overflow': 'The response exceeds the numeric range for these metrics.',
} satisfies Record<Exclude<StepMetricsResult['status'], 'ok'>, string>

export function StepResponsePanel({ samples, step, gainsUsed }: StepResponsePanelProps) {
  const thresholdErrorId = useId()
  const [edits, setEdits] = useState<Partial<Record<keyof StepMetricsOptions, string>>>({})
  const options: Record<keyof StepMetricsOptions, number> = { ...RECOMMENDED_STEP_METRICS_OPTIONS }
  for (const key of thresholdKeys) {
    const edit = edits[key]
    if (edit !== undefined) options[key] = readNumber(edit)
  }
  const plot = responsePlot(samples, step)
  const metrics = stepMetrics(samples, step, options)
  const invalidThresholds = thresholdKeys.some((key) => !Number.isFinite(options[key])) || metrics.status === 'invalid-options'

  return (
    <div className="space-y-3">
      <Section title="Step response">
        <ExactSignalsNotice />
        {samples.length === 0 ? <EmptyState>No step-response samples.</EmptyState> : plot && (
          <figure className="border-t border-line py-2" style={plotTheme}>
            <figcaption className="mb-2 flex gap-4 text-[12.5px]">
              <span className="text-[var(--color-setpoint)]">Setpoint</span><span>State</span>
            </figcaption>
            <div className="flex items-stretch gap-2">
              <div aria-hidden className="num flex flex-col justify-between text-right text-fg-subtle">
                <span>{plot.high}</span>{plot.low !== plot.high && <span>{plot.low}</span>}
              </div>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible"
                className="h-40 min-w-0 flex-1 border-b border-l border-line-strong" role="img"
                aria-label={`Setpoint and state from time ${plot.start} to ${plot.end}, signal extent ${plot.low} to ${plot.high}`}>
                {samples.length === 1 ? (
                  <>
                    <circle cx={plot.firstPoint.x} cy={plot.firstPoint.targetY} r="1" fill="var(--color-setpoint)" />
                    <circle cx={plot.firstPoint.x} cy={plot.firstPoint.y} r="1" fill="currentColor" />
                  </>
                ) : (
                  <>
                    <polyline points={plot.setpoint} fill="none" stroke="var(--color-setpoint)" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    <polyline points={plot.state} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
                  </>
                )}
              </svg>
            </div>
            <div className="num flex justify-between gap-2 text-fg-subtle">
              <span>{plot.start}</span><span>Time</span>{plot.end !== plot.start && <span>{plot.end}</span>}
            </div>
          </figure>
        )}
      </Section>
      <Section title="Metrics">
        <p className="border-t border-line py-2 text-[12.5px] text-fg-muted">
          Our metric conventions use the commanded step, the largest peak in the sample window, and the mean error over the final window.
        </p>
        <div className="grid gap-2 @min-[380px]:grid-cols-2">
          {thresholdKeys.map((key) => (
            <label key={key} className="text-[12.5px] text-fg-muted">
              {thresholdLabels[key]}
              <input className={tuningInputClass} inputMode="decimal" value={edits[key] ?? options[key]}
                aria-invalid={invalidThresholds} aria-describedby={invalidThresholds ? thresholdErrorId : undefined}
                onChange={(event) => setEdits((previous) => ({ ...previous, [key]: event.target.value }))} />
            </label>
          ))}
        </div>
        {invalidThresholds && <p id={thresholdErrorId} role="alert" className="py-2 text-[12.5px] text-fault">{unavailableMessages['invalid-options']}</p>}
        {samples.length > 0 && !invalidThresholds && <ResponseMetrics metrics={metrics} />}
      </Section>
      <Section title="Gains used">
        {Object.keys(gainsUsed).length === 0 ? <EmptyState>No gains supplied.</EmptyState> : (
          <Readouts>
            {Object.entries(gainsUsed).map(([name, value]) => <Readout key={name} label={name} value={value} />)}
          </Readouts>
        )}
      </Section>
    </div>
  )
}

function ResponseMetrics({ metrics }: { metrics: StepMetricsResult }) {
  if (metrics.status !== 'ok') return <EmptyState>{unavailableMessages[metrics.status]}</EmptyState>
  const { riseTime, peakTime, overshoot, settlingTime, steadyStateError } = metrics
  return (
    <Readouts>
      <Readout label="Rise time" {...(riseTime.status === 'reached' ? { value: riseTime.time } : { value: 'Did not reach the rise thresholds', mono: false })} />
      <Readout label="Peak time" value={peakTime} />
      <Readout label="Overshoot" {...(overshoot.status === 'overshoot' ? { value: overshoot.percent, unit: '%' } : { value: 'No overshoot', mono: false })} />
      <Readout label="Settling time" {...(settlingTime.status === 'settled' ? { value: settlingTime.time } : { value: 'Did not settle', mono: false })} />
      <Readout label="Steady-state error" value={steadyStateError} />
    </Readouts>
  )
}
