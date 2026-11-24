import { DEVICE_BUTTONS } from './device-buttons'

export function DeviceButtonControls({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        PlayStation flight buttons
      </label>
      <span className="text-fg-muted">{Object.values(DEVICE_BUTTONS)
        .map(({ name, label }) => `${name} → ${label}`).join(' · ')}</span>
    </div>
  )
}
