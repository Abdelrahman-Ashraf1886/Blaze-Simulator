import { useId, useState } from 'react'
import { EmptyState, Readout, Readouts, Section } from '@/components/section'
import { RECOMMENDED_STEP_METRICS_OPTIONS, stepMetrics, type ResponseStep, type StepMetricsOptions, type StepMetricsResult, type StepSample } from '@/domain/step-response'
import { responsePlot } from './response-plot'
import { ExactSignalsNotice } from './tuning-notice'
import { readNumber, tuningInputClass } from './tuning-values'

export interface StepResponsePanelProps {
  samples: readonly StepSample[]
  gyroSamples?: readonly StepSample[]
  sensorsOn?: boolean
  step: ResponseStep
  gainsUsed: Readonly<Record<string, number>>
  unit?: string
}

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

/** Fit the true response and the gyro overlay on the same rate axis. */
function gyroOverlay(plot: NonNullable<ReturnType<typeof responsePlot>>, samples?: readonly StepSample[]) {
  if (!samples?.length) return null
  let { low, high } = plot
  for (const { y } of samples) {
    low = Math.min(low, y)
    high = Math.max(high, y)
  }
  const span = high - low
  if (!Number.isFinite(span)) return null
  const y = (value: number) => span === 0 ? 50 : (high - value) / span * 100
  const x = (t: number) => plot.end === plot.start ? 50 : (t - plot.start) / (plot.end - plot.start) * 100
  const oldSpan = plot.high - plot.low
  const transform = span === 0 ? undefined : oldSpan === 0
    ? `translate(0 ${y(plot.high) - 50})`
    : `translate(0 ${y(plot.high)}) scale(1 ${oldSpan / span})`
  return { low, high, transform, points: samples.map((sample) => `${x(sample.t)},${y(sample.y)}`).join(' ') }
}

export function StepResponsePanel({ samples, gyroSamples, sensorsOn, step, gainsUsed, unit }: StepResponsePanelProps) {
  const thresholdErrorId = useId()
  const [edits, setEdits] = useState<Partial<Record<keyof StepMetricsOptions, string>>>({})
  const options: Record<keyof StepMetricsOptions, number> = { ...RECOMMENDED_STEP_METRICS_OPTIONS }
  for (const key of thresholdKeys) {
    const edit = edits[key]
    if (edit !== undefined) options[key] = readNumber(edit)
  }
  const plot = responsePlot(samples, step)
  const gyro = plot && gyroOverlay(plot, gyroSamples)
  const bounds = gyro ?? plot
  const metrics = stepMetrics(samples, step, options)
  const invalidThresholds = thresholdKeys.some((key) => !Number.isFinite(options[key])) || metrics.status === 'invalid-options'

  return (
    <div className="space-y-3">
      <Section title="Step response">
        {!sensorsOn && <ExactSignalsNotice />}
        {samples.length === 0 ? <EmptyState>No step-response samples.</EmptyState> : plot && bounds && (
          <figure className="border-t border-line py-2">
            <figcaption className="mb-2 flex flex-wrap gap-4 text-[12.5px]">
              <span className="text-setpoint">Setpoint</span><span>State{unit && ` (${unit})`}</span>
              {gyro && <span className="text-accent">Filtered gyro used by rate loop</span>}
            </figcaption>
            <div className="flex items-stretch gap-2">
              <div aria-hidden className="num flex flex-col justify-between text-right text-fg-subtle">
                <span>{bounds.high}</span>{bounds.low !== bounds.high && <span>{bounds.low}</span>}
              </div>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible"
                className="h-40 min-w-0 flex-1 border-b border-l border-line-strong" role="img"
                aria-label={`${gyro ? 'Setpoint, state, and filtered gyro' : 'Setpoint and state'} from time ${plot.start} to ${plot.end}, signal extent ${bounds.low} to ${bounds.high}`}>
                <g transform={gyro?.transform}>
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
                </g>
                {gyro && <polyline data-testid="step-gyro-trace" points={gyro.points} fill="none" stroke="var(--color-accent)"
                  strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
              </svg>
            </div>
            <div className="num flex justify-between gap-2 text-fg-subtle">
              <span>{plot.start}</span><span>Time (s)</span>{plot.end !== plot.start && <span>{plot.end}</span>}
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
        {samples.length > 0 && !invalidThresholds && <ResponseMetrics metrics={metrics} unit={unit} />}
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

function ResponseMetrics({ metrics, unit }: { metrics: StepMetricsResult; unit?: string }) {
  if (metrics.status !== 'ok') return <EmptyState>{unavailableMessages[metrics.status]}</EmptyState>
  const { riseTime, peakTime, overshoot, settlingTime, steadyStateError } = metrics
  return (
    <Readouts>
      <Readout label="Rise time" {...(riseTime.status === 'reached' ? { value: riseTime.time, unit: 's' } : { value: 'Did not reach the rise thresholds', mono: false })} />
      <Readout label="Peak time" value={peakTime} unit="s" />
      <Readout label="Overshoot" {...(overshoot.status === 'overshoot' ? { value: overshoot.percent, unit: '%' } : { value: 'No overshoot', mono: false })} />
      <Readout label="Settling time" {...(settlingTime.status === 'settled' ? { value: settlingTime.time, unit: 's' } : { value: 'Did not settle', mono: false })} />
      <Readout label="Steady-state error" value={steadyStateError} unit={unit} />
    </Readouts>
  )
}
