import type { FlightFrame } from './frame'
import { FLIGHT_MODE_LABELS } from './flight-mode'

const takeoffLabels = {
  disarmed: 'Disarmed',
  spoolUp: 'Spooling up',
  readyForTakeoff: 'Ready for takeoff',
  rampUp: 'Ramping up',
  flight: 'In flight',
}

const autoLabels = { takeoff: 'Takeoff', hold: 'Hold', land: 'Land', return: 'Return' }
const returnLabels = { climb: 'Climb', return: 'Return', descend: 'Descend', loiter: 'Loiter', land: 'Land', landed: 'Landed' }

export function FlightModeStatus({ frame }: { frame: FlightFrame }) {
  const loop = frame.flightLoop
  const actual = loop
    ? loop.mode === 'rates' ? 'Rates' : FLIGHT_MODE_LABELS[loop.mode]
    : frame.control ? FLIGHT_MODE_LABELS.attitudeHold : null
  const land = loop?.landState
  return (
    <div data-testid="flight-mode-status" aria-live="polite">
      <p>Engine mode <span className="font-medium text-fg" data-testid="flight-mode-actual">{actual ?? 'Awaiting diagnostics'}</span></p>
      {loop?.autoMode && <p data-testid="flight-auto-status">Automatic mode <span className="font-medium text-fg">{autoLabels[loop.autoMode]}</span>
        {loop.commandFinished ? ' · Finished' : loop.commandFinished === false ? ' · In progress' : ''}
      </p>}
      {loop?.returnState && <p data-testid="flight-return-state">Return state <span className="font-medium text-fg">{returnLabels[loop.returnState]}</span></p>}
      {loop?.takeoffState && <p>Takeoff state <span className="font-medium text-fg">{takeoffLabels[loop.takeoffState]}</span></p>}
      {land && <ul className="flex flex-wrap gap-x-3" aria-label="Land detection">
        <li>Freefall {land.freefall ? 'yes' : 'no'}</li>
        <li>Ground contact {land.groundContact ? 'yes' : 'no'}</li>
        <li>Maybe landed {land.maybeLanded ? 'yes' : 'no'}</li>
        <li>Landed {land.landed ? 'yes' : 'no'}</li>
      </ul>}
    </div>
  )
}
