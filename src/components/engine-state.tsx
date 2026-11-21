import type { EngineState as State } from '../../electron/ipc/contract'
import { cn } from '@/lib/utils'

const STYLE: Record<State, { label: string; dot: string; text?: string }> = {
  connected: { label: 'Connected', dot: 'bg-ok' },
  starting: { label: 'Starting…', dot: 'bg-warn motion-safe:animate-pulse' },
  restarting: { label: 'Restarting…', dot: 'bg-warn motion-safe:animate-pulse', text: 'text-warn' },
  stopped: { label: 'Stopped', dot: 'bg-fg-subtle' },
  failed: { label: 'Failed', dot: 'bg-fault', text: 'text-fault' },
}

/** Engine state with a status lamp. `prefix` turns "Connected" into e.g. "Engine connected". */
export function EngineState({ state, prefix }: { state: State; prefix?: string }) {
  const s = STYLE[state]
  const label = prefix ? `${prefix} ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)}` : s.label
  return (
    <span className={cn('inline-flex items-center gap-1.5', s.text)} data-testid="engine-state" data-state={state}>
      <span className={cn('size-1.5 shrink-0 rounded-full', s.dot)} aria-hidden />
      {label}
    </span>
  )
}
