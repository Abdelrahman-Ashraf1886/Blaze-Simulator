import type { GpuPreference, GraphicsStatus } from '../../../electron/ipc/contract'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'

const choices: ReadonlyArray<{ value: GpuPreference; label: string; description: string }> = [
  { value: 'high-performance', label: 'High performance', description: 'Uses more battery for smoother flight.' },
  { value: 'power-saving', label: 'Power saving', description: 'Prefers integrated graphics.' },
  { value: 'system', label: 'System', description: 'Windows decides and its per-app setting can override this preference.' },
]

interface GraphicsSectionProps {
  status: GraphicsStatus | null
  renderer: string | null | undefined
  busy: boolean
  error: string | null
  onSelect: (preference: GpuPreference) => void
  onRestart: () => void
}

export function GraphicsSection({ status, renderer, busy, error, onSelect, onRestart }: GraphicsSectionProps) {
  const restartNeeded = status !== null && status.preference !== status.startupPreference
  return (
    <Section title="Graphics" className="max-w-prose text-[13px]">
      <dl className="space-y-2 border-t border-line py-3">
        <div>
          <dt className="text-fg-muted">Drawing card</dt>
          <dd className="break-words" data-testid="drawing-card">{renderer === undefined ? 'Detecting…' : renderer ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Power source</dt>
          <dd>{status ? (status.onBattery ? 'Battery' : 'Plugged in') : 'Unknown'}</dd>
        </div>
      </dl>
      <fieldset disabled={!status || busy} className="space-y-3 border-t border-line py-3">
        <legend className="pr-2 font-medium">Graphics preference</legend>
        {choices.map(({ value, label, description }) => (
          <div key={value} className="grid grid-cols-[auto_1fr] items-baseline gap-x-2">
            <input
              id={value}
              name="graphics-preference"
              type="radio"
              value={value}
              checked={status?.preference === value}
              aria-describedby={`${value}-description`}
              className="accent-accent"
              onChange={() => onSelect(value)}
            />
            <label htmlFor={value}>{label}</label>
            <p id={`${value}-description`} className="col-start-2 text-fg-muted">{description}</p>
          </div>
        ))}
      </fieldset>
      {status?.onBattery && status.preference === 'high-performance' &&
        <p className="mb-3 text-warn">High performance uses more power while you’re on battery.</p>}
      {error && <p role="alert" className="mb-3 text-warn">{error}</p>}
      <div className="space-y-2 border-t border-line pt-3">
        <p role="status" className="text-fg-muted">
          {restartNeeded ? 'Preference saved. It will apply the next time the app starts.' : 'Changes apply the next time the app starts.'}
        </p>
        <Button type="button" disabled={!restartNeeded || busy} onClick={onRestart}>Restart now</Button>
      </div>
    </Section>
  )
}
