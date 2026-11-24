import type { FlightFrame } from './frame'
import { FLIGHT_MODE_LABELS } from './flight-mode'

export function FlightModeStatus({ frame, linearThrottle }: { frame: FlightFrame; linearThrottle: boolean }) {
  const loop = frame.flightLoop
  const actual = loop
    ? loop.mode === 'rates' ? 'Rates' : FLIGHT_MODE_LABELS[loop.mode]
    : frame.control ? FLIGHT_MODE_LABELS.attitudeHold : null
  const requested = loop?.requestedMode
  const groundFallback = loop?.mode === 'stabilized' && (requested === 'altitude' || requested === 'position')
  return (
    <div data-testid="flight-mode-status" aria-live="polite">
      <p>Engine mode <span className="font-medium text-fg" data-testid="flight-mode-actual">{actual ?? 'Awaiting diagnostics'}</span></p>
      {groundFallback && (
        <p className="text-warn">{FLIGHT_MODE_LABELS[requested]} fell back to Stabilized on ground contact.
          {' '}Centred throttle commands {linearThrottle ? 'mid-range thrust (linear throttle curve)' : 'hover thrust'} with no altitude or position hold.
        </p>
      )}
    </div>
  )
}
