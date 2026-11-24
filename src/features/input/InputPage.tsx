import { useState, useSyncExternalStore } from 'react'
import { PageHeader } from '@/components/page-header'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { CalibrationPanel } from './CalibrationPanel'
import { gamepads } from './device-input'
import { NO_DEVICES, type DeviceHandle } from './gamepads'

export function InputPage() {
  const devices = useSyncExternalStore(gamepads.subscribe, gamepads.getDevices, () => NO_DEVICES)
  const [selected, setSelected] = useState<DeviceHandle | null>(null)
  const device = devices.find(({ connection }) => connection === selected?.connection)

  return (
    <>
      <PageHeader title="Input devices" />
      <div className="mx-auto grid max-w-[1600px] gap-5 px-6 py-5 text-[13px] @min-[880px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Section title="Connected devices" count={devices.length}>
          <p className="mb-3 text-fg-muted">Connect a gamepad or transmitter, then press a button on it to make it appear here.</p>
          {devices.length === 0 && <p className="text-fg-subtle">No input devices detected.</p>}
          <ul>
            {devices.map((item) => (
              <li key={item.connection} className="space-y-2 border-t border-line py-3">
                <Button type="button" className="h-auto min-h-8 max-w-full whitespace-normal break-all text-left aria-pressed:border-accent aria-pressed:text-accent"
                  aria-pressed={device?.connection === item.connection} onClick={() => setSelected(item)}>
                  {item.id} · Index <span className="num">{item.index}</span>
                </Button>
                <p className="text-fg-muted">Mapping <span className="text-fg">{item.mapping || 'unknown'}</span></p>
                <Readings title="Axes" values={item.axes} />
                <Readings title="Buttons" values={item.buttons.map((button) => button.value)} />
              </li>
            ))}
          </ul>
        </Section>
        {device
          ? <CalibrationPanel key={device.connection} device={device} />
          : <Section title="Calibration">
              {selected
                ? <p role="status" className="text-warn">Device disconnected. Unsaved calibration was discarded. Reconnect and select the device to continue.</p>
                : <p className="text-fg-muted">Select a device to calibrate it.</p>}
            </Section>}
      </div>
    </>
  )
}

function Readings({ title, values }: { title: string; values: readonly number[] }) {
  return (
    <div className="text-[12px] text-fg-muted">
      <p>{title}</p>
      {values.length === 0
        ? <span>None reported</span>
        : <dl aria-label={title} className="flex flex-wrap gap-x-3 gap-y-1">
            {values.map((value, index) => (
              <div key={index} className="flex gap-1">
                <dt className="num">{index}</dt>
                <dd className="num text-fg">{Number.isFinite(value) ? value.toFixed(3) : '—'}</dd>
              </div>
            ))}
          </dl>}
    </div>
  )
}
