import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import type { DeviceHandle } from '../input/gamepads'
import { MIS_TAKEOFF_ALT_M, pauseLabels, takeoffCommand, type InputBlocker, type PauseReason } from './flight-controls'
import type { AutoCommand, FlightMode, Px4Sticks } from './frame'

export interface FlightInputOption extends DeviceHandle {
  calibrated: boolean
}

export function FlightInputSelector({ options, selected, locked, mode, onChange }: {
  options: readonly FlightInputOption[]
  selected: DeviceHandle | null
  locked: boolean
  mode: FlightMode
  onChange: (selected: FlightInputOption | null) => void
}) {
  const current = options.find(({ id, index }) => id === selected?.id && index === selected.index)
  const selectedValue = current ? String(current.connection) : selected ? 'disconnected' : 'keyboard'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">
        Input source
        <select data-testid="flight-input-source" className="h-7 max-w-64 rounded-sm border border-line-strong bg-chrome px-2"
          disabled={locked} value={selectedValue}
          onChange={(event) => onChange(options.find(({ connection }) => String(connection) === event.target.value) ?? null)}>
          <option value="keyboard">Keyboard</option>
          {options.map(({ connection, id, index, calibrated }) => (
            <option key={connection} value={connection}>{id} · Index {index}{calibrated ? '' : ' · Needs calibration'}</option>
          ))}
          {selected && !current && <option value="disconnected">{selected.id} · Disconnected</option>}
        </select>
      </label>
      {current && !current.calibrated && <Link className="text-accent" to="/input">Calibrate in Input devices</Link>}
      {mode === 'attitudeHold' && <span className="text-fg-muted">Attitude hold uses keyboard only. Choose a PX4 mode for a device.</span>}
    </div>
  )
}

export function StickReadout({ sticks }: { sticks: Px4Sticks | null }) {
  return <span className="num" data-testid="flight-device-sticks">{sticks
    ? `Forward ${sticks.forward} · right ${sticks.right} · yaw right ${sticks.yawRight} · throttle ${sticks.throttle}`
    : 'Live sticks unavailable'}</span>
}

export function FlightPauseControls({ paused, blocker, device, sticks, onToggle }: {
  paused: PauseReason | null
  blocker: InputBlocker | null
  device: boolean
  sticks: Px4Sticks | null
  onToggle: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" data-testid="flight-pause" disabled={paused !== null && blocker !== null} onClick={onToggle}>
        {paused ? 'Resume' : 'Pause'}
      </Button>
      {device && <StickReadout sticks={sticks} />}
      {paused && blocker && paused !== blocker && <span>{pauseLabels[blocker]}</span>}
    </div>
  )
}

export function FlightCommandControls({ command, height, paused, onHeight, onCommand }: {
  command: AutoCommand | null
  height: string | null
  paused: boolean
  onHeight: (height: string | null) => void
  onCommand: (command: AutoCommand | null) => void
}) {
  const takeoff = height === null ? null : takeoffCommand(height)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">
        Takeoff altitude (m above start)
        <input type="number" step="any" defaultValue={height ?? ''} data-testid="flight-takeoff-altitude" aria-invalid={takeoff === null}
          className="h-7 w-20 rounded-sm border border-line-strong bg-chrome px-2"
          onChange={(event) => onHeight(event.currentTarget.validity.badInput ? null : event.currentTarget.value)} />
      </label>
      <span>Empty uses MIS_TAKEOFF_ALT ({MIS_TAKEOFF_ALT_M} m)</span>
      {takeoff === null && <span role="status">Enter a positive altitude.</span>}
      <Button size="sm" disabled={paused || takeoff === null} onClick={() => { if (takeoff) onCommand(takeoff) }}>Takeoff</Button>
      <Button size="sm" disabled={paused} onClick={() => onCommand({ type: 'hold' })}>Hold</Button>
      <Button size="sm" disabled={paused} onClick={() => onCommand({ type: 'land' })}>Land</Button>
      <Button size="sm" disabled={paused || command === null} onClick={() => onCommand(null)}>Manual</Button>
      {command && <span>Use Manual to return to the selected mode.</span>}
    </div>
  )
}
