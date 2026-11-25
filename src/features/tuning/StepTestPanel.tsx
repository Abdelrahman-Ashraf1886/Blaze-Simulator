import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/section'
import type { TuningOverrides } from '@/domain/controller-params'
import { readRecordRuns } from '@/lib/prefs'
import { getApi } from '@/services/api'
import type { FlightSensorsDoc, StepTestInput, StepTestOutput } from '../../../electron/ipc/contract'
import type { FlightGate } from '../flight/readiness'
import { SensorNotice } from '../flight/sensors/SensorSection'
import { StepResponsePanel } from './StepResponsePanel'
import { EMPTY_STEP_TEST, gyroRateSamples, measuredSamples, readStepTest, STEP_CHOICES, stepTestInput, type StepTestDraft, type StepTestErrors } from './step-test-input'
import { tuningInputClass } from './tuning-values'

const fields = {
  amplitude: 'Amplitude',
  holdS: 'Hold (s)',
  durationS: 'Duration (s, including hold)',
  decimationSteps: 'Decimation (simulation steps per sample)',
}
const fieldNames = Object.keys(fields) as (keyof typeof fields)[]

type RunState =
  | { status: 'running' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: StepTestOutput; step: StepTestInput['test']['step']; label: string; unit: string; sensorMode?: FlightSensorsDoc['mode'] }

export function StepTestPanel({ projectId, gate, engineReady, saved, dirty, pending, sensorMode }: {
  projectId: string
  gate: FlightGate; engineReady: boolean; saved: TuningOverrides | null; dirty: boolean; pending: boolean
  sensorMode?: FlightSensorsDoc['mode']
}) {
  const [draft, setDraft] = useState<StepTestDraft>(EMPTY_STEP_TEST)
  const [submitted, setSubmitted] = useState(false)
  const [run, setRun] = useState<RunState | null>(null)
  const alive = useRef(false)
  const running = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const { test, errors } = readStepTest(draft)
  const input = stepTestInput(gate, test, saved)
  const choice = STEP_CHOICES.find(({ label }) => label === draft.step)
  const disabled = !gate.ok || !engineReady || saved === null || pending || run?.status === 'running'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(true)
    if (disabled || !input || !choice || running.current) return

    running.current = true
    setRun({ status: 'running' })
    try {
      const reply = await getApi().engine.stepTest(readRecordRuns()
        ? { ...input, recording: { projectId, title: choice.label } }
        : input)
      if (!alive.current) return
      setRun(reply.ok
        ? { status: 'done', result: reply.data, step: input.test.step, label: choice.label, unit: choice.unit, sensorMode }
        : { status: 'error', message: reply.error.message })
    } catch (error) {
      if (alive.current) setRun({ status: 'error', message: (error as Error).message })
    } finally {
      running.current = false
    }
  }

  return (
    <div className="space-y-3">
      <Section title="Step test">
        <SensorNotice mode={sensorMode} />
        {(!sensorMode || sensorMode === 'off') && <p className="py-2 text-[12.5px] text-fg-muted">Rate loop uses true rates.</p>}
        <StepTestForm draft={draft} errors={submitted ? errors : {}} disabled={disabled} running={run?.status === 'running'}
          dirty={dirty} onSubmit={(event) => void submit(event)} onChange={(name, value) => setDraft((d) => ({ ...d, [name]: value }))} />
      </Section>
      {run?.status === 'error' && <p role="alert" className="text-fault">Engine: {run.message}</p>}
      {run?.status === 'done' && <>
        {run.result.recordingError && <p role="alert" className="text-fault">Recording stopped: {run.result.recordingError}</p>}
        {run.sensorMode !== sensorMode && <SensorNotice mode={run.sensorMode} />}
        <StepTestResult result={run.result} step={run.step} label={run.label} unit={run.unit} sensorMode={run.sensorMode} />
      </>}
    </div>
  )
}

export function StepTestForm({ draft, errors, disabled, running, dirty, onSubmit, onChange }: {
  draft: StepTestDraft; errors: StepTestErrors; disabled: boolean; running: boolean; dirty: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onChange: (name: keyof StepTestDraft, value: string) => void
}) {
  const id = useId()
  const unit = STEP_CHOICES.find(({ label }) => label === draft.step)?.unit
  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-line py-2 text-[12.5px]">
      {/* step_test.rs:245–261, flight_loop.rs:235–253 and hover_thrust.rs:178–209. */}
      <p className="text-fg-muted">Step tests run in free space with perfect state for control outside the rate loop. The hover-thrust estimator runs from the start, and its estimate is valid only after at least 2 s. Vertical steps use MPC_THR_HOVER until then, and always when MPC_USE_HTE is 0. Allow a long enough hold.</p>
      <label htmlFor={`${id}-step`} className="block text-fg-muted">Step</label>
      <select id={`${id}-step`} className="h-7 w-full rounded-sm border border-line-strong bg-chrome px-2"
        value={draft.step} disabled={running} aria-invalid={Boolean(errors.step)} aria-describedby={errors.step ? `${id}-step-error` : undefined}
        onChange={(event) => onChange('step', event.target.value)}>
        <option value="">Choose a step</option>
        {STEP_CHOICES.map(({ label }) => <option key={label} value={label}>{label}</option>)}
      </select>
      {errors.step && <p id={`${id}-step-error`} className="text-fault">{errors.step}</p>}
      <div className="grid gap-2 @min-[380px]:grid-cols-2">
        {fieldNames.map((name) => (
          <div key={name}>
            <label htmlFor={`${id}-${name}`} className="block text-fg-muted">
              {fields[name]}{name === 'amplitude' && unit && ` (${unit})`}
            </label>
            <input id={`${id}-${name}`} className={tuningInputClass}
              inputMode={name === 'decimationSteps' ? 'numeric' : 'decimal'} value={draft[name]} disabled={running}
              aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
              onChange={(event) => onChange(name, event.target.value)} />
            {errors[name] && <p id={`${id}-${name}-error`} className="text-fault">{errors[name]}</p>}
          </div>
        ))}
      </div>
      {dirty && <p className="text-warn" role="status">Unsaved gains. Step tests use the last saved gains.</p>}
      <Button type="submit" size="sm" variant="primary" disabled={disabled}>{running ? 'Running…' : 'Run step test'}</Button>
    </form>
  )
}

const endReasons = {
  voltageCutoff: 'Voltage cut-off',
  chargeCutoff: 'Charge cut-off',
  nonFinite: 'Non-finite state',
  error: 'Engine error',
} satisfies Record<Exclude<StepTestOutput['endReason'], 'duration'>, string>

export function StepTestResult({ result, step, label, unit, sensorMode }: {
  result: StepTestOutput; step: StepTestInput['test']['step']; label: string; unit: string; sensorMode?: FlightSensorsDoc['mode']
}) {
  const amplitude = 'amplitudeRadps' in step ? step.amplitudeRadps : 'amplitudeRad' in step ? step.amplitudeRad : step.amplitudeM
  const flewOnGyro = result.rateLoopFeedback?.some(({ fromGyro }) => fromGyro)
  return (
    <div className="space-y-2">
      <p className="text-[12.5px] text-fg-muted">{label} · <span className="num">{amplitude} {unit}</span></p>
      <p className="text-[12.5px] text-fg-muted">Rate loop used {flewOnGyro ? 'modelled gyro' : 'true rates'}.
        The measured response and metrics use the true motion.</p>
      {result.endReason !== 'duration' && <p role="status" className="text-warn">Run ended at {result.elapsedS} s · {endReasons[result.endReason]}</p>}
      {result.error && <p role="alert" className="text-fault">Engine: {result.error}</p>}
      <p className="text-[12.5px] text-fg-muted">Start imbalance (body X / Y / Z): <span className="num">{result.startImbalanceNm.join(' / ')} N·m.</span> The controller trims it during the hold.</p>
      {/* step_test.rs:178–198,261–276,316 records the zero-to-amplitude command at the engine's step time. */}
      <StepResponsePanel samples={measuredSamples(result.trace)} gyroSamples={gyroRateSamples(result, step)}
        sensorsOn={result.rateLoopFeedback !== undefined || (sensorMode !== undefined && sensorMode !== 'off')}
        step={{ t0: result.stepTimeS, y0: 0, y1: amplitude }} gainsUsed={result.gains} unit={unit} />
    </div>
  )
}
