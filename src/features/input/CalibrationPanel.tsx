import { useEffect, useId, useRef, useState } from 'react'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/field'
import { readInputCalibration, writeInputCalibration } from '@/lib/prefs'
import { isAxisSample, readStick, STANDARD_AXES, STICKS, stickNames, type Stick } from './calibration'
import { checkAxis, createAxisSweep, createDraft } from './calibration-draft'
import { gamepads } from './device-input'
import type { InputDevice } from './gamepads'

const selectClass = 'h-8 w-full rounded-[var(--radius-sm)] border border-line-strong bg-chrome px-2 text-fg focus:border-accent focus:outline-none aria-invalid:border-fault'

export function CalibrationPanel({ device }: { device: InputDevice }) {
  const [stored, setStored] = useState(() => readInputCalibration(device.id))
  const incompatible = stored.status === 'saved' && stickNames.some((stick) => stored.calibration[stick].axis >= device.axes.length)
  const [draft, setDraft] = useState(() => createDraft(stored.status === 'saved' && !incompatible ? stored.calibration : undefined))
  const [attempted, setAttempted] = useState(false)
  const [saveMessage, setSaveMessage] = useState<'saved' | 'failed' | null>(null)
  const [sweeping, setSweeping] = useState<Stick | null>(null)
  const sweepRef = useRef<ReturnType<typeof createAxisSweep> | null>(null)
  const prefix = useId()
  const { connection } = device
  const currentDevice = () => gamepads.getDevices().find((sample) => sample.connection === connection)

  useEffect(() => {
    if (!sweeping) return
    return gamepads.subscribe(() => {
      const sample = gamepads.getDevices().find((item) => item.connection === connection)
      if (sample) sweepRef.current?.add(sample)
    })
  }, [connection, sweeping])

  function change(stick: Stick, changes: Partial<(typeof draft)[Stick]>) {
    setSaveMessage(null)
    setDraft((previous) => ({ ...previous, [stick]: { ...previous[stick], ...changes } }))
  }

  function applyPreset() {
    setSaveMessage(null)
    setDraft((previous) => {
      const next = { ...previous }
      const empty = createDraft()
      for (const stick of stickNames) {
        const axis = STANDARD_AXES[stick]
        if (next[stick].axis !== axis) next[stick] = { ...empty[stick], axis }
      }
      return next
    })
  }

  function toggleSweep(stick: Stick, axis: number) {
    const sample = currentDevice()
    if (!sample) return
    if (sweeping === stick) {
      sweepRef.current?.add(sample)
      change(stick, { range: sweepRef.current?.finish() ?? null, trim: null })
      sweepRef.current = null
      setSweeping(null)
    } else {
      const sweep = createAxisSweep(sample, axis)
      sweep.add(sample)
      sweepRef.current = sweep
      setSweeping(stick)
      setSaveMessage(null)
    }
  }

  const checked = {
    forward: checkAxis(draft, 'forward', device.axes.length),
    right: checkAxis(draft, 'right', device.axes.length),
    yawRight: checkAxis(draft, 'yawRight', device.axes.length),
    throttle: checkAxis(draft, 'throttle', device.axes.length),
  }

  function save() {
    setAttempted(true)
    setSaveMessage(null)
    const { forward, right, yawRight, throttle } = checked
    if (!currentDevice() || !forward.binding || !right.binding || !yawRight.binding || !throttle.binding) return
    const calibration = { forward: forward.binding, right: right.binding, yawRight: yawRight.binding, throttle: throttle.binding }
    if (writeInputCalibration(device.id, calibration)) {
      setStored({ status: 'saved', calibration })
      setSaveMessage('saved')
    } else {
      setSaveMessage('failed')
    }
  }

  return (
    <Section title="Calibration" className="border-t border-line pt-3 @min-[880px]:border-t-0 @min-[880px]:pt-0">
      <p className="mb-3 text-fg-muted">Choose an axis for each stick. Start a sweep, move to both ends, then finish the sweep. Set trim and check the live preview.</p>
      {stored.status === 'invalid' && <p role="status" className="mb-3 text-warn">Saved calibration is invalid and was ignored.</p>}
      {stored.status === 'unavailable' && <p role="status" className="mb-3 text-warn">Saved calibration could not be read.</p>}
      {incompatible && <p role="status" className="mb-3 text-warn">Saved calibration uses unavailable axes and was ignored.</p>}
      {device.mapping === 'standard' && (
        <div className="mb-3">
          <Button type="button" disabled={sweeping !== null || stickNames.some((stick) => STANDARD_AXES[stick] >= device.axes.length)} onClick={applyPreset}>
            Use standard gamepad preset
          </Button>
          <p className="mt-1 text-[12px] text-fg-muted">Left stick controls yaw and throttle. Right stick controls right and forward. Up and right read positive when reverse is off.</p>
        </div>
      )}
      <form noValidate onSubmit={(event) => { event.preventDefault(); save() }}>
        <div className="grid gap-x-5 @[560px]:grid-cols-2">
          {stickNames.map((stick) => {
            const { axis, range, trimMethod, deadZone, reverse } = draft[stick]
            const { binding, errors, trim } = checked[stick]
            const id = `${prefix}-${stick}`
            const showRangeError = attempted || range !== null
            const showTrimError = attempted || trim !== null || trimMethod === 'midpoint'
            const preview = binding ? readStick(device, binding) : null
            return (
              <fieldset key={stick} className="min-w-0 border-t border-line py-3" aria-labelledby={`${id}-title`}>
                <legend id={`${id}-title`} className="pr-2 font-semibold">{STICKS[stick]}</legend>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor={`${id}-axis`}>Axis</Label>
                    <select id={`${id}-axis`} className={selectClass} value={axis ?? ''} disabled={sweeping !== null}
                      aria-invalid={Boolean(errors.axis && (attempted || axis !== null))}
                      aria-describedby={`${id}-axis-error`}
                      onChange={(event) => change(stick, { ...createDraft()[stick], axis: event.target.value === '' ? null : Number(event.target.value) })}>
                      <option value="">Choose an axis</option>
                      {device.axes.map((_, index) => <option key={index} value={index}>Axis {index}</option>)}
                    </select>
                    <FieldError id={`${id}-axis-error`} message={attempted || axis !== null ? errors.axis : undefined} />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Button type="button" disabled={sweeping !== stick && (axis === null || Boolean(errors.axis) || sweeping !== null)}
                        aria-describedby={`${id}-range-error`} onClick={() => { if (axis !== null) toggleSweep(stick, axis) }}>
                        {sweeping === stick ? 'Finish sweep' : 'Start sweep'}
                      </Button>
                      <span className="text-[12px] text-fg-muted">Min <Reading value={range?.min} /> · Max <Reading value={range?.max} /></span>
                    </div>
                    {sweeping === stick && <p role="status" className="text-warn">Sweeping. Move the stick to both ends.</p>}
                    <FieldError id={`${id}-range-error`} message={showRangeError ? errors.range : undefined} />
                  </div>
                  <div>
                    {stick === 'throttle' && (
                      <>
                        <Label htmlFor={`${id}-trim-method`}>Does throttle self-centre?</Label>
                        <select id={`${id}-trim-method`} className={selectClass} value={trimMethod}
                          aria-invalid={showTrimError && Boolean(errors.trim)} aria-describedby={`${id}-trim-error`}
                          disabled={sweeping !== null}
                          onChange={(event) => {
                            const value = event.target.value
                            if (value === '' || value === 'centre' || value === 'midpoint') change(stick, { trimMethod: value, trim: null })
                          }}>
                          <option value="">{trimMethod === '' && trim !== null ? 'Keep saved trim' : 'Choose how to set trim'}</option>
                          <option value="centre">Yes, capture centre</option>
                          <option value="midpoint">No, use measured midpoint</option>
                        </select>
                      </>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {trimMethod === 'centre' && (
                        <Button type="button" disabled={sweeping !== null || !range || Boolean(errors.range || errors.axis)}
                          aria-describedby={`${id}-trim-error`} onClick={() => {
                            const sample = axis === null ? undefined : currentDevice()?.axes[axis]
                            change(stick, { trim: isAxisSample(sample) ? sample : null })
                          }}>Capture centre</Button>
                      )}
                      <span className="text-[12px] text-fg-muted">Trim <Reading value={trim} /></span>
                    </div>
                    <FieldError id={`${id}-trim-error`} message={showTrimError ? errors.trim : undefined} />
                  </div>
                  <div>
                    <Label htmlFor={`${id}-dead-zone`}>Dead zone (optional)</Label>
                    <Input id={`${id}-dead-zone`} className="num" inputMode="decimal" value={deadZone}
                      aria-invalid={Boolean(errors.deadZone)} aria-describedby={`${id}-dead-zone-error`}
                      onChange={(event) => change(stick, { deadZone: event.target.value })} />
                    <FieldError id={`${id}-dead-zone-error`} message={errors.deadZone} />
                  </div>
                  <label className="flex items-center gap-2 text-fg-muted">
                    <input className="accent-accent" type="checkbox" checked={reverse} onChange={(event) => change(stick, { reverse: event.target.checked })} />
                    Reverse
                  </label>
                  <p className="text-fg-muted">Live preview <Reading value={preview} /></p>
                </div>
              </fieldset>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <Button type="submit" variant="primary" disabled={sweeping !== null}>Save calibration</Button>
          {saveMessage === 'saved' && <p role="status" className="text-ok">Calibration saved.</p>}
          {saveMessage === 'failed' && <p role="status" className="text-fault">Calibration could not be saved.</p>}
        </div>
      </form>
    </Section>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return <p id={id} className="text-[12px] text-fault">{message}</p>
}

function Reading({ value }: { value?: number | null }) {
  return <span className="num text-fg">{value == null ? '—' : value.toFixed(3)}</span>
}
