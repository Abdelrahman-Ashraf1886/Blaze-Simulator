import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { stickNames } from './calibration'
import type { CalibrationDraft } from './calibration-draft'
import { gamepads } from './device-input'
import { PLAYSTATION_AXES } from './playstation'
import { createGuidedCapture, type StickMode } from './playstation-capture'

type Capture = ReturnType<typeof createGuidedCapture>
type Result = NonNullable<ReturnType<Capture['finish']>>

export function PlayStationSetup({ connection, disabled, onCapture, onDeadZones }: {
  connection: number
  disabled: boolean
  onCapture: (draft: CalibrationDraft) => void
  onDeadZones: (result: Result) => void
}) {
  const [mode, setMode] = useState<StickMode | ''>('')
  const [step, setStep] = useState<'choose' | 'range' | 'release' | 'rest' | 'result'>('choose')
  const [result, setResult] = useState<Result | null>(null)
  const capture = useRef<Capture | null>(null)

  useEffect(() => gamepads.subscribe(() => {
    const sample = gamepads.getDevices().find((item) => item.connection === connection)
    if (sample?.mapping === 'standard') capture.current?.add(sample)
    else if (capture.current) {
      capture.current = null
      setStep('choose')
    }
  }), [connection])

  function advance() {
    const sample = gamepads.getDevices().find((item) => item.connection === connection && item.mapping === 'standard')
    if (!sample) return
    if (step === 'choose' || step === 'result') {
      if (!mode) return
      capture.current = createGuidedCapture(sample, mode)
      setResult(null)
      setStep('range')
    } else if (step === 'range') {
      capture.current?.finishRange(sample)
      setStep('release')
    } else if (step === 'release') {
      capture.current?.startRest(sample)
      setStep('rest')
    } else {
      const measured = capture.current?.finish(sample)
      if (!measured) return
      capture.current = null
      setResult(measured)
      onCapture(measured.draft)
      setStep('result')
    }
  }

  const choosing = step === 'choose' || step === 'result'
  return (
    <div className="mb-3 space-y-2">
      <label className="flex flex-wrap items-center gap-2">
        PlayStation stick mode
        <select className="rounded-sm border border-line-strong bg-chrome px-2" value={mode}
          disabled={!choosing || disabled} onChange={(event) => setMode(event.target.value as StickMode | '')}>
          <option value="">Choose a mode</option>
          <option value="1">Mode 1 · Left stick (yaw + forward), right stick (right + throttle)</option>
          <option value="2">Mode 2 · Left stick (yaw + throttle), right stick (right + forward)</option>
          <option value="3">Mode 3 · Left stick (right + forward), right stick (yaw + throttle)</option>
          <option value="4">Mode 4 · Left stick (right + throttle), right stick (yaw + forward)</option>
        </select>
      </label>
      {step === 'range' && <p role="status">Move both sticks around their full range.</p>}
      {step === 'release' && <p role="status">Release both sticks before measuring their centres.</p>}
      {step === 'rest' && <p role="status">Keep both sticks released while measuring rest spread.</p>}
      <Button type="button" disabled={disabled || !mode} onClick={advance}>
        {choosing ? 'Start guided setup' : step === 'range' ? 'Finish range'
          : step === 'release' ? 'Start rest measurement' : 'Finish rest measurement'}
      </Button>
      {!choosing && <Button type="button" onClick={() => { capture.current = null; setStep('choose') }}>Cancel</Button>}
      {result && (
        <div className="space-y-1">
          <p>Measured rest spread (maximum distance from centre)</p>
          <ul className="flex flex-wrap gap-x-3">
            {stickNames.map((stick) => {
              const axis = result.draft[stick].axis
              return <li key={stick}>{axis === null ? stick : PLAYSTATION_AXES[axis]}: {result.spreads[stick]?.toPrecision(4) ?? 'Unavailable'}</li>
            })}
          </ul>
          <Button type="button" disabled={disabled} onClick={() => onDeadZones(result)}>Use measured spread as dead zone</Button>
        </div>
      )}
    </div>
  )
}
