import { X } from 'lucide-react'
import { useState } from 'react'
import { MAX_MOTOR_TILT, type MotorMount, type Spin } from '../../../electron/ipc/contract'
import { Readout, Readouts, Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FrameGeometry, MotorMountPoint } from '@/three/frame-geometry'
import { useAssembly } from './assembly-store'
import { toMm } from './frame-values'
import { useWorkshopView } from './view-store'

const toDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 10) / 10
const SPIN_LABEL: Record<Spin, string> = { cw: 'CW', ccw: 'CCW' }

/** Records a motor change; a motor back at its PX4 default is stored as "no override". */
function setMotor(m: MotorMountPoint, patch: Partial<MotorMount>, label: string) {
  useAssembly.getState().edit(label, (d) => {
    const next: MotorMount = { spin: m.spin, tilt: m.tilt, ...patch }
    const motors = { ...d.motors }
    if (next.spin === m.defaultSpin && next.tilt === 0) delete motors[m.id]
    else motors[m.id] = next
    return { ...d, motors }
  })
}

/** Left panel: every motor mount, in PX4 order. Clicking a row selects it. */
export function MotorList({ geo }: { geo: FrameGeometry }) {
  const selected = useWorkshopView((s) => s.selectedMount)
  return (
    <ul className="border-t border-line" data-testid="motor-list">
      {geo.motors.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            data-testid={`motor-row-${m.number}`}
            aria-pressed={selected === m.id}
            onClick={() => useWorkshopView.getState().selectMount(selected === m.id ? null : m.id)}
            className={cn(
              '-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-[var(--radius-sm)] border-b border-line/60 px-2 py-1.5 text-left text-[12.5px] hover:bg-hover/60',
              selected === m.id && 'bg-hover',
            )}
          >
            <span className={cn('num w-4 text-right', selected === m.id ? 'text-accent' : 'text-fg-subtle')}>
              {m.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{m.name}</span>
            <span className={cn('num', m.customised ? 'text-warn' : 'text-fg')} title={m.customised ? 'Differs from the PX4 default' : undefined}>
              {SPIN_LABEL[m.spin]}
              {m.tilt !== 0 && ` · ${toDeg(m.tilt)}°`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Right panel: details and orientation of the selected motor mount. */
export function MotorInspector({ geo }: { geo: FrameGeometry }) {
  const selected = useWorkshopView((s) => s.selectedMount)
  const m = geo.motors.find((x) => x.id === selected)
  if (!m) return null
  return (
    <Section
      title={`Motor ${m.number}`}
      testId="motor-inspector"
      actions={
        <button
          type="button"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={() => useWorkshopView.getState().selectMount(null)}
          className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      }
    >
      <Readouts>
        <Readout label="Mount" value={m.name} mono={false} />
        <Readout
          label="Position x, y"
          value={`${toMm(m.position[0])}, ${toMm(m.position[1])}`}
          unit="mm"
          title="x forward, y left, from the frame centre"
        />
        <Readout label="Arm angle" value={toDeg(m.angle)} unit="°" title="From the nose; positive is to the left" />
      </Readouts>

      <div className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
        <span className="text-[12.5px] text-fg-muted">Spin</span>
        <div role="group" aria-label="Spin direction" className="flex rounded-[var(--radius-sm)] border border-line-strong p-px">
          {(['cw', 'ccw'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={m.spin === s}
              title={s === 'cw' ? 'Clockwise, seen from above' : 'Counter-clockwise, seen from above'}
              onClick={() => m.spin !== s && setMotor(m, { spin: s }, `Set motor ${m.number} spin to ${SPIN_LABEL[s]}`)}
              className={cn(
                'num h-6 rounded-[2px] px-2.5 text-[12px] font-medium',
                m.spin === s ? 'bg-hover text-accent' : 'text-fg-muted hover:text-fg',
              )}
            >
              {SPIN_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <TiltField key={`${m.id}:${m.tilt}`} motor={m} />
      <p className="mt-2 text-[12px] text-fg-subtle">
        PX4 default: <span className="num text-fg-muted">{SPIN_LABEL[m.defaultSpin]}</span>, no tilt. Tilt turns the
        motor about its arm.
      </p>
      {m.customised && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => setMotor(m, { spin: m.defaultSpin, tilt: 0 }, `Reset motor ${m.number} to PX4 default`)}
        >
          Reset to PX4 default
        </Button>
      )}
    </Section>
  )
}

function TiltField({ motor }: { motor: MotorMountPoint }) {
  const stored = String(toDeg(motor.tilt))
  const [text, setText] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const max = toDeg(MAX_MOTOR_TILT)

  const commit = () => {
    if (text.trim() === stored) return setError(null)
    const v = Number(text.trim().replace(',', '.'))
    if (text.trim() === '' || !Number.isFinite(v)) return setError('Enter an angle in degrees')
    const rounded = Math.round(v * 10) / 10
    if (Math.abs(rounded) > max) return setError(`Between −${max}° and ${max}°`)
    setError(null)
    setMotor(motor, { tilt: (rounded * Math.PI) / 180 }, `Set motor ${motor.number} tilt to ${rounded}°`)
  }

  return (
    <div className="border-b border-line/60 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="motor-tilt" className="text-[12.5px] text-fg-muted">
          Tilt
        </label>
        <div
          className={cn(
            'flex h-7 w-[92px] items-center rounded-[var(--radius-sm)] border bg-chrome pr-2 focus-within:border-accent',
            error ? 'border-fault' : 'border-line-strong hover:border-fg-subtle/70',
          )}
        >
          <input
            id="motor-tilt"
            data-testid="motor-tilt"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-invalid={!!error}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setText(stored)
                setError(null)
              }
            }}
            className="num h-full w-full min-w-0 bg-transparent px-2 text-right text-fg outline-none"
          />
          <span className="num text-fg-subtle">°</span>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-right text-[11.5px] text-fault">
          {error}
        </p>
      )}
    </div>
  )
}
